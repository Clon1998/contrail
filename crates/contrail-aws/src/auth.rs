//! The real [`AuthProvider`]: local AWS files, STS and the AWS CLI.

use async_trait::async_trait;
use contrail_core::auth::{
    AuthError, AuthProvider, AwsCtx, CallerIdentity, LoginMethod, LoginProgress,
};
use contrail_core::profile::{Profile, ProfileAuth};
use contrail_core::sso::{SessionStatus, session_status};
use time::OffsetDateTime;

use crate::files::AwsFiles;
use crate::sso_device::{self, DeviceLogin};
use crate::{cli, sts};

/// Authentication against the real AWS setup of this machine.
pub struct AwsAuth {
    files: AwsFiles,
}

impl AwsAuth {
    pub fn new(files: AwsFiles) -> Self {
        Self { files }
    }

    fn find_profile(&self, name: &str) -> Result<Profile, AuthError> {
        self.files
            .load_profiles()?
            .into_iter()
            .find(|p| p.name == name)
            .ok_or_else(|| AuthError::ProfileNotFound(name.to_owned()))
    }
}

#[async_trait]
impl AuthProvider for AwsAuth {
    async fn list_profiles(&self) -> Result<Vec<Profile>, AuthError> {
        self.files.load_profiles()
    }

    async fn session_status(&self, profile: &str) -> Result<SessionStatus, AuthError> {
        let profile = self.find_profile(profile)?;
        let Some(session) = profile.auth.sso_session() else {
            return Ok(SessionStatus::NotSso);
        };
        let now = OffsetDateTime::now_utc();
        Ok(session_status(
            self.files.cached_token(&session, now).as_ref(),
            now,
        ))
    }

    async fn caller_identity(&self, ctx: &AwsCtx) -> Result<CallerIdentity, AuthError> {
        // Fail early with a clear message instead of an SDK error for unknown profiles.
        self.find_profile(&ctx.profile)?;
        let client = sts::sts_client(ctx).await;
        sts::caller_identity(&client, &ctx.profile).await
    }

    /// `aws sso login` when the CLI is installed (and `method` allows it), otherwise the built-in
    /// device flow, which writes the token to the CLI's cache itself.
    async fn login(
        &self,
        profile: &str,
        method: LoginMethod,
        progress: &(dyn Fn(LoginProgress) + Send + Sync),
    ) -> Result<(), AuthError> {
        let profile = self.find_profile(profile)?;
        let (
            ProfileAuth::Sso {
                start_url,
                sso_region,
                session_name,
                ..
            },
            Some(session),
        ) = (&profile.auth, profile.auth.sso_session())
        else {
            return Err(AuthError::NotSso(profile.name));
        };
        let cli = match method {
            LoginMethod::Auto => cli::find_aws_cli(),
            LoginMethod::BuiltIn => None,
        };
        if let Some(aws) = cli {
            return cli::sso_login(&aws, &profile.name, progress).await;
        }
        let login = DeviceLogin {
            start_url: start_url.clone(),
            region: sso_region.clone(),
            refreshable: session_name.is_some(),
        };
        let client = sso_device::oidc_client(sso_region).await;
        let token = sso_device::device_login(&client, &login, progress).await?;
        let path = self.files.write_cached_token(&session, &token)?;
        progress(LoginProgress::Output {
            line: format!(
                "Logged in. The token is in {} (shared with the AWS CLI).",
                path.display()
            ),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_with_config(config: &str) -> (tempfile::TempDir, AwsAuth) {
        let dir = tempfile::tempdir().unwrap();
        let files = AwsFiles::resolve(dir.path(), None, None);
        std::fs::create_dir_all(dir.path().join(".aws")).unwrap();
        std::fs::write(&files.config, config).unwrap();
        (dir, AwsAuth::new(files))
    }

    #[tokio::test]
    async fn status_of_non_sso_and_unknown_profiles() {
        let (_dir, auth) = auth_with_config("[profile keys]\naws_access_key_id = AKIAEXAMPLE\n");
        assert_eq!(auth.session_status("keys").await, Ok(SessionStatus::NotSso));
        assert_eq!(
            auth.session_status("nope").await,
            Err(AuthError::ProfileNotFound("nope".into()))
        );
    }

    #[tokio::test]
    async fn sso_profile_without_token_is_logged_out() {
        let (_dir, auth) = auth_with_config(
            "[profile dev]\nsso_start_url = https://example.awsapps.com/start\nsso_region = eu-central-1\n\
             sso_account_id = 111111111111\nsso_role_name = ReadOnly\n",
        );
        assert_eq!(
            auth.session_status("dev").await,
            Ok(SessionStatus::LoggedOut)
        );
    }

    #[tokio::test]
    async fn login_refuses_non_sso_profiles_before_looking_for_the_cli() {
        let (_dir, auth) = auth_with_config("[profile keys]\naws_access_key_id = AKIAEXAMPLE\n");
        assert_eq!(
            auth.login("keys", LoginMethod::Auto, &|_| {}).await,
            Err(AuthError::NotSso("keys".into()))
        );
    }
}
