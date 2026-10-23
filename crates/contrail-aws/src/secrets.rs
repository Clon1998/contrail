//! Secret values from Secrets Manager and SSM Parameter Store, read only on explicit request.
//!
//! The values pass through here to the UI and are never logged: errors carry AWS's messages, not
//! values, and nothing is cached except the SDK clients.

use async_trait::async_trait;
use aws_sdk_secretsmanager::Client as SecretsClient;
use aws_sdk_ssm::Client as ParametersClient;
use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::secrets::{SecretLocation, SecretSource, parse_value_from, pick_json_key};

use crate::clients::ClientCache;
use crate::error::map_sdk_error;

/// [`SecretSource`] backed by the AWS SDK, with clients per profile + region.
#[derive(Default)]
pub struct AwsSecrets {
    secrets: ClientCache<SecretsClient>,
    parameters: ClientCache<ParametersClient>,
}

impl AwsSecrets {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl SecretSource for AwsSecrets {
    async fn reveal(&self, ctx: &AwsCtx, value_from: &str) -> Result<String, SourceError> {
        // A reference's ARN names its region, which can differ from the view's.
        let in_region = |region: Option<String>| AwsCtx {
            profile: ctx.profile.clone(),
            region: region.or_else(|| ctx.region.clone()),
        };
        let location = parse_value_from(value_from);
        // Matching on `&location` only borrows it; once `region` is no longer used, the borrow
        // ends and `location` can be moved into `read_secret` (the compiler checks this).
        match &location {
            SecretLocation::SecretsManager { region, .. } => {
                let ctx = in_region(region.clone());
                let client = self.secrets.get(&ctx, SecretsClient::new).await;
                read_secret(&client, &ctx.profile, location).await
            }
            SecretLocation::Parameter { name, region } => {
                let ctx = in_region(region.clone());
                let client = self.parameters.get(&ctx, ParametersClient::new).await;
                read_parameter(&client, &ctx.profile, name).await
            }
        }
    }
}

async fn read_secret(
    client: &SecretsClient,
    profile: &str,
    location: SecretLocation,
) -> Result<String, SourceError> {
    let SecretLocation::SecretsManager {
        secret_id,
        json_key,
        version_stage,
        version_id,
        ..
    } = location
    else {
        unreachable!("only called for Secrets Manager references");
    };
    let output = client
        .get_secret_value()
        .secret_id(secret_id)
        .set_version_stage(version_stage)
        .set_version_id(version_id)
        .send()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;
    let text = output.secret_string().ok_or_else(|| {
        SourceError::Aws("the secret is binary; Contrail shows text secrets only".to_owned())
    })?;
    match json_key {
        Some(key) => pick_json_key(text, &key),
        None => Ok(text.to_owned()),
    }
}

async fn read_parameter(
    client: &ParametersClient,
    profile: &str,
    name: &str,
) -> Result<String, SourceError> {
    let output = client
        .get_parameter()
        .name(name)
        // SecureString parameters are encrypted; ECS decrypts them too.
        .with_decryption(true)
        .send()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;
    output
        .parameter()
        .and_then(|p| p.value())
        .map(str::to_owned)
        .ok_or_else(|| SourceError::NotFound(format!("parameter {name}")))
}

#[cfg(test)]
mod tests {
    use aws_sdk_secretsmanager::operation::get_secret_value::GetSecretValueOutput;
    use aws_sdk_ssm::operation::get_parameter::GetParameterOutput;
    use aws_sdk_ssm::types::Parameter;
    use aws_smithy_mocks::{mock, mock_client};
    use aws_smithy_types::error::ErrorMetadata;

    use super::*;

    const SECRET: &str = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:demo/db-AbCdEf";

    #[tokio::test]
    async fn reads_a_json_key_of_a_secret() {
        let get = mock!(SecretsClient::get_secret_value)
            .match_requests(|r| r.secret_id() == Some(SECRET) && r.version_stage().is_none())
            .then_output(|| {
                GetSecretValueOutput::builder()
                    .secret_string(r#"{"password":"s3cret"}"#)
                    .build()
            });
        let client = mock_client!(aws_sdk_secretsmanager, [&get]);
        let location = parse_value_from(&format!("{SECRET}:password::"));
        assert_eq!(
            read_secret(&client, "dev", location).await.unwrap(),
            "s3cret"
        );
    }

    #[tokio::test]
    async fn reads_a_decrypted_parameter() {
        let get = mock!(ParametersClient::get_parameter)
            .match_requests(|r| {
                r.name() == Some("/demo/token") && r.with_decryption() == Some(true)
            })
            .then_output(|| {
                GetParameterOutput::builder()
                    .parameter(Parameter::builder().value("t0ken").build())
                    .build()
            });
        let client = mock_client!(aws_sdk_ssm, [&get]);
        assert_eq!(
            read_parameter(&client, "dev", "/demo/token").await.unwrap(),
            "t0ken"
        );
    }

    #[tokio::test]
    async fn a_missing_permission_says_so() {
        let denied = mock!(ParametersClient::get_parameter).then_error(|| {
            aws_sdk_ssm::operation::get_parameter::GetParameterError::generic(
                ErrorMetadata::builder()
                    .code("AccessDeniedException")
                    .message("not authorized to perform ssm:GetParameter")
                    .build(),
            )
        });
        let client = mock_client!(aws_sdk_ssm, [&denied]);
        assert!(matches!(
            read_parameter(&client, "dev", "/demo/token").await,
            Err(SourceError::AccessDenied(_))
        ));
    }
}
