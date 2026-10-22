//! Mapping AWS SDK errors to Contrail's domain errors.

use aws_sdk_sts::error::{ProvideErrorMetadata, SdkError};
use aws_smithy_types::error::display::DisplayErrorContext;
use contrail_core::auth::AuthError;

/// Service error codes that mean "the credentials are no good", not "AWS had a problem".
const CREDENTIAL_ERROR_CODES: &[&str] = &[
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
    "AccessDeniedException",
    "AccessDenied",
];

/// Turns any SDK error into an [`AuthError`], telling credential problems apart from the rest.
///
/// Generic over the operation's error type `E`: the same function works for STS, ECS and
/// CloudWatch Logs calls. The `where` clause lists what the function needs from `E` (like a
/// bounded type parameter `<E extends …>` in Java).
pub(crate) fn map_sdk_error<E, R>(profile: &str, err: SdkError<E, R>) -> AuthError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug,
{
    let credentials = |message: String| AuthError::Credentials {
        profile: profile.to_owned(),
        message,
    };
    match &err {
        SdkError::ServiceError(service) => {
            let source = service.err();
            let message = source.message().unwrap_or("no message").to_owned();
            match source.code() {
                Some(code) if CREDENTIAL_ERROR_CODES.contains(&code) => {
                    credentials(format!("{code}: {message}"))
                }
                Some(code) => AuthError::Aws(format!("{code}: {message}")),
                None => AuthError::Aws(message),
            }
        }
        // Resolving credentials happens before the request is sent; when that fails (expired
        // SSO session, unknown profile, …) the SDK reports a dispatch failure that is neither an
        // I/O error nor a timeout.
        SdkError::DispatchFailure(failure) if !failure.is_io() && !failure.is_timeout() => {
            credentials(DisplayErrorContext(&err).to_string())
        }
        _ => AuthError::Aws(DisplayErrorContext(&err).to_string()),
    }
}
