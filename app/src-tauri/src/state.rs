//! Process-wide app state, managed by Tauri and injected into commands as `State<AppState>`.

use std::ops::Range;
use std::path::Path;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};

use contrail_core::auth::AuthProvider;
use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{EcsChanges, EcsSource};
use contrail_core::logs::timeline::{Timeline, timeline};
use contrail_core::logs::{
    FieldMapping, FieldSummary, FilterMode, LogBuffer, LogEvent, LogSource, StreamSelection,
    TimeRange, ViewFilter, VisibleChange, summarize,
};
use contrail_core::secrets::SecretSource;
use contrail_core::timestamp::Timestamp;

use crate::live::{LiveHandle, Views};
use crate::prefs_store::PrefsStore;
use crate::route_index::{RouteIndex, TopologyIndex};

/// Everything commands need, chosen once at start-up: real AWS or demo fakes.
pub struct AppState {
    /// `Arc<dyn AuthProvider>`: a shared pointer to *some* implementation of the trait, decided
    /// at runtime (dynamic dispatch, like holding a Java interface reference). `Arc` (atomically
    /// reference-counted) lets several owners share it across threads.
    pub auth: Arc<dyn AuthProvider>,
    pub ecs: Arc<dyn EcsSource>,
    /// The calls that change ECS: made only while the user allows changes (see
    /// `commands::ecs::changes_allowed`).
    pub changes: Arc<dyn EcsChanges>,
    pub logs: Arc<dyn LogSource>,
    /// Secret values, read only when the user asks for one.
    pub secrets: Arc<dyn SecretSource>,
    /// The routes found by the last topic scan of each cluster, kept for the session.
    pub routes: RouteIndex,
    /// The transformers' topics found by the last startup topology scan of each cluster.
    pub topology: TopologyIndex,
    pub prefs: PrefsStore,
    /// Open log views by ID, shared with their live tasks (see [`Views`]). The lock is only held
    /// for quick reads and inserts, never across an `.await`.
    pub views: Views,
    /// The next view ID. An atomic integer needs no lock (like Java's `AtomicInteger`).
    pub next_view_id: AtomicU32,
    pub demo: bool,
    /// The update found by the last check, ready to install.
    pub update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Stops the running update download (see `commands::update`).
    pub update_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl AppState {
    /// Demo mode: invented profiles and sessions, no AWS access at all. Preferences stay in
    /// memory, so demo favorites never mix with real ones.
    pub fn demo() -> Self {
        // One FakeAuth shared by the fake sources, so their calls see the demo session state.
        let auth = Arc::new(contrail_fake::FakeAuth::new());
        // One fake for reading and changing, so the demo shows what a change did.
        let ecs = Arc::new(contrail_fake::FakeEcs::new(auth.clone()));
        Self {
            ecs: ecs.clone(),
            changes: ecs,
            logs: Arc::new(contrail_fake::FakeLogs::new(auth.clone())),
            secrets: Arc::new(contrail_fake::FakeSecrets::new(auth.clone())),
            auth,
            routes: RouteIndex::default(),
            topology: TopologyIndex::default(),
            views: Views::default(),
            next_view_id: AtomicU32::new(1),
            prefs: PrefsStore::in_memory(),
            demo: true,
            update: Mutex::default(),
            update_cancel: Mutex::default(),
        }
    }

    /// The real AWS setup of this machine; preferences live in `data_dir/prefs.json`.
    pub fn aws(data_dir: &Path) -> Result<Self, contrail_core::auth::AuthError> {
        let files = contrail_aws::AwsFiles::from_env()?;
        // One SDK client cache for reading and changing.
        let ecs = Arc::new(contrail_aws::AwsEcs::new());
        Ok(Self {
            auth: Arc::new(contrail_aws::AwsAuth::new(files)),
            ecs: ecs.clone(),
            changes: ecs,
            logs: Arc::new(contrail_aws::AwsLogs::new()),
            secrets: Arc::new(contrail_aws::AwsSecrets::new()),
            routes: RouteIndex::default(),
            topology: TopologyIndex::default(),
            views: Views::default(),
            next_view_id: AtomicU32::new(1),
            prefs: PrefsStore::load(data_dir.join("prefs.json")),
            demo: false,
            update: Mutex::default(),
            update_cancel: Mutex::default(),
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
    /// The start of the view's time window, and how far back events are loaded so far (the view
    /// loads newest first; older events are loaded on request).
    pub window_start: Timestamp,
    pub loaded_from: Timestamp,
    /// The running live tail, if any. Dropping it (view closed) stops the task.
    pub live: Option<LiveHandle>,
    /// The search, if one is set (and not trivial).
    pub filter: Option<ViewFilter>,
    /// The service's field mapping, applied to events as they arrive.
    pub mapping: FieldMapping,
    /// The part of the window the list is narrowed to (picked on the timeline), if any. Only the
    /// listing changes: the buffer keeps every loaded event, so going back needs no reload.
    pub focus: Option<TimeRange>,
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
            window_start: backfilled_until,
            loaded_from: backfilled_until,
            live: None,
            filter: None,
            mapping: FieldMapping::default(),
            focus: None,
        }
    }

    /// Records the window and how much of it is loaded (by default: all of it).
    pub fn with_loaded(mut self, window_start: Timestamp, loaded_from: Timestamp) -> Self {
        self.window_start = window_start;
        self.loaded_from = loaded_from;
        self
    }

    /// Whether every event of the window is loaded.
    pub fn complete(&self) -> bool {
        self.loaded_from <= self.window_start
    }

    /// Uses a field mapping for the events inserted from now on.
    pub fn with_mapping(mut self, mapping: FieldMapping) -> Self {
        self.mapping = mapping;
        self
    }

    /// Adds events and returns what changed in the listed rows (filtered or not, focused or not).
    pub fn insert(&mut self, mut events: Vec<LogEvent>) -> VisibleChange {
        if !self.mapping.is_empty() {
            events.iter_mut().for_each(|e| self.mapping.apply(e));
        }
        let listed_before = self.listed();
        let before = self.buffer.len();
        let report = self.buffer.insert(events);
        let change = match &mut self.filter {
            Some(filter) => filter.after_insert(&self.buffer, report, before),
            None => VisibleChange {
                first_changed: report.first_index,
                evicted: report.evicted,
            },
        };
        if self.focus.is_none() {
            return change;
        }
        // The change is in rows of the whole listing; the list shows only the focused part.
        let listed = self.listed();
        VisibleChange {
            first_changed: change
                .first_changed
                .filter(|&first| first < listed.end)
                .map(|first| first.saturating_sub(listed.start)),
            evicted: change
                .evicted
                .saturating_sub(listed_before.start)
                .min(listed_before.len()),
        }
    }

    /// Sets (or with `None` clears) the search and evaluates it over all events.
    pub fn set_filter(&mut self, filter: Option<ViewFilter>) {
        self.filter = filter.filter(|f| !f.is_trivial()).map(|mut f| {
            f.rebuild(&self.buffer);
            f
        });
    }

    /// The buffer indices of the events inside the focus (all events without one). The buffer is
    /// sorted by time, so the focus is one contiguous range of it.
    fn focused_events(&self) -> Range<usize> {
        match self.focus {
            Some(focus) => self.buffer.index_at(focus.start)..self.buffer.index_at(focus.end),
            None => 0..self.buffer.len(),
        }
    }

    /// The listed rows as a range of the whole listing (the rows the search alone would list):
    /// positions in the matches when filtering, buffer indices otherwise.
    fn listed(&self) -> Range<usize> {
        let events = self.focused_events();
        match &self.filter {
            Some(filter) if filter.mode == FilterMode::Filter => filter.matches_within(events),
            _ => events,
        }
    }

    /// How many rows the list shows.
    pub fn visible_len(&self) -> usize {
        self.listed().len()
    }

    /// The number of matching events inside the focus, when there is a search.
    pub fn match_count(&self) -> Option<usize> {
        let events = self.focused_events();
        self.filter.as_ref().map(|f| f.matches_within(events).len())
    }

    /// The listed rows that match the search (for stepping through matches in highlight mode).
    pub fn match_positions(&self) -> Vec<usize> {
        match &self.filter {
            Some(filter) if filter.mode == FilterMode::Highlight => {
                let events = self.focused_events();
                filter.matched()[filter.matches_within(events.clone())]
                    .iter()
                    .map(|&i| i - events.start)
                    .collect()
            }
            // When filtering, every listed row matches.
            Some(_) => (0..self.visible_len()).collect(),
            None => Vec::new(),
        }
    }

    /// The field summary of the events that match the search (all events without one), inside
    /// the focus.
    pub fn field_summary(&self) -> FieldSummary {
        let events = self.focused_events();
        match &self.filter {
            Some(filter) => summarize(
                filter.matched()[filter.matches_within(events)]
                    .iter()
                    .filter_map(|&i| self.buffer.get(i)),
            ),
            None => summarize(events.filter_map(|i| self.buffer.get(i))),
        }
    }

    /// The listed events (the matches when filtering, every event otherwise) counted over time,
    /// from as far back as events are loaded (a long window loads newest first: what isn't
    /// loaded yet must not look like "no events") to the end or the newest event, if later.
    pub fn timeline(&self, max_buckets: u32, utc_offset_minutes: i32) -> Timeline {
        let newest = self.buffer.iter().last().map(|e| e.timestamp);
        let to = newest.map_or(self.backfilled_until, |n| n.max(self.backfilled_until));
        let filtering = self
            .filter
            .as_ref()
            .filter(|f| f.mode == FilterMode::Filter);
        match filtering {
            Some(filter) => timeline(
                filter.matched().iter().filter_map(|&i| self.buffer.get(i)),
                self.loaded_from,
                to,
                max_buckets,
                utc_offset_minutes,
            ),
            None => timeline(
                self.buffer.iter(),
                self.loaded_from,
                to,
                max_buckets,
                utc_offset_minutes,
            ),
        }
    }

    /// The listed rows `offset..offset + limit`.
    pub fn window(&self, offset: usize, limit: usize) -> Vec<LogEvent> {
        let listed = self.listed();
        let offset = listed.start + offset;
        let limit = limit.min(listed.end.saturating_sub(offset));
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
    use contrail_core::logs::RawEvent;
    use contrail_core::query::{MatchOptions, parse_query};
    use time::Duration;
    use time::macros::datetime;

    fn at(second: i64) -> Timestamp {
        Timestamp(datetime!(2026-01-15 12:00 UTC) + Duration::seconds(second))
    }

    fn event(second: i64, message: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: "s".into(),
            timestamp: at(second),
            message: format!(
                r#"{{"@timestamp":"2026-01-15T12:00:{second:02}Z","log.level":"INFO","message":"{message}"}}"#
            ),
        })
    }

    /// A view with an event every second from 0 to 9, `boom` on the even seconds.
    fn view() -> LogView {
        let mut view = LogView::new(
            LogBuffer::new(100),
            AwsCtx {
                profile: "dev".into(),
                region: None,
            },
            StreamSelection {
                log_group: "/ecs/orders-api".into(),
                region: None,
                account_id: None,
                streams: vec!["s".into()],
                stream_prefix: None,
                filter_pattern: None,
            },
            at(10),
        );
        view.insert(
            (0..10)
                .map(|i| event(i, if i % 2 == 0 { "boom" } else { "ok" }))
                .collect(),
        );
        view
    }

    fn search(view: &mut LogView, query: &str, mode: FilterMode) {
        let query = parse_query(query).unwrap();
        let filter = ViewFilter::new(query, MatchOptions::default(), Vec::new(), &[], mode);
        view.set_filter(Some(filter));
    }

    fn seconds(events: Vec<LogEvent>) -> Vec<i64> {
        let start = at(0).0;
        events
            .iter()
            .map(|e| (e.timestamp.0 - start).whole_seconds())
            .collect()
    }

    #[test]
    fn a_focus_lists_only_its_part_of_the_window_and_keeps_the_rest() {
        let mut view = view();
        view.focus = Some(TimeRange {
            start: at(3),
            end: at(6),
        });
        assert_eq!(view.visible_len(), 3);
        assert_eq!(seconds(view.window(0, 100)), [3, 4, 5]);
        assert_eq!(seconds(view.window(2, 100)), [5]);

        search(&mut view, "boom", FilterMode::Filter);
        assert_eq!(seconds(view.window(0, 100)), [4]);
        assert_eq!(view.match_count(), Some(1));

        search(&mut view, "boom", FilterMode::Highlight);
        assert_eq!(view.match_positions(), [1]);

        view.focus = None;
        assert_eq!(view.visible_len(), 10);
        assert_eq!(view.match_positions(), [0, 2, 4, 6, 8]);
    }

    #[test]
    fn inserts_outside_the_focus_change_no_listed_rows() {
        let mut view = view();
        view.focus = Some(TimeRange {
            start: at(3),
            end: at(6),
        });
        let change = view.insert(vec![event(12, "later")]);
        assert_eq!(change.first_changed, None);
        assert_eq!(view.visible_len(), 3);

        // After the event already at second 5: the fourth listed row.
        let change = view.insert(vec![event(5, "inside")]);
        assert_eq!(change.first_changed, Some(3));
        assert_eq!(view.visible_len(), 4);
    }

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
