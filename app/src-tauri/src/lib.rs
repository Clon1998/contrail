//! Contrail desktop app. This crate contains only Tauri glue: commands live in [`commands`] and
//! forward to the `contrail-*` crates, where the real logic lives.

mod commands;
#[cfg(test)]
mod demo_data;
mod error;
mod live;
mod prefs_store;
mod route_index;
mod state;

use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

use crate::state::AppState;

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
    use commands::{app, auth, ecs, files, links, logs, prefs, trace, update};

    Builder::<tauri::Wry>::new().commands(collect_commands![
        app::app_info,
        auth::list_profiles,
        auth::session_status,
        auth::caller_identity,
        auth::sso_login,
        ecs::list_clusters,
        ecs::list_services,
        ecs::describe_service,
        ecs::list_tasks,
        logs::open_service_logs,
        logs::get_log_rows,
        logs::log_context,
        logs::close_log_view,
        logs::export_log_view,
        logs::set_log_filter,
        logs::get_match_positions,
        logs::field_summary,
        logs::log_timeline,
        logs::start_live,
        logs::load_older,
        ecs::reveal_secret,
        ecs::services_on_topics,
        ecs::cluster_routes,
        ecs::startup_topology,
        files::save_image,
        links::view_link,
        links::parse_view_link,
        links::console_link,
        links::open_console,
        trace::trace_id,
        update::check_for_update,
        update::install_update,
        update::cancel_update,
        logs::pause_live,
        logs::resume_live,
        prefs::get_prefs,
        prefs::set_last_profile,
        prefs::set_region_override,
        prefs::set_settings,
        prefs::toggle_favorite,
        prefs::add_recent,
        prefs::add_noise,
        prefs::remove_noise,
        prefs::set_field_mapping,
        prefs::set_transformer,
        prefs::add_search,
        prefs::clear_search_history,
        prefs::save_search,
        prefs::delete_saved_search,
    ])
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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,contrail=debug".into()),
        )
        .init();

    let builder = specta_builder();

    // Regenerate bindings on every debug start so the UI types never drift from Rust.
    #[cfg(debug_assertions)]
    export_bindings(&builder);

    let demo = state::demo_requested(std::env::args(), std::env::var("CONTRAIL_DEMO").ok());

    // Two TLS stacks end up in the build: the AWS SDK's (aws-lc-rs) and the updater's. Whoever
    // needs TLS first without naming one would make "theirs" the process default; choosing it
    // here keeps every connection on the same one (`install_default` only fails if one is set).
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let app = tauri::Builder::default();
    // Must come first: a link opened while Contrail runs starts a second process on Windows and
    // Linux; this hands its link to the running app (to the deep-link plugin) and brings the
    // window forward, then the second process quits.
    #[cfg(any(windows, target_os = "linux"))]
    let app = app.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    app.plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        // `setup` runs once the app exists, so the app data folder (for preferences) is known.
        .setup(move |app| {
            let state = if demo {
                AppState::demo()
            } else {
                AppState::aws(&app.path().app_data_dir()?)?
            };
            app.manage(state);
            // `contrail://` links: installers register the scheme on Windows and macOS; an AppImage
            // (Linux) and development builds register it when they start.
            #[cfg(any(target_os = "linux", all(windows, debug_assertions)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    tracing::warn!(%err, "could not register contrail:// links");
                }
            }
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                demo,
                "Contrail started"
            );
            Ok(())
        })
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
