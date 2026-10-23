//! Invented secret values for demo mode (never real ones).

use std::sync::Arc;

use async_trait::async_trait;
use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::secrets::SecretSource;

use crate::FakeAuth;

/// Answers every reference with an obviously invented value, after the same credential check as
/// the other fake sources (an expired demo session can't reveal anything).
pub struct FakeSecrets {
    auth: Arc<FakeAuth>,
}

impl FakeSecrets {
    pub fn new(auth: Arc<FakeAuth>) -> Self {
        Self { auth }
    }
}

#[async_trait]
impl SecretSource for FakeSecrets {
    async fn reveal(&self, ctx: &AwsCtx, value_from: &str) -> Result<String, SourceError> {
        self.auth.check_credentials(&ctx.profile)?;
        // `rsplit('/')` walks the reference from the end; its first piece is the secret's name.
        let name = value_from.rsplit('/').next().unwrap_or(value_from);
        Ok(format!("demo-{name}-not-a-real-secret"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invents_a_value_for_a_logged_in_profile() {
        let secrets = FakeSecrets::new(Arc::new(FakeAuth::new()));
        let ctx = AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        };
        let value = secrets
            .reveal(
                &ctx,
                "arn:aws:ssm:eu-central-1:111122223333:parameter/demo/orders-api/api-token",
            )
            .await
            .unwrap();
        assert_eq!(value, "demo-api-token-not-a-real-secret");
        let expired = AwsCtx {
            profile: "demo-prod".into(),
            region: None,
        };
        assert!(secrets.reveal(&expired, "x").await.is_err());
    }
}
