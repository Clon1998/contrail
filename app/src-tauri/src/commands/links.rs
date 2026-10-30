//! Shareable links: to a log view (`contrail://`) and to the same logs in the CloudWatch console.

use contrail_core::ecs::ServiceRef;
use contrail_core::links::{self, LinkError, ViewLink};
use contrail_core::timestamp::Timestamp;
use tauri::State;
use time::Duration;

use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::state::AppState;

impl From<LinkError> for ApiError {
    fn from(error: LinkError) -> Self {
        ApiError::new(ErrorCode::InvalidInput, error.to_string())
            .with_hint("Ask for the link again: it may have been cut off when it was pasted.")
    }
}

/// The `contrail://` link of a view.
#[tauri::command]
#[specta::specta]
pub fn view_link(link: ViewLink) -> String {
    links::to_url(&link)
}

/// Reads a `contrail://` link (one Contrail was opened with, or one pasted).
#[tauri::command]
#[specta::specta]
pub fn parse_view_link(url: String) -> ApiResult<ViewLink> {
    Ok(links::parse_url(&url)?)
}

/// How much time around one event its console link shows.
const AROUND_EVENT: Duration = Duration::minutes(1);

/// The same logs in the CloudWatch console: an open view's log group and time range (its one
/// stream when it shows one task), or one event (`event_seq`) with a minute around it. `region` is
/// the service's region; `filter` the text to search for there, if any.
/// A service's page in the ECS console (open it with [`open_console`]).
#[tauri::command]
#[specta::specta]
pub fn ecs_console_link(service: ServiceRef) -> String {
    links::ecs_console_url(&service.cluster_arn, &service.service_name)
}

#[tauri::command]
#[specta::specta]
pub fn console_link(
    state: State<'_, AppState>,
    view_id: u32,
    region: String,
    event_seq: Option<u32>,
    filter: Option<String>,
) -> ApiResult<String> {
    console_link_of(&state, view_id, region, event_seq, filter)
}

pub(crate) fn console_link_of(
    state: &AppState,
    view_id: u32,
    region: String,
    event_seq: Option<u32>,
    filter: Option<String>,
) -> ApiResult<String> {
    let views = state.views.lock().expect("views lock poisoned");
    let view = views.get(&view_id).ok_or_else(|| {
        ApiError::new(ErrorCode::NotFound, format!("log view {view_id} is closed"))
    })?;
    let selection = &view.selection;
    let region = selection.region.clone().unwrap_or(region);
    let url = match event_seq {
        Some(seq) => {
            let event = view.buffer.iter().find(|e| e.seq == seq).ok_or_else(|| {
                ApiError::new(ErrorCode::NotFound, "that event is no longer loaded")
            })?;
            links::console_url(
                &region,
                &selection.log_group,
                Some(&event.stream),
                Timestamp(event.timestamp.0 - AROUND_EVENT),
                Timestamp(event.timestamp.0 + AROUND_EVENT),
                None,
            )
        }
        None => {
            // One task: its stream. A whole service: all streams of the group.
            let stream = (selection.streams.len() == 1 && selection.stream_prefix.is_none())
                .then(|| selection.streams[0].as_str());
            links::console_url(
                &region,
                &selection.log_group,
                stream,
                view.window_start,
                view.backfilled_until,
                filter.as_deref(),
            )
        }
    };
    Ok(url)
}

/// Opens a page of the AWS console (a [`console_link`]) in the browser. Other addresses are
/// refused, so this can't be used to open arbitrary pages.
#[tauri::command]
#[specta::specta]
pub fn open_console(app: tauri::AppHandle, url: String) -> ApiResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !links::is_console_url(&url) {
        return Err(ApiError::new(
            ErrorCode::InvalidInput,
            "not an AWS console page",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| ApiError::new(ErrorCode::Io, format!("can't open the browser: {err}")))
}
