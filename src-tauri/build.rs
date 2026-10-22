// Build script (like a Maven plugin bound to `generate-sources`): reads tauri.conf.json and the
// capability files at compile time and generates the code `tauri::generate_context!` embeds.
fn main() {
    tauri_build::build()
}
