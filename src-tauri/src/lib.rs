//! Contrail desktop app: wires the `contrail-*` crates into Tauri commands and app state.

mod commands;

/// Builds and runs the Tauri application. Blocks until the last window is closed.
pub fn run() {
    tauri::Builder::default()
        // `generate_handler!` registers the commands the frontend may `invoke`.
        .invoke_handler(tauri::generate_handler![commands::greet])
        .run(tauri::generate_context!())
        .expect("error while running the Contrail application");
}
