//! Log views: open (backfill into a buffer), read windows of rows, close.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::ServiceRef;
use contrail_core::logs::{
    BufferStats, ExportFormat, FilterMode, Level, LogBuffer, LogEvent, LogLocation, TimeRange,
    ViewFilter, process, resolve_log_location, write_events,
};
use contrail_core::query::{MatchOptions, QueryError, parse_query};
use contrail_core::timestamp::Timestamp;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri::ipc::Channel;
use time::{Duration, OffsetDateTime};

use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::live::{self, Control, LiveTask, LiveUpdate};
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
    let capacity = state.prefs.get().settings.buffer_capacity();
    let backfill = state
        .logs
        .backfill(&ctx, &selection, range, capacity)
        .await?;

    let mut buffer = LogBuffer::new(capacity);
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
    state.views.lock().expect("views lock poisoned").insert(
        info.view_id,
        LogView::new(buffer, ctx, selection, range.end),
    );
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
    Ok(view.window(offset as usize, limit as usize))
}

/// A search as the UI sends it.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub query: String,
    pub mode: FilterMode,
    /// Levels switched off with the level chips.
    pub hidden_levels: Vec<Level>,
    /// Search the whole raw line, not just the message.
    pub search_raw: bool,
    /// The service's "hide noise" texts, when hiding noise is on.
    pub noise: Vec<String>,
}

/// The outcome of setting a search.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FilterResult {
    Applied {
        /// Rows the list shows now.
        visible: u32,
        /// Matching events (`None` without a search).
        matches: Option<u32>,
        /// Words to highlight in messages.
        highlight_terms: Vec<String>,
    },
    /// The query can't be parsed; the previous search stays in effect.
    Invalid { error: QueryError },
}

/// Sets the search of a view (or clears it with an empty spec).
#[tauri::command]
#[specta::specta]
pub fn set_log_filter(
    state: State<'_, AppState>,
    view_id: u32,
    spec: FilterSpec,
) -> ApiResult<FilterResult> {
    apply_filter(&state, view_id, spec)
}

fn apply_filter(state: &AppState, view_id: u32, spec: FilterSpec) -> ApiResult<FilterResult> {
    let query = match parse_query(&spec.query) {
        Ok(query) => query,
        Err(error) => return Ok(FilterResult::Invalid { error }),
    };
    let highlight_terms = query.highlight_terms();
    let filter = ViewFilter::new(
        query,
        MatchOptions {
            raw: spec.search_raw,
        },
        spec.hidden_levels,
        &spec.noise,
        spec.mode,
    );
    let mut views = state.views.lock().expect("views lock poisoned");
    let view = views.get_mut(&view_id).ok_or_else(|| closed(view_id))?;
    view.set_filter(Some(filter));
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(FilterResult::Applied {
        visible: count(view.visible_len()),
        matches: view.match_count().map(count),
        highlight_terms,
    })
}

/// The listed rows that match the search (for stepping through matches in highlight mode).
#[tauri::command]
#[specta::specta]
pub fn get_match_positions(state: State<'_, AppState>, view_id: u32) -> ApiResult<Vec<u32>> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    let positions = match &view.filter {
        Some(filter) if filter.mode == FilterMode::Highlight => filter.matched().to_vec(),
        // When filtering, every listed row matches.
        Some(filter) => (0..filter.match_count()).collect(),
        None => Vec::new(),
    };
    Ok(positions
        .into_iter()
        .map(|i| u32::try_from(i).unwrap_or(u32::MAX))
        .collect())
}

/// Frees a view's buffer and stops its live tail.
#[tauri::command]
#[specta::specta]
pub fn close_log_view(state: State<'_, AppState>, view_id: u32) {
    // Removing the view drops its `LiveHandle`, which stops the task.
    state
        .views
        .lock()
        .expect("views lock poisoned")
        .remove(&view_id);
}

/// Writes the rows a view lists (all events, or the matches when filtering) to `path`, which
/// the user picked in a save dialog. Returns how many events were written.
#[tauri::command]
#[specta::specta]
pub async fn export_log_view(
    state: State<'_, AppState>,
    view_id: u32,
    path: String,
    format: ExportFormat,
) -> ApiResult<u32> {
    export_view(&state, view_id, path.into(), format).await
}

pub(crate) async fn export_view(
    state: &AppState,
    view_id: u32,
    path: std::path::PathBuf,
    format: ExportFormat,
) -> ApiResult<u32> {
    // Copy the rows out while holding the lock only briefly; the live tail keeps inserting.
    let rows = {
        let views = state.views.lock().expect("views lock poisoned");
        let view = views.get(&view_id).ok_or_else(|| {
            ApiError::new(ErrorCode::NotFound, format!("log view {view_id} is closed"))
        })?;
        view.window(0, view.visible_len())
    };
    // File I/O blocks: run it on tokio's blocking pool, not on an async worker thread.
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        let file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        write_events(&rows, format, file)
    })
    .await
    .map_err(|e| ApiError::new(ErrorCode::Io, e.to_string()))??;
    Ok(u32::try_from(written).unwrap_or(u32::MAX))
}

