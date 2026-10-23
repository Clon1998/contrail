//! Reading the value of a secret-backed environment variable, on explicit request only.
//!
//! ECS task definitions reference secrets by `valueFrom`: a Secrets Manager ARN (optionally with
//! `:json-key:version-stage:version-id` appended) or an SSM parameter (ARN or name). Contrail reads
//! them only when the user clicks "Reveal", keeps the value in memory for display and never stores
//! or logs it.

use async_trait::async_trait;

use crate::auth::AwsCtx;
use crate::error::SourceError;

/// Where a `valueFrom` points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretLocation {
    SecretsManager {
        /// The secret's ARN (without the appended parts).
        secret_id: String,
        /// The region from the ARN.
        region: Option<String>,
        /// Take this key from the secret's JSON value.
        json_key: Option<String>,
        version_stage: Option<String>,
        version_id: Option<String>,
    },
    Parameter {
        /// The parameter's ARN or name.
        name: String,
        /// The region from the ARN (`None` for a plain name: the task's region).
        region: Option<String>,
    },
}

/// Parses a container definition's `valueFrom`.
pub fn parse_value_from(value_from: &str) -> SecretLocation {
    let parts: Vec<&str> = value_from.split(':').collect();
    let non_empty = |part: Option<&&str>| part.filter(|p| !p.is_empty()).map(|p| (*p).to_owned());
    match parts.as_slice() {
        // arn:aws:secretsmanager:<region>:<account>:secret:<name>[:json-key[:stage[:id]]]
        ["arn", _, "secretsmanager", region, _, "secret", ..] if parts.len() >= 7 => {
            SecretLocation::SecretsManager {
                secret_id: parts[..7].join(":"),
                region: non_empty(Some(region)),
                json_key: non_empty(parts.get(7)),
                version_stage: non_empty(parts.get(8)),
                version_id: non_empty(parts.get(9)),
            }
        }
        // arn:aws:ssm:<region>:<account>:parameter/<name>
        ["arn", _, "ssm", region, ..] => SecretLocation::Parameter {
            name: value_from.to_owned(),
            region: non_empty(Some(region)),
        },
        _ => SecretLocation::Parameter {
            name: value_from.to_owned(),
            region: None,
        },
    }
}

/// The value of `key` in a secret that holds a JSON object (strings as they are, other values as
/// JSON text), like ECS does for `valueFrom` with a JSON key.
pub fn pick_json_key(secret: &str, key: &str) -> Result<String, SourceError> {
    let value: serde_json::Value = serde_json::from_str(secret).map_err(|_| {
        SourceError::Aws(format!(
            "the secret is not JSON, so it has no key \"{key}\""
        ))
    })?;
    match value.get(key) {
        Some(serde_json::Value::String(text)) => Ok(text.clone()),
        Some(other) => Ok(other.to_string()),
        None => Err(SourceError::NotFound(format!(
            "key \"{key}\" in the secret"
        ))),
    }
}

/// Reads secret values: Secrets Manager / SSM, or the demo fake.
#[async_trait]
pub trait SecretSource: Send + Sync {
    /// The current value behind `value_from`, read with the credentials of `ctx`.
    async fn reveal(&self, ctx: &AwsCtx, value_from: &str) -> Result<String, SourceError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_manager_arns_with_and_without_a_json_key() {
        let arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:demo/db-AbCdEf";
        assert_eq!(
            parse_value_from(arn),
            SecretLocation::SecretsManager {
                secret_id: arn.into(),
                region: Some("eu-central-1".into()),
                json_key: None,
                version_stage: None,
                version_id: None,
            }
        );
        assert_eq!(
            parse_value_from(&format!("{arn}:password::")),
            SecretLocation::SecretsManager {
                secret_id: arn.into(),
                region: Some("eu-central-1".into()),
                json_key: Some("password".into()),
                version_stage: None,
                version_id: None,
            }
        );
        let SecretLocation::SecretsManager { version_stage, .. } =
            parse_value_from(&format!("{arn}::AWSPREVIOUS:"))
        else {
            panic!("a Secrets Manager reference");
        };
        assert_eq!(version_stage.as_deref(), Some("AWSPREVIOUS"));
    }

    #[test]
    fn parameters_by_arn_or_name() {
        let arn = "arn:aws:ssm:eu-west-1:111122223333:parameter/demo/api-token";
        assert_eq!(
            parse_value_from(arn),
            SecretLocation::Parameter {
                name: arn.into(),
                region: Some("eu-west-1".into()),
            }
        );
        assert_eq!(
            parse_value_from("/demo/api-token"),
            SecretLocation::Parameter {
                name: "/demo/api-token".into(),
                region: None,
            }
        );
    }

    #[test]
    fn json_keys() {
        let secret = r#"{"username":"app","password":"s3cret","port":5432}"#;
        assert_eq!(pick_json_key(secret, "password").unwrap(), "s3cret");
        assert_eq!(pick_json_key(secret, "port").unwrap(), "5432");
        assert!(matches!(
            pick_json_key(secret, "missing"),
            Err(SourceError::NotFound(_))
        ));
        assert!(pick_json_key("plain text", "password").is_err());
    }
}
