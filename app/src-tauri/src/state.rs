//! Process-wide app state, managed by Tauri and injected into commands as `State<AppState>`.

use std::path::Path;
use std::sync::Arc;

use contrail_core::auth::AuthProvider;
use contrail_core::ecs::EcsSource;

use crate::prefs_store::PrefsStore;

/// Everything commands need, chosen once at start-up: real AWS or demo fakes.
pub struct AppState {
    /// `Arc<dyn AuthProvider>`: a shared pointer to *some* implementation of the trait, decided
    /// at runtime (dynamic dispatch, like holding a Java interface reference). `Arc` (atomically
    /// reference-counted) lets several owners share it across threads.
    pub auth: Arc<dyn AuthProvider>,
    pub ecs: Arc<dyn EcsSource>,
    pub prefs: PrefsStore,
    pub demo: bool,
}

impl AppState {
    /// Demo mode: invented profiles and sessions, no AWS access at all. Preferences stay in
    /// memory, so demo favorites never mix with real ones.
    pub fn demo() -> Self {
        // One FakeAuth shared by the fake sources, so their calls see the demo session state.
        let auth = Arc::new(contrail_fake::FakeAuth::new());
        Self {
            ecs: Arc::new(contrail_fake::FakeEcs::new(auth.clone())),
            auth,
            prefs: PrefsStore::in_memory(),
            demo: true,
        }
    }

    /// The real AWS setup of this machine; preferences live in `data_dir/prefs.json`.
    pub fn aws(data_dir: &Path) -> Result<Self, contrail_core::auth::AuthError> {
        let files = contrail_aws::AwsFiles::from_env()?;
        Ok(Self {
            auth: Arc::new(contrail_aws::AwsAuth::new(files)),
            ecs: Arc::new(contrail_aws::AwsEcs::new()),
            prefs: PrefsStore::load(data_dir.join("prefs.json")),
            demo: false,
        })
    }
}

/// Whether to start in demo mode: `--demo` on the command line or `CONTRAIL_DEMO=1`.
///
/// Takes the inputs as parameters (instead of reading them itself) so it can be unit-tested.
pub fn demo_requested(args: impl IntoIterator<Item = String>, env_value: Option<String>) -> bool {
    let from_env = env_value.is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes"));
    from_env || args.into_iter().any(|arg| arg == "--demo")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn demo_via_flag_or_env() {
        assert!(demo_requested(args(&["contrail", "--demo"]), None));
        assert!(demo_requested(args(&["contrail"]), Some("1".into())));
        assert!(demo_requested(args(&["contrail"]), Some("true".into())));
        assert!(!demo_requested(args(&["contrail"]), Some("0".into())));
        assert!(!demo_requested(args(&["contrail"]), None));
    }
}
