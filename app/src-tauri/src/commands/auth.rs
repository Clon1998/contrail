//! Profiles, SSO sessions and logins.

use contrail_core::auth::{AwsCtx, CallerIdentity, LoginMethod, LoginProgress};
use contrail_core::profile::Profile;
use contrail_core::sso::SessionStatus;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::ApiResult;
use crate::state::AppState;

/// All profiles of the AWS config, `default` first.
#[tauri::command]
#[specta::specta]
pub async fn list_profiles(state: State<'_, AppState>) -> ApiResult<Vec<Profile>> {
    Ok(state.auth.list_profiles().await?)
}

/// The SSO session state of one profile (from the local token cache; no AWS call).
#[tauri::command]
#[specta::specta]
pub async fn session_status(
    state: State<'_, AppState>,
    profile: String,
) -> ApiResult<SessionStatus> {
    Ok(state.auth.session_status(&profile).await?)
}

/// Checks the credentials with `sts:GetCallerIdentity` ("connected as …").
#[tauri::command]
#[specta::specta]
pub async fn caller_identity(state: State<'_, AppState>, ctx: AwsCtx) -> ApiResult<CallerIdentity> {
    Ok(state.auth.caller_identity(&ctx).await?)
}

/// Logs in to `profile`'s SSO session: `aws sso login`, or Contrail's own login when the CLI is
/// missing or the setting asks for it. Progress (the CLI's output lines, or the page and code of
/// the built-in login, whose page is opened in the browser) arrives on `on_progress`; the command
/// returns when the login has finished.
///
/// A Tauri `Channel` is a typed, ordered stream from Rust to the one frontend call that created
/// it, cheaper than global events. The log views will stream batches the same way.
#[tauri::command]
#[specta::specta]
pub async fn sso_login(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile: String,
    on_progress: Channel<LoginProgress>,
) -> ApiResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let demo = state.demo;
    let forward = |progress: LoginProgress| {
        // The demo's page doesn't exist: show it, don't open it.
        if let (LoginProgress::Device { url, .. }, false) = (&progress, demo)
            && let Err(err) = app.opener().open_url(url, None::<&str>)
        {
            tracing::warn!(%err, "could not open the SSO login page");
        }
        if let Err(err) = on_progress.send(progress) {
            tracing::warn!(%err, "could not send login progress");
        }
    };
    let method = if state.prefs.get().settings.builtin_login {
        LoginMethod::BuiltIn
    } else {
        LoginMethod::Auto
    };
    state.auth.login(&profile, method, &forward).await?;
    Ok(())
}
