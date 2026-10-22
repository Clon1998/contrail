//! AWS profiles as Contrail sees them, resolved from the shared config and credentials files.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ini;

/// A named AWS profile from `~/.aws/config` (or `~/.aws/credentials`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// The name used with `--profile` (`default` for the `[default]` section).
    pub name: String,
    /// The profile's default region, if it sets one.
    pub region: Option<String>,
    pub auth: ProfileAuth,
}

impl Profile {
    /// The AWS account ID, when the config names one (SSO profiles do).
    pub fn account_id(&self) -> Option<&str> {
        match &self.auth {
            ProfileAuth::Sso { account_id, .. } => Some(account_id),
            _ => None,
        }
    }
}

/// How a profile gets its credentials.
///
/// A Rust `enum` can carry different data per variant (a "sum type"); in Java this would be a
/// sealed interface with one record per case. `#[serde(tag = "kind")]` serializes it as
/// `{ "kind": "sso", "accountId": … }`, which TypeScript sees as a discriminated union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProfileAuth {
    /// IAM Identity Center (SSO). Contrail can show the session state and run the login.
    Sso {
        account_id: String,
        role_name: String,
        start_url: String,
        sso_region: String,
        /// The `[sso-session …]` this profile uses; `None` for the legacy inline SSO settings.
        session_name: Option<String>,
    },
    /// Assumes a role, with credentials from another profile (`source_profile`) or elsewhere.
    AssumeRole { source_profile: Option<String> },
    /// Long-term keys (in the credentials file or the config). Contrail never reads the keys.
    StaticKeys,
    /// Credentials come from an external `credential_process`.
    CredentialProcess,
    /// No credential settings Contrail recognises; the SDK's default chain decides.
    Other,
    /// The profile is broken, e.g. it references an `[sso-session]` that doesn't exist.
    Misconfigured { problem: String },
}

/// The SSO settings that keys an entry in the SSO token cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoSessionRef<'a> {
    pub start_url: &'a str,
    pub session_name: Option<&'a str>,
}

impl ProfileAuth {
    /// The SSO session this profile logs in with, if it is an SSO profile.
    ///
    /// The returned value *borrows* from `self` (`'a` ties both lifetimes together): no strings
    /// are copied, and the compiler guarantees the profile outlives the reference.
    pub fn sso_session<'a>(&'a self) -> Option<SsoSessionRef<'a>> {
        match self {
            ProfileAuth::Sso {
                start_url,
                session_name,
                ..
            } => Some(SsoSessionRef {
                start_url,
                session_name: session_name.as_deref(),
            }),
            _ => None,
        }
    }
}

/// Resolves all profiles from the text of the config file and (optionally) the credentials file.
///
/// Profiles that only exist in the credentials file appear as [`ProfileAuth::StaticKeys`]. Only
/// section names are taken from the credentials file; key values are never looked at or kept.
/// The result is sorted by name, with `default` first.
pub fn parse_profiles(config: &str, credentials: Option<&str>) -> Vec<Profile> {
    let config_sections = ini::parse(config);

    // `[sso-session NAME]` sections, looked up by profiles that say `sso_session = NAME`.
    let sso_sessions: Vec<(&str, &ini::Section)> = config_sections
        .iter()
        .filter_map(|s| Some((section_name(&s.header, "sso-session")?, s)))
        .collect();

    let mut profiles: Vec<Profile> = Vec::new();
    for section in &config_sections {
        let Some(name) = profile_name(&section.header) else {
            continue;
        };
        // A later section with the same name wins, as in the AWS CLI.
        profiles.retain(|p| p.name != name);
        let props = &section.properties;
        profiles.push(Profile {
            name: name.to_owned(),
            region: non_empty(props.get("region")),
            auth: resolve_auth(props, &sso_sessions),
        });
    }

    if let Some(credentials) = credentials {
        for section in ini::parse(credentials) {
            let name = section.header;
            let has_keys = section.properties.contains_key("aws_access_key_id");
            match profiles.iter_mut().find(|p| p.name == name) {
                Some(p) if has_keys && p.auth == ProfileAuth::Other => {
                    p.auth = ProfileAuth::StaticKeys
                }
                Some(_) => {}
                None => profiles.push(Profile {
                    name,
                    region: None,
                    auth: if has_keys {
                        ProfileAuth::StaticKeys
                    } else {
                        ProfileAuth::Other
                    },
                }),
            }
        }
    }

    profiles.sort_by(|a, b| (a.name != "default", &a.name).cmp(&(b.name != "default", &b.name)));
    profiles
}

/// `[default]` and `[profile default]` → `default`; `[profile dev]` → `dev`; others → `None`.
fn profile_name(header: &str) -> Option<&str> {
    if header == "default" {
        return Some("default");
    }
    section_name(header, "profile")
}

/// `("profile dev", "profile")` → `Some("dev")`.
fn section_name<'a>(header: &'a str, kind: &str) -> Option<&'a str> {
    let name = header.strip_prefix(kind)?;
    // Require whitespace after the kind, so `[profiles x]` isn't read as profile `s x`.
    if !name.starts_with(char::is_whitespace) {
        return None;
    }
    let name = name.trim();
    (!name.is_empty()).then_some(name)
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.filter(|v| !v.is_empty()).cloned()
}

