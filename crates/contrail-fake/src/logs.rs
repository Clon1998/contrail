//! A fake [`LogSource`]: realistic demo logs in the three production formats.
//!
//! Every event is a pure function of its stream and time slot, so fetching the same range twice
//! gives the same events (which also exercises deduplication). Content is invented.

use std::sync::Arc;

use async_trait::async_trait;
use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::logs::{
    Backfill, GroupEvent, LiveError, LiveItem, LiveStream, LogSource, RawEvent, StreamSelection,
    TimeRange,
};
use contrail_core::timestamp::Timestamp;
use futures::StreamExt;
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::FakeAuth;

/// How a demo service logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    /// ECS JSON with nested objects (newer Spring Boot).
    Nested,
    /// ECS JSON with dotted keys and stack traces (older Spring Boot).
    Dotted,
    /// Spring Boot's default console pattern; stack traces as one event per line.
    Spring,
}

/// Format and event interval per demo log group.
fn profile_of(log_group: &str) -> Option<(Format, Duration, &'static str)> {
    let service = log_group.strip_prefix("/ecs/")?;
    Some(match service {
        "orders-api" => (Format::Nested, Duration::seconds(4), "orders-api"),
        "payments-worker" => (Format::Dotted, Duration::seconds(6), "payments-worker"),
        "billing-sync" => (Format::Nested, Duration::seconds(10), "billing-sync"),
        "legacy-gateway" => (Format::Spring, Duration::seconds(5), "legacy-gateway"),
        "event-ingest" => (Format::Nested, Duration::milliseconds(200), "event-ingest"),
        "audit-archiver" => (Format::Dotted, Duration::seconds(8), "audit-archiver"),
        "partner-poller" => (Format::Nested, Duration::seconds(15), "partner-poller"),
        "event-enricher" => (Format::Nested, Duration::seconds(7), "event-enricher"),
        "search-feeder" => (Format::Nested, Duration::seconds(9), "search-feeder"),
        _ => return None,
    })
}

/// FNV-1a: a tiny, stable hash for picking deterministic content.
fn hash(parts: &[&str]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in parts.iter().flat_map(|p| p.bytes().chain([0])) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn pick<'a>(seed: u64, items: &[&'a str]) -> &'a str {
    items[(seed % items.len() as u64) as usize]
}

/// Demo logs. Shares the session state of [`FakeAuth`], like the other fake sources.
pub struct FakeLogs {
    auth: Arc<FakeAuth>,
    /// How often a live tail delivers (CloudWatch: every second).
    live_interval: std::time::Duration,
}

impl FakeLogs {
    pub fn new(auth: Arc<FakeAuth>) -> Self {
        Self {
            auth,
            live_interval: std::time::Duration::from_secs(1),
        }
    }

    /// Like [`FakeLogs::new`] with a different live update interval (shorter in tests).
    pub fn with_live_interval(auth: Arc<FakeAuth>, live_interval: std::time::Duration) -> Self {
        Self {
            auth,
            live_interval,
        }
    }
}

#[async_trait]
impl LogSource for FakeLogs {
    async fn backfill(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
        range: TimeRange,
        limit: usize,
    ) -> Result<Backfill, SourceError> {
        self.auth.check_credentials(&ctx.profile)?;
        let Some((format, interval, service)) = profile_of(&selection.log_group) else {
            return Ok(Backfill::default());
        };
        // A whole-service search (a trace) gives only the stream prefix: invent two task streams.
        let prefixed: Vec<String> = match (&selection.stream_prefix, selection.streams.is_empty()) {
            (Some(prefix), true) => ["0a1b2c3d4e5f", "6a7b8c9d0e1f"]
                .iter()
                .map(|task| format!("{prefix}{task}"))
                .collect(),
            _ => selection.streams.clone(),
        };
        let mut events: Vec<RawEvent> = prefixed
            .iter()
            .flat_map(|stream| generate(stream, service, format, interval, range))
            .collect();
        events.extend(documents(&prefixed, service, format, range));
        if let Some(pattern) = &selection.filter_pattern {
            events.retain(|e| e.message.contains(pattern.as_str()));
        }
        events.sort_by_key(|e| e.timestamp);
        let truncated = events.len() > limit;
        events.truncate(limit);
        Ok(Backfill { events, truncated })
    }

