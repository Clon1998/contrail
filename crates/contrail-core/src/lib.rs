//! Core of Contrail: domain model, source traits, log parsing, buffering and querying.
//!
//! This crate deliberately has **no AWS dependencies**. The app talks to AWS only through the
//! traits defined here; `contrail-aws` and `contrail-fake` provide the implementations
//! (comparable to a Java interface module with two implementation modules).

pub mod auth;
mod ini;
pub mod profile;
pub mod sso;

/// Builds the greeting returned by the hello-world IPC command.
///
/// `&str` is a *borrowed* string slice: the function only reads the caller's text and does not
/// take ownership of it (roughly a read-only view, no copy). The returned `String` is a new,
/// *owned* heap string that the caller is then responsible for.
pub fn greeting(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "Hello from Contrail!".to_owned()
    } else {
        format!("Hello, {name}! Greetings from Contrail.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets_by_name() {
        assert_eq!(
            greeting("Patrick"),
            "Hello, Patrick! Greetings from Contrail."
        );
    }

    #[test]
    fn trims_whitespace_and_handles_empty_names() {
        assert_eq!(greeting("  Ada "), "Hello, Ada! Greetings from Contrail.");
        assert_eq!(greeting("   "), "Hello from Contrail!");
    }
}
