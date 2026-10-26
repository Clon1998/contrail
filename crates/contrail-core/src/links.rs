//! Links to a log view (`contrail://open?…`) to share with teammates, and links to the same logs
//! in the CloudWatch console for teammates without Contrail.
//!
//! A link holds names, not credentials: the profile name, region, cluster, service, task, time
//! window and search. Whoever opens it needs a profile of that name with access to the account.

use serde::{Deserialize, Serialize};
use specta::Type;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;

use crate::logs::filter::FilterMode;
use crate::logs::source::TimeWindow;
use crate::timestamp::Timestamp;

/// The URL scheme Contrail registers with the operating system.
pub const SCHEME: &str = "contrail";

/// The search a link carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkSearch {
    pub query: String,
    pub mode: FilterMode,
    pub regex: bool,
    pub raw: bool,
}

/// A log view as a link: which service (or task) of which profile, the time window and the
/// search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewLink {
    pub profile: String,
    /// The region the view was opened in (`None`: the profile's own).
    pub region: Option<String>,
    pub cluster_arn: String,
    pub service_name: String,
    /// One task only (`None`: all tasks).
    pub task_id: Option<String>,
    pub window: TimeWindow,
    pub search: Option<LinkSearch>,
}

/// Why a link can't be opened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LinkError {
    #[error("not a Contrail link: {0}")]
    NotALink(String),
    #[error("the link has no {0}")]
    Missing(&'static str),
    #[error("the link's {0} is invalid: {1}")]
    Invalid(&'static str, String),
}

/// The link of `view`: `contrail://open?profile=…&cluster=…&service=…&last=15&q=…`.
pub fn to_url(view: &ViewLink) -> String {
    let mut url = Url::parse(&format!("{SCHEME}://open")).expect("a valid base URL");
    {
        // `query_pairs_mut` percent-encodes every value (a query can hold `&`, `#`, spaces, …).
        let mut query = url.query_pairs_mut();
        query.append_pair("profile", &view.profile);
        if let Some(region) = &view.region {
            query.append_pair("region", region);
        }
        query.append_pair("cluster", &view.cluster_arn);
        query.append_pair("service", &view.service_name);
        if let Some(task) = &view.task_id {
            query.append_pair("task", task);
        }
        match view.window {
            TimeWindow::Last { minutes } => {
                query.append_pair("last", &minutes.to_string());
            }
            TimeWindow::Range { from, to } => {
                query.append_pair("from", &rfc3339(from));
                query.append_pair("to", &rfc3339(to));
            }
        }
        if let Some(search) = &view.search {
            query.append_pair("q", &search.query);
            if search.mode == FilterMode::Highlight {
                query.append_pair("mode", "highlight");
            }
            if search.regex {
                query.append_pair("regex", "1");
            }
            if search.raw {
                query.append_pair("raw", "1");
            }
        }
    }
    url.into()
}

fn rfc3339(at: Timestamp) -> String {
    at.0.format(&Rfc3339).expect("a formattable time")
}

/// Reads a link made by [`to_url`].
pub fn parse_url(link: &str) -> Result<ViewLink, LinkError> {
    let url = Url::parse(link.trim()).map_err(|_| LinkError::NotALink(link.to_owned()))?;
    if url.scheme() != SCHEME || url.host_str() != Some("open") {
        return Err(LinkError::NotALink(link.to_owned()));
    }
    // The first value of each parameter (later duplicates are ignored).
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let get = |key: &str| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let required = |key: &'static str| {
        get(key)
            .filter(|v| !v.is_empty())
            .ok_or(LinkError::Missing(key))
    };
    let time = |key: &'static str| -> Result<Timestamp, LinkError> {
        let value = required(key)?;
        OffsetDateTime::parse(&value, &Rfc3339)
            .map(Timestamp)
            .map_err(|_| LinkError::Invalid(key, value))
    };

    let window = match get("last") {
        Some(minutes) => TimeWindow::Last {
            minutes: minutes
                .parse()
                .ok()
                .filter(|&m| m > 0)
                .ok_or(LinkError::Invalid("time window", minutes))?,
        },
        None => TimeWindow::Range {
            from: time("from")?,
            to: time("to")?,
        },
    };
    let search = get("q").map(|query| LinkSearch {
        query,
        mode: if get("mode").as_deref() == Some("highlight") {
            FilterMode::Highlight
        } else {
            FilterMode::Filter
        },
        regex: get("regex").as_deref() == Some("1"),
        raw: get("raw").as_deref() == Some("1"),
    });
    Ok(ViewLink {
        profile: required("profile")?,
        region: get("region").filter(|r| !r.is_empty()),
        cluster_arn: required("cluster")?,
        service_name: required("service")?,
        task_id: get("task").filter(|t| !t.is_empty()),
        window,
        search,
    })
}

/// The console's escaping inside its `#` fragment: `encodeURIComponent`, then `$25` for every `%`
/// (so `/` becomes `$252F`), which keeps the fragment intact through the console's router.
fn console_escape(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        // `byte_serialize` writes spaces as `+`; the console wants them escaped.
        .replace('+', "%20")
        .replace('%', "$25")
}