/// Starts following a view live (after its backfill). Updates arrive on `on_update`.
///
/// Async so it runs on Tauri's tokio runtime, where the live task is spawned.
#[tauri::command]
#[specta::specta]
pub async fn start_live(
    state: State<'_, AppState>,
    view_id: u32,
    on_update: Channel<LiveUpdate>,
) -> ApiResult<()> {
    let mut views = state.views.lock().expect("views lock poisoned");
    let view = views.get_mut(&view_id).ok_or_else(|| closed(view_id))?;
    let task = LiveTask {
        source: state.logs.clone(),
        ctx: view.ctx.clone(),
        selection: view.selection.clone(),
        views: state.views.clone(),
        view_id,
        last_seen: view.backfilled_until,
        sink: Arc::new(move |update| {
            if let Err(err) = on_update.send(update) {
                tracing::debug!(%err, "live update not delivered (view closed in the UI?)");
            }
        }),
    };
    // Replacing a running tail drops (and stops) the old one.
    view.live = Some(live::spawn(task));
    Ok(())
}

/// Pauses a view's live tail (the UI's pause button, or auto-pause when hidden).
#[tauri::command]
#[specta::specta]
pub fn pause_live(state: State<'_, AppState>, view_id: u32) -> ApiResult<()> {
    set_live(&state, view_id, Control::Pause)
}

/// Resumes a paused live tail; it first catches up on what was logged meanwhile.
#[tauri::command]
#[specta::specta]
pub fn resume_live(state: State<'_, AppState>, view_id: u32) -> ApiResult<()> {
    set_live(&state, view_id, Control::Run)
}

fn set_live(state: &AppState, view_id: u32, control: Control) -> ApiResult<()> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    if let Some(live) = &view.live {
        live.set(control);
    }
    Ok(())
}

fn closed(view_id: u32) -> ApiError {
    ApiError::new(ErrorCode::NotFound, format!("log view {view_id} is closed"))
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
    async fn exports_the_listed_rows() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");
        let info = open_logs(&state, ctx, service, 15, None).await.unwrap();
        let spec = FilterSpec {
            query: "level:ERROR".into(),
            mode: FilterMode::Filter,
            hidden_levels: vec![],
            search_raw: false,
            noise: vec![],
        };
        apply_filter(&state, info.view_id, spec).unwrap();

        let path = std::env::temp_dir().join(format!("contrail-export-{}.jsonl", info.view_id));
        let written = export_view(&state, info.view_id, path.clone(), ExportFormat::Jsonl)
            .await
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();

        assert!(written > 0);
        assert_eq!(text.lines().count(), written as usize);
        assert!(text.lines().all(|l| l.contains(r#""level":"ERROR""#)));
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

    #[tokio::test]
    async fn a_demo_view_goes_live_and_grows() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "event-ingest");
        let info = open_logs(&state, ctx, service, 1, None).await.unwrap();

        let updates: Arc<std::sync::Mutex<Vec<LiveUpdate>>> = Arc::default();
        let recorder = updates.clone();
        let task = {
            let views = state.views.lock().unwrap();
            let view = &views[&info.view_id];
            LiveTask {
                source: state.logs.clone(),
                ctx: view.ctx.clone(),
                selection: view.selection.clone(),
                views: state.views.clone(),
                view_id: info.view_id,
                last_seen: view.backfilled_until,
                sink: Arc::new(move |u| recorder.lock().unwrap().push(u)),
            }
        };
        let _handle = live::spawn(task);

        // The demo source delivers once a second; event-ingest logs every 200 ms per task.
        tokio::time::sleep(std::time::Duration::from_millis(2_300)).await;
        let updates = updates.lock().unwrap();
        assert!(updates.iter().any(|u| u.state == live::LiveState::Live));
        let last = updates.last().unwrap();
        assert!(
            last.stats.total > info.stats.total,
            "the view grew while live"
        );
    }

    fn spec(query: &str) -> FilterSpec {
        FilterSpec {
            query: query.into(),
            mode: FilterMode::Filter,
            hidden_levels: Vec::new(),
            search_raw: false,
            noise: Vec::new(),
        }
    }

    #[tokio::test]
    async fn filtering_a_view_lists_only_matches() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "payments-worker");
        let info = open_logs(&state, ctx, service, 15, None).await.unwrap();

        let FilterResult::Applied {
            visible, matches, ..
        } = apply_filter(&state, info.view_id, spec("level:ERROR")).unwrap()
        else {
            panic!("query should parse");
        };
        assert_eq!(Some(visible), matches);
        assert!(visible > 0 && visible < info.stats.total);
        {
            let views = state.views.lock().unwrap();
            let rows = views[&info.view_id].window(0, usize::MAX);
            assert!(rows.iter().all(|e| e.line.level == Some(Level::Error)));
        }

        // An invalid query keeps the previous search and says where the problem is.
        let FilterResult::Invalid { error } =
            apply_filter(&state, info.view_id, spec("level:LOUD")).unwrap()
        else {
            panic!("query should be invalid");
        };
        assert_eq!(error.start, 6);
        let views = state.views.lock().unwrap();
        assert_eq!(views[&info.view_id].visible_len() as u32, visible);
    }
}
