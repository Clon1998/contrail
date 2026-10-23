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

/// Opens a service's logs: backfills the last `minutes` into a new view. Without `task_id` the
/// view merges all tasks of the service (running and recently stopped); with it, only that
/// task's stream (the task view).
#[tauri::command]
#[specta::specta]
pub async fn open_service_logs(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
    minutes: u32,
    task_id: Option<String>,
) -> ApiResult<LogViewInfo> {
    // `State` derefs to `&AppState`; the logic lives in a plain function so tests can call it.
    open_logs(&state, ctx, service, minutes, task_id).await
}

async fn open_logs(
    state: &AppState,
    ctx: AwsCtx,
    service: ServiceRef,
    minutes: u32,
    task_id: Option<String>,
) -> ApiResult<LogViewInfo> {
    let detail = state.ecs.describe_service(&ctx, &service).await?;
    let task_definition = detail.task_definition.ok_or_else(|| {
        ApiError::new(
            ErrorCode::LogsUnavailable,
            "the service's task definition could not be read",
        )
    })?;
    let location = resolve_log_location(&task_definition)?;
    let mut tasks = state.ecs.list_tasks(&ctx, &service, true).await?;
    if let Some(task_id) = &task_id {
        tasks.retain(|t| &t.id == task_id);
        if tasks.is_empty() {
            return Err(ApiError::new(
                ErrorCode::NotFound,
                format!("task {task_id} is no longer known to ECS"),
            )
            .with_hint("ECS forgets stopped tasks after about an hour."));
        }
    }
    // `arn:aws:ecs:<region>:<account>:cluster/<name>`: the account is needed for log group ARNs.
    let account_id = service.cluster_arn.split(':').nth(4).map(str::to_owned);
    let selection = location.selection(&tasks, account_id, task_id.is_none());

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

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_service(cluster: &str, name: &str) -> (AwsCtx, ServiceRef) {
        (
            AwsCtx {
                profile: "demo-dev".into(),
                region: None,
            },
            ServiceRef {
                cluster_arn: format!("arn:aws:ecs:eu-central-1:111122223333:cluster/{cluster}"),
                service_name: name.into(),
            },
        )
    }

    #[tokio::test]
    async fn opens_a_demo_service_and_keeps_its_events_in_a_view() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");

        let info = open_logs(&state, ctx, service, 15, None).await.unwrap();

        assert_eq!(info.location.log_group, "/ecs/legacy-gateway");
        assert_eq!(info.streams, 2);
        assert!(info.stats.total > 300, "2 tasks × 15 min / 5 s");
        let views = state.views.lock().unwrap();
        let rows = views[&info.view_id].buffer.window(0, usize::MAX);
        // Split stack traces arrive joined.
        assert!(rows.iter().any(|e| e.line.error.is_some()));
        assert!(rows.iter().all(|e| !e.line.message.starts_with("\tat ")));
    }

    #[tokio::test]
    async fn expired_sessions_fail_with_a_credentials_error() {
        let state = AppState::demo();
        let (_, service) = demo_service("demo-core", "orders-api");
        let ctx = AwsCtx {
            profile: "demo-prod".into(),
            region: None,
        };
        let error = open_logs(&state, ctx, service, 15, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Credentials);
    }

    #[tokio::test]
    async fn a_task_view_reads_only_that_task() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");
        let tasks = state.ecs.list_tasks(&ctx, &service, true).await.unwrap();
        let task_id = tasks[0].id.clone();

        let info = open_logs(
            &state,
            ctx.clone(),
            service.clone(),
            15,
            Some(task_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(info.streams, 1);
        {
            // A block limits the lock to these lines: a std mutex must not be held across the
            // `.await` below.
            let views = state.views.lock().unwrap();
            let rows = views[&info.view_id].buffer.window(0, usize::MAX);
            assert!(!rows.is_empty());
            assert!(rows.iter().all(|e| e.task_id == task_id));
        }

        let unknown = open_logs(&state, ctx, service, 15, Some("gone".into()))
            .await
            .unwrap_err();
        assert_eq!(unknown.code, ErrorCode::NotFound);
    }
}