fn resolve_auth(
    props: &std::collections::BTreeMap<String, String>,
    sso_sessions: &[(&str, &ini::Section)],
) -> ProfileAuth {
    let get = |key: &str| non_empty(props.get(key));

    if props.contains_key("role_arn") {
        return ProfileAuth::AssumeRole {
            source_profile: get("source_profile"),
        };
    }

    let sso_session = get("sso_session");
    if sso_session.is_some() || props.contains_key("sso_start_url") {
        let (start_url, sso_region) = match &sso_session {
            Some(session) => {
                let Some((_, section)) = sso_sessions.iter().find(|(n, _)| n == session) else {
                    return ProfileAuth::Misconfigured {
                        problem: format!(
                            "sso_session \"{session}\" has no [sso-session {session}] section"
                        ),
                    };
                };
                (
                    non_empty(section.properties.get("sso_start_url")),
                    non_empty(section.properties.get("sso_region")),
                )
            }
            None => (get("sso_start_url"), get("sso_region")),
        };
        let fields = (
            start_url,
            sso_region,
            get("sso_account_id"),
            get("sso_role_name"),
        );
        let (Some(start_url), Some(sso_region), Some(account_id), Some(role_name)) = fields else {
            let missing: Vec<&str> = [
                ("sso_start_url", fields.0.is_none()),
                ("sso_region", fields.1.is_none()),
                ("sso_account_id", fields.2.is_none()),
                ("sso_role_name", fields.3.is_none()),
            ]
            .into_iter()
            .filter_map(|(key, missing)| missing.then_some(key))
            .collect();
            return ProfileAuth::Misconfigured {
                problem: format!("SSO profile is missing {}", missing.join(", ")),
            };
        };
        return ProfileAuth::Sso {
            account_id,
            role_name,
            start_url,
            sso_region,
            session_name: sso_session,
        };
    }

    if props.contains_key("credential_process") {
        return ProfileAuth::CredentialProcess;
    }
    if props.contains_key("aws_access_key_id") {
        return ProfileAuth::StaticKeys;
    }
    ProfileAuth::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic config covering the shapes Contrail has to handle.
    const CONFIG: &str = r#"
[default]
region = eu-central-1

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = eu-central-1
sso_registration_scopes = sso:account:access

[profile dev]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = ReadOnly
region = eu-central-1

[profile prod]
sso_session = corp
sso_account_id = 222222222222
sso_role_name = ReadOnly
region = eu-west-1

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-1
sso_account_id = 333333333333
sso_role_name = Admin

[profile assume]
role_arn = arn:aws:iam::444444444444:role/Example
source_profile = dev

[profile tool]
credential_process = /usr/local/bin/creds --profile tool

[profile broken]
sso_session = missing
sso_account_id = 555555555555
sso_role_name = ReadOnly

[profile incomplete]
sso_session = corp
"#;

    const CREDENTIALS: &str = "
[default]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = example

[ci]
aws_access_key_id = AKIAEXAMPLE2
aws_secret_access_key = example
";

    #[test]
    fn resolves_all_profile_kinds() {
        insta::assert_debug_snapshot!(parse_profiles(CONFIG, Some(CREDENTIALS)));
    }

    #[test]
    fn sso_session_settings_come_from_the_sso_session_section() {
        let profiles = parse_profiles(CONFIG, None);
        let dev = profiles.iter().find(|p| p.name == "dev").unwrap();
        assert_eq!(dev.account_id(), Some("111111111111"));
        assert_eq!(
            dev.auth.sso_session(),
            Some(SsoSessionRef {
                start_url: "https://example.awsapps.com/start",
                session_name: Some("corp"),
            })
        );
    }

    #[test]
    fn default_comes_first_then_alphabetical() {
        let names: Vec<String> = parse_profiles(CONFIG, Some(CREDENTIALS))
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(
            names,
            [
                "default",
                "assume",
                "broken",
                "ci",
                "dev",
                "incomplete",
                "legacy",
                "prod",
                "tool"
            ]
        );
    }

    #[test]
    fn profile_default_header_is_the_default_profile() {
        let profiles = parse_profiles("[profile default]\nregion = us-east-1\n", None);
        assert_eq!(profiles[0].name, "default");
        assert_eq!(profiles[0].region.as_deref(), Some("us-east-1"));
    }

    #[test]
    fn later_duplicate_sections_win() {
        let profiles = parse_profiles(
            "[profile a]\nregion = us-east-1\n[profile a]\nregion = eu-west-1\n",
            None,
        );
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].region.as_deref(), Some("eu-west-1"));
    }

    #[test]
    fn ignores_other_section_kinds() {
        let profiles = parse_profiles(
            "[services local]\ns3 =\n  endpoint_url = http://localhost\n[profiles x]\n[sso-session s]\n",
            None,
        );
        assert!(profiles.is_empty());
    }

    #[test]
    fn empty_input_has_no_profiles() {
        assert!(parse_profiles("", None).is_empty());
    }
}
