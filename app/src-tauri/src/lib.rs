//! Contrail desktop app. This crate contains only Tauri glue: commands live in [`commands`] and
//! forward to the `contrail-*` crates, where the real logic lives.

mod commands;

use tauri_specta::{Builder, collect_commands};

/// Where the generated TypeScript bindings are written, relative to this crate's directory.
///
/// Exporting only happens in debug builds and tests, so release builds compile it out.
#[cfg(any(debug_assertions, test))]
const BINDINGS_PATH: &str = "../ui/src/bindings.ts";

/// Builds the tauri-specta builder that knows every command (and later every event).
///
/// tauri-specta reads the Rust signatures of the commands and generates typed TypeScript
/// functions for them, so the frontend can't call a command with the wrong name or arguments.
/// It's a separate function so both [`run`] and the `export_bindings` test can use it.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![commands::greet])
}

/// Writes `app/ui/src/bindings.ts` from the registered commands and their types.
#[cfg(any(debug_assertions, test))]
fn export_bindings(builder: &Builder<tauri::Wry>) {
    // `CARGO_MANIFEST_DIR` makes the path independent of the working directory.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(BINDINGS_PATH);
    builder
        .export(specta_typescript::Typescript::default(), &path)
        .unwrap_or_else(|err| panic!("failed to export bindings to {}: {err}", path.display()));
}

/// Builds and runs the Tauri application. Blocks until the last window is closed.
pub fn run() {
    let builder = specta_builder();

    // Regenerate bindings on every debug start so the UI types never drift from Rust.
    #[cfg(debug_assertions)]
    export_bindings(&builder);

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running the Contrail application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Running `cargo test` regenerates the bindings. CI then fails if the committed
    /// `bindings.ts` differs, which catches forgotten regenerations.
    #[test]
    fn export_bindings_succeeds() {
        export_bindings(&specta_builder());
    }
}