    /// Demo Logs Insights: the same events, searched per log group (demo groups are
    /// `/ecs/<service>` with streams `ecs/<service>/<task>`).
    async fn insights_find(
        &self,
        ctx: &AwsCtx,
        _region: Option<String>,
        log_groups: &[String],
        text: &str,
        range: TimeRange,
        limit: usize,
    ) -> Result<Vec<GroupEvent>, SourceError> {
        let mut found = Vec::new();
        for group in log_groups {
            let service = group.trim_start_matches("/ecs/");
            let selection = StreamSelection {
                log_group: group.clone(),
                region: None,
                account_id: None,
                streams: Vec::new(),
                stream_prefix: Some(format!("ecs/{service}/")),
                filter_pattern: Some(text.to_owned()),
            };
            let backfill = self.backfill(ctx, &selection, range, limit).await?;
            found.extend(backfill.events.into_iter().map(|event| GroupEvent {
                log_group: group.clone(),
                event,
            }));
        }
        found.sort_by_key(|g| g.event.timestamp);
        found.truncate(limit);
        Ok(found)
    }

    async fn live(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
    ) -> Result<LiveStream, LiveError> {
        self.auth.check_credentials(&ctx.profile)?;
        let Some((format, interval, service)) = profile_of(&selection.log_group) else {
            return Err(LiveError::Unavailable(format!(
                "no demo logs for {}",
                selection.log_group
            )));
        };
        let streams = selection.streams.clone();
        let service = service.to_owned();
        let every = self.live_interval;

        // `stream::unfold` builds a stream from a state and an async step function, like a
        // generator: each step waits for the next update, then returns the events whose slots
        // passed since the previous one. The `move` closure owns everything it uses, because the
        // stream lives on after this method returns.
        let updates = futures::stream::unfold(OffsetDateTime::now_utc(), move |since| {
            let streams = streams.clone();
            let service = service.clone();
            async move {
                tokio::time::sleep(every).await;
                let now = OffsetDateTime::now_utc();
                let range = TimeRange {
                    start: Timestamp(since),
                    end: Timestamp(now),
                };
                let mut events: Vec<RawEvent> = streams
                    .iter()
                    .flat_map(|stream| generate(stream, &service, format, interval, range))
                    .collect();
                events.extend(documents(&streams, &service, format, range));
                events.sort_by_key(|e| e.timestamp);
                Some((
                    Ok(LiveItem::Events {
                        events,
                        sampled: false,
                    }),
                    now,
                ))
            }
        });
        let started = futures::stream::once(async { Ok(LiveItem::Started) });
        Ok(started.chain(updates).boxed())
    }
}

/// All events of one stream in `range`: one per `interval` slot, staggered per stream.
fn generate(
    stream: &str,
    service: &str,
    format: Format,
    interval: Duration,
    range: TimeRange,
) -> Vec<RawEvent> {
    let step = interval.whole_milliseconds().max(1) as i64;
    let offset = (hash(&[stream]) % step as u64) as i64;
    let start_ms = (range.start.0.unix_timestamp_nanos() / 1_000_000) as i64;
    let end_ms = (range.end.0.unix_timestamp_nanos() / 1_000_000) as i64;

    let mut events = Vec::new();
    let mut slot = (start_ms - offset).div_euclid(step) * step + offset;
    if slot < start_ms {
        slot += step;
    }
    while slot < end_ms {
        let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(slot) * 1_000_000)
            .expect("valid demo timestamp");
        for (i, line) in lines(stream, service, format, at).into_iter().enumerate() {
            // Split stack trace lines arrive a millisecond apart, like the awslogs driver.
            let timestamp = at + Duration::milliseconds(i as i64);
            if timestamp.unix_timestamp_nanos() / 1_000_000 < i128::from(end_ms) {
                events.push(RawEvent {
                    stream: stream.to_owned(),
                    timestamp: Timestamp(timestamp),
                    message: line,
                });
            }
        }
        slot += step;
    }
    events
}

/// One demo document starts every 30 seconds.
const DOCUMENT_EVERY_MS: i64 = 30_000;
/// The last step of a document comes this long after its start.
const DOCUMENT_TAKES_MS: i64 = 3_000;

