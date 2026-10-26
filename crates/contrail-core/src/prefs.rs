//! Local preferences: last profile, region overrides, favorite and recent services.
//!
//! Never contains credentials. Stored as JSON by the app (see `app/src-tauri/src/prefs_store.rs`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ecs::{ServiceRef, name_from_arn};
use crate::logs::FieldMapping;

/// How many recently opened services are remembered (across profiles).
pub const MAX_RECENT: usize = 10;

/// A service as remembered across sessions: enough to reopen it with the right profile/region.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceKey {
    pub profile: String,
    /// The region the service lives in (from its cluster ARN).
    pub region: String,
    pub cluster_arn: String,
    pub service_name: String,
}

impl ServiceKey {
    /// Builds a key, taking the region from the cluster ARN (`arn:aws:ecs:<region>:…`).
    pub fn new(profile: &str, service: &ServiceRef) -> Self {
        let region = service
            .cluster_arn
            .split(':')
            .nth(3)
            .unwrap_or_default()
            .to_owned();
        Self {
            profile: profile.to_owned(),
            region,
            cluster_arn: service.cluster_arn.clone(),
            service_name: service.service_name.clone(),
        }
    }

    pub fn cluster_name(&self) -> &str {
        name_from_arn(&self.cluster_arn)
    }

    /// The key under which per-service settings (the noise list) are stored.
    pub fn storage_key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.profile, self.cluster_arn, self.service_name
        )
    }
}

/// Light or dark UI; `System` follows the operating system.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ColorMode {
    System,
    Light,
    /// Contrail is dark-first.
    #[default]
    Dark,
}

/// The accent colour (buttons, focus rings, links).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Accent {
    #[default]
    Sky,
    Blue,
    Green,
    Violet,
    Orange,
    Rose,
    /// Black/white, no colour.
    Neutral,
}

/// How absolute timestamps are shown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TimeZone {
    #[default]
    Local,
    Utc,
}

/// Optional columns of the log list (time, level, task and message are always shown).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogColumn {
    Logger,
    Thread,
    Correlation,
}

/// The default number of events a log view keeps.
pub const DEFAULT_BUFFER_SIZE: u32 = 100_000;
/// The buffer size is kept within these bounds (memory vs. usefulness).
pub const BUFFER_SIZE_RANGE: std::ops::RangeInclusive<u32> = 10_000..=500_000;

/// The default backfill window of a log view, in minutes.
pub const DEFAULT_BACKFILL_MINUTES: u32 = 15;
/// The default UI size, in percent.
pub const DEFAULT_UI_SCALE: u32 = 100;
/// The default font size of log lines, in pixels.
pub const DEFAULT_LOG_FONT_SIZE: u32 = 12;
/// Background log views pause their live tail after this many minutes by default.
pub const DEFAULT_AUTO_PAUSE_MINUTES: u32 = 10;

/// The app settings (the settings dialog).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub color_mode: ColorMode,
    pub accent: Accent,
    pub time_zone: TimeZone,
    /// How far back a log view starts, in minutes.
    pub backfill_minutes: u32,
    /// The size of the whole UI, in percent.
    pub ui_scale: u32,
    /// The font size of log lines, in pixels.
    pub log_font_size: u32,
    /// Pause live tails while Contrail's window is hidden or minimized (Live Tail is billed per
    /// session minute).
    pub pause_when_hidden: bool,
    /// Pause live tails of views that aren't shown after this many minutes; 0 = never.
    pub auto_pause_minutes: u32,
    /// How many events a log view keeps (the oldest are dropped beyond that).
    pub buffer_size: u32,
    /// The optional columns shown in log lists.
    pub log_columns: Vec<LogColumn>,
    /// Log lists show the newest event at the top (and follow new events there).
    pub newest_first: bool,
    /// Long messages wrap onto more lines instead of being cut off at the list's edge.
    pub wrap_lines: bool,
    /// The timeline (events over time, by level) is shown above log lists.
    pub show_timeline: bool,
    /// Look for a new Contrail version on start (at most once a day).
    pub check_for_updates: bool,
}

