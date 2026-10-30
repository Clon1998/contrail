//! Log views: open (backfill into a buffer), read windows of rows, close.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::ServiceRef;
use contrail_core::logs::health::RouteHealth;
use contrail_core::logs::timeline::Timeline;
use contrail_core::logs::{
    BufferStats, ExportFormat, FieldSummary, FilterMode, Level, LineContext, LogBuffer, LogEvent,
    LogLocation, TimeRange, TimeWindow, ViewFilter, backfill_newest, process, resolve_log_location,
    write_events,
};
use contrail_core::prefs::ServiceKey;
use contrail_core::query::{MatchOptions, QueryError, parse_query, parse_regex_query};
use contrail_core::timestamp::Timestamp;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri::ipc::Channel;
use time::OffsetDateTime;

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
    /// A slice held more events than the buffer has room for: some are missing.
    pub truncated: bool,
    /// The view's time window.
    pub from: Timestamp,
    pub to: Timestamp,
    /// How far back events are loaded so far (newest first; `load_older` goes further back).
    pub loaded_from: Timestamp,
    /// The whole window is loaded.
    pub complete: bool,
}

/// How many events opening a view reads before it is shown (the newest, about a screenful):
/// the UI then loads older ones in the background up to its usual first amount, and more when
/// scrolled up.
const FIRST_EVENTS: usize = 200;
/// How many older events one `load_older` adds (at least, unless the window ends first).
const OLDER_EVENTS: usize = 5_000;
/// Listed rows on each side of the old first row that `load_older` returns along.
const BOUNDARY_ROWS: usize = 300;

/// Opens a service's logs: backfills the time `window` into a new view. Without `task_id` the
/// view merges all tasks of the service (running and recently stopped); with it, only that
/// task's stream (the task view).
#[tauri::command]
#[specta::specta]
pub async fn open_service_logs(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
    window: TimeWindow,
    task_id: Option<String>,
) -> ApiResult<LogViewInfo> {
    // `State` derefs to `&AppState`; the logic lives in a plain function so tests can call it.
    open_logs(&state, ctx, service, window, task_id).await
}

async fn open_logs(
    state: &AppState,
    ctx: AwsCtx,
    service: ServiceRef,
    window: TimeWindow,
    task_id: Option<String>,
) -> ApiResult<LogViewInfo> {
    // Check the window before calling AWS.
    let range = window.range(OffsetDateTime::now_utc())?;
    // Both calls at once: `try_join!` polls the two futures together and returns when both are
    // done, or with the first error (like `CompletableFuture.allOf` in Java, failing fast).
    let (detail, mut tasks) = tokio::try_join!(
        state.ecs.describe_service(&ctx, &service),
        state.ecs.list_tasks(&ctx, &service, true),
    )?;
    let task_definition = detail.task_definition.ok_or_else(|| {
        ApiError::new(
            ErrorCode::LogsUnavailable,
            "the service's task definition could not be read",
        )
    })?;
    let location = resolve_log_location(&task_definition)?;
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

    let prefs = state.prefs.get();
    let capacity = prefs.settings.buffer_capacity();
    let mapping = prefs.field_mapping(&ServiceKey::new(&ctx.profile, &service));
    // `&*state.logs`: from `Arc<dyn LogSource>` to the `&dyn LogSource` the function takes.
    let backfill = backfill_newest(
        &*state.logs,
        &ctx,
        &selection,
        range.end,
        range.start,
        FIRST_EVENTS,
        capacity,
    )
    .await?;

    let mut events = process(backfill.events);
    if !mapping.is_empty() {
        events.iter_mut().for_each(|e| mapping.apply(e));
    }
    let mut buffer = LogBuffer::new(capacity);
    buffer.insert(events);
    let info = LogViewInfo {
        view_id: state.next_view_id.fetch_add(1, Ordering::Relaxed),
        location,
        streams: u32::try_from(selection.streams.len()).unwrap_or(u32::MAX),
        stats: buffer.stats(),
        truncated: backfill.truncated,
        from: range.start,
        to: range.end,
        loaded_from: backfill.from,
        complete: backfill.complete,
    };
    state.views.lock().expect("views lock poisoned").insert(
        info.view_id,
        LogView::new(buffer, ctx, selection, range.end)
            .with_mapping(mapping)
            .with_loaded(range.start, backfill.from),
    );
    Ok(info)
}

