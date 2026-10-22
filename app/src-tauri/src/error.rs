//! The error type every command returns to the UI: `{ code, message, hint? }` (same as Frida).

use contrail_core::auth::AuthError;
use serde::Serialize;
use specta::Type;

/// A structured, user-actionable error. tauri-specta turns commands returning
/// `Result<T, ApiError>` into TS functions returning `{ status: "ok", data } | { status: "error", error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    /// What the user can do about it, when there is something useful to say.
    pub hint: Option<String>,
}

/// Lets the UI react to specific failures (e.g. offer "Log in" on `credentials`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    ProfileNotFound,
    NotSso,
    CliMissing,
    LoginFailed,
    Credentials,
    Aws,
    Config,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

/// `From` conversions let commands use `?` on core results: the error is converted to an
/// `ApiError` automatically (the compiler inserts the `.into()` call).
impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        let message = error.to_string();
        match error {
            AuthError::ProfileNotFound(_) => ApiError::new(ErrorCode::ProfileNotFound, message)
                .with_hint("Reload the profiles; the AWS config may have changed."),
            AuthError::NotSso(_) => ApiError::new(ErrorCode::NotSso, message),
            AuthError::CliMissing => ApiError::new(ErrorCode::CliMissing, message).with_hint(
                "Install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then try again.",
            ),
            AuthError::LoginFailed { .. } => ApiError::new(ErrorCode::LoginFailed, message)
                .with_hint("Check the login output above, or run `aws sso login` in a terminal."),
            AuthError::Credentials { profile, .. } => ApiError::new(ErrorCode::Credentials, message)
                .with_hint(format!("Log in again (aws sso login --profile {profile}).")),
            AuthError::Aws(_) => ApiError::new(ErrorCode::Aws, message),
            AuthError::Config(_) => ApiError::new(ErrorCode::Config, message)
                .with_hint("Check ~/.aws/config (or AWS_CONFIG_FILE)."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_errors_suggest_the_login_command() {
        let error = ApiError::from(AuthError::Credentials {
            profile: "dev".into(),
            message: "ExpiredToken".into(),
        });
        assert_eq!(error.code, ErrorCode::Credentials);
        assert_eq!(
            error.hint.as_deref(),
            Some("Log in again (aws sso login --profile dev).")
        );
    }

    #[test]
    fn serializes_for_the_frontend() {
        let json = serde_json::to_value(ApiError::from(AuthError::CliMissing)).unwrap();
        assert_eq!(json["code"], "cliMissing");
        assert!(json["hint"].as_str().unwrap().contains("AWS CLI v2"));
    }
}