/// Written by hand (instead of derived) because the numbers don't default to 0.
impl Default for Settings {
    fn default() -> Self {
        Self {
            color_mode: ColorMode::default(),
            accent: Accent::default(),
            time_zone: TimeZone::default(),
            backfill_minutes: DEFAULT_BACKFILL_MINUTES,
            ui_scale: DEFAULT_UI_SCALE,
            log_font_size: DEFAULT_LOG_FONT_SIZE,
            pause_when_hidden: true,
            auto_pause_minutes: DEFAULT_AUTO_PAUSE_MINUTES,
            buffer_size: DEFAULT_BUFFER_SIZE,
            log_columns: Vec::new(),
            newest_first: false,
            wrap_lines: false,
            show_timeline: true,
            check_for_updates: true,
        }
    }
}

impl Settings {
    /// Reads saved settings field by field: a missing or unreadable value (a field added in a
    /// later version, an accent that no longer exists, …) gets its default, the others are kept.
    fn from_saved(value: &serde_json::Value) -> Self {
        /// Overwrites `target` with `value[key]` if it is present and has the right type.
        /// Generic over the field type: `T: DeserializeOwned` means "can be read from JSON".
        fn read<T: serde::de::DeserializeOwned>(
            value: &serde_json::Value,
            key: &str,
            target: &mut T,
        ) {
            if let Some(Ok(parsed)) = value.get(key).map(|v| serde_json::from_value(v.clone())) {
                *target = parsed;
            }
        }

        let mut settings = Settings::default();
        read(value, "colorMode", &mut settings.color_mode);
        read(value, "accent", &mut settings.accent);
        read(value, "timeZone", &mut settings.time_zone);
        read(value, "backfillMinutes", &mut settings.backfill_minutes);
        read(value, "uiScale", &mut settings.ui_scale);
        read(value, "logFontSize", &mut settings.log_font_size);
        read(value, "pauseWhenHidden", &mut settings.pause_when_hidden);
        read(value, "autoPauseMinutes", &mut settings.auto_pause_minutes);
        read(value, "bufferSize", &mut settings.buffer_size);
        read(value, "logColumns", &mut settings.log_columns);
        read(value, "newestFirst", &mut settings.newest_first);
        read(value, "wrapLines", &mut settings.wrap_lines);
        read(value, "showTimeline", &mut settings.show_timeline);
        read(value, "checkForUpdates", &mut settings.check_for_updates);
        settings
    }

    /// The buffer size, kept within [`BUFFER_SIZE_RANGE`].
    pub fn buffer_capacity(&self) -> usize {
        self.buffer_size
            .clamp(*BUFFER_SIZE_RANGE.start(), *BUFFER_SIZE_RANGE.end()) as usize
    }
}

/// A service that reads and writes Kafka topics from its code (a "transformer"). No route
/// variables say which topics, so they are entered by hand for the cluster's route map.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Transformer {
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

impl Transformer {
    /// Trimmed, without blanks and duplicates, sorted.
    fn normalized(self) -> Self {
        let clean = |topics: Vec<String>| {
            let mut topics: Vec<String> = topics
                .into_iter()
                .map(|t| t.trim().to_owned())
                .filter(|t| !t.is_empty())
                .collect();
            topics.sort();
            topics.dedup();
            topics
        };
        Self {
            reads: clean(self.reads),
            writes: clean(self.writes),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.reads.is_empty() && self.writes.is_empty()
    }
}

/// How many searches are remembered per service, and across all services (newest first).
pub const MAX_SERVICE_SEARCHES: usize = 50;
pub const MAX_GLOBAL_SEARCHES: usize = 100;

/// A search as it was run: the query and how it is read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub query: String,
    /// The whole query is one regular expression.
    pub regex: bool,
    /// Searches the whole raw line, not just the message.
    pub raw: bool,
}

/// The searches run before: per service (by [`ServiceKey::storage_key`]) and across all services.
/// (A file without it gets the default through `Stored`; no `#[serde(default)]` here, so the
/// TypeScript type keeps both fields required.)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchHistory {
    pub per_service: BTreeMap<String, Vec<SearchEntry>>,
    pub global: Vec<SearchEntry>,
}

