//! Local preferences: last profile, region overrides, favorite and recent services.
//!
//! Never contains credentials. Stored as JSON by the app (see `app/src-tauri/src/prefs_store.rs`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ecs::{ServiceRef, name_from_arn};

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
        settings
    }
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
        })
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

    pub fn remove_noise(&mut self, key: &ServiceKey, text: &str) {
        let storage_key = key.storage_key();
        if let Some(list) = self.noise.get_mut(&storage_key) {
            list.retain(|n| n != text);
            if list.is_empty() {
                self.noise.remove(&storage_key);
            }
        }
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
            r#"{"colorMode":"dark","accent":"sky","timeZone":"local","backfillMinutes":15,"uiScale":100,"logFontSize":12,"pauseWhenHidden":true,"autoPauseMinutes":10}"#
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
    fn reads_older_files_with_missing_fields() {
        let prefs = Prefs::from_json(r#"{"lastProfile":"dev"}"#).unwrap();
        assert_eq!(prefs.last_profile.as_deref(), Some("dev"));
        assert!(prefs.favorites.is_empty());
    }
}
