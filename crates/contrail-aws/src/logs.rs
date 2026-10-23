//! The real [`LogSource`]: CloudWatch Logs `FilterLogEvents` (read-only).

use async_trait::async_trait;
use aws_sdk_cloudwatchlogs::Client;
use aws_sdk_cloudwatchlogs::operation::start_live_tail::StartLiveTailError;
use aws_sdk_cloudwatchlogs::types::StartLiveTailResponseStream;
use aws_sdk_cloudwatchlogs::types::error::StartLiveTailResponseStreamError;
use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::logs::{
    Backfill, LiveError, LiveItem, LiveStream, LogSource, RawEvent, StreamSelection, TimeRange,
};
use contrail_core::timestamp::Timestamp;
use futures::StreamExt;
use time::OffsetDateTime;

use crate::clients::ClientCache;
use crate::error::map_sdk_error;

/// `FilterLogEvents` and `StartLiveTail` accept at most this many stream names per request.
const MAX_STREAMS_PER_REQUEST: usize = 100;

/// CloudWatch Logs via the AWS SDK.
#[derive(Default)]
pub struct AwsLogs {
    clients: ClientCache<Client>,
}

impl AwsLogs {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl LogSource for AwsLogs {
    async fn backfill(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
        range: TimeRange,
        limit: usize,
    ) -> Result<Backfill, SourceError> {
        // The log group may live in another region than the service (`awslogs-region`).
        let log_ctx = AwsCtx {
            profile: ctx.profile.clone(),
            region: selection.region.clone().or_else(|| ctx.region.clone()),
        };
        let client = self.clients.get(&log_ctx, Client::new).await;
        backfill(&client, &ctx.profile, selection, range, limit).await
    }

    async fn live(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
    ) -> Result<LiveStream, LiveError> {
        let log_ctx = AwsCtx {
            profile: ctx.profile.clone(),
            region: selection.region.clone().or_else(|| ctx.region.clone()),
        };
        let client = self.clients.get(&log_ctx, Client::new).await;
        let region = client
            .config()
            .region()
            .map(|r| r.to_string())
            .ok_or_else(|| LiveError::Unavailable("no region configured".into()))?;
        let account = selection
            .account_id
            .as_deref()
            .ok_or_else(|| LiveError::Unavailable("the log group's account is unknown".into()))?;
        // Live Tail wants log group ARNs, not names.
        let arn = format!(
            "arn:aws:logs:{region}:{account}:log-group:{}",
            selection.log_group
        );

        let request = client.start_live_tail().log_group_identifiers(arn);
        let request = match &selection.stream_prefix {
            Some(prefix) => request.log_stream_name_prefixes(prefix),
            None => request.set_log_stream_names(Some(
                selection
                    .streams
                    .iter()
                    .take(MAX_STREAMS_PER_REQUEST)
                    .cloned()
                    .collect(),
            )),
        };
        let output = request
            .send()
            .await
            .map_err(|err| start_error(&ctx.profile, err))?;

        // Turn the SDK's event receiver into a stream. The state is `Option<receiver>`: after an
        // error the stream yields that error once and then ends.
        let profile = ctx.profile.clone();
        let stream = futures::stream::unfold(Some(output.response_stream), move |receiver| {
            let profile = profile.clone();
            async move {
                let mut receiver = receiver?;
                match receiver.recv().await {
                    Ok(Some(message)) => Some((Ok(live_item(message)), Some(receiver))),
                    Ok(None) => None,
                    Err(err) => Some((Err(stream_error(&profile, err)), None)),
                }
            }
        });
        Ok(stream.boxed())
    }
}

/// Maps one message of the Live Tail stream.
fn live_item(message: StartLiveTailResponseStream) -> LiveItem {
    match message {
        StartLiveTailResponseStream::SessionStart(_) => LiveItem::Started,
        StartLiveTailResponseStream::SessionUpdate(update) => LiveItem::Events {
            sampled: update.session_metadata().is_some_and(|m| m.sampled()),
            events: update
                .session_results()
                .iter()
                .filter_map(|event| {
                    Some(RawEvent {
                        stream: event.log_stream_name()?.to_owned(),
                        timestamp: event.timestamp().and_then(from_millis)?,
                        message: event.message()?.to_owned(),
                    })
                })
                .collect(),
        },
        // A message type newer than this SDK: nothing to show.
        _ => LiveItem::Events {
            events: Vec::new(),
            sampled: false,
        },
    }
}

/// Errors starting a session: some mean "Live Tail isn't possible here, poll instead".
fn start_error<R: std::fmt::Debug + 'static>(
    profile: &str,
    err: aws_sdk_cloudwatchlogs::error::SdkError<StartLiveTailError, R>,
) -> LiveError {
    match err.as_service_error() {
        Some(
            e @ (StartLiveTailError::AccessDeniedException(_)
            | StartLiveTailError::LimitExceededException(_)
            | StartLiveTailError::InvalidOperationException(_)),
        ) => LiveError::Unavailable(e.to_string()),
        _ => LiveError::Source(map_sdk_error(profile, err)),
    }
}

