//! Local preferences (last profile, region overrides, favorites, recent services).

use contrail_core::ecs::ServiceRef;
use contrail_core::prefs::{Prefs, ServiceKey, Settings};
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

/// Replaces the app settings (the settings dialog sends all of them).
#[tauri::command]
#[specta::specta]
pub fn set_settings(state: State<'_, AppState>, settings: Settings) -> ApiResult<Prefs> {
    Ok(state.prefs.update(|p| p.settings = settings)?)
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

/// Adds a "hide noise" text for a service.
#[tauri::command]
#[specta::specta]
pub fn add_noise(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
    text: String,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| p.add_noise(&key, &text))?)
}

/// Removes a "hide noise" text of a service.
#[tauri::command]
#[specta::specta]
pub fn remove_noise(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
    text: String,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| p.remove_noise(&key, &text))?)
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
