//! Route health: how the documents of a service's routes ended in a view's window, per topic and
//! consumer group, from the pipeline framework's status events (see [`super::status`]).

use std::collections::HashMap;

use serde::Serialize;
use specta::Type;
use time::Duration;

use crate::timestamp::Timestamp;

use super::LogEvent;
use super::timeline::{bucket_length, bucket_start};

/// How one topic did for one consumer group (none: the producing side).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicHealth {
    pub topic: String,
    pub consumer_group: Option<String>,
    /// Documents that went through: `COMPLETED` (read and handled) or `PUBLISHED` (written).
    pub done: u32,
    pub retrying: u32,
    pub failed: u32,
    /// `done` per bucket, oldest first: the throughput.
    pub done_over_time: Vec<u32>,
    /// `failed` per bucket, oldest first.
    pub failed_over_time: Vec<u32>,
}

/// The health of every topic a view's status events name, in buckets of equal length.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouteHealth {
    /// The start of the first bucket.
    pub start: Timestamp,
    pub bucket_ms: u32,
    /// The topics with failures first (most first), then by name.
    pub topics: Vec<TopicHealth>,
}

/// What a status counts as. Other states (`RECEIVED`, `CONSUMING`, …) are steps on the way.
enum Outcome {
    Done,
    Retrying,
    Failed,
}

fn outcome(state: &str) -> Option<Outcome> {
    match state.to_ascii_uppercase().as_str() {
        "COMPLETED" | "PUBLISHED" => Some(Outcome::Done),
        "RETRYING" => Some(Outcome::Retrying),
        "FAILED" => Some(Outcome::Failed),
        _ => None,
    }
}

/// Counts the outcomes of `events`' status changes from `from` to `to`, per topic and consumer
/// group, into at most about `max_buckets` buckets. Events without a status or a topic, and
/// outside the range, are left out.
pub fn route_health<'a>(
    events: impl IntoIterator<Item = &'a LogEvent>,
    from: Timestamp,
    to: Timestamp,
    max_buckets: u32,
) -> RouteHealth {
    let step = bucket_length(to.0 - from.0, max_buckets);
    // Aligned to UTC: the sparklines have no time labels, so the time zone doesn't matter.
    let start = bucket_start(from.0, step, Duration::ZERO);
    let step_ms = i128::from(step);
    let count =
        usize::try_from((to.0 - start).whole_milliseconds().max(0) / step_ms + 1).unwrap_or(1);

    // Keyed by topic and group; a `HashMap` like Java's, the entry API inserts on first use.
    let mut topics: HashMap<(String, Option<String>), TopicHealth> = HashMap::new();
    for event in events {
        let Some(status) = &event.status else {
            continue;
        };
        let (Some(topic), Some(outcome)) = (&status.topic, outcome(&status.state)) else {
            continue;
        };
        let at = event.timestamp.0;
        if at < from.0 || at > to.0 {
            continue;
        }
        let health = topics
            .entry((topic.clone(), status.consumer_group.clone()))
            .or_insert_with(|| TopicHealth {
                topic: topic.clone(),
                consumer_group: status.consumer_group.clone(),
                done: 0,
                retrying: 0,
                failed: 0,
                done_over_time: vec![0; count],
                failed_over_time: vec![0; count],
            });
        let bucket = usize::try_from((at - start).whole_milliseconds() / step_ms).ok();
        match outcome {
            Outcome::Done => {
                health.done += 1;
                if let Some(b) = bucket.and_then(|i| health.done_over_time.get_mut(i)) {
                    *b += 1;
                }
            }
            Outcome::Retrying => health.retrying += 1,
            Outcome::Failed => {
                health.failed += 1;
                if let Some(b) = bucket.and_then(|i| health.failed_over_time.get_mut(i)) {
                    *b += 1;
                }
            }
        }
    }

    let mut topics: Vec<TopicHealth> = topics.into_values().collect();
    topics.sort_by(|a, b| {
        b.failed
            .cmp(&a.failed)
            .then_with(|| a.topic.cmp(&b.topic))
            .then_with(|| a.consumer_group.cmp(&b.consumer_group))
    });
    RouteHealth {
        start: Timestamp(start),
        bucket_ms: step,
        topics,
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;
    use crate::logs::{LogKind, ParsedLine, StatusChange};

    fn status(minute: i64, topic: &str, group: Option<&str>, state: &str) -> LogEvent {
        let at = datetime!(2026-10-30 12:00 UTC) + Duration::minutes(minute);
        LogEvent {
            seq: 0,
            timestamp: Timestamp(at),
            cw_timestamp: Timestamp(at),
            stream: "s".into(),
            task_id: "t".into(),
            line: ParsedLine {
                kind: LogKind::Plain,
                timestamp: None,
                level: None,
                message: "m".into(),
                fields: Vec::new(),
                error: None,
                json_span: None,
            },
            raw: "m".into(),
            status: Some(StatusChange {
                prefix: "fw".into(),
                state: state.into(),
                previous_state: None,
                correlation_id: Some("c".into()),
                topic: Some(topic.into()),
                consumer_group: group.map(Into::into),
                message: None,
            }),
        }
    }

    #[test]
    fn counts_outcomes_per_topic_and_group_over_time() {
        let events = [
            status(0, "orders", Some("billing"), "CONSUMING"),
            status(1, "orders", Some("billing"), "COMPLETED"),
            status(2, "orders", Some("billing"), "completed"),
            status(3, "orders", Some("billing"), "RETRYING"),
            status(14, "orders", Some("billing"), "FAILED"),
            status(5, "orders", Some("audit"), "COMPLETED"),
            status(6, "orders", None, "PUBLISHED"),
            // Outside the range.
            status(30, "orders", Some("billing"), "FAILED"),
        ];
        let health = route_health(
            &events,
            Timestamp(datetime!(2026-10-30 12:00 UTC)),
            Timestamp(datetime!(2026-10-30 12:15 UTC)),
            3,
        );
        assert_eq!(health.bucket_ms, 5 * 60_000);
        let shape: Vec<_> = health
            .topics
            .iter()
            .map(|t| (t.consumer_group.as_deref(), t.done, t.retrying, t.failed))
            .collect();
        // Failures first; the producing side (no group) counts its publishing as done.
        assert_eq!(
            shape,
            [
                (Some("billing"), 2, 1, 1),
                (None, 1, 0, 0),
                (Some("audit"), 1, 0, 0),
            ]
        );
        let billing = &health.topics[0];
        assert_eq!(billing.done_over_time, [2, 0, 0, 0]);
        assert_eq!(billing.failed_over_time, [0, 0, 1, 0]);
    }

    #[test]
    fn lines_without_a_status_or_topic_are_left_out() {
        let mut no_topic = status(1, "x", None, "COMPLETED");
        if let Some(s) = &mut no_topic.status {
            s.topic = None;
        }
        let mut no_status = status(1, "x", None, "COMPLETED");
        no_status.status = None;
        let health = route_health(
            &[no_topic, no_status],
            Timestamp(datetime!(2026-10-30 12:00 UTC)),
            Timestamp(datetime!(2026-10-30 12:15 UTC)),
            10,
        );
        assert!(health.topics.is_empty());
    }
}
