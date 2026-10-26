//! The SSO login without the AWS CLI: the OAuth device flow of IAM Identity Center.
//!
//! 1. RegisterClient: a public client for this login (no secrets are configured anywhere).
//! 2. StartDeviceAuthorization: a page and a code the user confirms in the browser.
//! 3. CreateToken, asked every few seconds until the user has confirmed (or the code expired).
//!
//! These calls aren't signed (there are no credentials yet) and change nothing in the account.
//! The token is then written to the CLI's token cache by the caller (see `AwsFiles`).

use std::time::Duration as StdDuration;

use aws_config::{BehaviorVersion, Region};
use aws_sdk_ssooidc::Client;
use contrail_core::auth::{AuthError, LoginProgress};
use contrail_core::sso::{NewToken, RefreshGrant};
use time::{Duration, OffsetDateTime};

/// The client name IAM Identity Center shows on its consent page.
const CLIENT_NAME: &str = "Contrail";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// The scope `sso-session` profiles need for a refreshable token (what the CLI asks for too).
const ACCOUNT_ACCESS: &str = "sso:account:access";
/// IAM Identity Center asks clients to wait this much longer after "slow down".
const SLOW_DOWN: StdDuration = StdDuration::from_secs(5);

/// The session to log in to (from the profile's SSO settings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLogin {
    pub start_url: String,
    pub region: String,
    /// The profile uses an `[sso-session]`: the token can be refreshed (legacy profiles can't).
    pub refreshable: bool,
}

/// A client for IAM Identity Center's OIDC endpoint in `region`, without credentials.
pub async fn oidc_client(region: &str) -> Client {
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.to_owned()))
        .no_credentials()
        .load()
        .await;
    Client::new(&config)
}

fn failed(step: &str, err: impl std::fmt::Display) -> AuthError {
    AuthError::DeviceLoginFailed(format!("{step}: {err}"))
}

