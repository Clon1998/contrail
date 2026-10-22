//! SSO session state, derived from the AWS SSO token cache (`~/.aws/sso/cache/*.json`).
//!
//! `aws sso login` writes one JSON file per session. Its name is the SHA-1 of the
//! `[sso-session]` name (or, for legacy profiles, of the start URL). Contrail only reads the
//! expiry fields; tokens are never kept or sent anywhere.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use specta::Type;
use time::{Duration, OffsetDateTime};

use crate::profile::SsoSessionRef;

/// Below this remaining lifetime a session that can't refresh itself counts as "expiring soon".
pub const EXPIRING_SOON: Duration = Duration::minutes(15);

/// The state of a profile's SSO session, as shown in the profile switcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionStatus {
    /// The access token is valid until `expires_at`.
    Valid {
        #[serde(with = "time::serde::rfc3339")]
        #[specta(type = String)]
        expires_at: OffsetDateTime,
    },
    /// Valid, but ends within [`EXPIRING_SOON`] and can't be refreshed automatically.
    ExpiringSoon {
        #[serde(with = "time::serde::rfc3339")]
        #[specta(type = String)]
        expires_at: OffsetDateTime,
    },
    /// The access token has expired, but the cache holds a refresh token, so the SDK will most
    /// likely get a new one without a login. (Only a real call, e.g. GetCallerIdentity, can tell
    /// for sure: the session itself may have ended.)
    Refreshable,
    /// The token has expired and can't be refreshed: `aws sso login` is needed.
    Expired {
        #[serde(with = "time::serde::rfc3339")]
        #[specta(type = String)]
        expired_at: OffsetDateTime,
    },
    /// There is no cached token for this session (never logged in, or logged out).
    LoggedOut,
    /// The profile doesn't use SSO; Contrail can't tell whether its credentials are valid.
    NotSso,
}

/// The parts of a cached SSO token that matter for the session state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedToken {
    pub expires_at: OffsetDateTime,
    /// A refresh token and a client registration that hasn't expired yet.
    pub can_refresh: bool,
}

/// A token cache file that couldn't be understood.
#[derive(Debug, thiserror::Error)]
pub enum TokenCacheError {
    #[error("invalid token cache JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid timestamp {0:?} in token cache")]
    Timestamp(String),
}

/// The file name of a session's entry in `~/.aws/sso/cache/`.
pub fn cache_file_name(session: &SsoSessionRef<'_>) -> String {
    let key = session.session_name.unwrap_or(session.start_url);
    let digest = Sha1::digest(key.as_bytes());
    let mut name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    name.push_str(".json");
    name
}

/// Reads the expiry fields of a token cache file.
pub fn parse_cached_token(json: &str, now: OffsetDateTime) -> Result<CachedToken, TokenCacheError> {
    /// The subset of the cache file Contrail looks at. Unknown fields (including the tokens
    /// themselves) are skipped by serde without being stored.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawToken {
        expires_at: String,
        #[serde(default)]
        refresh_token: Option<serde::de::IgnoredAny>,
        #[serde(default)]
        registration_expires_at: Option<String>,
    }

    let raw: RawToken = serde_json::from_str(json)?;
    let expires_at = parse_timestamp(&raw.expires_at)?;
    let registration_valid = match raw.registration_expires_at {
        Some(ts) => parse_timestamp(&ts)? > now,
        None => false,
    };
    Ok(CachedToken {
        expires_at,
        can_refresh: raw.refresh_token.is_some() && registration_valid,
    })
}

/// Derives the session state from the cached token (if there is one) at time `now`.
///
/// `now` is a parameter rather than read from the clock, so tests are deterministic.
pub fn session_status(token: Option<&CachedToken>, now: OffsetDateTime) -> SessionStatus {
    let Some(token) = token else {
        return SessionStatus::LoggedOut;
    };
    let expires_at = token.expires_at;
    match (expires_at > now, token.can_refresh) {
        (true, true) => SessionStatus::Valid { expires_at },
        (true, false) if expires_at - now <= EXPIRING_SOON => {
            SessionStatus::ExpiringSoon { expires_at }
        }
        (true, false) => SessionStatus::Valid { expires_at },
        (false, true) => SessionStatus::Refreshable,
        (false, false) => SessionStatus::Expired {
            expired_at: expires_at,
        },
    }
}