/// A search kept under a name, for one service or (without `service`) for every service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    pub name: String,
    pub search: SearchEntry,
    pub service: Option<ServiceKey>,
}

/// `entry` moved to the front of `list` (added if new), keeping at most `max` entries.
fn remember_search(list: &mut Vec<SearchEntry>, entry: &SearchEntry, max: usize) {
    list.retain(|e| e != entry);
    list.insert(0, entry.clone());
    list.truncate(max);
}

/// Everything Contrail remembers between starts. Read from disk with [`Prefs::from_json`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub last_profile: Option<String>,
    /// Region chosen in the region selector, per profile.
    pub region_overrides: BTreeMap<String, String>,
    /// Pinned services, in the order they were pinned.
    pub favorites: Vec<ServiceKey>,
    /// Recently opened services, newest first, at most [`MAX_RECENT`].
    pub recent: Vec<ServiceKey>,
    pub settings: Settings,
    /// "Hide noise" texts per service (by [`ServiceKey::storage_key`]): log lines whose message
    /// contains one of them are hidden while hiding noise is on.
    pub noise: BTreeMap<String, Vec<String>>,
    /// Field mappings per service (by [`ServiceKey::storage_key`]).
    pub field_mappings: BTreeMap<String, FieldMapping>,
    /// Transformers by service name. Not per profile or cluster: a service reads and writes the
    /// same topics in every environment.
    pub transformers: BTreeMap<String, Transformer>,
    /// When the automatic update check last ran (Unix seconds).
    pub last_update_check: Option<u32>,
    /// The searches run before (the search box recalls them with the arrow keys).
    pub search_history: SearchHistory,
    /// Searches kept under a name, sorted by name.
    pub saved_searches: Vec<SavedSearch>,
}

impl Prefs {
    /// Reads a saved preferences file. Fields missing in older files get their defaults, so new
    /// fields can be added without breaking existing preferences.
    pub fn from_json(json: &str) -> serde_json::Result<Self> {
        /// The file format. `#[serde(default)]` lives here rather than on [`Prefs`], so the
        /// TypeScript type of `Prefs` keeps all fields required (they are always sent).
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Stored {
            last_profile: Option<String>,
            region_overrides: BTreeMap<String, String>,
            favorites: Vec<ServiceKey>,
            recent: Vec<ServiceKey>,
            #[serde(deserialize_with = "settings_or_default")]
            settings: Settings,
            noise: BTreeMap<String, Vec<String>>,
            field_mappings: BTreeMap<String, FieldMapping>,
            transformers: BTreeMap<String, Transformer>,
            last_update_check: Option<u32>,
            search_history: SearchHistory,
            saved_searches: Vec<SavedSearch>,
        }

        /// Settings are read leniently (see [`Settings::from_saved`]), so an unknown value never
        /// makes the whole file unreadable and loses favorites and recent services with it.
        fn settings_or_default<'de, D>(deserializer: D) -> Result<Settings, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            let value = serde_json::Value::deserialize(deserializer)?;
            Ok(Settings::from_saved(&value))
        }

