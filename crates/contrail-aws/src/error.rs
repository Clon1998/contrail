//! Mapping AWS SDK errors to Contrail's domain errors.

use aws_sdk_sts::error::{ProvideErrorMetadata, SdkError};
use aws_smithy_types::error::display::DisplayErrorContext;
use contrail_core::error::SourceError;

/// Service error codes that mean "the credentials are no good", not "AWS had a problem".
const CREDENTIAL_ERROR_CODES: &[&str] = &[
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
];

/// Codes for a missing IAM permission.
const ACCESS_DENIED_CODES: &[&str] = &["AccessDeniedException", "AccessDenied"];

/// Turns any SDK error into a [`SourceError`], telling credential problems apart from the rest.
///
/// Generic over the operation's error type `E`: the same function works for STS, ECS and
/// CloudWatch Logs calls. The `where` clause lists what the function needs from `E` (like a
/// bounded type parameter `<E extends …>` in Java).
pub(crate) fn map_sdk_error<E, R>(profile: &str, err: SdkError<E, R>) -> SourceError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + 'static,
{
    let credentials = |message: String| SourceError::Credentials {
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
                Some(code) if ACCESS_DENIED_CODES.contains(&code) => {
                    SourceError::AccessDenied(format!("{code}: {message}"))
                }
                Some(code) => SourceError::Aws(format!("{code}: {message}")),
                None => SourceError::Aws(message),
            }
        }
        // Resolving credentials happens before the request is sent; when that fails (expired
        // SSO session, unknown profile, …) the SDK reports a dispatch failure that is neither an
        // I/O error nor a timeout. The full chain (with debug dumps of HTTP responses) is only
        // useful in the log; the user sees the innermost cause, e.g. "Session token not found".
        SdkError::DispatchFailure(failure) if !failure.is_io() && !failure.is_timeout() => {
            tracing::debug!(profile, error = %DisplayErrorContext(&err), "credentials failed");
            credentials(root_cause(&err))
        }
        _ => SourceError::Aws(DisplayErrorContext(&err).to_string()),
    }
}

/// The `Display` text of the last error in the `source()` chain (the most specific one).
///
/// `std::error::Error::source()` is Rust's counterpart of Java's `Throwable.getCause()`;
/// `successors` keeps calling it until it returns `None`, like walking `getCause()` in a loop.
fn root_cause(err: &(dyn std::error::Error + 'static)) -> String {
    std::iter::successors(Some(err), |e| e.source())
        .last()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_sts::error::ConnectorError;
    use aws_sdk_sts::operation::get_caller_identity::GetCallerIdentityError;

    /// An error with an optional cause, to build chains like the SDK's credential providers do.
    #[derive(Debug)]
    struct Chained(&'static str, Option<Box<Chained>>);

    impl std::fmt::Display for Chained {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Chained {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref().map(|e| e as _)
        }
    }

    #[test]
    fn credential_failures_report_only_the_root_cause() {
        let cause = Chained(
            "an error occurred while loading credentials",
            Some(Box::new(Chained(
                "service error",
                Some(Box::new(Chained(
                    "UnauthorizedException: Session token not found or invalid",
                    None,
                ))),
            ))),
        );
        let err: SdkError<GetCallerIdentityError, ()> =
            SdkError::dispatch_failure(ConnectorError::other(Box::new(cause), None));

        assert_eq!(
            map_sdk_error("dev", err),
            SourceError::Credentials {
                profile: "dev".into(),
                message: "UnauthorizedException: Session token not found or invalid".into(),
            }
        );
    }
}
