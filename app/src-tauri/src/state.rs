//! Process-wide app state, managed by Tauri and injected into commands as `State<AppState>`.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;

use contrail_core::auth::AuthProvider;
use contrail_core::auth::AwsCtx;
use contrail_core::ecs::EcsSource;
use contrail_core::logs::{
    FieldMapping, LogBuffer, LogEvent, LogSource, StreamSelection, ViewFilter, VisibleChange,
};
use contrail_core::timestamp::Timestamp;

use crate::live::{LiveHandle, Views};
use crate::prefs_store::PrefsStore;

/// Everything commands need, chosen once at start-up: real AWS or demo fakes.
pub struct AppState {
    /// `Arc<dyn AuthProvider>`: a shared pointer to *some* implementation of the trait, decided
    /// at runtime (dynamic dispatch, like holding a Java interface reference). `Arc` (atomically
    /// reference-counted) lets several owners share it across threads.
    pub auth: Arc<dyn AuthProvider>,
    pub ecs: Arc<dyn EcsSource>,
    pub logs: Arc<dyn LogSource>,
    pub prefs: PrefsStore,
    /// Open log views by ID, shared with their live tasks (see [`Views`]). The lock is only held
    /// for quick reads and inserts, never across an `.await`.
    pub views: Views,
    /// The next view ID. An atomic integer needs no lock (like Java's `AtomicInteger`).
    pub next_view_id: AtomicU32,
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
            logs: Arc::new(contrail_fake::FakeLogs::new(auth.clone())),
            auth,
            views: Views::default(),
            next_view_id: AtomicU32::new(1),
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
            logs: Arc::new(contrail_aws::AwsLogs::new()),
            views: Views::default(),
            next_view_id: AtomicU32::new(1),
            prefs: PrefsStore::load(data_dir.join("prefs.json")),
            demo: false,
        })
    }
}

/// One open log view: the events of a service, kept in Rust; the UI reads windows of rows.
pub struct LogView {
    pub buffer: LogBuffer,
    /// Where the events come from, for starting the live tail.
    pub ctx: AwsCtx,
    pub selection: StreamSelection,
    /// The end of the backfill: the live tail catches up from here.
    pub backfilled_until: Timestamp,
    /// The running live tail, if any. Dropping it (view closed) stops the task.
    pub live: Option<LiveHandle>,
    /// The search, if one is set (and not trivial).
    pub filter: Option<ViewFilter>,
    /// The service's field mapping, applied to events as they arrive.
    pub mapping: FieldMapping,
}

impl LogView {
    pub fn new(
        buffer: LogBuffer,
        ctx: AwsCtx,
        selection: StreamSelection,
        backfilled_until: Timestamp,
    ) -> Self {
        Self {
            buffer,
            ctx,
            selection,
            backfilled_until,
            live: None,
            filter: None,
            mapping: FieldMapping::default(),
        }
    }

    /// Uses a field mapping for the events inserted from now on.
    pub fn with_mapping(mut self, mapping: FieldMapping) -> Self {
        self.mapping = mapping;
        self
    }

    /// Adds events and returns what changed in the listed rows (filtered or not).
    pub fn insert(&mut self, mut events: Vec<LogEvent>) -> VisibleChange {
        if !self.mapping.is_empty() {
            events.iter_mut().for_each(|e| self.mapping.apply(e));
        }
        let before = self.buffer.len();
        let report = self.buffer.insert(events);
        match &mut self.filter {
            Some(filter) => filter.after_insert(&self.buffer, report, before),
            None => VisibleChange {
                first_changed: report.first_index,
                evicted: report.evicted,
            },
        }
    }

    /// Sets (or with `None` clears) the search and evaluates it over all events.
    pub fn set_filter(&mut self, filter: Option<ViewFilter>) {
        self.filter = filter.filter(|f| !f.is_trivial()).map(|mut f| {
            f.rebuild(&self.buffer);
            f
        });
    }

    /// How many rows the list shows.
    pub fn visible_len(&self) -> usize {
        match &self.filter {
            Some(filter) => filter.visible_len(&self.buffer),
            None => self.buffer.len(),
        }
    }

    pub fn match_count(&self) -> Option<usize> {
        self.filter.as_ref().map(ViewFilter::match_count)
    }

    /// The listed rows `offset..offset + limit`.
    pub fn window(&self, offset: usize, limit: usize) -> Vec<LogEvent> {
        match &self.filter {
            Some(filter) => filter.window(&self.buffer, offset, limit),
            None => self.buffer.window(offset, limit),
        }
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