/// One status event of a demo document in one service.
struct Step {
    /// After the document's start.
    after_ms: i64,
    previous: &'static str,
    state: &'static str,
    topic: &'static str,
    /// The consumer group, on the reading side.
    group: Option<&'static str>,
    message: &'static str,
}

const RAW: &str = "demo.events";
const ENRICHED: &str = "demo.events.enriched";

/// What `service` logs about document `n`: `event-ingest` writes it to `demo.events`;
/// `legacy-gateway`, `audit-archiver` and the transformer `event-enricher` read it there, and the
/// enricher writes it on to `demo.events.enriched`, where `search-feeder` reads it. Every sixth
/// document stays stuck retrying in `audit-archiver`, every tenth fails in `search-feeder`
/// (the second document of the recorded demo data both).
fn steps(service: &str, n: i64) -> Vec<Step> {
    let step = |after_ms, previous, state, topic, group, message| Step {
        after_ms,
        previous,
        state,
        topic,
        group,
        message,
    };
    let consumed = "Record consumed, starting processing";
    let completed = "Processing completed";
    match service {
        "event-ingest" => vec![
            step(0, "NEW", "RECEIVED", RAW, None, "Document received"),
            step(
                40,
                "RECEIVED",
                "PUBLISHED",
                RAW,
                None,
                "Document stored and published",
            ),
        ],
        "legacy-gateway" => vec![
            step(
                800,
                "PUBLISHED",
                "CONSUMING",
                RAW,
                Some("legacy-gateway"),
                consumed,
            ),
            step(
                1_100,
                "CONSUMING",
                "COMPLETED",
                RAW,
                Some("legacy-gateway"),
                completed,
            ),
        ],
        "audit-archiver" => {
            let group = Some("audit-archiver");
            let end = if n % 6 == 1 {
                step(
                    1_500,
                    "CONSUMING",
                    "RETRYING",
                    RAW,
                    group,
                    "Route is stopping, the record is retried",
                )
            } else {
                step(1_400, "CONSUMING", "COMPLETED", RAW, group, completed)
            };
            vec![
                step(900, "PUBLISHED", "CONSUMING", RAW, group, consumed),
                end,
            ]
        }
        "event-enricher" => {
            let group = Some("event-enricher");
            vec![
                step(700, "PUBLISHED", "CONSUMING", RAW, group, consumed),
                step(
                    1_000,
                    "NEW",
                    "RECEIVED",
                    ENRICHED,
                    None,
                    "Document received",
                ),
                step(
                    1_050,
                    "RECEIVED",
                    "PUBLISHED",
                    ENRICHED,
                    None,
                    "Document stored and published",
                ),
                step(1_100, "CONSUMING", "COMPLETED", RAW, group, completed),
            ]
        }
        "search-feeder" => {
            let group = Some("search-feeder");
            let end = if n % 10 == 1 {
                step(
                    2_000,
                    "CONSUMING",
                    "FAILED",
                    ENRICHED,
                    group,
                    "Processing failed: missing required field 'sku'",
                )
            } else {
                step(2_000, "CONSUMING", "COMPLETED", ENRICHED, group, completed)
            };
            vec![
                step(1_600, "PUBLISHED", "CONSUMING", ENRICHED, group, consumed),
                end,
            ]
        }
        _ => Vec::new(),
    }
}

/// The correlation ID of demo document `n` (32 hex digits).
pub fn document_id(n: i64) -> String {
    format!("{:016x}{n:016x}", hash(&["document", &n.to_string()]))
}

