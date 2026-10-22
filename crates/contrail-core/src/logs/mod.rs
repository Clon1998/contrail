//! Log events: the model, parsing of the three production formats, multi-line joining and the
//! in-memory buffer the log views read from.

pub mod buffer;
mod json;
pub mod location;
pub mod multiline;
pub mod parse;
pub mod source;
mod spring;

use serde::Serialize;
use specta::Type;

use crate::timestamp::Timestamp;

pub use buffer::{BufferStats, LogBuffer};
pub use location::{LocationError, LogLocation, resolve_log_location};
pub use multiline::MultilineJoiner;
pub use parse::parse_line;
pub use source::{Backfill, LogSource, StreamSelection, TimeRange};

/// Log levels, from least to most severe (the derived `Ord` follows declaration order, so
/// `Level::Warn > Level::Info` works for "WARN and above" filters).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Type)]
#[serde(rename_all = "UPPERCASE")]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    /// Reads a level name case-insensitively, including common aliases (`WARNING`, `FATAL`, …).
    pub fn parse(name: &str) -> Option<Level> {
        match name.trim().to_ascii_uppercase().as_str() {
            "TRACE" | "FINEST" => Some(Level::Trace),
            "DEBUG" | "FINE" => Some(Level::Debug),
            "INFO" | "INFORMATION" | "NOTICE" => Some(Level::Info),
            "WARN" | "WARNING" => Some(Level::Warn),
            "ERROR" | "ERR" | "FATAL" | "CRITICAL" | "SEVERE" => Some(Level::Error),
            _ => None,
        }
    }
}

/// How a line was understood.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogKind {
    /// Elastic Common Schema JSON (Spring Boot's `ecs` structured logging), nested or dotted.
    Ecs,
    /// Some other JSON object.
    Json,
    /// Spring Boot's default console pattern.
    Spring,
    /// Anything else, shown as it is.
    Plain,
}

/// One field of a structured event, with its dotted name (`log.logger`, `pipeline.offset`).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub value: FieldValue,
}

/// A field's value: strings stay strings, numbers stay numbers.
///
/// `#[serde(untagged)]` serializes just the inner value (`"x"`, `42`, `true`), so TypeScript
/// sees `string | number | boolean`. Fields whose value is `null` are left out by the parser.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(untagged)]
pub enum FieldValue {
    Text(String),
    /// Kept as JSON's number (exact digits); a plain `number` in TypeScript.
    Number(#[specta(type = f64)] serde_json::Number),
    Bool(bool),
}

impl From<serde_json::Value> for FieldValue {
    fn from(value: serde_json::Value) -> Self {
        use serde_json::Value;
        match value {
            Value::String(s) => FieldValue::Text(s),
            Value::Number(n) => FieldValue::Number(n),
            Value::Bool(b) => FieldValue::Bool(b),
            // Arrays (and objects inside them) are rare in logs: shown as compact JSON. (The
            // parser drops nulls before they get here.)
            other => FieldValue::Text(other.to_string()),
        }
    }
}

impl FieldValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FieldValue::Text(s) => Some(s),
            _ => None,
        }
    }
}

/// An exception attached to an event (ECS `error.*`, or a joined plain-text stack trace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogError {
    pub error_type: Option<String>,
    pub message: Option<String>,
    pub stack_trace: Option<String>,
}

/// What the parser gets out of one raw log line.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLine {
    pub kind: LogKind,
    /// The event's own time (`@timestamp`, or the time at the start of a Spring line), when it
    /// has one with a time zone.
    pub timestamp: Option<Timestamp>,
    pub level: Option<Level>,
    /// The human-readable part: `message` for JSON, the text after `:` for Spring, the whole line
    /// for plain text (ANSI colour codes kept).
    pub message: String,
    /// All other structured fields, flattened to dotted names, in their original order.
    pub fields: Vec<Field>,
    pub error: Option<LogError>,
    /// Byte range `[start, end)` of the first JSON object embedded in `message`, if any.
    pub json_span: Option<(u32, u32)>,
}

impl ParsedLine {
    /// The value of a field by its dotted name.
    pub fn field(&self, key: &str) -> Option<&FieldValue> {
        self.fields.iter().find(|f| f.key == key).map(|f| &f.value)
    }
}

/// A log event as CloudWatch delivers it, before parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    /// The log stream, e.g. `ecs/orders-api/0123abcd…` (`<prefix>/<container>/<task id>`).
    pub stream: String,
    /// CloudWatch's timestamp of the event (milliseconds precision).
    pub timestamp: Timestamp,
    pub message: String,
}

/// A parsed log event in a view.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    /// Unique and stable within a view (assigned by the buffer), for the UI's row keys.
    pub seq: u32,
    /// The time shown and sorted by: the event's own timestamp, else CloudWatch's.
    pub timestamp: Timestamp,
    /// CloudWatch's timestamp, for ordering ties and deduplication.
    pub cw_timestamp: Timestamp,
    pub stream: String,
    /// The ECS task the stream belongs to (its last path segment).
    pub task_id: String,
    pub line: ParsedLine,
    /// The original text (several lines when a stack trace was joined).
    pub raw: String,
}

impl LogEvent {
    /// Parses a raw CloudWatch event. `seq` is assigned when the event enters a buffer.
    pub fn from_raw(raw: RawEvent) -> Self {
        let line = parse_line(&raw.message);
        Self {
            seq: 0,
            timestamp: line.timestamp.unwrap_or(raw.timestamp),
            cw_timestamp: raw.timestamp,
            task_id: raw.stream.rsplit('/').next().unwrap_or_default().to_owned(),
            stream: raw.stream,
            line,
            raw: raw.message.trim_end_matches(['\n', '\r']).to_owned(),
        }
    }
}

/// Turns a backfill into view-ready events: parses every line and joins split stack traces.
pub fn process(raw: Vec<RawEvent>) -> Vec<LogEvent> {
    let events = raw.into_iter().map(LogEvent::from_raw).collect();
    multiline::join_all(events, multiline::DEFAULT_WINDOW)
}
