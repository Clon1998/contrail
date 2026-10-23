//! Status-change events of a pipeline framework: one event per step of a document's way through
//! the services (`RECEIVED → PUBLISHED`, `CONSUMING → COMPLETED | FAILED | RETRYING`).
//!
//! The framework puts the status fields under one prefix (the real one differs from the neutral
//! `pipeline.*` of the fixtures), nested or dotted; in plain-text logs the same status follows as a
//! JSON line of its own. Nothing here knows the prefix: a group of fields `<prefix>.state` with a
//! sibling `<prefix>.correlationId` is a status event.

use serde::Serialize;
use specta::Type;

use super::{FieldValue, ParsedLine};

/// What a status-change event says, for the state badge, the state chips and correlation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    /// The field prefix the status came from (`""` for a plain-text JSON status line).
    pub prefix: String,
    /// `RECEIVED`, `PUBLISHED`, `CONSUMING`, `COMPLETED`, `FAILED`, `RETRYING`, … (as logged).
    pub state: String,
    pub previous_state: Option<String>,
    /// Follows one document across all services.
    pub correlation_id: Option<String>,
    pub topic: Option<String>,
}

const STATE: &str = "state";
const CORRELATION: &str = "correlationId";

/// The status change a line reports, if it is one.
pub fn status_change(line: &ParsedLine) -> Option<StatusChange> {
    from_fields(line).or_else(|| from_json_message(&line.message))
}

fn text(value: &FieldValue) -> Option<String> {
    match value {
        FieldValue::Text(text) if !text.is_empty() => Some(text.clone()),
        FieldValue::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// `<prefix>.state` + `<prefix>.correlationId` among the flattened fields.
fn from_fields(line: &ParsedLine) -> Option<StatusChange> {
    let field = |key: String| {
        line.fields
            .iter()
            .find(|f| f.key == key)
            .and_then(|f| text(&f.value))
    };
    line.fields.iter().find_map(|f| {
        let prefix = f.key.strip_suffix(STATE)?.strip_suffix('.')?;
        let state = text(&f.value)?;
        let correlation_id = field(format!("{prefix}.{CORRELATION}"))?;
        Some(StatusChange {
            prefix: prefix.to_owned(),
            state,
            previous_state: field(format!("{prefix}.previousState")),
            correlation_id: Some(correlation_id),
            topic: field(format!("{prefix}.topicName")),
        })
    })
}

/// A message that is itself a JSON status object (the framework's plain-text mode).
fn from_json_message(message: &str) -> Option<StatusChange> {
    let message = message.trim();
    if !message.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    let get = |key: &str| {
        value
            .get(key)?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some(StatusChange {
        prefix: String::new(),
        state: get(STATE)?,
        previous_state: get("previousState"),
        correlation_id: Some(get(CORRELATION)?),
        topic: get("topicName"),
    })
}

/// The correlation ID of an event: from its status change, else any field named
/// `correlationId` / `correlation_id` (under any prefix).
pub fn correlation_id<'a>(
    status: Option<&'a StatusChange>,
    line: &'a ParsedLine,
) -> Option<&'a str> {
    if let Some(id) = status.and_then(|s| s.correlation_id.as_deref()) {
        return Some(id);
    }
    line.fields.iter().find_map(|f| {
        let name = f.key.rsplit('.').next().unwrap_or(&f.key);
        let is_correlation = name.eq_ignore_ascii_case("correlationid")
            || name.eq_ignore_ascii_case("correlation_id");
        match &f.value {
            FieldValue::Text(id) if is_correlation && !id.is_empty() => Some(id.as_str()),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::parse_line;

    #[test]
    fn nested_status_fields_under_any_prefix() {
        let line = parse_line(
            r#"{"@timestamp":"2026-01-15T09:12:01Z","log":{"level":"INFO"},"message":"Document status change: [order] PUBLISHED -> CONSUMING","acme":{"state":"CONSUMING","previousState":"PUBLISHED","topicName":"example.orders.v1","correlationId":"4C12-0001"}}"#,
        );
        assert_eq!(
            status_change(&line),
            Some(StatusChange {
                prefix: "acme".into(),
                state: "CONSUMING".into(),
                previous_state: Some("PUBLISHED".into()),
                correlation_id: Some("4C12-0001".into()),
                topic: Some("example.orders.v1".into()),
            })
        );
    }

    #[test]
    fn dotted_status_fields() {
        let line = parse_line(
            r#"{"@timestamp":"2026-01-15T09:12:01Z","log.level":"ERROR","message":"failed","pipeline.state":"FAILED","pipeline.correlationId":"4C12-0002","pipeline.previousState":null}"#,
        );
        let status = status_change(&line).unwrap();
        assert_eq!(
            (status.prefix.as_str(), status.state.as_str()),
            ("pipeline", "FAILED")
        );
        assert_eq!(status.previous_state, None);
    }

    #[test]
    fn a_plain_text_json_status_line() {
        let line = parse_line(
            r#"2026-01-15T09:12:01.186Z  INFO 1 --- [orders] [consumer-1] c.e.p.StatusManager : {"state":"COMPLETED","previousState":"CONSUMING","topicName":"example.orders.v1","correlationId":"4C12-0003"}"#,
        );
        let status = status_change(&line).unwrap();
        assert_eq!(
            (status.prefix.as_str(), status.state.as_str()),
            ("", "COMPLETED")
        );
        assert_eq!(status.correlation_id.as_deref(), Some("4C12-0003"));
    }

    #[test]
    fn other_lines_are_not_status_changes() {
        // A `state` field alone (e.g. an order's state) doesn't make a status event.
        let line = parse_line(
            r#"{"@timestamp":"2026-01-15T09:12:01Z","message":"order updated","order":{"state":"SHIPPED"}}"#,
        );
        assert_eq!(status_change(&line), None);
        assert_eq!(status_change(&parse_line("just text")), None);
    }

    #[test]
    fn correlation_ids_from_status_or_any_field() {
        let line = parse_line(
            r#"{"@timestamp":"2026-01-15T09:12:01Z","message":"m","acme":{"correlationId":"C-1"}}"#,
        );
        assert_eq!(correlation_id(None, &line), Some("C-1"));
        let plain = parse_line("no ids here");
        assert_eq!(correlation_id(None, &plain), None);
    }
}