/// The status events `service` logs in `range` about the demo documents (see [`steps`]), each on
/// one of `streams`.
fn documents(streams: &[String], service: &str, format: Format, range: TimeRange) -> Vec<RawEvent> {
    let millis = |t: Timestamp| (t.0.unix_timestamp_nanos() / 1_000_000) as i64;
    let (start, end) = (millis(range.start), millis(range.end));
    if streams.is_empty() || steps(service, 0).is_empty() {
        return Vec::new();
    }
    let mut events = Vec::new();
    let first = (start - DOCUMENT_TAKES_MS).div_euclid(DOCUMENT_EVERY_MS);
    for n in first..=end.div_euclid(DOCUMENT_EVERY_MS) {
        let id = document_id(n);
        let stream = &streams[(hash(&[&id, service]) % streams.len() as u64) as usize];
        for step in steps(service, n) {
            let at = n * DOCUMENT_EVERY_MS + step.after_ms;
            if !(start..end).contains(&at) {
                continue;
            }
            let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(at) * 1_000_000)
                .expect("valid demo timestamp");
            for (i, message) in status_lines(service, format, &step, &id, n, at)
                .into_iter()
                .enumerate()
            {
                events.push(RawEvent {
                    stream: stream.clone(),
                    timestamp: Timestamp(at + Duration::milliseconds(i as i64)),
                    message,
                });
            }
        }
    }
    events
}

/// A document's status event as `service` logs it: ECS JSON with the status under `pipeline`
/// (nested or dotted), or for plain-text logs a line and the status as a JSON line of its own.
fn status_lines(
    service: &str,
    format: Format,
    step: &Step,
    id: &str,
    n: i64,
    at: OffsetDateTime,
) -> Vec<String> {
    let level = match step.state {
        "FAILED" => "ERROR",
        "RETRYING" => "WARN",
        _ => "INFO",
    };
    let logger = "com.example.pipeline.StatusManager";
    let message = format!(
        "Document status change: [event] {} -> {}",
        step.previous, step.state
    );
    let status = json!({
        "state": step.state,
        "previousState": step.previous,
        "message": step.message,
        "topicName": step.topic,
        "consumerGroup": step.group,
        "partition": n.rem_euclid(3),
        "offset": 500_000 + n.rem_euclid(100_000),
        "correlationId": id,
        "objectName": format!("inbound/demo/{id}_event.json"),
    });
    match format {
        Format::Nested => vec![
            json!({
                "@timestamp": rfc3339(at),
                "log": { "level": level, "logger": logger },
                "process": { "pid": 1, "thread": { "name": "events-0-C-1" } },
                "service": { "name": service, "version": "4.2.0", "environment": "DEMO", "node": {} },
                "message": message,
                "pipeline": status,
                "ecs": { "version": "8.11" },
            })
            .to_string(),
        ],
        Format::Dotted => {
            let mut event = json!({
                "@timestamp": rfc3339(at),
                "log.level": level,
                "log.logger": logger,
                "process.thread.name": "events-0-C-1",
                "service.name": service,
                "message": message,
                "ecs.version": "8.11",
            });
            for (key, value) in status.as_object().expect("an object") {
                event[format!("pipeline.{key}")] = value.clone();
            }
            vec![event.to_string()]
        }
        Format::Spring => {
            let time = at
                .format(&time::macros::format_description!(
                    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
                ))
                .expect("formattable timestamp");
            let line = |text: &str| {
                format!(
                    "{time} {level:>5} 1 --- [{service}] [{:>15}] {:<40} : {text}",
                    "events-0-C-1", "c.e.p.StatusManager"
                )
            };
            vec![line(&message), line(&status.to_string())]
        }
    }
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).expect("formattable timestamp")
}

/// The CloudWatch event(s) one slot produces: one line, or several for a split stack trace.
fn lines(stream: &str, service: &str, format: Format, at: OffsetDateTime) -> Vec<String> {
    let seed = hash(&[stream, &at.unix_timestamp_nanos().to_string()]);
    // The event's own time has nanoseconds; CloudWatch's only milliseconds.
    let event_time = at + Duration::nanoseconds((seed % 999_999) as i64);
    match format {
        Format::Nested => vec![nested(service, seed, event_time)],
        Format::Dotted => vec![dotted(service, seed, event_time)],
        Format::Spring => spring(service, seed, event_time),
    }
}

/// A request's trace ID (32 hex digits, like OpenTelemetry's). A handful of them, shared by
/// orders-api, billing-sync and payments-worker, so one request shows up in several services.
fn trace_id(seed: u64) -> String {
    format!("5f3c9a7e1b2d4c6e{:016x}", (seed % 7 + 1) * 0x9e37_79b9_7f4a)
}

const THREADS: &[&str] = &[
    "main",
    "scheduling-1",
    "http-nio-8080-exec-2",
    "events-0-C-1",
];