/// What `load_older` added to a view.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OlderEvents {
    /// Listed rows added in front of the previous first row (every listed index moved by this).
    pub added: u32,
    pub visible: u32,
    pub matches: Option<u32>,
    pub stats: BufferStats,
    pub loaded_from: Timestamp,
    pub complete: bool,
    /// The buffer is full: no older events can be added.
    pub full: bool,
    /// The listed rows from `rows_from` on, around the previous first row, so the rows on screen
    /// don't have to be fetched again.
    pub rows_from: u32,
    pub rows: Vec<LogEvent>,
}

/// Loads the next older events of a view's window (newest first, in slices): at least
/// `at_least` of them (by default as many as one scroll to the top asks for), unless the window
/// starts first.
#[tauri::command]
#[specta::specta]
pub async fn load_older(
    state: State<'_, AppState>,
    view_id: u32,
    at_least: Option<u32>,
) -> ApiResult<OlderEvents> {
    let target = at_least.map_or(OLDER_EVENTS, |n| n as usize);
    load_older_events(&state, view_id, target).await
}

async fn load_older_events(
    state: &AppState,
    view_id: u32,
    target: usize,
) -> ApiResult<OlderEvents> {
    // Copy what the read needs and release the lock: it can't be held across an `.await`.
    let (ctx, selection, from, window_start, room) = {
        let views = state.views.lock().expect("views lock poisoned");
        let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
        let room = view.buffer.capacity().saturating_sub(view.buffer.len());
        (
            view.ctx.clone(),
            view.selection.clone(),
            view.loaded_from,
            view.window_start,
            room,
        )
    };
    let slices = if from > window_start && room > 0 {
        let slices = backfill_newest(
            &*state.logs,
            &ctx,
            &selection,
            from,
            window_start,
            target,
            room,
        )
        .await?;
        Some(slices)
    } else {
        None
    };

    let mut views = state.views.lock().expect("views lock poisoned");
    let view = views.get_mut(&view_id).ok_or_else(|| closed(view_id))?;
    let before = view.visible_len();
    // A second request for the same slices may have finished first: then these are already in.
    if let Some(slices) = slices
        && view.loaded_from == from
    {
        view.insert(process(slices.events));
        view.loaded_from = slices.from;
    }
    let visible = view.visible_len();
    let added = visible.saturating_sub(before);
    let rows_from = added.saturating_sub(BOUNDARY_ROWS);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(OlderEvents {
        added: count(added),
        visible: count(visible),
        matches: view.match_count().map(count),
        stats: view.buffer.stats(),
        loaded_from: view.loaded_from,
        complete: view.complete(),
        full: view.buffer.len() >= view.buffer.capacity(),
        rows_from: count(rows_from),
        rows: view.window(rows_from, added - rows_from + BOUNDARY_ROWS),
    })
}

/// How the documents of a view's service ended, per topic and consumer group, in at most about
/// `max_buckets` buckets over time.
#[tauri::command]
#[specta::specta]
pub fn route_health(
    state: State<'_, AppState>,
    view_id: u32,
    max_buckets: u32,
) -> ApiResult<RouteHealth> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    Ok(view.route_health(max_buckets))
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

/// The lines around event `seq` of a view in its own stream (task), ignoring the search: up to
/// `before` older and `after` newer ones.
#[tauri::command]
#[specta::specta]
pub fn log_context(
    state: State<'_, AppState>,
    view_id: u32,
    seq: u32,
    before: u32,
    after: u32,
) -> ApiResult<LineContext> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| {
        ApiError::new(ErrorCode::NotFound, format!("log view {view_id} is closed"))
    })?;
    view.buffer
        .around(seq, before as usize, after as usize)
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::NotFound,
                "This line is no longer loaded (older lines make room for new ones)",
            )
        })
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
    /// The query is one regular expression (the search box's regex mode), not query syntax.
    pub regex: bool,
    /// The service's "hide noise" texts, when hiding noise is on.
    pub noise: Vec<String>,
    /// Lists only the events in this part of the window (picked on the timeline); the loaded
    /// events stay, so clearing it is instant.
    pub focus: Option<TimeRange>,
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
        /// The rows of the requested windows in the new listing, so the list can switch to the
        /// new rows in one step (no placeholder rows while they would be fetched).
        rows: Vec<RowBlock>,
    },
    /// The query can't be parsed; the previous search stays in effect.
    Invalid { error: QueryError },
}

