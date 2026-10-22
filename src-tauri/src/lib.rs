//! Contrail desktop app: wires the `contrail-*` crates into Tauri commands and app state.

/// Builds and runs the Tauri application. Blocks until the last window is closed.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Contrail application");
}
