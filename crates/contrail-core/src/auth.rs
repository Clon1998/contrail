//! The authentication port: listing profiles, session state, login and identity checks.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::SourceError;
use crate::profile::Profile;
use crate::sso::SessionStatus;

/// Which AWS account and region a call goes to: a profile name plus an optional region override.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AwsCtx {
    pub profile: String,
    /// Overrides the profile's own region; `None` uses the profile's (or the SDK default).
    pub region: Option<String>,
}

/// Who the credentials of a profile belong to (`sts:GetCallerIdentity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub account: String,
    pub arn: String,
    pub user_id: String,
}

/// Progress of a running SSO login, streamed to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoginProgress {
    /// One line the login process printed (it contains the URL and code to use when the
    /// browser doesn't open by itself).
    Output { line: String },
    /// The built-in login waits for the user to confirm `code` on the page `url` (the app opens
    /// it in the browser).
    Device { url: String, code: String },
}

/// How to log in to an SSO profile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LoginMethod {
    /// `aws sso login` when the AWS CLI is installed, the built-in login otherwise.
    #[default]
    Auto,
    /// Always the built-in login (the device flow), even with the CLI installed.
    BuiltIn,
}

/// Everything that can go wrong in an [`AuthProvider`].
///
/// `thiserror` derives `std::error::Error` and the `Display` text from the `#[error]`
/// attributes, roughly what a Java exception hierarchy with message templates gives you.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("profile \"{0}\" not found in the AWS config")]
    ProfileNotFound(String),
    #[error("profile \"{0}\" doesn't use AWS SSO, so Contrail can't log in for it")]
    NotSso(String),
    #[error("the AWS CLI (`aws`) was not found")]
    CliMissing,
    #[error("`aws sso login` failed{}", exit_code.map(|c| format!(" (exit code {c})")).unwrap_or_default())]
    LoginFailed { exit_code: Option<i32> },
    /// The built-in login didn't finish (denied, timed out, or IAM Identity Center refused it).
    #[error("SSO login failed: {0}")]
    DeviceLoginFailed(String),
    #[error("no valid credentials for profile \"{profile}\": {message}")]
    Credentials { profile: String, message: String },
    #[error("AWS error: {0}")]
    Aws(String),
    #[error("can't read the AWS configuration: {0}")]
    Config(String),
}

/// The AWS-call errors of a source are auth errors too (e.g. GetCallerIdentity).
impl From<SourceError> for AuthError {
    fn from(error: SourceError) -> Self {
        match error {
            SourceError::Credentials { profile, message } => {
                AuthError::Credentials { profile, message }
            }
            SourceError::Aws(message)
            | SourceError::NotFound(message)
            | SourceError::AccessDenied(message) => AuthError::Aws(message),
            SourceError::Config(message) => AuthError::Config(message),
        }
    }
}

/// Where profiles, sessions and identities come from: the real AWS setup or the demo fake.
///
/// This is Contrail's equivalent of a Java interface with two implementations
/// (`contrail-aws` and `contrail-fake`); the app picks one at start-up and only ever talks to
/// this trait.
///
/// Why `#[async_trait]`: Rust supports `async fn` in traits natively, but such traits can't be
/// used as *trait objects* (`dyn AuthProvider`) yet, and the app needs exactly that to choose the
/// implementation at runtime. The macro rewrites each `async fn` into a normal method returning a
/// boxed future, which works with `dyn`. The cost (one heap allocation per call) doesn't matter
/// for these infrequent calls.
///
/// `Send + Sync` promise that an implementation can be shared between threads, which Tauri
/// requires for anything in its managed state.
#[async_trait]
pub trait AuthProvider: Send + Sync {
    /// All profiles of the AWS config, sorted by name with `default` first.
    async fn list_profiles(&self) -> Result<Vec<Profile>, AuthError>;

    /// The SSO session state of one profile.
    async fn session_status(&self, profile: &str) -> Result<SessionStatus, AuthError>;

    /// Calls `sts:GetCallerIdentity` to prove the credentials work.
    async fn caller_identity(&self, ctx: &AwsCtx) -> Result<CallerIdentity, AuthError>;

    /// Runs the SSO login for `profile` (see [`LoginMethod`]) and returns once it has finished.
    ///
    /// `progress` is a borrowed callback (`&dyn Fn`): the caller keeps ownership, the provider
    /// may call it any number of times while the login runs.
    async fn login(
        &self,
        profile: &str,
        method: LoginMethod,
        progress: &(dyn Fn(LoginProgress) + Send + Sync),
    ) -> Result<(), AuthError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_failed_message_includes_exit_code_when_known() {
        assert_eq!(
            AuthError::LoginFailed { exit_code: Some(2) }.to_string(),
            "`aws sso login` failed (exit code 2)"
        );
        assert_eq!(
            AuthError::LoginFailed { exit_code: None }.to_string(),
            "`aws sso login` failed"
        );
    }

    #[test]
    fn login_progress_serializes_as_tagged_union() {
        let json = serde_json::to_string(&LoginProgress::Output {
            line: "Then enter the code:".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"output","line":"Then enter the code:"}"#);
    }
}