/// Parses RFC 3339 timestamps, plus the `2026-10-22T20:00:00UTC` form older CLI versions wrote.
fn parse_timestamp(value: &str) -> Result<OffsetDateTime, TokenCacheError> {
    use time::format_description::well_known::Rfc3339;
    let normalized = match value.strip_suffix("UTC") {
        Some(prefix) => format!("{prefix}Z"),
        None => value.to_owned(),
    };
    OffsetDateTime::parse(&normalized, &Rfc3339)
        .map_err(|_| TokenCacheError::Timestamp(value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    const NOW: OffsetDateTime = datetime!(2026-10-22 12:00 UTC);

    fn token(expires_at: OffsetDateTime, can_refresh: bool) -> CachedToken {
        CachedToken {
            expires_at,
            can_refresh,
        }
    }

    #[test]
    fn cache_file_name_is_sha1_of_session_name_or_start_url() {
        // SHA-1("abc") is a well-known test vector.
        let by_session = SsoSessionRef {
            start_url: "https://ignored.example.com/start",
            session_name: Some("abc"),
        };
        assert_eq!(
            cache_file_name(&by_session),
            "a9993e364706816aba3e25717850c26c9cd0d89d.json"
        );
        let legacy = SsoSessionRef {
            start_url: "abc",
            session_name: None,
        };
        assert_eq!(
            cache_file_name(&legacy),
            "a9993e364706816aba3e25717850c26c9cd0d89d.json"
        );
    }

    #[test]
    fn parses_cache_file_with_refresh_token() {
        let json = r#"{
            "startUrl": "https://example.awsapps.com/start",
            "region": "eu-central-1",
            "accessToken": "secret",
            "expiresAt": "2026-10-22T13:00:00Z",
            "clientId": "id",
            "clientSecret": "secret",
            "registrationExpiresAt": "2027-01-01T00:00:00Z",
            "refreshToken": "secret"
        }"#;
        let token = parse_cached_token(json, NOW).unwrap();
        assert_eq!(token.expires_at, datetime!(2026-10-22 13:00 UTC));
        assert!(token.can_refresh);
    }

    #[test]
    fn legacy_cache_file_cannot_refresh_and_may_use_utc_suffix() {
        let json = r#"{"startUrl":"u","region":"r","accessToken":"t","expiresAt":"2026-10-22T13:00:00UTC"}"#;
        let token = parse_cached_token(json, NOW).unwrap();
        assert_eq!(token.expires_at, datetime!(2026-10-22 13:00 UTC));
        assert!(!token.can_refresh);
    }

    #[test]
    fn expired_registration_means_no_refresh() {
        let json = r#"{"expiresAt":"2026-10-22T13:00:00Z","refreshToken":"t","registrationExpiresAt":"2026-10-01T00:00:00Z"}"#;
        assert!(!parse_cached_token(json, NOW).unwrap().can_refresh);
    }

    #[test]
    fn rejects_bad_timestamps_and_json() {
        assert!(matches!(
            parse_cached_token(r#"{"expiresAt":"tomorrow"}"#, NOW),
            Err(TokenCacheError::Timestamp(_))
        ));
        assert!(matches!(
            parse_cached_token("not json", NOW),
            Err(TokenCacheError::Json(_))
        ));
    }

    #[test]
    fn status_without_token_is_logged_out() {
        assert_eq!(session_status(None, NOW), SessionStatus::LoggedOut);
    }

    #[test]
    fn status_follows_expiry_and_refreshability() {
        let in_1h = datetime!(2026-10-22 13:00 UTC);
        let in_10m = datetime!(2026-10-22 12:10 UTC);
        let ago_1h = datetime!(2026-10-22 11:00 UTC);

        assert_eq!(
            session_status(Some(&token(in_1h, false)), NOW),
            SessionStatus::Valid { expires_at: in_1h }
        );
        assert_eq!(
            session_status(Some(&token(in_10m, false)), NOW),
            SessionStatus::ExpiringSoon { expires_at: in_10m }
        );
        // A refreshable session is never "expiring soon": the SDK renews it.
        assert_eq!(
            session_status(Some(&token(in_10m, true)), NOW),
            SessionStatus::Valid { expires_at: in_10m }
        );
        assert_eq!(
            session_status(Some(&token(ago_1h, true)), NOW),
            SessionStatus::Refreshable
        );
        assert_eq!(
            session_status(Some(&token(ago_1h, false)), NOW),
            SessionStatus::Expired { expired_at: ago_1h }
        );
    }

    #[test]
    fn serializes_for_the_frontend() {
        let json = serde_json::to_string(&SessionStatus::Expired {
            expired_at: datetime!(2026-10-22 11:00 UTC),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"state":"expired","expiredAt":"2026-10-22T11:00:00Z"}"#
        );
    }
}
