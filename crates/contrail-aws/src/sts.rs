//! SDK configuration per profile and the `sts:GetCallerIdentity` check.

use aws_config::{BehaviorVersion, Region, SdkConfig};
use contrail_core::auth::{AuthError, AwsCtx, CallerIdentity};

use crate::error::map_sdk_error;

/// STS is a global service, so any region works when a profile doesn't set one.
const FALLBACK_REGION: &str = "us-east-1";

/// Loads the SDK configuration (credentials, region) for a profile + region override.
///
/// Credentials are resolved lazily by the SDK, on the first call. It reads the SSO token
/// cache itself; Contrail never handles credentials.
pub(crate) async fn sdk_config(ctx: &AwsCtx) -> SdkConfig {
    let mut loader = aws_config::defaults(BehaviorVersion::latest()).profile_name(&ctx.profile);
    if let Some(region) = &ctx.region {
        loader = loader.region(Region::new(region.clone()));
    }
    loader.load().await
}

/// Builds an STS client for `ctx`, falling back to a default region if none is configured.
pub(crate) async fn sts_client(ctx: &AwsCtx) -> aws_sdk_sts::Client {
    let config = sdk_config(ctx).await;
    let mut builder = aws_sdk_sts::config::Builder::from(&config);
    if config.region().is_none() {
        builder = builder.region(Region::from_static(FALLBACK_REGION));
    }
    aws_sdk_sts::Client::from_conf(builder.build())
}

/// Calls `sts:GetCallerIdentity` (read-only, needs no IAM permission) and maps the answer.
pub(crate) async fn caller_identity(
    client: &aws_sdk_sts::Client,
    profile: &str,
) -> Result<CallerIdentity, AuthError> {
    let output = client
        .get_caller_identity()
        .send()
        .await
        .map_err(|err| AuthError::from(map_sdk_error(profile, err)))?;
    // The SDK models every field as optional; STS always returns all three.
    let field = |value: Option<&str>| value.unwrap_or_default().to_owned();
    Ok(CallerIdentity {
        account: field(output.account()),
        arn: field(output.arn()),
        user_id: field(output.user_id()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_sts::Client;
    use aws_sdk_sts::operation::get_caller_identity::{
        GetCallerIdentityError, GetCallerIdentityOutput,
    };
    use aws_smithy_mocks::{mock, mock_client};
    use aws_smithy_types::error::ErrorMetadata;

    fn service_error(code: &str) -> GetCallerIdentityError {
        GetCallerIdentityError::generic(
            ErrorMetadata::builder()
                .code(code)
                .message("something went wrong")
                .build(),
        )
    }

    #[tokio::test]
    async fn maps_the_identity() {
        let rule = mock!(Client::get_caller_identity).then_output(|| {
            GetCallerIdentityOutput::builder()
                .account("111122223333")
                .arn("arn:aws:sts::111122223333:assumed-role/ReadOnly/someone")
                .user_id("AROAEXAMPLE:someone")
                .build()
        });
        let client = mock_client!(aws_sdk_sts, [&rule]);

        let identity = caller_identity(&client, "dev").await.unwrap();

        assert_eq!(
            identity,
            CallerIdentity {
                account: "111122223333".into(),
                arn: "arn:aws:sts::111122223333:assumed-role/ReadOnly/someone".into(),
                user_id: "AROAEXAMPLE:someone".into(),
            }
        );
        assert_eq!(rule.num_calls(), 1);
    }

    #[tokio::test]
    async fn expired_token_is_a_credentials_error() {
        let rule = mock!(Client::get_caller_identity).then_error(|| service_error("ExpiredToken"));
        let client = mock_client!(aws_sdk_sts, [&rule]);

        assert_eq!(
            caller_identity(&client, "dev").await,
            Err(AuthError::Credentials {
                profile: "dev".into(),
                message: "ExpiredToken: something went wrong".into(),
            })
        );
    }

    #[tokio::test]
    async fn other_service_errors_are_aws_errors() {
        let rule = mock!(Client::get_caller_identity).then_error(|| service_error("Throttling"));
        let client = mock_client!(aws_sdk_sts, [&rule]);

        assert_eq!(
            caller_identity(&client, "dev").await,
            Err(AuthError::Aws("Throttling: something went wrong".into()))
        );
    }
}