fn nested(service: &str, seed: u64, at: OffsetDateTime) -> String {
    let roll = seed % 100;
    let (level, logger, message) = match roll {
        0..=4 => (
            "WARN",
            "com.example.client.DownstreamClient",
            r#"Retrying after 503, body: {"title":"Service Unavailable","status":503}"#.to_owned(),
        ),
        5..=6 => (
            "ERROR",
            "com.example.pipeline.StatusManager",
            "Document status change: [order] CONSUMING -> FAILED".to_owned(),
        ),
        7..=19 => (
            "DEBUG",
            "com.example.cache.CatalogCache",
            format!("Refreshed {} catalog entries", 1000 + seed % 500),
        ),
        _ => (
            "INFO",
            "com.example.pipeline.StatusManager",
            pick(
                seed >> 8,
                &[
                    "Document status change: [order] PUBLISHED -> CONSUMING",
                    "Document status change: [order] CONSUMING -> COMPLETED",
                    "POST /api/v1/requests -> 202 Accepted",
                    "Received 3 records from example.orders.events.v1",
                ],
            )
            .to_owned(),
        ),
    };
    // The route services of demo-edge log their documents' steps (see `documents`); only the
    // demo-core services log status changes of random documents.
    let (level, logger, message) = if message.starts_with("Document status change")
        && !matches!(service, "orders-api" | "billing-sync")
    {
        (
            "INFO",
            "com.example.pipeline.ConsumerHealth",
            format!("{} records in flight", seed % 5),
        )
    } else {
        (level, logger, message)
    };
    let mut event = json!({
        "@timestamp": rfc3339(at),
        "log": { "level": level, "logger": logger },
        "process": { "pid": 1, "thread": { "name": pick(seed >> 16, THREADS) } },
        "service": { "name": service, "version": "4.2.0", "environment": "DEMO", "node": {} },
        "message": message,
    });
    // "Document status change: [order] PUBLISHED -> CONSUMING": the status fields say the same.
    if let Some((before, state)) = message
        .strip_prefix("Document status change")
        .and_then(|rest| rest.rsplit_once(" -> "))
    {
        let previous = before.rsplit(' ').next().unwrap_or("CONSUMING");
        let reason = match state {
            "FAILED" => pick(
                seed >> 4,
                &[
                    "Processing failed: missing required field 'customerId'",
                    "Processing failed: Read timed out",
                    "Processing failed: missing required field 'customerId'",
                ],
            ),
            "COMPLETED" => "Processing completed",
            "RETRYING" => "Route is stopping, the record is retried",
            _ => "Record consumed, starting processing",
        };
        event["pipeline"] = json!({
            "state": state,
            "previousState": previous,
            "message": reason,
            "topicName": pick(seed >> 12, &["example.orders.events.v1", "example.orders.events.v1", "example.returns.events.v1"]),
            "partition": seed % 6,
            "offset": 230_000 + seed % 10_000,
            // A handful of documents, so one document shows up in several events (and services).
            "correlationId": format!("DE40C0DE{:08X}-{:016X}", seed % 7, (seed % 7) * 7919),
        });
    }
    // Requests and their downstream calls carry a trace ID; background jobs don't.
    else if level != "DEBUG" {
        event["trace"] = json!({ "id": trace_id(seed >> 24) });
    }
    event["ecs"] = json!({ "version": "8.11" });
    event.to_string()
}

fn stack_trace(seed: u64, frames: usize) -> String {
    let classes = [
        "com.example.payments.client.LedgerClient",
        "com.example.payments.service.SettlementService",
        "org.springframework.web.client.RestTemplate",
        "java.util.concurrent.ThreadPoolExecutor",
    ];
    let mut lines = vec!["java.lang.IllegalStateException: Ledger batch is closed".to_owned()];
    for i in 0..frames {
        let class = classes[(seed as usize + i) % classes.len()];
        let name = class.rsplit('.').next().unwrap_or(class);
        lines.push(format!("\tat {class}.step{i}({name}.java:{})", 40 + i * 3));
    }
    lines.push("Caused by: java.net.SocketTimeoutException: Read timed out".to_owned());
    lines.push(
        "\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(NioSocketImpl.java:278)".to_owned(),
    );
    lines.push(format!(
        "\t... {} common frames omitted",
        frames.saturating_sub(2)
    ));
    lines.join("\n")
}

