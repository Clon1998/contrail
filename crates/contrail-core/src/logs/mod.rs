//! Log events: the model, parsing of the three production formats, multi-line joining and the
//! in-memory buffer the log views read from.

mod json;
pub mod parse;
mod spring;

use serde::Serialize;
use specta::Type;

use crate::timestamp::Timestamp;

pub use parse::parse_line;

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
    /// The JSON value: strings stay strings, numbers stay numbers.
    pub value: serde_json::Value,
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
    pub fn field(&self, key: &str) -> Option<&serde_json::Value> {
        self.fields.iter().find(|f| f.key == key).map(|f| &f.value)
    }
}