/// Listed rows the UI wants along with a new search: `limit` rows from `offset`, or the last
/// `limit` rows with `from_end` (the newest, where a following list stays).
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowWindow {
    pub offset: u32,
    pub limit: u32,
    pub from_end: bool,
}

/// Listed rows from `offset` on.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowBlock {
    pub offset: u32,
    pub rows: Vec<LogEvent>,
}

/// At most this many rows per requested window (a screen plus some margin is plenty).
const MAX_WINDOW_ROWS: u32 = 1_000;

/// Sets the search of a view (or clears it with an empty spec) and returns the rows of `windows`
/// in the new listing.
#[tauri::command]
#[specta::specta]
pub fn set_log_filter(
    state: State<'_, AppState>,
    view_id: u32,
    spec: FilterSpec,
    windows: Vec<RowWindow>,
) -> ApiResult<FilterResult> {
    apply_filter(&state, view_id, spec, &windows)
}

fn apply_filter(
    state: &AppState,
    view_id: u32,
    spec: FilterSpec,
    windows: &[RowWindow],
) -> ApiResult<FilterResult> {
    let parsed = if spec.regex {
        parse_regex_query(&spec.query)
    } else {
        parse_query(&spec.query)
    };
    let query = match parsed {
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
    view.focus = spec.focus;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let visible = view.visible_len();
    let rows = windows
        .iter()
        .map(|window| {
            let limit = window.limit.min(MAX_WINDOW_ROWS) as usize;
            let offset = if window.from_end {
                visible.saturating_sub(limit)
            } else {
                window.offset as usize
            };
            RowBlock {
                offset: count(offset),
                rows: view.window(offset, limit),
            }
        })
        .collect();
    Ok(FilterResult::Applied {
        visible: count(visible),
        matches: view.match_count().map(count),
        highlight_terms,
        rows,
    })
}

/// The listed rows that match the search (for stepping through matches in highlight mode).
#[tauri::command]
#[specta::specta]
pub fn get_match_positions(state: State<'_, AppState>, view_id: u32) -> ApiResult<Vec<u32>> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    Ok(view
        .match_positions()
        .into_iter()
        .map(|i| u32::try_from(i).unwrap_or(u32::MAX))
        .collect())
}

/// Which fields the events matching the view's search have, their most common values, and an
/// overview of the pipeline status events among them (for the Fields panel).
#[tauri::command]
#[specta::specta]
pub fn field_summary(state: State<'_, AppState>, view_id: u32) -> ApiResult<FieldSummary> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    Ok(view.field_summary())
}