fn dotted(service: &str, seed: u64, at: OffsetDateTime) -> String {
    let roll = seed % 100;
    let mut event = json!({
        "@timestamp": rfc3339(at),
        "log.level": "INFO",
        "process.pid": 1,
        "process.thread.name": pick(seed >> 16, THREADS),
        "service.name": service,
        "service.version": "2.3.0",
        "service.environment": "DEMO",
        "log.logger": "com.example.payments.service.SettlementService",
        "message": format!("Settled batch 2026/{:04}", seed % 10_000),
    });
    // Payments come in over HTTP and look up their order in orders-api, with a trace ID.
    if roll < 70 {
        event["trace.id"] = json!(trace_id(seed >> 24));
    }
    if (20..45).contains(&roll) {
        event["log.logger"] = json!("com.example.payments.web.PaymentController");
        event["message"] = json!(format!(
            "POST /api/v1/payments -> 201 Created ({} ms)",
            20 + seed % 180
        ));
    } else if (45..70).contains(&roll) {
        event["log.logger"] = json!("com.example.payments.client.OrdersClient");
        event["message"] = json!(format!(
            "GET orders-api /api/v1/orders/{} -> 200 OK",
            100_000 + seed % 900_000
        ));
    }
    if roll < 20 {
        event["log.level"] = json!(if roll < 12 { "ERROR" } else { "WARN" });
        event["message"] = json!("Error while settling batch");
        event["error.type"] = json!("java.lang.IllegalStateException");
        event["error.message"] = json!("Ledger batch is closed");
        event["error.stack_trace"] = json!(stack_trace(seed, 30 + (seed % 50) as usize));
    }
    event["ecs.version"] = json!("8.11");
    // Older logback encoders escape slashes; keep that quirk in the demo data.
    event.to_string().replace('/', "\\/")
}

