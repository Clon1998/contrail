//! Locations of the shared AWS files and reading them.

use std::io;
use std::path::{Path, PathBuf};

use contrail_core::auth::AuthError;
use contrail_core::profile::{Profile, SsoSessionRef, parse_profiles};
use contrail_core::sso::{self, CachedToken};
use time::OffsetDateTime;

/// Where the AWS config, credentials and SSO token cache live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwsFiles {
    pub config: PathBuf,
    pub credentials: PathBuf,
    pub sso_cache_dir: PathBuf,
}

impl AwsFiles {
    /// The standard locations under `~/.aws`, honouring `AWS_CONFIG_FILE` and
    /// `AWS_SHARED_CREDENTIALS_FILE` like the AWS CLI and SDK do.
    pub fn from_env() -> Result<Self, AuthError> {
        let home = std::env::home_dir()
            .ok_or_else(|| AuthError::Config("can't determine the home directory".into()))?;
        let env_path = |var: &str| {
            std::env::var_os(var)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Ok(Self::resolve(
            &home,
            env_path("AWS_CONFIG_FILE"),
            env_path("AWS_SHARED_CREDENTIALS_FILE"),
        ))
    }

    /// Builds the paths from a home directory and optional overrides (testable without env vars).
    pub fn resolve(home: &Path, config: Option<PathBuf>, credentials: Option<PathBuf>) -> Self {
        let aws_dir = home.join(".aws");
        Self {
            config: config.unwrap_or_else(|| aws_dir.join("config")),
            credentials: credentials.unwrap_or_else(|| aws_dir.join("credentials")),
            sso_cache_dir: aws_dir.join("sso").join("cache"),
        }
    }

    /// Reads and resolves all profiles. A missing config file simply means "no profiles".
    pub fn load_profiles(&self) -> Result<Vec<Profile>, AuthError> {
        let config = read_optional(&self.config)?.unwrap_or_default();
        let credentials = read_optional(&self.credentials)?;
        Ok(parse_profiles(&config, credentials.as_deref()))
    }

    /// Reads the cached token of an SSO session; `None` when there is none (logged out).
    ///
    /// An unreadable cache file is logged and treated like a missing one: the fix is the same
    /// (log in again), and it shouldn't break the whole profile list.
    pub fn cached_token(
        &self,
        session: &SsoSessionRef<'_>,
        now: OffsetDateTime,
    ) -> Option<CachedToken> {
        let path = self.sso_cache_dir.join(sso::cache_file_name(session));
        let json = match read_optional(&path) {
            Ok(json) => json?,
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "can't read SSO token cache");
                return None;
            }
        };
        match sso::parse_cached_token(&json, now) {
            Ok(token) => Some(token),
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "ignoring invalid SSO token cache file");
                None
            }
        }
    }
}

/// Reads a text file, returning `Ok(None)` if it doesn't exist.
///
/// The `?` operator returns early with the error (like a checked exception propagating), but
/// only after `match` has turned the "not found" case into a normal value.
fn read_optional(path: &Path) -> Result<Option<String>, AuthError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AuthError::Config(format!("{}: {err}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contrail_core::sso::SessionStatus;
    use time::macros::datetime;

    const NOW: OffsetDateTime = datetime!(2026-10-22 12:00 UTC);

    fn files_in(dir: &Path) -> AwsFiles {
        AwsFiles::resolve(dir, None, None)
    }

    #[test]
    fn resolves_default_paths_and_overrides() {
        let home = Path::new("/home/someone");
        let files = AwsFiles::resolve(home, None, None);
        assert_eq!(files.config, home.join(".aws/config"));
        assert_eq!(files.credentials, home.join(".aws/credentials"));
        assert_eq!(files.sso_cache_dir, home.join(".aws/sso/cache"));

        let files = AwsFiles::resolve(home, Some("/etc/aws.cfg".into()), Some("/etc/creds".into()));
        assert_eq!(files.config, Path::new("/etc/aws.cfg"));
        assert_eq!(files.credentials, Path::new("/etc/creds"));
    }

    #[test]
    fn missing_files_mean_no_profiles() {
        let dir = tempfile::tempdir().unwrap();
        assert!(files_in(dir.path()).load_profiles().unwrap().is_empty());
    }

    #[test]
    fn loads_profiles_and_reads_their_token() {
        let dir = tempfile::tempdir().unwrap();
        let files = files_in(dir.path());
        std::fs::create_dir_all(&files.sso_cache_dir).unwrap();
        std::fs::write(
            &files.config,
            "[sso-session corp]\nsso_start_url = https://example.awsapps.com/start\nsso_region = eu-central-1\n\
             [profile dev]\nsso_session = corp\nsso_account_id = 111111111111\nsso_role_name = ReadOnly\n",
        )
        .unwrap();
        let session = SsoSessionRef {
            start_url: "https://example.awsapps.com/start",
            session_name: Some("corp"),
        };
        std::fs::write(
            files.sso_cache_dir.join(sso::cache_file_name(&session)),
            r#"{"expiresAt":"2026-10-22T13:00:00Z"}"#,
        )
        .unwrap();

        let profiles = files.load_profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        let token = files.cached_token(&profiles[0].auth.sso_session().unwrap(), NOW);
        assert_eq!(
            sso::session_status(token.as_ref(), NOW),
            SessionStatus::Valid {
                expires_at: datetime!(2026-10-22 13:00 UTC)
            }
        );
    }

    #[test]
    fn invalid_or_missing_token_counts_as_logged_out() {
        let dir = tempfile::tempdir().unwrap();
        let files = files_in(dir.path());
        let session = SsoSessionRef {
            start_url: "https://example.awsapps.com/start",
            session_name: Some("corp"),
        };
        assert_eq!(files.cached_token(&session, NOW), None);

        std::fs::create_dir_all(&files.sso_cache_dir).unwrap();
        std::fs::write(
            files.sso_cache_dir.join(sso::cache_file_name(&session)),
            "garbage",
        )
        .unwrap();
        assert_eq!(files.cached_token(&session, NOW), None);
    }
}
