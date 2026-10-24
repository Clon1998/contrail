//! Following one ID (a document's correlation ID, an API's trace ID) across several services.
//!
//! Each service's log group is searched for the ID (CloudWatch filters, so only matching events
//! travel); the hits are merged by time and summarised per service.

use futures::StreamExt;
use serde::Serialize;
use specta::Type;

use crate::auth::AwsCtx;
use crate::timestamp::Timestamp;

use super::{LogEvent, LogSource, StatusChange, StreamSelection, TimeRange, process};

/// At most this many services are searched at the same time (CloudWatch limits the request rate).
const PARALLEL: usize = 4;

/// One service to search: its name (for display) and where its logs are.
#[derive(Debug, Clone)]
pub struct TraceTarget {
    pub service: String,
    pub selection: StreamSelection,
}

/// An event of the trace and the service that logged it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceHit {
    pub service: String,
    pub event: LogEvent,
}

/// What the trace shows of one service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTrace {
    pub service: String,
    pub events: u32,
    pub first: Timestamp,
    pub last: Timestamp,
    /// The state of the service's last status event, if it logged any.
    pub last_state: Option<String>,
}

/// Whether a service wrote the document to a topic or read it from one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HopDirection {
    Writes,
    Reads,
}

/// One step of the document's way: a service writing it to a topic, or reading it from one, as
/// its status events tell. A service that reads one topic and writes the next (a transformer) has
/// two hops.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub service: String,
    pub topic: String,
    pub direction: HopDirection,
    /// The consumer group that read the topic.
    pub group: Option<String>,
    /// Status events of this hop.
    pub events: u32,
    pub first: Timestamp,
    pub last: Timestamp,
    /// The state of the hop's last status event.
    pub last_state: String,
}

/// Whether the document finished everywhere it went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TraceOutcome {
    /// Some service's last state is FAILED.
    Failed,
    /// Every service with status events ended in COMPLETED.
    Completed,
    /// A service is still in an earlier state (or there are no status events).
    Open,
}

/// A search that failed for one service; the others still count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceFailure {
    pub service: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    /// Oldest first.
    pub hits: Vec<TraceHit>,
    /// In the order the services were first reached.
    pub services: Vec<ServiceTrace>,
    /// The topics the document went through, in the order the hops started.
    pub hops: Vec<TraceHop>,
    pub outcome: TraceOutcome,
    /// A service had more matching events than `limit`: its newest are missing.
    pub truncated: bool,
    pub failures: Vec<TraceFailure>,
}