/// The same logs in the CloudWatch console: the log group's events in `start..end`, filtered to
/// `stream` when given (one task, or the stream of one event), with `filter` as the console's
/// filter pattern (plain text matches as a phrase). For teammates without Contrail.
pub fn console_url(
    region: &str,
    log_group: &str,
    stream: Option<&str>,
    start: Timestamp,
    end: Timestamp,
    filter: Option<&str>,
) -> String {
    let millis = |t: Timestamp| (t.0.unix_timestamp_nanos() / 1_000_000).to_string();
    let mut params = vec![("start", millis(start)), ("end", millis(end))];
    if let Some(filter) = filter.filter(|f| !f.trim().is_empty()) {
        params.push(("filterPattern", format!("\"{}\"", filter.replace('"', ""))));
    }
    if let Some(stream) = stream {
        params.push(("logStreamNameFilter", stream.to_owned()));
    }
    // The inner query's `?`, `=` and `&` are written the same way: `$3F`, `$3D`, `$26`.
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}$3D{}", console_escape(v)))
        .collect::<Vec<_>>()
        .join("$26");
    format!(
        "https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}\
         #logsV2:log-groups/log-group/{}/log-events$3F{query}",
        console_escape(log_group)
    )
}

/// Whether `url` is a page of the AWS console (`https://….console.aws.amazon.com/…`): the only
/// pages Contrail opens in the browser on the UI's request.
pub fn is_console_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some_and(|host| {
                host == "console.aws.amazon.com" || host.ends_with(".console.aws.amazon.com")
            })
    })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use time::macros::datetime;

    use super::*;

    fn view() -> ViewLink {
        ViewLink {
            profile: "dev".into(),
            region: Some("eu-central-1".into()),
            cluster_arn: "arn:aws:ecs:eu-central-1:111122223333:cluster/core".into(),
            service_name: "orders-api".into(),
            task_id: None,
            window: TimeWindow::Last { minutes: 15 },
            search: Some(LinkSearch {
                query: "level:ERROR & \"read timed out\" #1".into(),
                mode: FilterMode::Filter,
                regex: false,
                raw: false,
            }),
        }
    }

    #[test]
    fn a_link_reads_back_as_the_same_view() {
        let link = to_url(&view());
        assert!(link.starts_with("contrail://open?profile=dev&region=eu-central-1&cluster=arn"));
        assert_eq!(parse_url(&link), Ok(view()));

        let range = ViewLink {
            region: None,
            task_id: Some("5f2adcb1".into()),
            window: TimeWindow::Range {
                from: Timestamp(datetime!(2026-10-26 09:00 UTC)),
                to: Timestamp(datetime!(2026-10-26 11:30 UTC)),
            },
            search: None,
            ..view()
        };
        let link = to_url(&range);
        assert!(link.contains("from=2026-10-26T09%3A00%3A00Z"));
        assert_eq!(parse_url(&link), Ok(range));
    }

    #[test]
    fn explains_what_is_wrong_with_a_link() {
        assert!(matches!(
            parse_url("https://example.com"),
            Err(LinkError::NotALink(_))
        ));
        assert!(matches!(
            parse_url("contrail://other?profile=x"),
            Err(LinkError::NotALink(_))
        ));
        assert_eq!(
            parse_url("contrail://open?cluster=c&service=s&last=15"),
            Err(LinkError::Missing("profile"))
        );
        assert_eq!(
            parse_url("contrail://open?profile=p&cluster=c&service=s&last=0"),
            Err(LinkError::Invalid("time window", "0".into()))
        );
        assert_eq!(
            parse_url("contrail://open?profile=p&cluster=c&service=s&from=yesterday&to=now"),
            Err(LinkError::Invalid("from", "yesterday".into()))
        );
    }

    #[test]
    fn links_to_the_console() {
        let url = console_url(
            "eu-central-1",
            "/ecs/orders-api",
            Some("ecs/orders-api/abc"),
            Timestamp(datetime!(2026-10-26 09:00 UTC)),
            Timestamp(datetime!(2026-10-26 09:15 UTC)),
            Some("timeout"),
        );
        assert_eq!(
            url,
            "https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1\
             #logsV2:log-groups/log-group/$252Fecs$252Forders-api/log-events\
             $3Fstart$3D1793005200000$26end$3D1793006100000$26filterPattern$3D$2522timeout$2522\
             $26logStreamNameFilter$3Decs$252Forders-api$252Fabc"
        );
    }

    #[test]
    fn only_console_pages_count_as_console_links() {
        assert!(is_console_url(
            "https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1"
        ));
        assert!(!is_console_url(
            "http://eu-central-1.console.aws.amazon.com/"
        ));
        assert!(!is_console_url(
            "https://console.aws.amazon.com.evil.example/"
        ));
        assert!(!is_console_url(
            "https://evil.example/?console.aws.amazon.com"
        ));
        assert!(!is_console_url("file:///etc/passwd"));
    }

    // Arbitrary text for names and queries, including the characters URLs care about.
    fn text() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9 &=?#%+/:\"'ü€-]{1,40}"
    }

    proptest! {
        #[test]
        fn every_view_round_trips(
            profile in text(),
            region in proptest::option::of(text()),
            cluster in text(),
            service in text(),
            task in proptest::option::of(text()),
            last in proptest::option::of(1u32..100_000),
            from in 0i64..4_000_000_000,
            length in 1i64..10_000_000,
            search in proptest::option::of((text(), any::<bool>(), any::<bool>(), any::<bool>())),
        ) {
            let window = match last {
                Some(minutes) => TimeWindow::Last { minutes },
                None => TimeWindow::Range {
                    from: Timestamp(OffsetDateTime::from_unix_timestamp(from).unwrap()),
                    to: Timestamp(OffsetDateTime::from_unix_timestamp(from + length).unwrap()),
                },
            };
            let view = ViewLink {
                profile,
                region,
                cluster_arn: cluster,
                service_name: service,
                task_id: task,
                window,
                search: search.map(|(query, highlight, regex, raw)| LinkSearch {
                    query,
                    mode: if highlight { FilterMode::Highlight } else { FilterMode::Filter },
                    regex,
                    raw,
                }),
            };
            prop_assert_eq!(parse_url(&to_url(&view)), Ok(view));
        }
    }
}