/// Runs the device flow and returns the token. `progress` gets the page and code to confirm
/// (the app opens the page). Returns once the user confirmed, or fails when they denied it or
/// the code expired.
pub async fn device_login(
    client: &Client,
    login: &DeviceLogin,
    progress: &(dyn Fn(LoginProgress) + Send + Sync),
) -> Result<NewToken, AuthError> {
    let mut register = client
        .register_client()
        .client_name(CLIENT_NAME)
        .client_type("public");
    if login.refreshable {
        register = register
            .scopes(ACCOUNT_ACCESS)
            .grant_types(DEVICE_GRANT)
            .grant_types("refresh_token");
    }
    let client_reg = register.send().await.map_err(|e| {
        failed(
            "registering the client",
            aws_sdk_ssooidc::error::DisplayErrorContext(e),
        )
    })?;
    let client_id = client_reg.client_id().unwrap_or_default().to_owned();
    let client_secret = client_reg.client_secret().unwrap_or_default().to_owned();
    let registration_expires_at =
        OffsetDateTime::from_unix_timestamp(client_reg.client_secret_expires_at())
            .unwrap_or_else(|_| OffsetDateTime::now_utc());

    let device = client
        .start_device_authorization()
        .client_id(&client_id)
        .client_secret(&client_secret)
        .start_url(&login.start_url)
        .send()
        .await
        .map_err(|e| {
            failed(
                "starting the login",
                aws_sdk_ssooidc::error::DisplayErrorContext(e),
            )
        })?;
    let device_code = device.device_code().unwrap_or_default().to_owned();
    let url = device
        .verification_uri_complete()
        .or(device.verification_uri())
        .unwrap_or_default()
        .to_owned();
    progress(LoginProgress::Device {
        url,
        code: device.user_code().unwrap_or_default().to_owned(),
    });

    let mut interval = StdDuration::from_secs(u64::try_from(device.interval().max(1)).unwrap_or(5));
    let deadline = tokio::time::Instant::now()
        + StdDuration::from_secs(u64::try_from(device.expires_in()).unwrap_or(600));
    loop {
        tokio::time::sleep(interval).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(AuthError::DeviceLoginFailed(
                "the code expired before the login was confirmed".into(),
            ));
        }
        let result = client
            .create_token()
            .client_id(&client_id)
            .client_secret(&client_secret)
            .grant_type(DEVICE_GRANT)
            .device_code(&device_code)
            .send()
            .await;
        let token = match result {
            Ok(token) => token,
            Err(err) => {
                let service = err.as_service_error();
                if service.is_some_and(|e| e.is_authorization_pending_exception()) {
                    continue;
                }
                if service.is_some_and(|e| e.is_slow_down_exception()) {
                    interval += SLOW_DOWN;
                    continue;
                }
                return Err(match service {
                    Some(e) if e.is_access_denied_exception() => {
                        AuthError::DeviceLoginFailed("the login was denied in the browser".into())
                    }
                    Some(e) if e.is_expired_token_exception() => AuthError::DeviceLoginFailed(
                        "the code expired before the login was confirmed".into(),
                    ),
                    _ => failed(
                        "getting the token",
                        aws_sdk_ssooidc::error::DisplayErrorContext(err),
                    ),
                });
            }
        };
        let refresh = match (login.refreshable, token.refresh_token()) {
            (true, Some(refresh_token)) => Some(RefreshGrant {
                refresh_token: refresh_token.to_owned(),
                client_id: client_id.clone(),
                client_secret: client_secret.clone(),
                registration_expires_at,
            }),
            _ => None,
        };
        return Ok(NewToken {
            start_url: login.start_url.clone(),
            region: login.region.clone(),
            access_token: token.access_token().unwrap_or_default().to_owned(),
            expires_at: OffsetDateTime::now_utc()
                + Duration::seconds(i64::from(token.expires_in())),
            refresh,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use aws_sdk_ssooidc::operation::create_token::{CreateTokenError, CreateTokenOutput};
    use aws_sdk_ssooidc::operation::register_client::RegisterClientOutput;
    use aws_sdk_ssooidc::operation::start_device_authorization::StartDeviceAuthorizationOutput;
    use aws_sdk_ssooidc::types::error::{
        AccessDeniedException, AuthorizationPendingException, SlowDownException,
    };
    use aws_smithy_mocks::{RuleMode, mock, mock_client};

    use super::*;

    fn login(refreshable: bool) -> DeviceLogin {
        DeviceLogin {
            start_url: "https://example.awsapps.com/start".into(),
            region: "eu-central-1".into(),
            refreshable,
        }
    }

    fn register() -> aws_smithy_mocks::Rule {
        mock!(Client::register_client)
            .match_requests(|r| r.client_type() == Some("public"))
            .then_output(|| {
                RegisterClientOutput::builder()
                    .client_id("client-1")
                    .client_secret("secret-1")
                    .client_secret_expires_at(1_900_000_000)
                    .build()
            })
    }

    fn start() -> aws_smithy_mocks::Rule {
        mock!(Client::start_device_authorization)
            .match_requests(|r| {
                r.client_id() == Some("client-1")
                    && r.start_url() == Some("https://example.awsapps.com/start")
            })
            .then_output(|| {
                StartDeviceAuthorizationOutput::builder()
                    .device_code("device-1")
                    .user_code("ABCD-EFGH")
                    .verification_uri("https://device.sso.eu-central-1.amazonaws.com/")
                    .verification_uri_complete(
                        "https://device.sso.eu-central-1.amazonaws.com/?user_code=ABCD-EFGH",
                    )
                    .interval(1)
                    .expires_in(600)
                    .build()
            })
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_the_confirmation_and_returns_a_refreshable_token() {
        // Pending twice, "slow down" once, then the token.
        let token = mock!(Client::create_token)
            .match_requests(|r| r.device_code() == Some("device-1"))
            .sequence()
            .error(|| {
                CreateTokenError::AuthorizationPendingException(
                    AuthorizationPendingException::builder().build(),
                )
            })
            .times(2)
            .error(|| CreateTokenError::SlowDownException(SlowDownException::builder().build()))
            .output(|| {
                CreateTokenOutput::builder()
                    .access_token("access-1")
                    .refresh_token("refresh-1")
                    .expires_in(28_800)
                    .build()
            })
            .build();
        let client = mock_client!(
            aws_sdk_ssooidc,
            RuleMode::MatchAny,
            [&register(), &start(), &token]
        );
        let seen = Mutex::new(Vec::new());

        let started = tokio::time::Instant::now();
        let new = device_login(&client, &login(true), &|p| seen.lock().unwrap().push(p))
            .await
            .unwrap();

        assert_eq!(token.num_calls(), 4);
        // 3 × 1 s, plus 5 s more after "slow down".
        assert!(started.elapsed() >= StdDuration::from_secs(9));
        assert_eq!(
            seen.into_inner().unwrap(),
            [LoginProgress::Device {
                url: "https://device.sso.eu-central-1.amazonaws.com/?user_code=ABCD-EFGH".into(),
                code: "ABCD-EFGH".into(),
            }]
        );
        assert_eq!(new.access_token, "access-1");
        assert_eq!(new.region, "eu-central-1");
        let refresh = new.refresh.unwrap();
        assert_eq!(refresh.refresh_token, "refresh-1");
        assert_eq!(refresh.client_id, "client-1");
        assert_eq!(
            refresh.registration_expires_at.unix_timestamp(),
            1_900_000_000
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_legacy_profile_gets_no_refresh_and_a_denial_is_an_error() {
        let token = mock!(Client::create_token).then_output(|| {
            CreateTokenOutput::builder()
                .access_token("access-1")
                .refresh_token("ignored")
                .expires_in(3_600)
                .build()
        });
        let client = mock_client!(
            aws_sdk_ssooidc,
            RuleMode::MatchAny,
            [&register(), &start(), &token]
        );
        let new = device_login(&client, &login(false), &|_| {}).await.unwrap();
        assert_eq!(new.refresh, None);

        let denied = mock!(Client::create_token).then_error(|| {
            CreateTokenError::AccessDeniedException(AccessDeniedException::builder().build())
        });
        let client = mock_client!(
            aws_sdk_ssooidc,
            RuleMode::MatchAny,
            [&register(), &start(), &denied]
        );
        assert_eq!(
            device_login(&client, &login(true), &|_| {}).await,
            Err(AuthError::DeviceLoginFailed(
                "the login was denied in the browser".into()
            ))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_when_the_code_expires() {
        let pending = mock!(Client::create_token).then_error(|| {
            CreateTokenError::AuthorizationPendingException(
                AuthorizationPendingException::builder().build(),
            )
        });
        let client = mock_client!(
            aws_sdk_ssooidc,
            RuleMode::MatchAny,
            [&register(), &start(), &pending]
        );
        let result = device_login(&client, &login(true), &|_| {}).await;
        assert!(matches!(result, Err(AuthError::DeviceLoginFailed(m)) if m.contains("expired")));
    }
}
