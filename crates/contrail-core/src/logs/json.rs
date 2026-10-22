//! JSON log lines: ECS (nested or dotted) and other JSON objects.

use serde_json::{Map, Value};

use super::parse::{find_json_span, parse_timestamp};
use super::{Field, FieldValue, Level, LogError, LogKind, ParsedLine};

/// Flattens nested objects into dotted keys: `{"log":{"level":"INFO"}}` → `log.level`.
/// Empty objects (`"node":{}`) and `null` values disappear; arrays are kept as values.
fn flatten(prefix: &str, map: Map<String, Value>, out: &mut Vec<Field>) {
    for (key, value) in map {
        let key = if prefix.is_empty() {
            key
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            Value::Object(inner) => flatten(&key, inner, out),
            Value::Null => {}
            value => out.push(Field {
                key,
                value: value.into(),
            }),
        }
    }
}

/// Removes the first field named any of `keys` and returns its value.
fn take(fields: &mut Vec<Field>, keys: &[&str]) -> Option<FieldValue> {
    let index = fields.iter().position(|f| keys.contains(&f.key.as_str()))?;
    Some(fields.remove(index).value)
}

fn get<'a>(fields: &'a [Field], key: &str) -> Option<&'a FieldValue> {
    fields.iter().find(|f| f.key == key).map(|f| &f.value)
}

fn as_text(value: &FieldValue) -> Option<String> {
    Some(match value {
        FieldValue::Text(s) => s.clone(),
        FieldValue::Number(n) => n.to_string(),
        FieldValue::Bool(b) => b.to_string(),
    })
}

/// Parses a line that is a JSON object; `None` if it isn't.
pub(super) fn parse_json(line: &str) -> Option<ParsedLine> {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(line) else {
        return None;
    };
    let mut fields = Vec::new();
    flatten("", map, &mut fields);

    let is_ecs = get(&fields, "@timestamp").is_some()
        && (get(&fields, "ecs.version").is_some() || get(&fields, "log.level").is_some());

    // Where timestamp, level and message live: ECS names first, then common alternatives.
    let (time_keys, level_keys, message_keys): (&[&str], &[&str], &[&str]) = if is_ecs {
        (&["@timestamp"], &["log.level"], &["message"])
    } else {
        (
            &["@timestamp", "timestamp", "time", "ts"],
            &["level", "log.level", "severity", "lvl"],
            &["message", "msg", "log"],
        )
    };

    let timestamp =
        time_keys
            .iter()
            .find_map(|key| get(&fields, key))
            .and_then(|value| match value {
                FieldValue::Text(text) => parse_timestamp(text),
                FieldValue::Number(n) => n.as_i64().and_then(epoch_timestamp),
                _ => None,
            });
    let level = level_keys
        .iter()
        .find_map(|key| get(&fields, key))
        .and_then(FieldValue::as_str)
        .and_then(Level::parse);
    let message = take(&mut fields, message_keys)
        .and_then(|v| as_text(&v))
        .unwrap_or_default();

    let stack_trace = take(&mut fields, &["error.stack_trace"]).and_then(|v| as_text(&v));
    let error_type = get(&fields, "error.type").and_then(as_text);
    let error_message = get(&fields, "error.message").and_then(as_text);
    let has_error = error_type.is_some() || error_message.is_some() || stack_trace.is_some();
    let error = has_error.then_some(LogError {
        error_type,
        message: error_message,
        stack_trace,
    });

    Some(ParsedLine {
        kind: if is_ecs { LogKind::Ecs } else { LogKind::Json },
        timestamp,
        level,
        json_span: find_json_span(&message),
        message,
        fields,
        error,
    })
}

/// Epoch seconds or milliseconds (whichever the magnitude suggests).
fn epoch_timestamp(value: i64) -> Option<crate::timestamp::Timestamp> {
    let nanos = if value > 100_000_000_000 {
        i128::from(value) * 1_000_000
    } else {
        i128::from(value) * 1_000_000_000
    };
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .map(crate::timestamp::Timestamp)
}