        let stored: Stored = serde_json::from_str(json)?;
        Ok(Self {
            last_profile: stored.last_profile,
            region_overrides: stored.region_overrides,
            favorites: stored.favorites,
            recent: stored.recent,
            settings: stored.settings,
            noise: stored.noise,
            field_mappings: stored.field_mappings,
            transformers: stored.transformers,
            last_update_check: stored.last_update_check,
            search_history: stored.search_history,
            saved_searches: stored.saved_searches,
        })
    }

    /// Whether the automatic update check should run at `now` (Unix seconds): switched on, and
    /// not in the last 24 hours (or the clock went backwards since).
    pub fn update_check_due(&self, now: u32) -> bool {
        const DAY: u32 = 24 * 60 * 60;
        self.settings.check_for_updates
            && self
                .last_update_check
                .is_none_or(|last| now < last || now - last >= DAY)
    }

    pub fn set_region_override(&mut self, profile: &str, region: Option<String>) {
        match region {
            Some(region) => self.region_overrides.insert(profile.to_owned(), region),
            None => self.region_overrides.remove(profile),
        };
    }

    /// Pins the service, or unpins it if it is pinned already. Returns whether it is now pinned.
    pub fn toggle_favorite(&mut self, key: ServiceKey) -> bool {
        if let Some(index) = self.favorites.iter().position(|f| *f == key) {
            self.favorites.remove(index);
            false
        } else {
            self.favorites.push(key);
            true
        }
    }

    /// Adds a "hide noise" text for a service (ignoring duplicates and blank text).
    pub fn add_noise(&mut self, key: &ServiceKey, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let list = self.noise.entry(key.storage_key()).or_default();
        if !list.iter().any(|n| n == text) {
            list.push(text.to_owned());
        }
    }

    /// Sets (or, when empty, removes) the field mapping of a service.
    pub fn set_field_mapping(&mut self, key: &ServiceKey, mapping: FieldMapping) {
        if mapping.is_empty() {
            self.field_mappings.remove(&key.storage_key());
        } else {
            self.field_mappings.insert(key.storage_key(), mapping);
        }
    }

    /// Sets (or, without topics, removes) what a transformer reads and writes.
    pub fn set_transformer(&mut self, service: &str, transformer: Transformer) {
        let transformer = transformer.normalized();
        if transformer.is_empty() {
            self.transformers.remove(service);
        } else {
            self.transformers.insert(service.to_owned(), transformer);
        }
    }

    /// The field mapping of a service (empty if none is set).
    pub fn field_mapping(&self, key: &ServiceKey) -> FieldMapping {
        self.field_mappings
            .get(&key.storage_key())
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_noise(&mut self, key: &ServiceKey, text: &str) {
        let storage_key = key.storage_key();
        if let Some(list) = self.noise.get_mut(&storage_key) {
            list.retain(|n| n != text);
            if list.is_empty() {
                self.noise.remove(&storage_key);
            }
        }
    }

    /// Remembers a search run in a service's logs, for that service and across all services. A
    /// search run again moves to the front; blank ones aren't kept.
    pub fn add_search(&mut self, key: &ServiceKey, mut entry: SearchEntry) {
        entry.query = entry.query.trim().to_owned();
        if entry.query.is_empty() {
            return;
        }
        let history = &mut self.search_history;
        let list = history.per_service.entry(key.storage_key()).or_default();
        remember_search(list, &entry, MAX_SERVICE_SEARCHES);
        remember_search(&mut history.global, &entry, MAX_GLOBAL_SEARCHES);
    }

    /// Forgets every search run before (saved searches stay).
    pub fn clear_search_history(&mut self) {
        self.search_history = SearchHistory::default();
    }

    /// Keeps a search under a name. One with the same name for the same service (or for all
    /// services) is replaced. A blank name or query isn't kept.
    pub fn save_search(&mut self, mut saved: SavedSearch) {
        saved.name = saved.name.trim().to_owned();
        saved.search.query = saved.search.query.trim().to_owned();
        if saved.name.is_empty() || saved.search.query.is_empty() {
            return;
        }
        self.saved_searches
            .retain(|s| !(s.name == saved.name && s.service == saved.service));
        self.saved_searches.push(saved);
        // Sorted by name, then the service ones before the global ones of the same name.
        self.saved_searches
            .sort_by(|a, b| (&a.name, a.service.is_none()).cmp(&(&b.name, b.service.is_none())));
    }

    /// Forgets the saved search of this name for `service` (or, with `None`, the global one).
    pub fn delete_saved_search(&mut self, name: &str, service: Option<&ServiceKey>) {
        self.saved_searches
            .retain(|s| !(s.name == name && s.service.as_ref() == service));
    }

    /// Moves the service to the front of the recent list (adding it if new), keeping at most
    /// [`MAX_RECENT`] entries.
    pub fn add_recent(&mut self, key: ServiceKey) {
        self.recent.retain(|r| *r != key);
        self.recent.insert(0, key);
        self.recent.truncate(MAX_RECENT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(profile: &str, service: &str) -> ServiceKey {
        ServiceKey::new(
            profile,
            &ServiceRef {
                cluster_arn: "arn:aws:ecs:eu-west-1:111122223333:cluster/core".into(),
                service_name: service.into(),
            },
        )
    }

    #[test]
    fn key_takes_region_and_cluster_from_the_arn() {
        let key = key("dev", "orders");
        assert_eq!(key.region, "eu-west-1");
        assert_eq!(key.cluster_name(), "core");
    }

    #[test]
    fn toggling_favorites() {
        let mut prefs = Prefs::default();
        assert!(prefs.toggle_favorite(key("dev", "orders")));
        assert!(prefs.toggle_favorite(key("dev", "billing")));
        assert!(!prefs.toggle_favorite(key("dev", "orders")));
        assert_eq!(prefs.favorites, [key("dev", "billing")]);
    }

    #[test]
    fn recent_is_newest_first_without_duplicates_and_bounded() {
        let mut prefs = Prefs::default();
        for i in 0..12 {
            prefs.add_recent(key("dev", &format!("svc-{i}")));
        }
        prefs.add_recent(key("dev", "svc-5"));
        assert_eq!(prefs.recent.len(), MAX_RECENT);
        assert_eq!(prefs.recent[0], key("dev", "svc-5"));
        assert_eq!(prefs.recent[1], key("dev", "svc-11"));
        assert_eq!(
            prefs
                .recent
                .iter()
                .filter(|r| r.service_name == "svc-5")
                .count(),
            1
        );
    }

    fn entry(query: &str) -> SearchEntry {
        SearchEntry {
            query: query.into(),
            regex: false,
            raw: false,
        }
    }

    #[test]
    fn searches_are_remembered_per_service_and_globally_newest_first() {
        let mut prefs = Prefs::default();
        let (orders, payments) = (key("dev", "orders"), key("dev", "payments"));
        prefs.add_search(&orders, entry("timeout"));
        prefs.add_search(&payments, entry("  level:ERROR "));
        prefs.add_search(&orders, entry("state:FAILED"));
        // Run again: moves to the front, not listed twice. Blank: not kept.
        prefs.add_search(&orders, entry("timeout"));
        prefs.add_search(&orders, entry("   "));
        // The same text as a regex is a different search.
        prefs.add_search(
            &orders,
            SearchEntry {
                regex: true,
                ..entry("timeout")
            },
        );

        let history = &prefs.search_history;
        let queries =
            |list: &[SearchEntry]| list.iter().map(|e| e.query.clone()).collect::<Vec<_>>();
        assert_eq!(
            queries(&history.per_service[&orders.storage_key()]),
            ["timeout", "timeout", "state:FAILED"]
        );
        assert!(history.per_service[&orders.storage_key()][0].regex);
        assert_eq!(
            queries(&history.per_service[&payments.storage_key()]),
            ["level:ERROR"]
        );
        assert_eq!(
            queries(&history.global),
            ["timeout", "timeout", "state:FAILED", "level:ERROR"]
        );

        for i in 0..200 {
            prefs.add_search(&orders, entry(&format!("q{i}")));
        }
        let history = &prefs.search_history;
        assert_eq!(
            history.per_service[&orders.storage_key()].len(),
            MAX_SERVICE_SEARCHES
        );
        assert_eq!(history.global.len(), MAX_GLOBAL_SEARCHES);
        assert_eq!(history.global[0].query, "q199");

        prefs.clear_search_history();
        assert_eq!(prefs.search_history, SearchHistory::default());
    }

    #[test]
    fn saved_searches_are_kept_by_name_and_scope() {
        let mut prefs = Prefs::default();
        let orders = key("dev", "orders");
        let saved = |name: &str, query: &str, service: Option<&ServiceKey>| SavedSearch {
            name: name.into(),
            search: entry(query),
            service: service.cloned(),
        };
        prefs.save_search(saved("errors", "level>=WARN", None));
        prefs.save_search(saved(" errors ", "level:ERROR", Some(&orders)));
        prefs.save_search(saved("billing", "billing", None));
        // Same name and scope: replaced. Blank name or query: not kept.
        prefs.save_search(saved("errors", "level:ERROR", None));
        prefs.save_search(saved(" ", "x", None));
        prefs.save_search(saved("empty", " ", None));

        let listed: Vec<_> = prefs
            .saved_searches
            .iter()
            .map(|s| {
                (
                    s.name.as_str(),
                    s.search.query.as_str(),
                    s.service.is_some(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                ("billing", "billing", false),
                ("errors", "level:ERROR", true),
                ("errors", "level:ERROR", false),
            ]
        );

        prefs.delete_saved_search("errors", None);
        assert_eq!(prefs.saved_searches.len(), 2);
        assert!(prefs.saved_searches.iter().any(|s| s.service.is_some()));
    }

    #[test]
    fn older_preferences_get_an_empty_history() {
        let prefs = Prefs::from_json(r#"{"lastProfile":"dev","noise":{}}"#).unwrap();
        assert_eq!(prefs.search_history, SearchHistory::default());
        assert!(prefs.saved_searches.is_empty());
        assert_eq!(prefs.last_profile.as_deref(), Some("dev"));
        // And they survive a save and load.
        let mut prefs = prefs;
        prefs.add_search(&key("dev", "orders"), entry("timeout"));
        let json = serde_json::to_string(&prefs).unwrap();
        assert_eq!(Prefs::from_json(&json).unwrap(), prefs);
    }

    #[test]
    fn buffer_size_and_columns_are_saved_and_bounded() {
        let json = r#"{"settings":{"bufferSize":5,"logColumns":["thread","logger"]}}"#;
        let settings = Prefs::from_json(json).unwrap().settings;
        assert_eq!(settings.log_columns, [LogColumn::Thread, LogColumn::Logger]);
        assert_eq!(settings.buffer_capacity(), 10_000);
        assert_eq!(Settings::default().buffer_capacity(), 100_000);
        // An unknown column (from a newer version) falls back to the default list.
        let json = r#"{"settings":{"logColumns":["future"],"bufferSize":200000}}"#;
        let settings = Prefs::from_json(json).unwrap().settings;
        assert!(settings.log_columns.is_empty());
        assert_eq!(settings.buffer_capacity(), 200_000);
    }

    #[test]
    fn wrapping_lines_is_off_unless_saved() {
        // Preferences saved before the setting existed.
        let settings = Prefs::from_json(r#"{"settings":{"newestFirst":true}}"#)
            .unwrap()
            .settings;
        assert!(!settings.wrap_lines);
        assert!(settings.show_timeline, "on unless switched off");
        assert!(settings.newest_first);
        let json = r#"{"settings":{"wrapLines":true}}"#;
        assert!(Prefs::from_json(json).unwrap().settings.wrap_lines);
    }

    #[test]
    fn field_mappings_per_service() {
        let mut prefs = Prefs::default();
        let orders = key("dev", "orders");
        let mapping = FieldMapping {
            message: Some("text".into()),
            ..FieldMapping::default()
        };
        prefs.set_field_mapping(&orders, mapping.clone());
        assert_eq!(prefs.field_mapping(&orders), mapping);
        assert!(prefs.field_mapping(&key("dev", "billing")).is_empty());

        let json = serde_json::to_string(&prefs).unwrap();
        assert_eq!(Prefs::from_json(&json).unwrap(), prefs);

        prefs.set_field_mapping(&orders, FieldMapping::default());
        assert!(prefs.field_mappings.is_empty());
    }

    #[test]
    fn transformers_by_service_name() {
        let mut prefs = Prefs::default();
        prefs.set_transformer(
            "enricher",
            Transformer {
                reads: vec![" raw ".into(), "raw".into(), "".into()],
                writes: vec!["enriched".into()],
            },
        );
        assert_eq!(
            prefs.transformers["enricher"],
            Transformer {
                reads: vec!["raw".into()],
                writes: vec!["enriched".into()],
            },
            "trimmed, without blanks and duplicates"
        );
        let json = serde_json::to_string(&prefs).unwrap();
        assert_eq!(Prefs::from_json(&json).unwrap(), prefs);

        prefs.set_transformer("enricher", Transformer::default());
        assert!(prefs.transformers.is_empty());
    }

    #[test]
    fn noise_lists_per_service() {
        let mut prefs = Prefs::default();
        let orders = key("dev", "orders");
        prefs.add_noise(&orders, " GET /actuator/health ");
        prefs.add_noise(&orders, "GET /actuator/health");
        prefs.add_noise(&orders, "   ");
        assert_eq!(prefs.noise[&orders.storage_key()], ["GET /actuator/health"]);
        assert!(
            !prefs
                .noise
                .contains_key(&key("dev", "billing").storage_key())
        );

        let json = serde_json::to_string(&prefs).unwrap();
        assert_eq!(Prefs::from_json(&json).unwrap().noise, prefs.noise);

        prefs.remove_noise(&orders, "GET /actuator/health");
        assert!(prefs.noise.is_empty());
    }

    #[test]
    fn region_overrides_can_be_cleared() {
        let mut prefs = Prefs::default();
        prefs.set_region_override("dev", Some("us-west-2".into()));
        assert_eq!(prefs.region_overrides["dev"], "us-west-2");
        prefs.set_region_override("dev", None);
        assert!(prefs.region_overrides.is_empty());
    }

    #[test]
    fn round_trips_through_json() {
        let mut prefs = Prefs::default();
        prefs.add_recent(key("dev", "orders"));
        prefs.set_region_override("dev", Some("us-west-2".into()));
        let json = serde_json::to_string(&prefs).unwrap();
        assert_eq!(Prefs::from_json(&json).unwrap(), prefs);
    }

    #[test]
    fn settings_default_to_dark_sky_local() {
        let settings = Prefs::default().settings;
        assert_eq!(settings.color_mode, ColorMode::Dark);
        assert_eq!(settings.accent, Accent::Sky);
        assert_eq!(settings.time_zone, TimeZone::Local);
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            r#"{"colorMode":"dark","accent":"sky","timeZone":"local","backfillMinutes":15,"uiScale":100,"logFontSize":12,"pauseWhenHidden":true,"autoPauseMinutes":10,"bufferSize":100000,"logColumns":[],"newestFirst":false,"wrapLines":false,"showTimeline":true,"checkForUpdates":true}"#
        );
    }

    #[test]
    fn unknown_settings_fall_back_one_field_at_a_time() {
        let json = r#"{"favorites":[{"profile":"dev","region":"eu-west-1","clusterArn":"arn:aws:ecs:eu-west-1:1:cluster/c","serviceName":"s"}],
                       "settings":{"colorMode":"light","accent":"chartreuse","timeZone":"utc"}}"#;
        let prefs = Prefs::from_json(json).unwrap();
        assert_eq!(prefs.favorites.len(), 1);
        // Known values are kept; the unknown accent and the missing fields get their defaults.
        assert_eq!(
            prefs.settings,
            Settings {
                color_mode: ColorMode::Light,
                time_zone: TimeZone::Utc,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn the_update_check_runs_at_most_once_a_day_when_switched_on() {
        let day = 24 * 60 * 60;
        let mut prefs = Prefs::default();
        assert!(prefs.update_check_due(1_000), "never checked");
        prefs.last_update_check = Some(1_000);
        assert!(!prefs.update_check_due(1_000 + day - 1));
        assert!(prefs.update_check_due(1_000 + day));
        assert!(prefs.update_check_due(10), "the clock went backwards");
        prefs.settings.check_for_updates = false;
        assert!(!prefs.update_check_due(1_000 + 2 * day));
    }

    #[test]
    fn reads_older_files_with_missing_fields() {
        let prefs = Prefs::from_json(r#"{"lastProfile":"dev"}"#).unwrap();
        assert_eq!(prefs.last_profile.as_deref(), Some("dev"));
        assert!(prefs.favorites.is_empty());
    }
}
