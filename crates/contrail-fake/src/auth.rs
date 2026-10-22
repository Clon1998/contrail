//! A fake [`AuthProvider`] for demo mode and tests: a fixed set of profiles in every session state.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use contrail_core::auth::{AuthError, AuthProvider, AwsCtx, CallerIdentity, LoginProgress};
use contrail_core::error::SourceError;
use contrail_core::profile::{Profile, ProfileAuth};
use contrail_core::sso::{CachedToken, SessionStatus, session_status};
use time::{Duration, OffsetDateTime};

const START_URL: &str = "https://demo-corp.awsapps.com/start";

/// Demo profiles with their initial session state, simulated in memory.
pub struct FakeAuth {
    profiles: Vec<Profile>,
    /// The simulated SSO token cache: profile name → cached token.
    ///
    /// `Mutex` gives interior mutability: `login(&self)` only has a shared reference, yet must
    /// change the map. The lock makes that safe across threads (like `synchronized` in Java).
    /// A `std::sync::Mutex` is fine here because the lock is never held across an `.await`.
    tokens: Mutex<HashMap<String, CachedToken>>,
    /// How long the simulated `aws sso login` takes (zero in tests).
    login_delay: StdDuration,
}

impl FakeAuth {
    /// The demo setup, with a short pause during login so the UI shows its progress state.
    pub fn new() -> Self {
        Self::with_login_delay(StdDuration::from_millis(1500))
    }

    pub fn with_login_delay(login_delay: StdDuration) -> Self {
        let now = OffsetDateTime::now_utc();
        let sso = |account_id: &str, role_name: &str| ProfileAuth::Sso {
            account_id: account_id.to_owned(),
            role_name: role_name.to_owned(),
            start_url: START_URL.to_owned(),
            sso_region: "eu-central-1".to_owned(),
            session_name: Some("demo-corp".to_owned()),
        };
        let profile = |name: &str, region: &str, auth: ProfileAuth| Profile {
            name: name.to_owned(),
            region: Some(region.to_owned()),
            auth,
        };

        let profiles = vec![
            profile("demo-dev", "eu-central-1", sso("111122223333", "ReadOnly")),
            profile(
                "demo-staging",
                "eu-central-1",
                sso("222233334444", "ReadOnly"),
            ),
            profile("demo-prod", "eu-west-1", sso("333344445555", "ReadOnly")),
            profile("demo-sandbox", "us-east-1", sso("444455556666", "Admin")),
            profile("demo-keys", "eu-central-1", ProfileAuth::StaticKeys),
            profile(
                "demo-broken",
                "eu-central-1",
                ProfileAuth::Misconfigured {
                    problem: "sso_session \"gone\" has no [sso-session gone] section".to_owned(),
                },
            ),
        ];

        let token = |expires_in: Duration, can_refresh: bool| CachedToken {
            expires_at: now + expires_in,
            can_refresh,
        };
        let tokens = HashMap::from([
            ("demo-dev".to_owned(), token(Duration::hours(7), true)),
            (
                "demo-staging".to_owned(),
                token(Duration::minutes(9), false),
            ),
            ("demo-prod".to_owned(), token(-Duration::hours(2), false)),
            // demo-sandbox: no token, i.e. logged out.
        ]);

        Self {
            profiles,
            tokens: Mutex::new(tokens),
            login_delay,
        }
    }

    fn profile(&self, name: &str) -> Result<&Profile, AuthError> {
        self.profiles
            .iter()
            .find(|p| p.name == name)
            .ok_or_else(|| AuthError::ProfileNotFound(name.to_owned()))
    }

    fn status_now(&self, profile: &Profile) -> SessionStatus {
        if profile.auth.sso_session().is_none() {
            return SessionStatus::NotSso;
        }
        let tokens = self.tokens.lock().expect("token lock poisoned");
        session_status(tokens.get(&profile.name), OffsetDateTime::now_utc())
    }
}

