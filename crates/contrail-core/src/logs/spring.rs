//! Spring Boot's default console pattern:
//!
//! `<ISO timestamp> <LEVEL> <pid> --- [<app>] [<thread>] <logger> : <message>`
//!
//! Level, thread and logger are padded; older versions have no `[<app>]` block; newer ones may add
//! a correlation block (`[traceId-spanId]`) after the thread.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::parse::{find_json_span, parse_timestamp, strip_ansi};
use super::{Field, Level, LogKind, ParsedLine};

/// Compiled once on first use. `LazyLock` (std) is the thread-safe "initialize on first access"
/// helper, like a lazily initialized `static final` in Java.
static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?x)^
        (?P<ts>\d{4}-\d{2}-\d{2}[T\ ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+
        (?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+
        (?P<pid>\d+)\s+---\s+
        (?:\[(?P<app>[^\]]*)\]\s+)?
        \[(?P<thread>[^\]]*)\]\s+
        (?:\[(?P<corr>[^\]]*)\]\s+)?
        (?P<logger>\S+)\s*:\s?
        (?P<message>.*)$",
    )
    .expect("valid Spring console pattern")
});

/// Parses a Spring Boot console line; `None` if the line doesn't follow the pattern.
pub(super) fn parse_spring(line: &str) -> Option<ParsedLine> {
    // Colour output (ANSI codes) is common in console logs; match on the plain text.
    let text = strip_ansi(line);
    let caps = PATTERN.captures(&text)?;
    let group = |name: &str| caps.name(name).map(|m| m.as_str().trim());

    let mut fields = Vec::new();
    let mut push = |key: &str, value: Value| {
        fields.push(Field {
            key: key.to_owned(),
            value: value.into(),
        })
    };
    let level = group("level").and_then(Level::parse);
    if let Some(level) = group("level") {
        push("log.level", Value::from(level));
    }
    if let Some(pid) = group("pid").and_then(|p| p.parse::<u64>().ok()) {
        push("process.pid", Value::from(pid));
    }
    if let Some(app) = group("app").filter(|a| !a.is_empty()) {
        push("service.name", Value::from(app));
    }
    if let Some(thread) = group("thread") {
        push("process.thread.name", Value::from(thread));
    }
    if let Some(corr) = group("corr").filter(|c| !c.is_empty()) {
        push("log.correlation", Value::from(corr));
    }
    if let Some(logger) = group("logger") {
        push("log.logger", Value::from(logger));
    }

    let message = caps
        .name("message")
        .map(|m| m.as_str().to_owned())
        .unwrap_or_default();
    Some(ParsedLine {
        kind: LogKind::Spring,
        timestamp: group("ts").and_then(|ts| parse_timestamp(&ts.replace(',', "."))),
        level,
        json_span: find_json_span(&message),
        message,
        fields,
        error: None,
    })
}