fn spring(service: &str, seed: u64, at: OffsetDateTime) -> Vec<String> {
    let time = at
        .format(&time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .expect("formattable timestamp");
    let line = |level: &str, thread: &str, logger: &str, message: &str| {
        format!("{time} {level:>5} 1 --- [{service}] [{thread:>15}] {logger:<40} : {message}")
    };
    let roll = seed % 100;
    if roll < 6 {
        let mut lines = vec![line(
            "ERROR",
            "scheduling-1",
            "c.e.g.p.ShipmentPollingService",
            "Polling failed",
        )];
        lines.extend(
            stack_trace(seed, 6)
                .replace(
                    "IllegalStateException: Ledger batch is closed",
                    "IllegalStateException: Partner API unavailable",
                )
                .lines()
                .map(str::to_owned),
        );
        return lines;
    }
    let message = match roll {
        6..=12 => line(
            "WARN",
            "http-nio-8080-exec-2",
            "c.e.g.web.RateLimitFilter",
            "Rate limit reached for client demo-partner (120 req/min)",
        ),
        13..=20 => line(
            "ERROR",
            "scheduling-1",
            "c.e.g.p.ShipmentPollingService",
            r#"Error while polling shipment 9F2K: 404 Not Found: "{"title":"Shipment not found","status":404}""#,
        ),
        21..=40 => line(
            "DEBUG",
            "http-nio-8080-exec-2",
            "c.e.g.web.RequestLogger",
            "GET /actuator/health 200 2ms",
        ),
        _ => line(
            "INFO",
            "scheduling-1",
            "c.e.g.p.ShipmentPollingService",
            &format!("Polled {} shipments, {} changed", 10 + seed % 20, seed % 3),
        ),
    };
    vec![message]
}

#[cfg(test)]
mod tests {
    use super::*;
    use contrail_core::logs::{FieldValue, LogKind, process};
    use std::time::Duration as StdDuration;
    use time::macros::datetime;

    fn fake() -> FakeLogs {
        FakeLogs::new(Arc::new(FakeAuth::with_login_delay(StdDuration::ZERO)))
    }

    fn ctx() -> AwsCtx {
        AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        }
    }

    fn selection(service: &str, tasks: &[&str]) -> StreamSelection {
        StreamSelection {
            log_group: format!("/ecs/{service}"),
            region: None,
            account_id: None,
            streams: tasks.iter().map(|t| format!("ecs/{service}/{t}")).collect(),
            stream_prefix: None,
            filter_pattern: None,
        }
    }

    fn minutes(n: i64) -> TimeRange {
        let start = datetime!(2026-01-15 12:00 UTC);
        TimeRange {
            start: Timestamp(start),
            end: Timestamp(start + Duration::minutes(n)),
        }
    }

    #[tokio::test]
    async fn same_range_gives_the_same_events() {
        let sel = selection("orders-api", &["task1", "task2"]);
        let a = fake()
            .backfill(&ctx(), &sel, minutes(5), 10_000)
            .await
            .unwrap();
        let b = fake()
            .backfill(&ctx(), &sel, minutes(5), 10_000)
            .await
            .unwrap();
        assert_eq!(a, b);
        // 2 streams × 5 min / 4 s
        assert_eq!(a.events.len(), 150);
        assert!(
            a.events
                .windows(2)
                .all(|w| w[0].timestamp <= w[1].timestamp)
        );
    }

    #[tokio::test]
    async fn each_service_logs_in_its_format() {
        for (service, kind) in [
            ("orders-api", LogKind::Ecs),
            ("payments-worker", LogKind::Ecs),
            ("legacy-gateway", LogKind::Spring),
        ] {
            let raw = fake()
                .backfill(&ctx(), &selection(service, &["t1"]), minutes(10), 10_000)
                .await
                .unwrap();
            let events = process(raw.events);
            assert!(!events.is_empty(), "{service}");
            assert!(events.iter().all(|e| e.line.kind == kind), "{service}");
        }
    }

    #[tokio::test]
    async fn documents_pass_through_the_edge_services_in_their_formats() {
        // 12:00 is a document's start: 12:00 UTC is a multiple of 30 s.
        let n = datetime!(2026-01-15 12:00 UTC).unix_timestamp() * 1000 / DOCUMENT_EVERY_MS;
        let id = document_id(n);
        let mut seen = Vec::new();
        for service in [
            "event-ingest",
            "legacy-gateway",
            "audit-archiver",
            "event-enricher",
            "search-feeder",
        ] {
            let mut sel = selection(service, &["t1", "t2"]);
            sel.filter_pattern = Some(id.clone());
            let raw = fake()
                .backfill(&ctx(), &sel, minutes(1), 10_000)
                .await
                .unwrap();
            for event in process(raw.events) {
                let status = event
                    .status
                    .expect("only status events mention the document");
                assert_eq!(status.correlation_id.as_deref(), Some(id.as_str()));
                seen.push((
                    service,
                    status.state,
                    status.topic.unwrap(),
                    status.consumer_group,
                ));
            }
        }
        let has = |service: &str, state: &str, topic: &str| {
            seen.iter()
                .any(|(s, st, t, _)| *s == service && st == state && t == topic)
        };
        assert!(has("event-ingest", "PUBLISHED", RAW));
        // Plain text: the status comes from the JSON line after the message.
        assert!(has("legacy-gateway", "COMPLETED", RAW));
        // Dotted ECS.
        assert!(has("audit-archiver", "CONSUMING", RAW));
        // The transformer reads one topic and writes the next.
        assert!(has("event-enricher", "COMPLETED", RAW));
        assert!(has("event-enricher", "PUBLISHED", ENRICHED));
        assert!(has("search-feeder", "CONSUMING", ENRICHED));
        assert!(
            seen.iter()
                .filter(|(_, state, ..)| state == "CONSUMING")
                .all(|(service, _, _, group)| group.as_deref() == Some(*service)),
            "readers log their consumer group"
        );
    }

    #[test]
    fn some_documents_get_stuck_or_fail() {
        let ends = |service: &str, n: i64| steps(service, n).last().map(|s| s.state);
        assert_eq!(ends("audit-archiver", 7), Some("RETRYING"));
        assert_eq!(ends("audit-archiver", 6), Some("COMPLETED"));
        assert_eq!(ends("search-feeder", 11), Some("FAILED"));
        assert_eq!(ends("search-feeder", 12), Some("COMPLETED"));
        assert_eq!(ends("orders-api", 1), None, "not on the documents' way");
    }

    #[tokio::test]
    async fn a_trace_id_shows_up_in_several_services() {
        let services = ["orders-api", "billing-sync", "payments-worker"];
        let mut events = Vec::new();
        for service in services {
            let raw = fake()
                .backfill(&ctx(), &selection(service, &["t1"]), minutes(10), 10_000)
                .await
                .unwrap();
            events.push(process(raw.events));
        }
        let id = trace_id(0);
        for (service, events) in services.iter().zip(&events) {
            assert!(
                events.iter().any(|e| e
                    .line
                    .fields
                    .iter()
                    .any(|f| matches!(&f.value, FieldValue::Text(v) if *v == id))),
                "{service} logs {id}"
            );
        }
    }

    #[tokio::test]
    async fn stack_traces_appear_in_both_shapes() {
        let dotted = process(
            fake()
                .backfill(
                    &ctx(),
                    &selection("payments-worker", &["t1"]),
                    minutes(30),
                    10_000,
                )
                .await
                .unwrap()
                .events,
        );
        assert!(dotted.iter().any(|e| {
            e.line
                .error
                .as_ref()
                .is_some_and(|err| err.stack_trace.is_some())
        }));

        // The Spring service's split traces are joined back into their ERROR line.
        let spring = process(
            fake()
                .backfill(
                    &ctx(),
                    &selection("legacy-gateway", &["t1"]),
                    minutes(60),
                    10_000,
                )
                .await
                .unwrap()
                .events,
        );
        let joined = spring
            .iter()
            .find(|e| e.line.message == "Polling failed")
            .expect("at least one split stack trace in an hour");
        let trace = joined
            .line
            .error
            .as_ref()
            .unwrap()
            .stack_trace
            .as_ref()
            .unwrap();
        assert!(trace.contains("Caused by: java.net.SocketTimeoutException"));
    }

    #[tokio::test]
    async fn limit_truncates_and_unknown_groups_are_empty() {
        let result = fake()
            .backfill(
                &ctx(),
                &selection("event-ingest", &["t1", "t2"]),
                minutes(15),
                1_000,
            )
            .await
            .unwrap();
        assert_eq!(result.events.len(), 1_000);
        assert!(result.truncated);

        let none = fake()
            .backfill(&ctx(), &selection("unknown", &["t1"]), minutes(5), 100)
            .await
            .unwrap();
        assert!(none.events.is_empty());
    }

    #[tokio::test]
    async fn expired_demo_profiles_fail() {
        let ctx = AwsCtx {
            profile: "demo-prod".into(),
            region: None,
        };
        let result = fake()
            .backfill(&ctx, &selection("orders-api", &["t1"]), minutes(1), 10)
            .await;
        assert!(matches!(result, Err(SourceError::Credentials { .. })));
    }

    #[tokio::test]
    async fn live_tail_delivers_new_events_after_starting() {
        let logs = FakeLogs::with_live_interval(
            Arc::new(FakeAuth::with_login_delay(StdDuration::ZERO)),
            StdDuration::from_millis(450),
        );
        let mut live = logs
            .live(&ctx(), &selection("event-ingest", &["t1", "t2"]))
            .await
            .unwrap();
        assert_eq!(live.next().await, Some(Ok(LiveItem::Started)));
        let Some(Ok(LiveItem::Events { events, sampled })) = live.next().await else {
            panic!("expected events");
        };
        // Two streams with one event per 200 ms each, over 450 ms.
        assert!(events.len() >= 2, "got {}", events.len());
        assert!(!sampled);
        assert!(events.windows(2).all(|w| w[0].timestamp <= w[1].timestamp));
    }

    #[tokio::test]
    async fn live_tail_fails_for_expired_sessions_and_unknown_groups() {
        let expired = AwsCtx {
            profile: "demo-prod".into(),
            region: None,
        };
        assert!(matches!(
            fake()
                .live(&expired, &selection("orders-api", &["t1"]))
                .await,
            Err(LiveError::Source(SourceError::Credentials { .. }))
        ));
        assert!(matches!(
            fake().live(&ctx(), &selection("unknown", &["t1"])).await,
            Err(LiveError::Unavailable(_))
        ));
    }
}
