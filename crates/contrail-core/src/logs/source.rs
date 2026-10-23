//! The log source port: fetching raw events from CloudWatch Logs (or the demo fake).

use std::pin::Pin;

use async_trait::async_trait;
use futures::Stream;
use serde::Serialize;
use specta::Type;

use crate::auth::AwsCtx;
use crate::error::SourceError;
use crate::timestamp::Timestamp;

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
}

/// A time range, start inclusive, end exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeRange {
    pub start: Timestamp,
    pub end: Timestamp,
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
