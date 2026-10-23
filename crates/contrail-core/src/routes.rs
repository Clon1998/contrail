//! Routes of a routing-framework service, rebuilt from its task definition's environment.
//!
//! Such services run one image with configurable routes, set through Spring's relaxed binding:
//! `<PREFIX>_ROUTES_<n>_TOPIC`, `…_INPUT_TYPE`, `…_OUTPUTS_<m>_PROPERTIES_<KEY>`, … The prefix
//! differs per deployment and the variables come in any order, so nothing here is hard-coded but
//! the `ROUTES_<n>_` part and the names of the route's own settings.

use std::collections::BTreeMap;

use regex::Regex;
use serde::Serialize;
use specta::Type;

use crate::ecs::EnvVar;

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
    pub value: String,
    /// The original variable name (to mask credentials the same way as in the environment list).
    pub variable: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub index: u32,
    pub topic: Option<String>,
    pub enabled: bool,
    /// The consumer group (output routes).
    pub group: Option<String>,
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

fn property(variable: &str, key: &str, value: &str) -> RouteProperty {
    RouteProperty {
        key: key.to_lowercase(),
        value: value.to_owned(),
        variable: variable.to_owned(),
    }
}

/// Fills one endpoint setting (`TYPE`, `SYSTEM`, `ENABLED`, `PROPERTIES_<KEY>`).
fn set_endpoint(endpoint: &mut Endpoint, variable: &str, rest: &str, value: &str) {
    match rest {
        "TYPE" => endpoint.kind = Some(value.to_owned()),
        "SYSTEM" => endpoint.system = Some(value.to_owned()),
        "ENABLED" => endpoint.enabled = flag(value),
        _ => {
            let key = rest.strip_prefix("PROPERTIES_").unwrap_or(rest);
            endpoint.properties.push(property(variable, key, value));
        }
    }
}

fn new_endpoint() -> Endpoint {
    Endpoint {
        enabled: true,
        ..Endpoint::default()
    }
}

/// The routes configured in `env`, or `None` when it has no `…ROUTES_<n>_…` variables.
pub fn parse_routes(env: &[EnvVar]) -> Option<RouteConfig> {
    // `(?:^|_)` keeps `MYROUTES_0_…` out; the prefix is everything before `ROUTES_`.
    let route =
        Regex::new(r"^(?P<prefix>(?:.*_)?)ROUTES_(?P<n>\d+)_(?P<rest>.+)$").expect("valid regex");
    let output = Regex::new(r"^OUTPUTS_(?P<m>\d+)_(?P<rest>.+)$").expect("valid regex");

    // `BTreeMap` keeps routes and outputs sorted by their index (env order is arbitrary).
    let mut routes: BTreeMap<u32, (Route, BTreeMap<u32, Endpoint>)> = BTreeMap::new();
    let mut prefix = None;
    for var in env {
        let Some(caps) = route.captures(&var.name) else {
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
        let value = var.value.as_str();
        if let Some(out) = output.captures(rest) {
            let Ok(m) = out["m"].parse::<u32>() else {
                continue;
            };
            let endpoint = outputs.entry(m).or_insert_with(new_endpoint);
            set_endpoint(endpoint, &var.name, &out["rest"], value);
        } else if let Some(input) = rest.strip_prefix("INPUT_") {
            let endpoint = route.input.get_or_insert_with(new_endpoint);
            set_endpoint(endpoint, &var.name, input, value);
        } else {
            match rest {
                "TOPIC" => route.topic = Some(value.to_owned()),
                "ENABLED" => route.enabled = flag(value),
                "GROUP" => route.group = Some(value.to_owned()),
                other => route.settings.push(property(&var.name, other, value)),
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
        let config = parse_routes(&env(&[
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
        ]))
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
        let config = parse_routes(&env(&[
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
        ]))
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
    fn services_without_routes() {
        assert_eq!(
            parse_routes(&env(&[("SERVER_PORT", "8080"), ("MYROUTES_0_TOPIC", "x")])),
            None
        );
    }
}
