//! Writing a view's events to a file: the raw lines (`.log`) or one JSON object per event (`.jsonl`).

use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use super::{FieldValue, Level, LogError, LogEvent};
use crate::timestamp::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// The original lines, as CloudWatch delivered them (stack traces joined).
    Log,
    /// One JSON object per event: time, level, task, stream, message, fields, error.
    Jsonl,
}

/// One line of a `.jsonl` export. Borrows from the event: `'a` says the row can't outlive it,
/// so nothing is copied before serializing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonRow<'a> {
    timestamp: Timestamp,
    level: Option<Level>,
    task_id: &'a str,
    stream: &'a str,
    message: &'a str,
    /// The structured fields as one object, keyed by their dotted names.
    #[serde(skip_serializing_if = "Map::is_empty")]
    fields: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a LogError>,
}

impl<'a> JsonRow<'a> {
    fn new(event: &'a LogEvent) -> Self {
        let fields = event
            .line
            .fields
            .iter()
            .map(|f| {
                let value = match &f.value {
                    FieldValue::Text(s) => Value::String(s.clone()),
                    FieldValue::Number(n) => Value::Number(n.clone()),
                    FieldValue::Bool(b) => Value::Bool(*b),
                };
                (f.key.clone(), value)
            })
            .collect();
        Self {
            timestamp: event.timestamp,
            level: event.line.level,
            task_id: &event.task_id,
            stream: &event.stream,
            message: &event.line.message,
            fields,
            error: event.line.error.as_ref(),
        }
    }
}

/// Writes `events` to `out` in `format`; returns how many were written.
///
/// Generic over `W: Write` (like a `java.io.Writer` parameter): the app passes a buffered file,
/// the tests a `Vec<u8>`.
pub fn write_events<'a, W: Write>(
    events: impl IntoIterator<Item = &'a LogEvent>,
    format: ExportFormat,
    mut out: W,
) -> io::Result<usize> {
    let mut count = 0;
    for event in events {
        match format {
            ExportFormat::Log => writeln!(out, "{}", event.raw)?,
            ExportFormat::Jsonl => {
                serde_json::to_writer(&mut out, &JsonRow::new(event))?;
                out.write_all(b"\n")?;
            }
        }
        count += 1;
    }
    out.flush()?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::{RawEvent, process};
    use time::macros::datetime;

    fn events() -> Vec<LogEvent> {
        let raw = |message: &str| RawEvent {
            stream: "ecs/orders-api/5f2a".into(),
            timestamp: Timestamp(datetime!(2026-03-01 10:00:00 UTC)),
            message: message.into(),
        };
        process(vec![
            raw(
                r#"{"@timestamp":"2026-03-01T10:00:00.123Z","log.level":"WARN","message":"slow","trace.id":"abc","http.status":503}"#,
            ),
            raw("2026-03-01T10:00:01.000Z ERROR 1 --- [main] c.e.Orders : boom"),
            raw("java.lang.IllegalStateException: boom"),
            raw("\tat com.example.Orders.run(Orders.java:42)"),
        ])
    }

    #[test]
    fn log_format_writes_the_raw_lines() {
        let mut out = Vec::new();
        let count = write_events(&events(), ExportFormat::Log, &mut out).unwrap();
        assert_eq!(count, 2, "the stack trace is joined to its line");
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with(r#"{"@timestamp":"2026-03-01T10:00:00.123Z""#));
        assert!(text.ends_with("\tat com.example.Orders.run(Orders.java:42)\n"));
    }

    #[test]
    fn jsonl_writes_one_object_per_event() {
        let mut out = Vec::new();
        write_events(&events(), ExportFormat::Jsonl, &mut out).unwrap();
        let rows: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["level"], "WARN");
        assert_eq!(rows[0]["message"], "slow");
        assert_eq!(rows[0]["taskId"], "5f2a");
        assert_eq!(rows[0]["fields"]["trace.id"], "abc");
        assert_eq!(rows[0]["fields"]["http.status"], 503);
        assert!(rows[0].get("error").is_none());
        assert_eq!(rows[1]["level"], "ERROR");
        assert!(
            rows[1]["error"]["stackTrace"]
                .as_str()
                .unwrap()
                .contains("Orders.java:42")
        );
    }
}
