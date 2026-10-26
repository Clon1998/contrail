//! Tauri commands: the functions the frontend can call (through the generated `bindings.ts`).
//!
//! A command is a thin adapter (like a Spring `@RestController` method): it takes the app state
//! and arguments, delegates to the `contrail-*` crates and returns a serializable result.

pub mod app;
pub mod auth;
pub mod ecs;
pub mod files;
pub mod links;
pub mod logs;
pub mod prefs;
pub mod trace;
pub mod update;