/// Searches every target for `id` within `range` (at most `limit` events per service).
pub async fn trace(
    source: &dyn LogSource,
    ctx: &AwsCtx,
    targets: Vec<TraceTarget>,
    id: &str,
    range: TimeRange,
    limit: usize,
) -> Trace {
    // `buffer_unordered` runs up to PARALLEL searches at once and yields them as they finish,
    // like a bounded thread pool with a completion queue.
    let results: Vec<_> = futures::stream::iter(targets)
        .map(|target| async move {
            let mut selection = target.selection;
            selection.filter_pattern = Some(id.to_owned());
            let result = source.backfill(ctx, &selection, range, limit).await;
            (target.service, result)
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;

    let mut hits = Vec::new();
    let mut failures = Vec::new();
    let mut truncated = false;
    for (service, result) in results {
        match result {
            Ok(backfill) => {
                truncated |= backfill.truncated;
                hits.extend(process(backfill.events).into_iter().map(|event| TraceHit {
                    service: service.clone(),
                    event,
                }));
            }
            Err(error) => failures.push(TraceFailure {
                service,
                message: error.to_string(),
            }),
        }
    }
    assemble(hits, failures, truncated)
}

/// Logs Insights can query this many log groups at once.
const INSIGHTS_GROUPS: usize = 50;

/// Like [`trace`], but with Logs Insights: one query per region and 50 log groups instead of a
/// search per service (faster for many services; billed per GB scanned). `limit` applies per
/// query.
pub async fn trace_insights(
    source: &dyn LogSource,
    ctx: &AwsCtx,
    targets: Vec<TraceTarget>,
    id: &str,
    range: TimeRange,
    limit: usize,
) -> Trace {
    // Log groups per region (a group's region comes from the service's awslogs settings).
    let mut by_region: Vec<(Option<String>, Vec<String>)> = Vec::new();
    for target in &targets {
        let region = target.selection.region.clone();
        let group = target.selection.log_group.clone();
        match by_region.iter_mut().find(|(r, _)| *r == region) {
            Some((_, groups)) if !groups.contains(&group) => groups.push(group),
            Some(_) => {}
            None => by_region.push((region, vec![group])),
        }
    }

    let mut hits = Vec::new();
    let mut failures = Vec::new();
    let mut truncated = false;
    for (region, groups) in by_region {
        for chunk in groups.chunks(INSIGHTS_GROUPS) {
            match source
                .insights_find(ctx, region.clone(), chunk, id, range, limit)
                .await
            {
                Ok(found) => {
                    truncated |= found.len() >= limit;
                    for (raw, group) in found.into_iter().map(|g| (g.event, g.log_group)) {
                        // Several services can share a log group: their stream prefix tells.
                        let owner = targets.iter().find(|t| {
                            t.selection.log_group == group
                                && t.selection
                                    .stream_prefix
                                    .as_deref()
                                    .is_none_or(|prefix| raw.stream.starts_with(prefix))
                        });
                        if let Some(target) = owner {
                            hits.extend(process(vec![raw]).into_iter().map(|event| TraceHit {
                                service: target.service.clone(),
                                event,
                            }));
                        }
                    }
                }
                Err(error) => failures.extend(
                    targets
                        .iter()
                        .filter(|t| chunk.contains(&t.selection.log_group))
                        .map(|t| TraceFailure {
                            service: t.service.clone(),
                            message: error.to_string(),
                        }),
                ),
            }
        }
    }
    assemble(hits, failures, truncated)
}

/// Orders the hits and failures and adds the per-service summary and the outcome.
fn assemble(mut hits: Vec<TraceHit>, mut failures: Vec<TraceFailure>, truncated: bool) -> Trace {
    hits.sort_by_key(|h| (h.event.timestamp, h.event.cw_timestamp));
    failures.sort_by(|a, b| a.service.cmp(&b.service));
    let services = summarize(&hits);
    Trace {
        outcome: outcome(&services),
        hops: hops(&hits),
        hits,
        services,
        truncated,
        failures,
    }
}

fn summarize(hits: &[TraceHit]) -> Vec<ServiceTrace> {
    let mut services: Vec<ServiceTrace> = Vec::new();
    for hit in hits {
        let state = hit.event.status.as_ref().map(|s| s.state.clone());
        match services.iter_mut().find(|s| s.service == hit.service) {
            Some(service) => {
                service.events += 1;
                service.last = hit.event.timestamp;
                if state.is_some() {
                    service.last_state = state;
                }
            }
            None => services.push(ServiceTrace {
                service: hit.service.clone(),
                events: 1,
                first: hit.event.timestamp,
                last: hit.event.timestamp,
                last_state: state,
            }),
        }
    }
    services
}

/// The producing side logs `RECEIVED → PUBLISHED` without a consumer group; everything else
/// (`CONSUMING → COMPLETED | FAILED | RETRYING`) happens while reading. A producer that fails
/// (`RECEIVED → FAILED`) is still writing.
fn direction(status: &StatusChange) -> HopDirection {
    let writing = |state: &str| {
        ["RECEIVED", "PUBLISHED"]
            .iter()
            .any(|w| state.eq_ignore_ascii_case(w))
    };
    if status.consumer_group.is_none()
        && (writing(&status.state) || status.previous_state.as_deref().is_some_and(writing))
    {
        HopDirection::Writes
    } else {
        HopDirection::Reads
    }
}

/// The hops of the (time-ordered) hits: one per service, topic and direction.
fn hops(hits: &[TraceHit]) -> Vec<TraceHop> {
    let mut hops: Vec<TraceHop> = Vec::new();
    for hit in hits {
        let Some(status) = &hit.event.status else {
            continue;
        };
        let Some(topic) = &status.topic else {
            continue;
        };
        let direction = direction(status);
        let existing = hops
            .iter_mut()
            .find(|h| h.service == hit.service && &h.topic == topic && h.direction == direction);
        match existing {
            Some(hop) => {
                hop.events += 1;
                hop.last = hit.event.timestamp;
                hop.last_state = status.state.clone();
                if hop.group.is_none() {
                    hop.group = status.consumer_group.clone();
                }
            }
            None => hops.push(TraceHop {
                service: hit.service.clone(),
                topic: topic.clone(),
                direction,
                group: status.consumer_group.clone(),
                events: 1,
                first: hit.event.timestamp,
                last: hit.event.timestamp,
                last_state: status.state.clone(),
            }),
        }
    }
    hops
}

fn outcome(services: &[ServiceTrace]) -> TraceOutcome {
    let states: Vec<&str> = services
        .iter()
        .filter_map(|s| s.last_state.as_deref())
        .collect();
    if states.iter().any(|s| s.eq_ignore_ascii_case("FAILED")) {
        TraceOutcome::Failed
    } else if !states.is_empty() && states.iter().all(|s| s.eq_ignore_ascii_case("COMPLETED")) {
        TraceOutcome::Completed
    } else {
        TraceOutcome::Open
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use futures::executor::block_on;
    use time::macros::datetime;

    use super::*;
    use crate::error::SourceError;
    use crate::logs::{Backfill, RawEvent};

    /// A log group's events: seconds after 12:00 and the message (or the error reading it).
    type GroupEvents = Result<Vec<(i64, &'static str)>, SourceError>;

    /// Events per log group; honours the filter pattern like CloudWatch.
    struct Groups(HashMap<&'static str, GroupEvents>);

    #[async_trait]
    impl LogSource for Groups {
        async fn backfill(
            &self,
            _ctx: &AwsCtx,
            selection: &StreamSelection,
            _range: TimeRange,
            limit: usize,
        ) -> Result<Backfill, SourceError> {
            let events = self.0[selection.log_group.as_str()].clone()?;
            let pattern = selection.filter_pattern.clone().unwrap_or_default();
            let mut events: Vec<RawEvent> = events
                .into_iter()
                .filter(|(_, message)| message.contains(&pattern))
                .map(|(second, message)| RawEvent {
                    stream: format!("ecs/{}/task1", selection.log_group),
                    timestamp: Timestamp(
                        datetime!(2026-10-23 12:00 UTC) + time::Duration::seconds(second),
                    ),
                    message: message.to_owned(),
                })
                .collect();
            let truncated = events.len() > limit;
            events.truncate(limit);
            Ok(Backfill { events, truncated })
        }
    }

    fn status(state: &str, id: &str) -> &'static str {
        Box::leak(
            format!(r#"{{"message":"status","fw":{{"state":"{state}","correlationId":"{id}"}}}}"#)
                .into_boxed_str(),
        )
    }

    /// A status event about `topic`, read by `group` (or written, without one).
    fn hop(state: &str, topic: &str, group: Option<&str>) -> &'static str {
        let group = group.map_or("null".to_owned(), |g| format!(r#""{g}""#));
        Box::leak(
            format!(
                r#"{{"message":"status","fw":{{"state":"{state}","correlationId":"DOC-1","topicName":"{topic}","consumerGroup":{group}}}}}"#
            )
            .into_boxed_str(),
        )
    }

    fn target(name: &str) -> TraceTarget {
        TraceTarget {
            service: name.into(),
            selection: StreamSelection {
                log_group: name.into(),
                region: None,
                account_id: None,
                streams: vec![],
                stream_prefix: Some(format!("ecs/{name}/")),
                filter_pattern: None,
            },
        }
    }

    fn run(source: &Groups, names: &[&str]) -> Trace {
        let ctx = AwsCtx {
            profile: "dev".into(),
            region: None,
        };
        let range = TimeRange {
            start: Timestamp(datetime!(2026-10-23 11:00 UTC)),
            end: Timestamp(datetime!(2026-10-23 13:00 UTC)),
        };
        block_on(trace(
            source,
            &ctx,
            names.iter().map(|n| target(n)).collect(),
            "DOC-1",
            range,
            100,
        ))
    }

    #[test]
    fn merges_services_by_time_and_follows_the_document() {
        let source = Groups(HashMap::from([
            (
                "input",
                Ok(vec![
                    (1, status("RECEIVED", "DOC-1")),
                    (2, status("PUBLISHED", "DOC-1")),
                    (3, status("RECEIVED", "DOC-2")),
                ]),
            ),
            (
                "output",
                Ok(vec![
                    (5, status("CONSUMING", "DOC-1")),
                    (6, status("COMPLETED", "DOC-1")),
                ]),
            ),
        ]));
        let trace = run(&source, &["output", "input"]);
        let order: Vec<_> = trace.hits.iter().map(|h| h.service.as_str()).collect();
        assert_eq!(
            order,
            ["input", "input", "output", "output"],
            "only DOC-1, by time"
        );
        assert_eq!(trace.services[0].service, "input");
        assert_eq!(trace.services[0].last_state.as_deref(), Some("PUBLISHED"));
        assert_eq!(trace.services[1].last_state.as_deref(), Some("COMPLETED"));
        // The input service's last state is PUBLISHED: its part isn't "completed".
        assert_eq!(trace.outcome, TraceOutcome::Open);
    }

    #[test]
    fn a_failure_anywhere_fails_the_trace_and_errors_are_per_service() {
        let source = Groups(HashMap::from([
            (
                "output",
                Ok(vec![
                    (5, status("CONSUMING", "DOC-1")),
                    (6, status("FAILED", "DOC-1")),
                ]),
            ),
            (
                "denied",
                Err(SourceError::AccessDenied("logs:FilterLogEvents".into())),
            ),
        ]));
        let trace = run(&source, &["output", "denied"]);
        assert_eq!(trace.outcome, TraceOutcome::Failed);
        assert_eq!(trace.hits.len(), 2);
        assert_eq!(trace.failures.len(), 1);
        assert_eq!(trace.failures[0].service, "denied");
    }

    /// Answers Insights queries from the same groups (and counts the queries).
    struct Insights(Groups, std::sync::Mutex<Vec<Vec<String>>>);

    #[async_trait]
    impl LogSource for Insights {
        async fn backfill(
            &self,
            ctx: &AwsCtx,
            selection: &StreamSelection,
            range: TimeRange,
            limit: usize,
        ) -> Result<Backfill, SourceError> {
            self.0.backfill(ctx, selection, range, limit).await
        }

        async fn insights_find(
            &self,
            ctx: &AwsCtx,
            _region: Option<String>,
            log_groups: &[String],
            text: &str,
            range: TimeRange,
            limit: usize,
        ) -> Result<Vec<crate::logs::GroupEvent>, SourceError> {
            self.1.lock().unwrap().push(log_groups.to_vec());
            let mut found = Vec::new();
            for group in log_groups {
                let mut selection = target(group).selection;
                selection.filter_pattern = Some(text.to_owned());
                let backfill = self.0.backfill(ctx, &selection, range, limit).await?;
                found.extend(
                    backfill
                        .events
                        .into_iter()
                        .map(|event| crate::logs::GroupEvent {
                            log_group: group.clone(),
                            event,
                        }),
                );
            }
            Ok(found)
        }
    }

    #[test]
    fn insights_queries_many_groups_at_once() {
        let source = Insights(
            Groups(HashMap::from([
                ("input", Ok(vec![(1, status("RECEIVED", "DOC-1"))])),
                ("output", Ok(vec![(5, status("COMPLETED", "DOC-1"))])),
            ])),
            std::sync::Mutex::default(),
        );
        let ctx = AwsCtx {
            profile: "dev".into(),
            region: None,
        };
        let range = TimeRange {
            start: Timestamp(datetime!(2026-10-23 11:00 UTC)),
            end: Timestamp(datetime!(2026-10-23 13:00 UTC)),
        };
        let mut output = target("output");
        // The stream prefix decides which service a hit belongs to.
        output.selection.stream_prefix = Some("ecs/output/".into());
        let trace = block_on(trace_insights(
            &source,
            &ctx,
            vec![target("input"), output],
            "DOC-1",
            range,
            100,
        ));
        assert_eq!(
            source.1.lock().unwrap().len(),
            1,
            "one query for both groups"
        );
        let services: Vec<_> = trace.services.iter().map(|s| s.service.as_str()).collect();
        assert_eq!(services, ["input", "output"]);
    }

    #[test]
    fn hops_follow_the_document_through_a_transformer() {
        let source = Groups(HashMap::from([
            (
                "input",
                Ok(vec![
                    (1, hop("RECEIVED", "raw", None)),
                    (2, hop("PUBLISHED", "raw", None)),
                ]),
            ),
            (
                "enricher",
                Ok(vec![
                    (3, hop("CONSUMING", "raw", Some("enricher"))),
                    (4, hop("RECEIVED", "enriched", None)),
                    (5, hop("PUBLISHED", "enriched", None)),
                    (6, hop("COMPLETED", "raw", Some("enricher"))),
                ]),
            ),
            (
                "output",
                Ok(vec![
                    (7, hop("CONSUMING", "enriched", Some("output"))),
                    (8, hop("RETRYING", "enriched", Some("output"))),
                    (9, "a plain line about DOC-1"),
                ]),
            ),
        ]));
        let trace = run(&source, &["output", "enricher", "input"]);
        let hops: Vec<_> = trace
            .hops
            .iter()
            .map(|h| {
                (
                    h.service.as_str(),
                    h.topic.as_str(),
                    h.direction,
                    h.group.as_deref(),
                    h.events,
                    h.last_state.as_str(),
                )
            })
            .collect();
        use HopDirection::{Reads, Writes};
        assert_eq!(
            hops,
            [
                ("input", "raw", Writes, None, 2, "PUBLISHED"),
                ("enricher", "raw", Reads, Some("enricher"), 2, "COMPLETED"),
                ("enricher", "enriched", Writes, None, 2, "PUBLISHED"),
                ("output", "enriched", Reads, Some("output"), 2, "RETRYING"),
            ]
        );
    }

    #[test]
    fn a_failing_producer_is_still_writing() {
        let failed = |previous: &str, group: Option<&str>| StatusChange {
            prefix: "fw".into(),
            state: "FAILED".into(),
            previous_state: Some(previous.into()),
            correlation_id: Some("DOC-1".into()),
            topic: Some("raw".into()),
            consumer_group: group.map(str::to_owned),
            message: None,
        };
        assert_eq!(direction(&failed("RECEIVED", None)), HopDirection::Writes);
        assert_eq!(
            direction(&failed("CONSUMING", Some("out"))),
            HopDirection::Reads
        );
        // Without a group, a failure while consuming still counts as reading.
        assert_eq!(direction(&failed("CONSUMING", None)), HopDirection::Reads);
    }

    #[test]
    fn completed_everywhere() {
        let source = Groups(HashMap::from([
            ("a", Ok(vec![(1, status("COMPLETED", "DOC-1"))])),
            (
                "b",
                Ok(vec![
                    (2, "plain line mentioning DOC-1"),
                    (3, status("COMPLETED", "DOC-1")),
                ]),
            ),
        ]));
        let trace = run(&source, &["a", "b"]);
        assert_eq!(trace.outcome, TraceOutcome::Completed);
        assert_eq!(trace.services[1].events, 2);
    }
}