/// Errors on a running session: timeouts (3 hours) and streaming problems mean "reconnect".
fn stream_error<R: std::fmt::Debug + 'static>(
    profile: &str,
    err: aws_sdk_cloudwatchlogs::error::SdkError<StartLiveTailResponseStreamError, R>,
) -> LiveError {
    match err.as_service_error() {
        Some(
            e @ (StartLiveTailResponseStreamError::SessionTimeoutException(_)
            | StartLiveTailResponseStreamError::SessionStreamingException(_)),
        ) => LiveError::SessionEnded(e.to_string()),
        _ => LiveError::Source(map_sdk_error(profile, err)),
    }
}

fn millis(timestamp: Timestamp) -> i64 {
    (timestamp.0.unix_timestamp_nanos() / 1_000_000) as i64
}

fn from_millis(millis: i64) -> Option<Timestamp> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .map(Timestamp)
}

async fn backfill(
    client: &Client,
    profile: &str,
    selection: &StreamSelection,
    range: TimeRange,
    limit: usize,
) -> Result<Backfill, SourceError> {
    let mut result = Backfill::default();
    // A whole service is read by its stream prefix (one request, every task that logged); a
    // task by its stream names, in batches of 100 that run one after another so the limit
    // applies across all of them.
    let batches: Vec<Option<&[String]>> = match &selection.stream_prefix {
        Some(_) => vec![None],
        None => selection
            .streams
            .chunks(MAX_STREAMS_PER_REQUEST)
            .map(Some)
            .collect(),
    };
    for streams in batches {
        let request = client
            .filter_log_events()
            .log_group_name(&selection.log_group);
        let request = match (streams, &selection.stream_prefix) {
            (Some(streams), _) => request.set_log_stream_names(Some(streams.to_vec())),
            (None, prefix) => request.set_log_stream_name_prefix(prefix.clone()),
        };
        let mut pages = request
            .start_time(millis(range.start))
            .end_time(millis(range.end))
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            let page = page.map_err(|err| map_sdk_error(profile, err))?;
            for event in page.events() {
                if result.events.len() >= limit {
                    result.truncated = true;
                    break;
                }
                let (Some(stream), Some(timestamp), Some(message)) = (
                    event.log_stream_name(),
                    event.timestamp().and_then(from_millis),
                    event.message(),
                ) else {
                    continue;
                };
                result.events.push(RawEvent {
                    stream: stream.to_owned(),
                    timestamp,
                    message: message.to_owned(),
                });
            }
            if result.truncated {
                break;
            }
        }
        if result.truncated {
            break;
        }
    }
    // Each request is ordered by time; batches need merging.
    result.events.sort_by_key(|e| e.timestamp);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_cloudwatchlogs::operation::filter_log_events::FilterLogEventsOutput;
    use aws_sdk_cloudwatchlogs::types::FilteredLogEvent;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use time::Duration;
    use time::macros::datetime;

    fn range() -> TimeRange {
        let start = datetime!(2026-01-15 12:00 UTC);
        TimeRange {
            start: Timestamp(start),
            end: Timestamp(start + Duration::minutes(15)),
        }
    }

    fn event(stream: &str, millis: i64, message: &str) -> FilteredLogEvent {
        FilteredLogEvent::builder()
            .log_stream_name(stream)
            .timestamp(1_768_478_400_000 + millis)
            .message(message)
            .build()
    }

    fn selection(streams: usize) -> StreamSelection {
        StreamSelection {
            log_group: "/ecs/orders-api".into(),
            region: None,
            account_id: None,
            stream_prefix: None,
            streams: (0..streams)
                .map(|i| format!("ecs/orders-api/task{i:03}"))
                .collect(),
        }
    }

    #[tokio::test]
    async fn follows_pages_and_sends_range_and_streams() {
        let rule = mock!(Client::filter_log_events)
            .match_requests(|req| {
                req.log_group_name() == Some("/ecs/orders-api")
                    && req.start_time() == Some(1_768_478_400_000)
                    && req.end_time() == Some(1_768_478_400_000 + 15 * 60_000)
                    && req.log_stream_names().len() == 2
            })
            .sequence()
            .output(|| {
                FilterLogEventsOutput::builder()
                    .events(event("ecs/orders-api/task000", 1, "first"))
                    .next_token("page-2")
                    .build()
            })
            .output(|| {
                FilterLogEventsOutput::builder()
                    .events(event("ecs/orders-api/task001", 2, "second"))
                    .build()
            })
            .build();
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::Sequential, [&rule]);

        let result = backfill(&client, "dev", &selection(2), range(), 100)
            .await
            .unwrap();

        let messages: Vec<&str> = result.events.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, ["first", "second"]);
        assert_eq!(result.events[0].stream, "ecs/orders-api/task000");
        assert!(!result.truncated);
        assert_eq!(rule.num_calls(), 2);
    }

    #[tokio::test]
    async fn splits_more_than_100_streams_and_merges_by_time() {
        let rule = mock!(Client::filter_log_events).then_compute_output(|req| {
            assert!(req.log_stream_names().len() <= 100);
            // The first batch has the later event, to check the merge.
            let first_batch = req
                .log_stream_names()
                .contains(&"ecs/orders-api/task000".to_owned());
            let (stream, millis) = if first_batch {
                ("ecs/orders-api/task000", 50)
            } else {
                ("ecs/orders-api/task120", 10)
            };
            FilterLogEventsOutput::builder()
                .events(event(stream, millis, stream))
                .build()
        });
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::MatchAny, [&rule]);

        let result = backfill(&client, "dev", &selection(150), range(), 100)
            .await
            .unwrap();

        assert_eq!(rule.num_calls(), 2);
        let streams: Vec<&str> = result.events.iter().map(|e| e.stream.as_str()).collect();
        assert_eq!(
            streams,
            ["ecs/orders-api/task120", "ecs/orders-api/task000"]
        );
    }

    #[tokio::test]
    async fn stops_at_the_limit() {
        let rule = mock!(Client::filter_log_events).then_output(|| {
            FilterLogEventsOutput::builder()
                .set_events(Some(
                    (0..10)
                        .map(|i| event("ecs/orders-api/task000", i, "m"))
                        .collect(),
                ))
                .next_token("more")
                .build()
        });
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::MatchAny, [&rule]);

        let result = backfill(&client, "dev", &selection(1), range(), 15)
            .await
            .unwrap();

        assert_eq!(result.events.len(), 15);
        assert!(result.truncated);
        assert_eq!(rule.num_calls(), 2, "no further pages after the limit");
    }

    #[test]
    fn maps_live_tail_updates() {
        use aws_sdk_cloudwatchlogs::types::{
            LiveTailSessionLogEvent, LiveTailSessionMetadata, LiveTailSessionStart,
            LiveTailSessionUpdate,
        };
        assert_eq!(
            live_item(StartLiveTailResponseStream::SessionStart(
                LiveTailSessionStart::builder().build()
            )),
            LiveItem::Started
        );
        let update = LiveTailSessionUpdate::builder()
            .session_metadata(LiveTailSessionMetadata::builder().sampled(true).build())
            .session_results(
                LiveTailSessionLogEvent::builder()
                    .log_stream_name("ecs/orders-api/task1")
                    .timestamp(1_768_478_400_000)
                    .message("hello")
                    .build(),
            )
            // Incomplete events are skipped.
            .session_results(
                LiveTailSessionLogEvent::builder()
                    .message("no stream")
                    .build(),
            )
            .build();
        let LiveItem::Events { events, sampled } =
            live_item(StartLiveTailResponseStream::SessionUpdate(update))
        else {
            panic!("expected events");
        };
        assert!(sampled);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].stream, "ecs/orders-api/task1");
        assert_eq!(events[0].message, "hello");
    }

    #[tokio::test]
    async fn access_denied_means_live_tail_is_unavailable() {
        use aws_sdk_cloudwatchlogs::types::error::AccessDeniedException;
        let rule = mock!(Client::start_live_tail).then_error(|| {
            StartLiveTailError::AccessDeniedException(
                AccessDeniedException::builder()
                    .message("not allowed: logs:StartLiveTail")
                    .build(),
            )
        });
        let client = mock_client!(aws_sdk_cloudwatchlogs, [&rule]);
        let err = client
            .start_live_tail()
            .log_group_identifiers("arn:aws:logs:eu-central-1:111122223333:log-group:/ecs/x")
            .send()
            .await
            .unwrap_err();
        assert!(matches!(start_error("dev", err), LiveError::Unavailable(_)));
    }

    #[tokio::test]
    async fn a_whole_service_is_read_by_its_stream_prefix() {
        let rule = mock!(Client::filter_log_events)
            .match_requests(|req| {
                req.log_stream_name_prefix() == Some("ecs/orders-api/")
                    && req.log_stream_names().is_empty()
            })
            .then_output(|| {
                FilterLogEventsOutput::builder()
                    .events(event(
                        "ecs/orders-api/new-task",
                        1,
                        "from a task started later",
                    ))
                    .build()
            });
        let client = mock_client!(aws_sdk_cloudwatchlogs, [&rule]);
        let mut sel = selection(150);
        sel.stream_prefix = Some("ecs/orders-api/".into());

        let result = backfill(&client, "dev", &sel, range(), 100).await.unwrap();

        assert_eq!(rule.num_calls(), 1, "one request instead of two batches");
        assert_eq!(result.events[0].stream, "ecs/orders-api/new-task");
    }
}
