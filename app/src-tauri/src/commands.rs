//! Tauri commands: the functions the frontend can call with `invoke("<name>", args)`.
//!
//! A command is a thin adapter (like a Spring `@RestController` method): it converts arguments,
//! delegates to the `contrail-*` crates and returns a serializable result.

/// Hello-world command proving the IPC round trip works.
///
/// `#[tauri::command]` generates the glue that deserializes `{ name: "…" }` from the frontend
/// and serializes the returned `String` back as JSON.
#[tauri::command]
#[specta::specta]
pub fn greet(name: &str) -> String {
    contrail_core::greeting(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_delegates_to_core() {
        assert_eq!(
            greet("Contrail"),
            "Hello, Contrail! Greetings from Contrail."
        );
    }
}