impl FakeAuth {
    /// What an AWS call with this profile's credentials would see: the account ID, or the error
    /// AWS would return for missing/expired credentials. Shared with the fake ECS and Logs sources.
    pub fn check_credentials(&self, profile: &str) -> Result<String, SourceError> {
        let profile = self
            .profile(profile)
            .map_err(|_| SourceError::Config(format!("profile \"{profile}\" not found")))?;
        let account = match &profile.auth {
            ProfileAuth::Sso { account_id, .. } => account_id.clone(),
            ProfileAuth::Misconfigured { problem } => {
                return Err(SourceError::Config(problem.clone()));
            }
            _ => "999988887777".to_owned(),
        };
        match self.status_now(profile) {
            SessionStatus::Expired { .. } | SessionStatus::LoggedOut => {
                Err(SourceError::Credentials {
                    profile: profile.name.clone(),
                    message: "the SSO session has expired or doesn't exist".to_owned(),
                })
            }
            _ => Ok(account),
        }
    }
}

impl Default for FakeAuth {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AuthProvider for FakeAuth {
    async fn list_profiles(&self) -> Result<Vec<Profile>, AuthError> {
        Ok(self.profiles.clone())
    }

    async fn session_status(&self, profile: &str) -> Result<SessionStatus, AuthError> {
        Ok(self.status_now(self.profile(profile)?))
    }

    async fn caller_identity(&self, ctx: &AwsCtx) -> Result<CallerIdentity, AuthError> {
        let account = self.check_credentials(&ctx.profile)?;
        Ok(CallerIdentity {
            arn: format!("arn:aws:sts::{account}:assumed-role/DemoReadOnly/demo.user"),
            user_id: "AROADEMOEXAMPLE:demo.user".to_owned(),
            account,
        })
    }

    async fn login(
        &self,
        profile: &str,
        progress: &(dyn Fn(LoginProgress) + Send + Sync),
    ) -> Result<(), AuthError> {
        let profile = self.profile(profile)?;
        if profile.auth.sso_session().is_none() {
            return Err(AuthError::NotSso(profile.name.clone()));
        }
        for line in [
            "Attempting to automatically open the SSO authorization page in your default browser.",
            "Demo mode: no browser opens, the login completes by itself.",
        ] {
            progress(LoginProgress::Output { line: line.into() });
        }
        tokio::time::sleep(self.login_delay).await;

        let token = CachedToken {
            expires_at: OffsetDateTime::now_utc() + Duration::hours(8),
            can_refresh: true,
        };
        self.tokens
            .lock()
            .expect("token lock poisoned")
            .insert(profile.name.clone(), token);
        progress(LoginProgress::Output {
            line: format!("Successfully logged into Start URL: {START_URL}"),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake() -> FakeAuth {
        FakeAuth::with_login_delay(StdDuration::ZERO)
    }

    fn ctx(profile: &str) -> AwsCtx {
        AwsCtx {
            profile: profile.to_owned(),
            region: None,
        }
    }

    #[tokio::test]
    async fn covers_every_session_state() {
        let auth = fake();
        let mut states = Vec::new();
        for p in auth.list_profiles().await.unwrap() {
            let status = auth.session_status(&p.name).await.unwrap();
            // Serialize to get just the `state` tag, ignoring timestamps.
            let json = serde_json::to_value(&status).unwrap();
            states.push((p.name, json["state"].as_str().unwrap().to_owned()));
        }
        let expected = [
            ("demo-dev", "valid"),
            ("demo-staging", "expiringSoon"),
            ("demo-prod", "expired"),
            ("demo-sandbox", "loggedOut"),
            ("demo-keys", "notSso"),
            ("demo-broken", "notSso"),
        ];
        let expected: Vec<(String, String)> = expected
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(states, expected);
    }

    #[tokio::test]
    async fn login_makes_an_expired_session_valid() {
        let auth = fake();
        assert!(matches!(
            auth.caller_identity(&ctx("demo-prod")).await,
            Err(AuthError::Credentials { .. })
        ));

        let lines = Mutex::new(Vec::new());
        auth.login("demo-prod", &|p| lines.lock().unwrap().push(p))
            .await
            .unwrap();

        assert!(matches!(
            auth.session_status("demo-prod").await.unwrap(),
            SessionStatus::Valid { .. }
        ));
        let identity = auth.caller_identity(&ctx("demo-prod")).await.unwrap();
        assert_eq!(identity.account, "333344445555");
        assert_eq!(lines.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn login_rejects_unknown_and_non_sso_profiles() {
        let auth = fake();
        let ignore = |_: LoginProgress| {};
        assert_eq!(
            auth.login("nope", &ignore).await,
            Err(AuthError::ProfileNotFound("nope".into()))
        );
        assert_eq!(
            auth.login("demo-keys", &ignore).await,
            Err(AuthError::NotSso("demo-keys".into()))
        );
    }
}