/// The listed events of a view counted over time, by level, in at most about `max_buckets`
/// buckets aligned to the time zone `utc_offset_minutes` ahead of UTC (the timeline).
#[tauri::command]
#[specta::specta]
pub fn log_timeline(
    state: State<'_, AppState>,
    view_id: u32,
    max_buckets: u32,
    utc_offset_minutes: i32,
) -> ApiResult<Timeline> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| closed(view_id))?;
    Ok(view.timeline(max_buckets, utc_offset_minutes))
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
    paused: bool,
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
    let initial = if paused { Control::Pause } else { Control::Run };
    view.live = Some(live::spawn(task, initial));
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

    const LAST_15: TimeWindow = TimeWindow::Last { minutes: 15 };

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

        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();

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
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();
        let spec = FilterSpec {
            query: "level:ERROR".into(),
            mode: FilterMode::Filter,
            hidden_levels: vec![],
            search_raw: false,
            regex: false,
            noise: vec![],
            focus: None,
        };
        apply_filter(&state, info.view_id, spec, &[]).unwrap();

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
    async fn links_a_view_or_one_event_to_the_console() {
        use crate::commands::links::console_link_of;
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();

        let view = console_link_of(
            &state,
            info.view_id,
            "eu-central-1".into(),
            None,
            Some("timeout".into()),
        )
        .unwrap();
        assert!(view.starts_with("https://eu-central-1.console.aws.amazon.com/cloudwatch/home"));
        assert!(view.contains("log-group/$252Fecs$252Flegacy-gateway/log-events"));
        assert!(view.contains("filterPattern$3D$2522timeout$2522"));
        // A whole service: no stream filter.
        assert!(!view.contains("logStreamNameFilter"));

        let (seq, stream) = {
            let views = state.views.lock().unwrap();
            let event = views[&info.view_id].buffer.iter().next().unwrap();
            (event.seq, event.stream.clone())
        };
        let event =
            console_link_of(&state, info.view_id, "eu-central-1".into(), Some(seq), None).unwrap();
        assert!(event.contains(&format!(
            "logStreamNameFilter$3D{}",
            stream.replace('/', "$252F")
        )));
        assert!(
            console_link_of(
                &state,
                info.view_id,
                "eu-central-1".into(),
                Some(u32::MAX),
                None
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn the_timeline_counts_the_listed_events() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();
        let counted = |state: &AppState, mode| {
            let spec = FilterSpec {
                query: "level:ERROR".into(),
                mode,
                hidden_levels: vec![],
                search_raw: false,
                regex: false,
                noise: vec![],
                focus: None,
            };
            apply_filter(state, info.view_id, spec, &[]).unwrap();
            let timeline = state.views.lock().unwrap()[&info.view_id].timeline(60, 0);
            assert!(timeline.buckets.len() <= 61);
            timeline
                .buckets
                .iter()
                .map(|b| (b.total(), b.error))
                .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
        };
        // Filtering: only the matches, all of them errors.
        let (total, errors) = counted(&state, FilterMode::Filter);
        assert!(total > 0);
        assert_eq!(total, errors);
        // Highlighting lists every event, so the timeline counts them all.
        let (total, _) = counted(&state, FilterMode::Highlight);
        assert_eq!(total, info.stats.total);
    }

    #[tokio::test]
    async fn summarizes_the_fields_of_the_matching_events() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "orders-api");
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();
        let summary = |state: &AppState| state.views.lock().unwrap()[&info.view_id].field_summary();

        let all = summary(&state);
        assert_eq!(all.events, info.stats.total);
        assert!(all.fields.iter().any(|f| f.key == "log.logger"));
        let pipeline = all.pipeline.unwrap();
        assert!(pipeline.states.len() > 1);
        assert_eq!(pipeline.topics.len(), 2);

        // Drilling down: only the failed status events count now.
        let spec = FilterSpec {
            query: "state:FAILED".into(),
            mode: FilterMode::Highlight,
            hidden_levels: vec![],
            search_raw: false,
            regex: false,
            noise: vec![],
            focus: None,
        };
        apply_filter(&state, info.view_id, spec, &[]).unwrap();
        let failed = summary(&state);
        let pipeline = failed.pipeline.unwrap();
        assert_eq!(failed.events, pipeline.events);
        let states: Vec<&str> = pipeline.states.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(states, ["FAILED"]);
        assert!(!pipeline.failure_reasons.is_empty());
    }

    #[tokio::test]
    async fn expired_sessions_fail_with_a_credentials_error() {
        let state = AppState::demo();
        let (_, service) = demo_service("demo-core", "orders-api");
        let ctx = AwsCtx {
            profile: "demo-prod".into(),
            region: None,
        };
        let error = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap_err();
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
            LAST_15,
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

        let unknown = open_logs(&state, ctx, service, LAST_15, Some("gone".into()))
            .await
            .unwrap_err();
        assert_eq!(unknown.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn a_demo_view_goes_live_and_grows() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "event-ingest");
        let info = open_logs(&state, ctx, service, TimeWindow::Last { minutes: 1 }, None)
            .await
            .unwrap();

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
        let _handle = live::spawn(task, Control::Run);

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
            regex: false,
            noise: Vec::new(),
            focus: None,
        }
    }

    #[tokio::test]
    async fn a_route_services_view_counts_how_its_documents_ended() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-edge", "legacy-gateway");
        let info = open_logs(&state, ctx, service, TimeWindow::Last { minutes: 15 }, None)
            .await
            .unwrap();
        let views = state.views.lock().unwrap();
        let health = views[&info.view_id].route_health(30);
        assert!(
            !health.topics.is_empty(),
            "the demo service logs status events"
        );
        assert!(
            health.topics.iter().all(|t| t.consumer_group.is_some()),
            "an output service"
        );
        assert!(health.topics.iter().map(|t| t.done).sum::<u32>() > 0);
    }

    #[tokio::test]
    async fn opens_with_a_screenful_and_tops_up_by_as_many_as_asked() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "orders-api");
        let six_hours = TimeWindow::Last { minutes: 360 };
        let info = open_logs(&state, ctx, service, six_hours, None)
            .await
            .unwrap();
        // The first slices stop once a screenful is there (a slice is read whole, so a few more).
        assert!(info.stats.total as usize >= FIRST_EVENTS);
        assert!((info.stats.total as usize) < OLDER_EVENTS);

        let small = load_older_events(&state, info.view_id, 50).await.unwrap();
        let large = load_older_events(&state, info.view_id, OLDER_EVENTS)
            .await
            .unwrap();
        assert!(small.added > 0 && small.added < large.added);
    }

    #[tokio::test]
    async fn a_long_window_opens_with_the_newest_events_and_loads_older_ones() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "orders-api");
        let six_hours = TimeWindow::Last { minutes: 360 };
        let info = open_logs(&state, ctx, service, six_hours, None)
            .await
            .unwrap();
        assert!(!info.complete, "only the newest part of 6 hours is loaded");
        assert!(info.loaded_from > info.from);
        let mut total = info.stats.total;
        let mut loaded_from = info.loaded_from;
        for _ in 0..50 {
            let older = load_older_events(&state, info.view_id, OLDER_EVENTS)
                .await
                .unwrap();
            assert!(older.loaded_from <= loaded_from, "goes back in time");
            assert_eq!(older.stats.total, total + older.added);
            // The returned rows end right after the previous first row's neighbourhood.
            assert_eq!(
                older.rows.len() as u32 + older.rows_from,
                (older.added + 300).min(older.visible)
            );
            total = older.stats.total;
            loaded_from = older.loaded_from;
            if older.complete || older.full {
                break;
            }
        }
        let views = state.views.lock().unwrap();
        let view = &views[&info.view_id];
        assert!(view.complete());
        let rows = view.window(0, usize::MAX);
        assert_eq!(rows.len() as u32, total, "no duplicates");
        assert!(
            rows.windows(2)
                .all(|w| w[0].cw_timestamp <= w[1].cw_timestamp),
            "in order"
        );
        assert!(rows[0].cw_timestamp >= info.from);
    }

    #[tokio::test]
    async fn regex_mode_reads_the_query_as_one_expression() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "payments-worker");
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();
        let regex = |query: &str| FilterSpec {
            regex: true,
            ..spec(query)
        };

        // `level:ERROR` is query syntax; as a regex it is just text no message contains.
        let FilterResult::Applied { visible, .. } =
            apply_filter(&state, info.view_id, regex("level:ERROR"), &[]).unwrap()
        else {
            panic!("regex should compile");
        };
        assert_eq!(visible, 0);
        assert!(matches!(
            apply_filter(&state, info.view_id, regex("time(out"), &[]).unwrap(),
            FilterResult::Invalid { .. }
        ));
    }

    #[tokio::test]
    async fn filtering_a_view_lists_only_matches() {
        let state = AppState::demo();
        let (ctx, service) = demo_service("demo-core", "payments-worker");
        let info = open_logs(&state, ctx, service, LAST_15, None)
            .await
            .unwrap();

        let FilterResult::Applied {
            visible,
            matches,
            rows,
            ..
        } = apply_filter(
            &state,
            info.view_id,
            spec("level:ERROR"),
            &[
                RowWindow {
                    offset: 0,
                    limit: 2,
                    from_end: false,
                },
                RowWindow {
                    offset: 0,
                    limit: 1,
                    from_end: true,
                },
            ],
        )
        .unwrap()
        else {
            panic!("query should parse");
        };
        assert_eq!(Some(visible), matches);
        assert!(visible > 1 && visible < info.stats.total);
        // The requested windows of the new listing come along: the first two and the newest row.
        assert_eq!((rows[0].offset, rows[0].rows.len()), (0, 2));
        assert_eq!((rows[1].offset, rows[1].rows.len()), (visible - 1, 1));
        assert!(
            rows.iter()
                .flat_map(|b| &b.rows)
                .all(|e| e.line.level == Some(Level::Error))
        );
        {
            let views = state.views.lock().unwrap();
            let rows = views[&info.view_id].window(0, usize::MAX);
            assert!(rows.iter().all(|e| e.line.level == Some(Level::Error)));
        }

        // An invalid query keeps the previous search and says where the problem is.
        let FilterResult::Invalid { error } =
            apply_filter(&state, info.view_id, spec("level:LOUD"), &[]).unwrap()
        else {
            panic!("query should be invalid");
        };
        assert_eq!(error.start, 6);
        let views = state.views.lock().unwrap();
        assert_eq!(views[&info.view_id].visible_len() as u32, visible);
    }
}
