use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// Running on invented demo data (`--demo` / `CONTRAIL_DEMO=1`).
    pub demo: bool,
}

/// Version and mode of the running app.
#[tauri::command]
#[specta::specta]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        demo: state.demo,
    }
}
