//! The log source port: fetching raw events from CloudWatch Logs (or the demo fake).

use std::pin::Pin;

use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth::AwsCtx;
use crate::error::SourceError;
use crate::timestamp::Timestamp;
use time::{Duration, OffsetDateTime};

use super::RawEvent;

/// Which streams of which log group to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelection {
    pub log_group: String,
    /// The log group's region if it differs from the service's (`awslogs-region`).
    pub region: Option<String>,
    /// The account of the log group (needed for its ARN, which Live Tail requires).
    pub account_id: Option<String>,
    pub streams: Vec<String>,
    /// For a whole service: the prefix all its task streams share (`<prefix>/<container>/`).
    /// Live tail and polling use it instead of `streams`, so tasks started later (deployments,
    /// restarts) are picked up automatically. `None` for a single task.
    pub stream_prefix: Option<String>,
    /// Only events containing this text (a CloudWatch filter pattern for a quoted phrase), e.g. a
    /// correlation ID when tracing a document; `None` reads everything.
    pub filter_pattern: Option<String>,
}

/// A time range, start inclusive, end exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeRange {
    pub start: Timestamp,
    pub end: Timestamp,
}

/// The time window a log view is opened for, as the UI picks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TimeWindow {
    /// The last `minutes` until now (presets and custom "last 2 days").
    Last { minutes: u32 },
    /// A fixed range in the past (custom from–to).
    Range { from: Timestamp, to: Timestamp },
}

/// A time window that can't be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidWindow {
    #[error("the time window is empty")]
    Empty,
    #[error("the time window starts in the future")]
    InFuture,
}

impl TimeWindow {
    /// The range to backfill at `now`. A range ending in the future ends at `now`.
    pub fn range(self, now: OffsetDateTime) -> Result<TimeRange, InvalidWindow> {
        let (start, end) = match self {
            TimeWindow::Last { minutes: 0 } => return Err(InvalidWindow::Empty),
            TimeWindow::Last { minutes } => (now - Duration::minutes(i64::from(minutes)), now),
            TimeWindow::Range { from, to } => (from.0, to.0.min(now)),
        };
        if start >= now {
            return Err(InvalidWindow::InFuture);
        }
        if start >= end {
            return Err(InvalidWindow::Empty);
        }
        Ok(TimeRange {
            start: Timestamp(start),
            end: Timestamp(end),
        })
    }
}

/// An event found by a Logs Insights query, and the log group it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEvent {
    pub log_group: String,
    pub event: RawEvent,
}

/// The result of a backfill.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Backfill {
    /// Oldest first.
    pub events: Vec<RawEvent>,
    /// The limit was reached before the end of the range: newer events are missing.
    pub truncated: bool,
}

/// What a live tail delivers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveItem {
    /// The session is established.
    Started,
    /// New events (may be empty: a heartbeat).
    Events {
        events: Vec<RawEvent>,
        /// CloudWatch sampled this update (more than 500 events per second).
        sampled: bool,
    },
}

/// Why a live tail stopped or couldn't start.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LiveError {
    /// Live tail can't be used here (no permission, too many sessions, unsupported): poll instead.
    #[error("live tail unavailable: {0}")]
    Unavailable(String),
    /// The session ended (CloudWatch closes sessions after 3 hours): reconnect.
    #[error("live tail session ended: {0}")]
    SessionEnded(String),
    #[error(transparent)]
    Source(#[from] SourceError),
}

/// A running live tail: a stream of items that ends when the session ends.
///
/// `Pin<Box<dyn Stream …>>` is a heap-allocated stream of some concrete type the caller doesn't
/// need to know (each source has its own); `Pin` is required to poll async streams safely.
pub type LiveStream = Pin<Box<dyn Stream<Item = Result<LiveItem, LiveError>> + Send>>;

/// Where log events come from. Read-only.
#[async_trait]
pub trait LogSource: Send + Sync {
    /// The events of `selection` in `range`, oldest first, at most `limit`.
    async fn backfill(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
        range: TimeRange,
        limit: usize,
    ) -> Result<Backfill, SourceError>;

    /// Logs Insights: the events of `log_groups` (in `region`, `None` = the profile's) whose
    /// message contains `text`, oldest first, at most `limit`. One query for many log groups (at
    /// most 50), billed per GB scanned. The default says it isn't available.
    async fn insights_find(
        &self,
        _ctx: &AwsCtx,
        _region: Option<String>,
        _log_groups: &[String],
        _text: &str,
        _range: TimeRange,
        _limit: usize,
    ) -> Result<Vec<GroupEvent>, SourceError> {
        Err(SourceError::Aws(
            "Logs Insights isn't available here".to_owned(),
        ))
    }

    /// Starts a live tail of `selection` (its `stream_prefix` if set, else its `streams`).
    ///
    /// The default says "unavailable", so a source without live support falls back to polling.
    async fn live(
        &self,
        _ctx: &AwsCtx,
        _selection: &StreamSelection,
    ) -> Result<LiveStream, LiveError> {
        Err(LiveError::Unavailable(
            "not supported by this source".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    const NOW: OffsetDateTime = datetime!(2026-10-23 12:00 UTC);

    fn ts(value: OffsetDateTime) -> Timestamp {
        Timestamp(value)
    }

    #[test]
    fn last_minutes_end_now() {
        let range = TimeWindow::Last { minutes: 90 }.range(NOW).unwrap();
        assert_eq!(range.start, ts(datetime!(2026-10-23 10:30 UTC)));
        assert_eq!(range.end, ts(NOW));
        assert_eq!(
            TimeWindow::Last { minutes: 0 }.range(NOW),
            Err(InvalidWindow::Empty)
        );
    }

    #[test]
    fn ranges_are_clamped_to_now_and_must_not_be_empty() {
        let window = |from, to| TimeWindow::Range {
            from: ts(from),
            to: ts(to),
        };
        let past = window(
            datetime!(2026-10-22 08:00 UTC),
            datetime!(2026-10-22 09:00 UTC),
        );
        assert_eq!(
            past.range(NOW).unwrap().end,
            ts(datetime!(2026-10-22 09:00 UTC))
        );

        let open_ended = window(
            datetime!(2026-10-23 11:00 UTC),
            datetime!(2026-10-24 00:00 UTC),
        );
        assert_eq!(open_ended.range(NOW).unwrap().end, ts(NOW));

        let reversed = window(
            datetime!(2026-10-22 09:00 UTC),
            datetime!(2026-10-22 08:00 UTC),
        );
        assert_eq!(reversed.range(NOW), Err(InvalidWindow::Empty));
        let future = window(
            datetime!(2026-10-24 09:00 UTC),
            datetime!(2026-10-24 10:00 UTC),
        );
        assert_eq!(future.range(NOW), Err(InvalidWindow::InFuture));
    }

    #[test]
    fn deserializes_from_the_ui() {
        let window: TimeWindow = serde_json::from_str(
            r#"{"kind":"range","from":"2026-10-22T08:00:00Z","to":"2026-10-22T09:00:00Z"}"#,
        )
        .unwrap();
        assert!(matches!(window, TimeWindow::Range { .. }));
        let window: TimeWindow = serde_json::from_str(r#"{"kind":"last","minutes":15}"#).unwrap();
        assert_eq!(window, TimeWindow::Last { minutes: 15 });
    }
}
