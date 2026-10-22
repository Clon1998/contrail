//! Profiles, SSO sessions and logins.

use contrail_core::auth::{AwsCtx, CallerIdentity, LoginProgress};
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

/// Runs `aws sso login` for `profile`. Output lines arrive on `on_progress` while it runs; the
/// command returns when the login has finished.
///
/// A Tauri `Channel` is a typed, ordered stream from Rust to the one frontend call that created
/// it, cheaper than global events. The log views will stream batches the same way.
#[tauri::command]
#[specta::specta]
pub async fn sso_login(
    state: State<'_, AppState>,
    profile: String,
    on_progress: Channel<LoginProgress>,
) -> ApiResult<()> {
    let forward = |progress: LoginProgress| {
        if let Err(err) = on_progress.send(progress) {
            tracing::warn!(%err, "could not send login progress");
        }
    };
    state.auth.login(&profile, &forward).await?;
    Ok(())
}
