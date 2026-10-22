//! The log source port: fetching raw events from CloudWatch Logs (or the demo fake).

use async_trait::async_trait;
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
    pub streams: Vec<String>,
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
}
