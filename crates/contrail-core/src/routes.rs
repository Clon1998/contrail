//! Routes of a routing-framework service, rebuilt from its task definition's environment.
//!
//! Such services run one image with configurable routes, set through Spring's relaxed binding:
//! `<PREFIX>_ROUTES_<n>_TOPIC`, `…_INPUT_TYPE`, `…_OUTPUTS_<m>_PROPERTIES_<KEY>`, … The prefix
//! differs per deployment and the variables come in any order, so nothing here is hard-coded but
//! the `ROUTES_<n>_` part and the names of the route's own settings. Settings filled from Secrets
//! Manager or SSM (a password, say) are included with their reference only.

use std::collections::BTreeMap;

use regex::Regex;
use serde::Serialize;
use specta::Type;

use crate::ecs::{EnvVar, SecretRef};

/// One end of a route: where data comes from (input) or goes to (output).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// `sftp`, `s3`, `http`, `kafka`, … (the framework's `type`).
    pub kind: Option<String>,
    /// A label for the other system.
    pub system: Option<String>,
    pub enabled: bool,
    /// Endpoint settings (`host`, `path`, …), keys lower-cased as relaxed binding loses their case.
    pub properties: Vec<RouteProperty>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouteProperty {
    pub key: String,
    /// Empty for a setting filled from a secret (see `value_from`).
    pub value: String,
    /// The original variable name (to mask credentials the same way as in the environment list).
    pub variable: String,
    /// The Secrets Manager or SSM reference when the value comes from there (it is only read when
    /// the user asks, like in the environment list).
    pub value_from: Option<String>,
}

/// Variable names that usually hold a credential, as whole words (`…KEYEXPRESSION` isn't a key).
/// The same rule as `looksSecret` in the UI.
///
/// `LazyLock` compiles the regex once, on first use, and shares it between threads (like a Java
/// `static final` field with lazy initialisation).
static SECRET_NAME: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(
        r"(?i)(^|[_.-])(PASSWORD|PASSWD|PWD|SECRET|TOKEN|CREDENTIALS?|API_?KEY|ACCESS_KEY|PRIVATE_KEY|KEY)([_.-]|$)",
    )
    .expect("valid regex")
});

impl RouteProperty {
    /// Filled from a secret, or a plain variable whose name says it holds a credential.
    pub fn is_secret(&self) -> bool {
        self.value_from.is_some() || SECRET_NAME.is_match(&self.variable)
    }

