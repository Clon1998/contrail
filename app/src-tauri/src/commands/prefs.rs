//! Local preferences (last profile, region overrides, favorites, recent services).

use contrail_core::ecs::ServiceRef;
use contrail_core::logs::FieldMapping;
use contrail_core::prefs::{Prefs, SavedSearch, SearchEntry, ServiceKey, Settings, Transformer};
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

/// Sets a service's field mapping (an empty one removes it). Open views keep theirs until reopened.
#[tauri::command]
#[specta::specta]
pub fn set_field_mapping(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
    mapping: FieldMapping,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| p.set_field_mapping(&key, mapping))?)
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

/// Sets what a transformer reads and writes (no topics removes it), for the route maps.
#[tauri::command]
#[specta::specta]
pub fn set_transformer(
    state: State<'_, AppState>,
    service: String,
    transformer: Transformer,
) -> ApiResult<Prefs> {
    Ok(state
        .prefs
        .update(|p| p.set_transformer(&service, transformer))?)
}

/// Remembers a search run in a service's logs (for the search box's history).
#[tauri::command]
#[specta::specta]
pub fn add_search(
    state: State<'_, AppState>,
    profile: String,
    service: ServiceRef,
    search: SearchEntry,
) -> ApiResult<Prefs> {
    let key = ServiceKey::new(&profile, &service);
    Ok(state.prefs.update(|p| p.add_search(&key, search))?)
}

/// Forgets every search run before (saved searches stay).
#[tauri::command]
#[specta::specta]
pub fn clear_search_history(state: State<'_, AppState>) -> ApiResult<Prefs> {
    Ok(state.prefs.update(Prefs::clear_search_history)?)
}

/// Keeps a search under a name, for `service` of `profile` or (without a service) for all.
#[tauri::command]
#[specta::specta]
pub fn save_search(
    state: State<'_, AppState>,
    profile: String,
    service: Option<ServiceRef>,
    name: String,
    search: SearchEntry,
) -> ApiResult<Prefs> {
    let service = service.map(|s| ServiceKey::new(&profile, &s));
    Ok(state.prefs.update(|p| {
        p.save_search(SavedSearch {
            name,
            search,
            service,
        })
    })?)
}

/// Forgets a saved search (`service` as it was saved: a key, or none for a global one).
#[tauri::command]
#[specta::specta]
pub fn delete_saved_search(
    state: State<'_, AppState>,
    name: String,
    service: Option<ServiceKey>,
) -> ApiResult<Prefs> {
    Ok(state
        .prefs
        .update(|p| p.delete_saved_search(&name, service.as_ref()))?)
}
