//! In-app updates: thin glue around `tauri-plugin-updater` (the same approach as Frida).
//!
//! The plugin reads `latest.json` from the newest **published** GitHub release (only reachable
//! without a token once the repository is public), compares versions and verifies the download
//! with the update public key in `tauri.conf.json`. Contrail's own logic is small: check on start
//! at most once a day (a setting), never in development builds, and let the download be
//! cancelled. Release-side steps (signing key, secrets): `docs/releasing.md`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::state::AppState;

/// A newer version that can be installed (or, see `install_blocker`, only downloaded by hand).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release notes (Markdown), when the release has any.
    pub notes: Option<String>,
    /// When the release was published, RFC 3339.
    pub date: Option<String>,
    /// Why this copy can't update itself (no update key yet, a development build, not installed
    /// from an installer). `None`: "Install and restart" works.
    pub install_blocker: Option<String>,
}

/// Sent while an update downloads. `total` is `None` when the server doesn't say.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// Bytes. `u32` (up to 4 GB) because specta can't export `u64` to TypeScript numbers.
    pub downloaded: u32,
    pub total: Option<u32>,
}

/// Download progress is reported in steps of this many bytes, not for every chunk.
const PROGRESS_STEP: u64 = 256 * 1024;

/// Where the releases are, for "download it yourself" hints.
const RELEASES_URL: &str = "https://github.com/Clon1998/contrail/releases/latest";

/// Looks for a newer version. `manual` is "Check for updates" in the settings; otherwise this
/// is the check on start, which does nothing unless it's switched on and due (once a day) and
/// never runs in development builds. Returns `None` when Contrail is up to date (or the
/// automatic check was skipped).
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: bool,
) -> ApiResult<Option<UpdateInfo>> {
    if !manual {
        if cfg!(debug_assertions) || state.demo {
            return Ok(None);
        }
        let now = unix_now();
        if !state.prefs.get().update_check_due(now) {
            return Ok(None);
        }
        // Remember the attempt before asking, so being offline doesn't retry on every start.
        state.prefs.update(|p| p.last_update_check = Some(now))?;
    }

    let updater = app.updater().map_err(update_error)?;
    let found = match updater.check().await {
        Ok(found) => found,
        // The automatic check is quiet: being offline is no reason for an error.
        Err(err) if !manual => {
            tracing::info!(%err, "update check failed");
            return Ok(None);
        }
        Err(err) => return Err(update_error(err)),
    };
    let info = found.as_ref().map(|u| update_info(&app, u));
    if let Some(info) = &info {
        tracing::info!(version = %info.version, "update available");
    }
    *state.update.lock().expect("update lock poisoned") = found;
    Ok(info)
}

/// Downloads and installs the update found by the last [`check_for_update`], then restarts
/// Contrail. Progress arrives on `on_progress`; [`cancel_update`] stops the download. On
/// Windows the installer closes the app itself.
#[tauri::command]
#[specta::specta]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<UpdateProgress>,
) -> ApiResult<()> {
    let update = state
        .update
        .lock()
        .expect("update lock poisoned")
        .clone()
        .ok_or_else(|| {
            ApiError::new(ErrorCode::Update, "there is no update to install")
                .with_hint("Check for updates first.")
        })?;
    if let Some(blocker) = install_blocker(&app) {
        return Err(ApiError::new(ErrorCode::Update, blocker)
            .with_hint(format!("Download the new version from {RELEASES_URL}.")));
    }

    // A one-shot channel as the cancel signal: `cancel_update` sends, the download stops.
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    *state.update_cancel.lock().expect("update lock poisoned") = Some(cancel);
    let result = download(&update, &on_progress, cancelled).await;
    *state.update_cancel.lock().expect("update lock poisoned") = None;
    let bytes = result?;

    // Installing replaces the app on disk (blocking file work), so off the async runtime. The
    // signature is checked again inside `install` before anything is touched.
    let installing = update.clone();
    tokio::task::spawn_blocking(move || installing.install(bytes))
        .await
        .map_err(|e| ApiError::new(ErrorCode::Update, format!("the installer stopped: {e}")))?
        .map_err(update_error)?;
    tracing::info!(version = %update.version, "update installed, restarting");
    app.restart()
}

/// Stops a running update download. Installing (after the download) can't be stopped.
#[tauri::command]
#[specta::specta]
pub fn cancel_update(state: State<'_, AppState>) {
    if let Some(cancel) = state
        .update_cancel
        .lock()
        .expect("update lock poisoned")
        .take()
    {
        // The receiver may already be gone (the download just finished): nothing to stop then.
        let _ = cancel.send(());
    }
}

/// Downloads the update, reporting progress. `tokio::select!` waits for whichever finishes
/// first: the download or the cancel signal. When the signal wins, the download future is simply
/// dropped, which stops it (Rust futures do nothing unless they are polled).
async fn download(
    update: &Update,
    on_progress: &Channel<UpdateProgress>,
    cancelled: tokio::sync::oneshot::Receiver<()>,
) -> ApiResult<Vec<u8>> {
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let on_chunk = |chunk: usize, total: Option<u64>| {
        downloaded += chunk as u64;
        if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
            reported = downloaded;
            let progress = UpdateProgress {
                downloaded: clamp_u32(downloaded),
                total: total.map(clamp_u32),
            };
            if let Err(err) = on_progress.send(progress) {
                tracing::debug!(%err, "update progress not delivered");
            }
        }
    };
    tokio::select! {
        result = update.download(on_chunk, || {}) => result.map_err(update_error),
        _ = cancelled => Err(ApiError::new(ErrorCode::Cancelled, "the download was cancelled")),
    }
}

fn update_info(app: &AppHandle, update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
        date: update.date.and_then(|d| {
            d.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
        install_blocker: install_blocker(app),
    }
}

/// Why this copy can't replace itself, if it can't. Without the update public key nothing could
/// be verified; the updater also needs to know which installer it came from (Tauri records that
/// in bundled builds only).
fn install_blocker(app: &AppHandle) -> Option<String> {
    if !has_update_key(app) {
        return Some("this build has no update key, so updates can't be verified".into());
    }
    if cfg!(debug_assertions) {
        return Some("this is a development build, which can't update itself".into());
    }
    if tauri::utils::platform::bundle_type().is_none() {
        return Some("this copy of Contrail wasn't installed from an installer".into());
    }
    None
}

/// Whether `plugins.updater.pubkey` in `tauri.conf.json` is filled in.
fn has_update_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Turns a plugin error into a message the user can act on.
fn update_error(err: tauri_plugin_updater::Error) -> ApiError {
    use tauri_plugin_updater::Error as E;
    let message = format!("update failed: {err}");
    let hint = match &err {
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => {
            "Check your internet connection and try again later."
        }
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            "The download's signature didn't match, so nothing was installed. Try again later, or download the new version from GitHub."
        }
        E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            "There is no update for this platform yet. Download the new version from GitHub."
        }
        _ => "Download the new version from GitHub instead.",
    };
    tracing::warn!(%err, "update failed");
    ApiError::new(ErrorCode::Update, message).with_hint(hint)
}

fn unix_now() -> u32 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    clamp_u32(secs)
}

fn clamp_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