    /// The property with the value of a secret left out (the reference stays).
    pub fn masked(&self) -> RouteProperty {
        RouteProperty {
            value: if self.is_secret() {
                String::new()
            } else {
                self.value.clone()
            },
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub index: u32,
    pub topic: Option<String>,
    pub enabled: bool,
    /// The consumer group (output routes).
    pub group: Option<String>,
    /// An output route reads the plain Kafka topic `topic` (`rawTopic: true`) instead of the
    /// framework's integration topic (`integration.<topic>`, the default).
    pub raw_topic: bool,
    pub input: Option<Endpoint>,
    pub outputs: Vec<Endpoint>,
    /// Other settings of the route (`keyexpression`, `concurrency`, …).
    pub settings: Vec<RouteProperty>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouteConfig {
    /// The variable prefix before `ROUTES_` (e.g. `ACME_`), for display.
    pub prefix: String,
    pub routes: Vec<Route>,
}

fn flag(value: &str) -> bool {
    !value.eq_ignore_ascii_case("false")
}

/// A variable of the task definition: a plain one, or one filled from a secret.
struct Var<'a> {
    name: &'a str,
    value: &'a str,
    value_from: Option<&'a str>,
}

fn property(var: &Var, key: &str) -> RouteProperty {
    RouteProperty {
        key: key.to_lowercase(),
        value: var.value.to_owned(),
        variable: var.name.to_owned(),
        value_from: var.value_from.map(str::to_owned),
    }
}

/// Fills one endpoint setting (`TYPE`, `SYSTEM`, `ENABLED`, `PROPERTIES_<KEY>`). A secret is
/// always a property: its value isn't known.
fn set_endpoint(endpoint: &mut Endpoint, var: &Var, rest: &str) {
    match rest {
        "TYPE" if var.value_from.is_none() => endpoint.kind = Some(var.value.to_owned()),
        "SYSTEM" if var.value_from.is_none() => endpoint.system = Some(var.value.to_owned()),
        "ENABLED" if var.value_from.is_none() => endpoint.enabled = flag(var.value),
        _ => {
            let key = rest.strip_prefix("PROPERTIES_").unwrap_or(rest);
            endpoint.properties.push(property(var, key));
        }
    }
}

fn new_endpoint() -> Endpoint {
    Endpoint {
        enabled: true,
        ..Endpoint::default()
    }
}

/// The routes configured in `env` and `secrets`, or `None` when they have no `…ROUTES_<n>_…`
/// variables.
pub fn parse_routes(env: &[EnvVar], secrets: &[SecretRef]) -> Option<RouteConfig> {
    // `(?:^|_)` keeps `MYROUTES_0_…` out; the prefix is everything before `ROUTES_`.
    let route =
        Regex::new(r"^(?P<prefix>(?:.*_)?)ROUTES_(?P<n>\d+)_(?P<rest>.+)$").expect("valid regex");
    let output = Regex::new(r"^OUTPUTS_(?P<m>\d+)_(?P<rest>.+)$").expect("valid regex");

    // `BTreeMap` keeps routes and outputs sorted by their index (env order is arbitrary).
    let mut routes: BTreeMap<u32, (Route, BTreeMap<u32, Endpoint>)> = BTreeMap::new();
    let mut prefix = None;
    let plain = env.iter().map(|v| Var {
        name: &v.name,
        value: &v.value,
        value_from: None,
    });
    let from_secrets = secrets.iter().map(|s| Var {
        name: &s.name,
        value: "",
        value_from: Some(&s.value_from),
    });
    for var in plain.chain(from_secrets) {
        let Some(caps) = route.captures(var.name) else {
            continue;
        };
        let Ok(index) = caps["n"].parse::<u32>() else {
            continue;
        };
        prefix.get_or_insert_with(|| caps["prefix"].to_owned());
        let (route, outputs) = routes.entry(index).or_insert_with(|| {
            (
                Route {
                    index,
                    enabled: true,
                    ..Route::default()
                },
                BTreeMap::new(),
            )
        });
        let rest = &caps["rest"];
        if let Some(out) = output.captures(rest) {
            let Ok(m) = out["m"].parse::<u32>() else {
                continue;
            };
            let endpoint = outputs.entry(m).or_insert_with(new_endpoint);
            set_endpoint(endpoint, &var, &out["rest"]);
        } else if let Some(input) = rest.strip_prefix("INPUT_") {
            let endpoint = route.input.get_or_insert_with(new_endpoint);
            set_endpoint(endpoint, &var, input);
        } else {
            match (rest, var.value_from) {
                ("TOPIC", None) => route.topic = Some(var.value.to_owned()),
                ("ENABLED", None) => route.enabled = flag(var.value),
                ("GROUP", None) => route.group = Some(var.value.to_owned()),
                // `rawTopic` in env-var form (Spring's relaxed binding drops the case).
                ("RAWTOPIC" | "RAW_TOPIC", None) => route.raw_topic = flag(var.value),
                (other, _) => route.settings.push(property(&var, other)),
            }
        }
    }
    if routes.is_empty() {
        return None;
    }
    Some(RouteConfig {
        prefix: prefix.unwrap_or_default(),
        routes: routes
            .into_values()
            .map(|(mut route, outputs)| {
                route.outputs = outputs.into_values().collect();
                for endpoint in route.input.iter_mut().chain(route.outputs.iter_mut()) {
                    endpoint.properties.sort_by(|a, b| a.key.cmp(&b.key));
                }
                route.settings.sort_by(|a, b| a.key.cmp(&b.key));
                route
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(vars: &[(&str, &str)]) -> Vec<EnvVar> {
        vars.iter()
            .map(|(name, value)| EnvVar {
                name: (*name).into(),
                value: (*value).into(),
            })
            .collect()
    }

    #[test]
    fn input_routes_in_any_order() {
        let config = parse_routes(
            &env(&[
                ("ACME_ROUTES_1_INPUT_TYPE", "sftp"),
                ("SPRING_PROFILES_ACTIVE", "prod"),
                ("ACME_ROUTES_0_INPUT_PROPERTIES_HOST", "sftp.example.com"),
                ("ACME_ROUTES_0_TOPIC", "partner.requests"),
                ("ACME_ROUTES_0_INPUT_TYPE", "sftp"),
                ("ACME_ROUTES_0_INPUT_SYSTEM", "Partner"),
                ("ACME_ROUTES_0_INPUT_PROPERTIES_ANTINCLUDE", "*"),
                ("ACME_ROUTES_1_TOPIC", "partner.events"),
                ("ACME_ROUTES_1_ENABLED", "false"),
                ("ACME_ROUTES_0_KEYEXPRESSION", "#{header.id}"),
            ]),
            &[],
        )
        .unwrap();
        assert_eq!(config.prefix, "ACME_");
        assert_eq!(config.routes.len(), 2);
        let first = &config.routes[0];
        assert_eq!(first.topic.as_deref(), Some("partner.requests"));
        assert!(first.enabled);
        let input = first.input.as_ref().unwrap();
        assert_eq!(
            (input.kind.as_deref(), input.system.as_deref()),
            (Some("sftp"), Some("Partner"))
        );
        let keys: Vec<_> = input.properties.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["antinclude", "host"], "lower-cased and sorted");
        assert_eq!(first.settings[0].key, "keyexpression");
        assert!(!config.routes[1].enabled);
    }

    #[test]
    fn output_routes_with_several_targets() {
        let config = parse_routes(
            &env(&[
                ("ROUTES_0_TOPIC", "orders"),
                ("ROUTES_0_GROUP", "orders-out"),
                ("ROUTES_0_OUTPUTS_1_TYPE", "http"),
                ("ROUTES_0_OUTPUTS_1_ENABLED", "false"),
                ("ROUTES_0_OUTPUTS_0_TYPE", "s3"),
                ("ROUTES_0_OUTPUTS_0_SYSTEM", "Archive"),
                (
                    "ROUTES_0_OUTPUTS_0_PROPERTIES_BUCKETNAMEORARN",
                    "demo-archive",
                ),
            ]),
            &[],
        )
        .unwrap();
        assert_eq!(config.prefix, "");
        let route = &config.routes[0];
        assert_eq!(route.group.as_deref(), Some("orders-out"));
        assert!(route.input.is_none());
        let kinds: Vec<_> = route.outputs.iter().map(|o| o.kind.as_deref()).collect();
        assert_eq!(kinds, [Some("s3"), Some("http")], "by output index");
        assert!(!route.outputs[1].enabled);
        assert_eq!(
            route.outputs[0].properties[0].variable,
            "ROUTES_0_OUTPUTS_0_PROPERTIES_BUCKETNAMEORARN"
        );
    }

    #[test]
    fn an_output_route_can_read_a_raw_topic() {
        let config = parse_routes(
            &env(&[
                ("ROUTES_0_TOPIC", "orders.events"),
                ("ROUTES_0_GROUP", "orders-out"),
                ("ROUTES_0_RAWTOPIC", "true"),
                ("ROUTES_0_OUTPUTS_0_TYPE", "s3"),
                ("ROUTES_1_TOPIC", "orders.other"),
                ("ROUTES_1_GROUP", "orders-out"),
                ("ROUTES_1_OUTPUTS_0_TYPE", "s3"),
            ]),
            &[],
        )
        .unwrap();
        assert!(config.routes[0].raw_topic);
        // Not a setting of its own anymore.
        assert!(config.routes[0].settings.is_empty());
        // Default: the integration topic.
        assert!(!config.routes[1].raw_topic);
    }

    #[test]
    fn credentials_are_masked_by_reference_or_name() {
        let property = |variable: &str, value_from: Option<&str>| RouteProperty {
            key: "k".into(),
            value: "plain".into(),
            variable: variable.into(),
            value_from: value_from.map(str::to_owned),
        };
        for secret in [
            property("ROUTES_0_OUTPUTS_0_PROPERTIES_PASSWORD", None),
            property("ROUTES_0_INPUT_PROPERTIES_API_KEY", None),
            property("ROUTES_0_INPUT_PROPERTIES_HOST", Some("arn:aws:ssm:…")),
        ] {
            assert!(secret.is_secret(), "{}", secret.variable);
            assert_eq!(secret.masked().value, "");
            assert_eq!(secret.masked().value_from, secret.value_from);
        }
        for plain in [
            property("ROUTES_0_INPUT_PROPERTIES_HOST", None),
            property("ROUTES_0_INPUT_PROPERTIES_KEYEXPRESSION", None),
        ] {
            assert!(!plain.is_secret(), "{}", plain.variable);
            assert_eq!(plain.masked().value, "plain");
        }
    }

    #[test]
    fn secret_settings_keep_only_their_reference() {
        let config = parse_routes(
            &env(&[
                ("ROUTES_0_TOPIC", "orders"),
                ("ROUTES_0_OUTPUTS_0_TYPE", "mq"),
                ("ROUTES_0_OUTPUTS_0_PROPERTIES_USER", "app"),
            ]),
            &[SecretRef {
                name: "ROUTES_0_OUTPUTS_0_PROPERTIES_PASSWORD".into(),
                value_from: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:billing/mq"
                    .into(),
            }],
        )
        .unwrap();
        let props = &config.routes[0].outputs[0].properties;
        assert_eq!(props.len(), 2);
        assert_eq!(props[0].key, "password", "sorted with the plain settings");
        assert_eq!(props[0].value, "");
        assert_eq!(
            props[0].value_from.as_deref(),
            Some("arn:aws:secretsmanager:eu-central-1:111111111111:secret:billing/mq")
        );
        assert_eq!(props[1].value_from, None);
    }

    #[test]
    fn services_without_routes() {
        assert_eq!(
            parse_routes(
                &env(&[("SERVER_PORT", "8080"), ("MYROUTES_0_TOPIC", "x")]),
                &[]
            ),
            None
        );
    }
}
