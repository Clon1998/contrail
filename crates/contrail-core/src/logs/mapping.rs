//! Per-service "field mapping": which JSON keys hold the message, level and timestamp, for
//! services whose JSON logs don't follow ECS or the common alternatives the parser knows.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::json::{as_text, epoch_timestamp, get, take};
use super::parse::{find_json_span, parse_timestamp};
use super::{Field, FieldValue, Level, LogEvent, LogKind};

/// A set, non-blank key name. A `fn` rather than a closure: lifetime elision ties the returned
/// `&str` to the borrowed input here, which closures can't express.
fn key(name: &Option<String>) -> Option<&str> {
    name.as_deref().map(str::trim).filter(|k| !k.is_empty())
}

/// Dotted field names to read the message, level and timestamp from; `None` keeps the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    pub message: Option<String>,
    pub level: Option<String>,
    pub timestamp: Option<String>,
}

impl FieldMapping {
    /// Whether nothing is overridden (blank names count as unset).
    pub fn is_empty(&self) -> bool {
        [&self.message, &self.level, &self.timestamp]
            .into_iter()
            .all(|name| key(name).is_none())
    }

    /// Re-reads message, level and timestamp of a JSON event from the mapped fields. Lines that
    /// aren't JSON, and events without a mapped field, stay as they are.
    pub fn apply(&self, event: &mut LogEvent) {
        let line = &mut event.line;
        if !matches!(line.kind, LogKind::Ecs | LogKind::Json) {
            return;
        }

        if let Some(key) = key(&self.message)
            && let Some(value) = take(&mut line.fields, &[key]).and_then(|v| as_text(&v))
        {
            // The message the parser found stays visible as a field.
            let previous = std::mem::replace(&mut line.message, value);
            if !previous.is_empty() {
                line.fields.insert(
                    0,
                    Field {
                        key: "message".into(),
                        value: FieldValue::Text(previous),
                    },
                );
            }
            line.json_span = find_json_span(&line.message);
        }
        if let Some(key) = key(&self.level)
            && let Some(level) = get(&line.fields, key)
                .and_then(as_text)
                .and_then(|text| Level::parse(&text))
        {
            line.level = Some(level);
        }
        if let Some(key) = key(&self.timestamp)
            && let Some(timestamp) = get(&line.fields, key).and_then(|value| match value {
                FieldValue::Text(text) => parse_timestamp(text),
                FieldValue::Number(n) => n.as_i64().and_then(epoch_timestamp),
                FieldValue::Bool(_) => None,
            })
        {
            line.timestamp = Some(timestamp);
            event.timestamp = timestamp;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::RawEvent;
    use crate::timestamp::Timestamp;
    use time::macros::datetime;

    fn event(message: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: "app/web/5f2a".into(),
            timestamp: Timestamp(datetime!(2026-03-01 10:00:00 UTC)),
            message: message.into(),
        })
    }

    fn mapping(message: &str, level: &str, timestamp: &str) -> FieldMapping {
        let some = |s: &str| (!s.is_empty()).then(|| s.to_owned());
        FieldMapping {
            message: some(message),
            level: some(level),
            timestamp: some(timestamp),
        }
    }

    #[test]
    fn reads_message_level_and_time_from_custom_keys() {
        let mut e =
            event(r#"{"text":"order stored","sev":"warning","at":1772359205000,"msg":"x"}"#);
        mapping("text", "sev", "at").apply(&mut e);
        assert_eq!(e.line.message, "order stored");
        assert_eq!(e.line.level, Some(Level::Warn));
        assert_eq!(e.timestamp.0, datetime!(2026-03-01 10:00:05 UTC));
        // The message found before is kept as a field.
        assert_eq!(e.line.field("message"), Some(&FieldValue::Text("x".into())));
        assert!(e.line.field("text").is_none());
    }

    #[test]
    fn leaves_lines_without_the_fields_or_json_alone() {
        let original = event(r#"{"message":"hello","level":"INFO"}"#);
        let mut e = original.clone();
        mapping("text", "sev", "at").apply(&mut e);
        assert_eq!(e, original);

        let original = event("2026-03-01 plain text");
        let mut e = original.clone();
        mapping("text", "", "").apply(&mut e);
        assert_eq!(e, original);
    }

    #[test]
    fn blank_names_are_empty() {
        assert!(FieldMapping::default().is_empty());
        assert!(mapping(" ", "", "").is_empty());
        assert!(!mapping("", "sev", "").is_empty());
    }
}
