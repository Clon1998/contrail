//! Loading and saving [`Prefs`] as JSON in the app data folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use contrail_core::prefs::Prefs;

/// The preferences in memory plus the file they're saved to.
pub struct PrefsStore {
    /// `None` keeps everything in memory only (demo mode, tests).
    path: Option<PathBuf>,
    prefs: Mutex<Prefs>,
}

impl PrefsStore {
    /// Reads `path`. A missing file means defaults; an unreadable one is logged and replaced
    /// with defaults on the next save (preferences aren't worth refusing to start over).
    pub fn load(path: PathBuf) -> Self {
        let prefs = match std::fs::read_to_string(&path) {
            Ok(json) => Prefs::from_json(&json).unwrap_or_else(|err| {
                tracing::warn!(path = %path.display(), %err, "ignoring invalid preferences file");
                Prefs::default()
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Prefs::default(),
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "can't read preferences");
                Prefs::default()
            }
        };
        Self {
            path: Some(path),
            prefs: Mutex::new(prefs),
        }
    }

    /// Preferences that are never written to disk.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            prefs: Mutex::new(Prefs::default()),
        }
    }

    pub fn get(&self) -> Prefs {
        self.prefs.lock().expect("prefs lock poisoned").clone()
    }

    /// Applies `change`, saves, and returns the new preferences.
    ///
    /// `impl FnOnce(&mut Prefs)` accepts any closure that may be called once and gets a mutable
    /// borrow of the preferences for the duration of the call.
    pub fn update(&self, change: impl FnOnce(&mut Prefs)) -> std::io::Result<Prefs> {
        let mut prefs = self.prefs.lock().expect("prefs lock poisoned");
        change(&mut prefs);
        if let Some(path) = &self.path {
            write_atomically(path, &serde_json::to_vec_pretty(&*prefs)?)?;
        }
        Ok(prefs.clone())
    }
}

/// Writes to a temporary file next to `path` and renames it over the original, so a crash
/// mid-write never leaves a half-written preferences file.
fn write_atomically(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/prefs.json");

        let store = PrefsStore::load(path.clone());
        assert_eq!(store.get(), Prefs::default());
        store
            .update(|p| p.last_profile = Some("dev".into()))
            .unwrap();

        let reloaded = PrefsStore::load(path);
        assert_eq!(reloaded.get().last_profile.as_deref(), Some("dev"));
    }

    #[test]
    fn invalid_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(PrefsStore::load(path).get(), Prefs::default());
    }

    #[test]
    fn in_memory_store_writes_nothing() {
        let store = PrefsStore::in_memory();
        let prefs = store.update(|p| p.last_profile = Some("x".into())).unwrap();
        assert_eq!(prefs.last_profile.as_deref(), Some("x"));
    }
}
