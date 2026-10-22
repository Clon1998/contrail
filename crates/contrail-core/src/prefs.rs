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
}

/// Everything Contrail remembers between starts.
///
/// `#[serde(default)]` fills in missing fields when reading an older file, so new fields can be
/// added without breaking existing preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub last_profile: Option<String>,
    /// Region chosen in the region selector, per profile.
    pub region_overrides: BTreeMap<String, String>,
    /// Pinned services, in the order they were pinned.
    pub favorites: Vec<ServiceKey>,
    /// Recently opened services, newest first, at most [`MAX_RECENT`].
    pub recent: Vec<ServiceKey>,
}

impl Prefs {
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
    fn region_overrides_can_be_cleared() {
        let mut prefs = Prefs::default();
        prefs.set_region_override("dev", Some("us-west-2".into()));
        assert_eq!(prefs.region_overrides["dev"], "us-west-2");
        prefs.set_region_override("dev", None);
        assert!(prefs.region_overrides.is_empty());
    }

    #[test]
    fn reads_older_files_with_missing_fields() {
        let prefs: Prefs = serde_json::from_str(r#"{"lastProfile":"dev"}"#).unwrap();
        assert_eq!(prefs.last_profile.as_deref(), Some("dev"));
        assert!(prefs.favorites.is_empty());
    }
}
