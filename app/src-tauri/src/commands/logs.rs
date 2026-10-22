//! Log views: open (backfill into a buffer), read windows of rows, close.

use std::sync::atomic::Ordering;

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::ServiceRef;
use contrail_core::logs::buffer::DEFAULT_CAPACITY;
use contrail_core::logs::{
    BufferStats, LogBuffer, LogEvent, LogLocation, TimeRange, process, resolve_log_location,
};
use contrail_core::timestamp::Timestamp;
use serde::Serialize;
use specta::Type;
use tauri::State;
use time::{Duration, OffsetDateTime};

use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::state::{AppState, LogView};

/// What the UI needs to know about an opened log view.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogViewInfo {
    pub view_id: u32,
    pub location: LogLocation,
    /// How many task streams were read (running and recently stopped tasks).
    pub streams: u32,
    pub stats: BufferStats,
    /// The backfill hit the buffer size before reaching the newest events.
    pub truncated: bool,
    pub from: Timestamp,
    pub to: Timestamp,
}

/// Opens a service's logs: backfills the last `minutes` of all its tasks into a new view.
#[tauri::command]
#[specta::specta]
pub async fn open_service_logs(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
    minutes: u32,
) -> ApiResult<LogViewInfo> {
    let detail = state.ecs.describe_service(&ctx, &service).await?;
    let task_definition = detail.task_definition.ok_or_else(|| {
        ApiError::new(
            ErrorCode::LogsUnavailable,
            "the service's task definition could not be read",
        )
    })?;
    let location = resolve_log_location(&task_definition)?;
    let tasks = state.ecs.list_tasks(&ctx, &service, true).await?;
    let selection = location.selection(&tasks);

    let now = OffsetDateTime::now_utc();
    let range = TimeRange {
        start: Timestamp(now - Duration::minutes(i64::from(minutes))),
        end: Timestamp(now),
    };
    let backfill = state
        .logs
        .backfill(&ctx, &selection, range, DEFAULT_CAPACITY)
        .await?;

    let mut buffer = LogBuffer::new(DEFAULT_CAPACITY);
    buffer.insert(process(backfill.events));
    let info = LogViewInfo {
        view_id: state.next_view_id.fetch_add(1, Ordering::Relaxed),
        location,
        streams: u32::try_from(selection.streams.len()).unwrap_or(u32::MAX),
        stats: buffer.stats(),
        truncated: backfill.truncated,
        from: range.start,
        to: range.end,
    };
    state
        .views
        .lock()
        .expect("views lock poisoned")
        .insert(info.view_id, LogView { buffer });
    Ok(info)
}

/// Up to `limit` events of a view from `offset` (oldest first).
#[tauri::command]
#[specta::specta]
pub fn get_log_rows(
    state: State<'_, AppState>,
    view_id: u32,
    offset: u32,
    limit: u32,
) -> ApiResult<Vec<LogEvent>> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| {
        ApiError::new(ErrorCode::NotFound, format!("log view {view_id} is closed"))
    })?;
    Ok(view.buffer.window(offset as usize, limit as usize))
}

/// Frees a view's buffer.
#[tauri::command]
#[specta::specta]
pub fn close_log_view(state: State<'_, AppState>, view_id: u32) {
    state
        .views
        .lock()
        .expect("views lock poisoned")
        .remove(&view_id);
}
