//! Local preferences (last profile, region overrides, favorites, recent services).

use contrail_core::ecs::ServiceRef;
use contrail_core::prefs::{Prefs, ServiceKey};
use tauri::State;

use crate::error::ApiResult;
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub fn get_prefs(state: State<'_, AppState>) -> Prefs {
    state.prefs.get()
}

#[tauri::command]
#[specta::specta]
pub fn set_last_profile(state: State<'_, AppState>, profile: String) -> ApiResult<Prefs> {
    Ok(state.prefs.update(|p| p.last_profile = Some(profile))?)
}

/// Sets (or with `None` clears) the region override of a profile.
#[tauri::command]
#[specta::specta]
pub fn set_region_override(
    state: State<'_, AppState>,
    profile: String,
    region: Option<String>,
) -> ApiResult<Prefs> {
    Ok(state
        .prefs
        .update(|p| p.set_region_override(&profile, region))?)
}

/// Pins or unpins a service of `profile`.
#[tauri::command]
#[specta::specta]
pub fn toggle_favorite(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| {
        p.toggle_favorite(key);
    })?)
}

/// Records that a service was opened (for "recent" in the palette).
#[tauri::command]
#[specta::specta]
pub fn add_recent(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| p.add_recent(key))?)
}
