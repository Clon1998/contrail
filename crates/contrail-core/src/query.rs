//! Session search: a small query language evaluated against the events of a view.
//!
//! ```text
//! timeout                 free text (case-insensitive, in the message)
//! "read timed out"        a phrase
//! /time(out|d out)/       a regular expression (case-insensitive)
//! level:ERROR level>=WARN the log level (TRACE < DEBUG < INFO < WARN < ERROR)
//! trace.id:abc123         a field equals (case-insensitive)
//! log.logger:*Camel*      a field matches a glob (`*` any text, `?` one character)
//! pipeline.offset>=230000 a numeric field compared (>, >=, <, <=)
//! task:5f2a  message:x    the task ID (prefix) or the message
//! -healthcheck            any term negated
//! ```
//!
//! All terms must match (AND).

use regex::{Regex, RegexBuilder};
use serde::Serialize;
use specta::Type;

use crate::logs::{FieldValue, Level, LogEvent, correlation_id};

/// A comparison in `key<op>value`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// `:` — equals, or matches a glob for fields.
    Is,
    Gt,
    Ge,
    Lt,
    Le,
}

/// What one term tests.
#[derive(Debug, Clone)]
pub enum Condition {
    /// Contains this (lower-cased) text.
    Text(String),
    Regex(Regex),
    Level(Op, Level),
    /// The task ID starts with this (lower-cased) text.
    Task(String),
    /// A pipeline status change in this state (or a plain `state` field), any case.
    State(String),
    /// The event's correlation ID (status change or any `…correlationId` field), any case.
    Correlation(String),
    /// A field equals (case-insensitive) this text.
    FieldIs {
        key: String,
        value: String,
    },
    /// A field matches this glob (compiled to an anchored regex).
    FieldGlob {
        key: String,
        pattern: Regex,
    },
    /// A numeric field compared with a number.
    FieldCompare {
        key: String,
        op: Op,
        value: f64,
    },
}

/// One term of a query, with its position in the input (byte offsets) for highlighting and errors.
#[derive(Debug, Clone)]
pub struct Term {
    pub negated: bool,
    pub condition: Condition,
    pub start: usize,
    pub end: usize,
}

/// A parsed query: all terms must match.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub terms: Vec<Term>,
}

/// Why a query couldn't be parsed, with the position of the problem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct QueryError {
    pub message: String,
    /// Byte range of the problem in the query text (UTF-8).
    pub start: u32,
    pub end: u32,
    pub hint: Option<String>,
}

fn error(message: impl Into<String>, start: usize, end: usize, hint: Option<&str>) -> QueryError {
    QueryError {
        message: message.into(),
        start: u32::try_from(start).unwrap_or(u32::MAX),
        end: u32::try_from(end).unwrap_or(u32::MAX),
        hint: hint.map(str::to_owned),
    }
}

/// A raw token: its text and where it is in the input.
struct Token<'a> {
    text: &'a str,
    start: usize,
}

/// Splits the input at whitespace outside quotes and `/regex/` (so both may contain spaces).
fn tokenize(input: &str) -> Result<Vec<Token<'_>>, QueryError> {
    let mut tokens = Vec::new();
    let mut chars = input.char_indices().peekable();
    while let Some(&(start, c)) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        // Inside a token: track whether we're in quotes or a regex, skipping escaped characters.
        let mut quote: Option<(char, usize)> = None;
        let mut end = input.len();
        let mut escaped = false;
        let mut first = true;
        while let Some(&(i, c)) = chars.peek() {
            if let Some((q, _)) = quote {
                chars.next();
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            if c.is_whitespace() {
                end = i;
                break;
            }
            // A regex starts at the beginning of a term (after an optional `-`).
            let starts_regex = c == '/' && (first || input[start..i] == *"-");
            if c == '"' || starts_regex {
                quote = Some((c, i));
            }
            first = false;
            chars.next();
        }
        if let Some((q, at)) = quote {
            let (what, hint) = if q == '"' {
                ("unterminated quote", "Close the phrase with \"")
            } else {
                (
                    "unterminated regular expression",
                    "Close the regular expression with /",
                )
            };
            return Err(error(what, at, input.len(), Some(hint)));
        }
        tokens.push(Token {
            text: &input[start..end],
            start,
        });
    }
    Ok(tokens)
}

/// `key<op>value`: the key, the operator and where the value starts.
fn split_key(text: &str) -> Option<(&str, Op, usize)> {
    let key_end = text
        .char_indices()
        .find(|&(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')))
        .map(|(i, _)| i)?;
    let key = &text[..key_end];
    if key.is_empty() || !key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '@') {
        return None;
    }
    let rest = &text[key_end..];
    let (op, len) = if rest.starts_with(">=") {
        (Op::Ge, 2)
    } else if rest.starts_with("<=") {
        (Op::Le, 2)
    } else if rest.starts_with('>') {
        (Op::Gt, 1)
    } else if rest.starts_with('<') {
        (Op::Lt, 1)
    } else if rest.starts_with(':') {
        (Op::Is, 1)
    } else {
        return None;
    };
    Some((key, op, key_end + len))
}

/// Removes surrounding quotes and unescapes `\"` and `\\`.
fn unquote(text: &str) -> String {
    let inner = text
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(text);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

const LEVEL_HINT: &str = "Levels: TRACE, DEBUG, INFO, WARN, ERROR";

/// Parses a query. An empty query matches everything.
pub fn parse_query(input: &str) -> Result<Query, QueryError> {
    let mut terms = Vec::new();
    for token in tokenize(input)? {
        let (negated, body, body_start) = match token.text.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest, token.start + 1),
            _ => (false, token.text, token.start),
        };
        let end = token.start + token.text.len();
        let condition = parse_term(body, body_start, end)?;
        terms.push(Term {
            negated,
            condition,
            start: token.start,
            end,
        });
    }
    Ok(Query { terms })
}

/// Parses the search box in regex mode: the whole input is one case-insensitive regular
/// expression (no query syntax, so spaces, quotes and slashes need no escaping).
pub fn parse_regex_query(input: &str) -> Result<Query, QueryError> {
    if input.is_empty() {
        return Ok(Query::default());
    }
    let condition = regex_condition(input, 0, input.len(), "time(out|d out)")?;
    Ok(Query {
        terms: vec![Term {
            negated: false,
            condition,
            start: 0,
            end: input.len(),
        }],
    })
}

/// A case-insensitive regex term; errors point at `start..end` and show `example` as a hint.
fn regex_condition(
    pattern: &str,
    start: usize,
    end: usize,
    example: &str,
) -> Result<Condition, QueryError> {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map(Condition::Regex)
        .map_err(|e| {
            error(
                format!("invalid regular expression: {}", first_line(&e.to_string())),
                start,
                end,
                Some(&format!(
                    "Regular expressions use Rust syntax, e.g. {example}"
                )),
            )
        })
}

fn parse_term(body: &str, start: usize, end: usize) -> Result<Condition, QueryError> {
    if let Some(pattern) = body.strip_prefix('/').and_then(|b| b.strip_suffix('/'))
        && body.len() >= 2
    {
        return regex_condition(pattern, start, end, "/time(out|d out)/");
    }
    if body.starts_with('"') {
        return Ok(Condition::Text(unquote(body).to_lowercase()));
    }
    let Some((key, op, value_at)) = split_key(body) else {
        return Ok(Condition::Text(body.to_lowercase()));
    };
    let raw_value = &body[value_at..];
    if raw_value.is_empty() {
        return Err(error(
            format!("value missing after \"{}\"", &body[..value_at]),
            start,
            end,
            Some("Write e.g. level:ERROR or trace.id:abc123"),
        ));
    }
    let value = unquote(raw_value);
    match key.to_ascii_lowercase().as_str() {
        "level" => {
            let level = Level::parse(&value).ok_or_else(|| {
                error(
                    format!("unknown level \"{value}\""),
                    start + value_at,
                    end,
                    Some(LEVEL_HINT),
                )
            })?;
            Ok(Condition::Level(op, level))
        }
        "message" | "msg" if op == Op::Is => Ok(Condition::Text(value.to_lowercase())),
        "task" if op == Op::Is => Ok(Condition::Task(value.to_lowercase())),
        "state" if op == Op::Is => Ok(Condition::State(value.to_lowercase())),
        "correlation" if op == Op::Is => Ok(Condition::Correlation(value.to_lowercase())),
        _ if op == Op::Is && value.contains(['*', '?']) => Ok(Condition::FieldGlob {
            key: key.to_owned(),
            pattern: glob(&value),
        }),
        _ if op == Op::Is => Ok(Condition::FieldIs {
            key: key.to_owned(),
            value: value.to_lowercase(),
        }),
        _ => {
            let number: f64 = value.parse().map_err(|_| {
                error(
                    format!("\"{value}\" is not a number"),
                    start + value_at,
                    end,
                    Some("Comparisons (>, >=, <, <=) work on numeric fields, e.g. pipeline.offset>=230000"),
                )
            })?;
            Ok(Condition::FieldCompare {
                key: key.to_owned(),
                op,
                value: number,
            })
        }
    }
}

/// `*Camel*` → `^.*camel.*$` (case-insensitive).
fn glob(pattern: &str) -> Regex {
    let mut regex = String::from("^");
    for c in pattern.chars() {
        match c {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            c => regex.push_str(&regex::escape(&c.to_string())),
        }
    }
    regex.push('$');
    RegexBuilder::new(&regex)
        .case_insensitive(true)
        .build()
        .expect("escaped glob is a valid regex")
}

fn first_line(text: &str) -> &str {
    text.lines().last().unwrap_or(text).trim()
}

/// Options that change what text terms look at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MatchOptions {
    /// Search the whole raw line (all JSON fields, the full stack trace), not just the message.
    pub raw: bool,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Whether the event matches every term.
    pub fn matches(&self, event: &LogEvent, options: MatchOptions) -> bool {
        // Lower-case the haystack once per event, only if a text term needs it.
        let mut haystack: Option<String> = None;
        self.terms.iter().all(|term| {
            let hit = match &term.condition {
                Condition::Text(needle) => haystack
                    .get_or_insert_with(|| text_of(event, options).to_lowercase())
                    .contains(needle.as_str()),
                Condition::Regex(regex) => regex.is_match(text_of(event, options)),
                Condition::Level(op, level) => event
                    .line
                    .level
                    .is_some_and(|actual| compare(op, actual.cmp(level))),
                Condition::Task(prefix) => {
                    event.task_id.to_lowercase().starts_with(prefix.as_str())
                }
                Condition::State(state) => {
                    event
                        .status
                        .as_ref()
                        .is_some_and(|s| s.state.to_lowercase() == *state)
                        || field_text(event, "state").is_some_and(|t| t.to_lowercase() == *state)
                }
                Condition::Correlation(id) => correlation_id(event.status.as_ref(), &event.line)
                    .is_some_and(|actual| actual.to_lowercase() == *id),
                Condition::FieldIs { key, value } => {
                    field_text(event, key).is_some_and(|text| text.to_lowercase() == *value)
                }
                Condition::FieldGlob { key, pattern } => {
                    field_text(event, key).is_some_and(|text| pattern.is_match(&text))
                }
                Condition::FieldCompare { key, op, value } => {
                    field_number(event, key).is_some_and(|actual| match actual.partial_cmp(value) {
                        Some(ordering) => compare(op, ordering),
                        None => false,
                    })
                }
            };
            hit != term.negated
        })
    }

    /// The plain text and phrase terms (not negated), for highlighting matches in the UI.
    pub fn highlight_terms(&self) -> Vec<String> {
        self.terms
            .iter()
            .filter(|t| !t.negated)
            .filter_map(|t| match &t.condition {
                Condition::Text(text) if !text.is_empty() => Some(text.clone()),
                _ => None,
            })
            .collect()
    }
}

fn compare(op: &Op, ordering: std::cmp::Ordering) -> bool {
    use std::cmp::Ordering::*;
    match op {
        Op::Is => ordering == Equal,
        Op::Gt => ordering == Greater,
        Op::Ge => ordering != Less,
        Op::Lt => ordering == Less,
        Op::Le => ordering != Greater,
    }
}

fn text_of(event: &LogEvent, options: MatchOptions) -> &str {
    if options.raw {
        &event.raw
    } else {
        &event.line.message
    }
}

/// A field's value as text (also `stream`, which isn't a parsed field).
fn field_text(event: &LogEvent, key: &str) -> Option<String> {
    if key == "stream" {
        return Some(event.stream.clone());
    }
    Some(match event.line.field(key)? {
        FieldValue::Text(s) => s.clone(),
        FieldValue::Number(n) => n.to_string(),
        FieldValue::Bool(b) => b.to_string(),
    })
}

fn field_number(event: &LogEvent, key: &str) -> Option<f64> {
    match event.line.field(key)? {
        FieldValue::Number(n) => n.as_f64(),
        FieldValue::Text(s) => s.trim().parse().ok(),
        FieldValue::Bool(_) => None,
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
            stream: "ecs/orders-api/5f2adcb1aaaa".into(),
            timestamp: Timestamp(datetime!(2026-01-15 12:00 UTC)),
            message: message.into(),
        })
    }

    fn ecs(level: &str, message: &str) -> LogEvent {
        event(&format!(
            r#"{{"@timestamp":"2026-01-15T12:00:00Z","log.level":"{level}","log.logger":"com.example.camel.Route","message":"{message}","trace.id":"ABC123","pipeline.offset":230328,"error.stack_trace":"java.net.SocketTimeoutException: Read timed out"}}"#
        ))
    }

    fn matches(query: &str, event: &LogEvent) -> bool {
        parse_query(query)
            .unwrap()
            .matches(event, MatchOptions::default())
    }

    #[test]
    fn free_text_and_phrases_are_case_insensitive() {
        let e = ecs("INFO", "Connection Timeout after 30 s");
        assert!(matches("timeout", &e));
        assert!(matches("TIMEOUT connection", &e));
        assert!(matches("\"timeout after\"", &e));
        assert!(!matches("\"after timeout\"", &e));
        assert!(matches("", &e), "empty query matches everything");
    }

    #[test]
    fn regex_terms() {
        let e = ecs("INFO", "request timed out");
        assert!(matches("/time(out|d out)/", &e));
        assert!(!matches("/^timed/", &e));
        assert!(matches("/^REQUEST/", &e), "case-insensitive");
    }

    #[test]
    fn regex_mode_takes_the_whole_input_as_one_expression() {
        let e = ecs("INFO", "order 42 failed: read timed out");
        let regex = |input: &str| {
            parse_regex_query(input)
                .unwrap()
                .matches(&e, MatchOptions::default())
        };
        // Spaces, slashes and quotes are part of the expression, not query syntax.
        assert!(regex("order \\d+ failed"));
        assert!(regex("FAILED: read"), "case-insensitive");
        assert!(!regex("-timed"));
        assert!(parse_regex_query("").unwrap().is_empty());

        let error = parse_regex_query("time(out").unwrap_err();
        assert!(error.message.starts_with("invalid regular expression"));
        assert_eq!((error.start, error.end), (0, 8));
    }

    #[test]
    fn pipeline_state_and_correlation_terms() {
        let status = LogEvent::from_raw(RawEvent {
            stream: "ecs/app/abc".into(),
            timestamp: Timestamp(datetime!(2026-01-15 12:00 UTC)),
            message:
                r#"{"message":"status","acme":{"state":"FAILED","correlationId":"CE50-66FE"}}"#
                    .into(),
        });
        assert!(matches("state:failed", &status));
        assert!(!matches("state:COMPLETED", &status));
        assert!(matches("correlation:ce50-66fe", &status));
        assert!(!matches("correlation:other", &status));
        // A plain `state` field counts too (logs that aren't status events).
        let order = ecs("INFO", "order");
        assert!(!matches("state:SHIPPED", &order));
    }

    #[test]
    fn levels_with_comparisons() {
        let warn = ecs("WARN", "m");
        assert!(matches("level:WARN", &warn));
        assert!(matches("level:warn", &warn));
        assert!(matches("level>=WARN", &warn));
        assert!(!matches("level>WARN", &warn));
        assert!(matches("level<ERROR", &warn));
        assert!(!matches("level:ERROR", &warn));
        // Lines without a level never match a level term (but do match its negation).
        let plain = event("no level here");
        assert!(!matches("level>=TRACE", &plain));
        assert!(matches("-level:DEBUG", &plain));
    }

    #[test]
    fn fields_exact_glob_and_numeric() {
        let e = ecs("INFO", "m");
        assert!(matches("trace.id:abc123", &e));
        assert!(!matches("trace.id:abc", &e));
        assert!(matches("log.logger:*Camel*", &e));
        assert!(matches("log.logger:com.example.?amel.*", &e));
        assert!(!matches("log.logger:*Kafka*", &e));
        assert!(matches("pipeline.offset>=230000", &e));
        assert!(matches("pipeline.offset:230328", &e));
        assert!(!matches("pipeline.offset<100", &e));
        assert!(!matches("missing.field:x", &e));
    }

    #[test]
    fn task_message_and_stream_keys() {
        let e = ecs("INFO", "hello world");
        assert!(matches("task:5f2a", &e));
        assert!(!matches("task:9999", &e));
        assert!(matches("message:world", &e));
        assert!(matches("stream:*orders-api*", &e));
    }

    #[test]
    fn negation_and_conjunction() {
        let e = ecs("INFO", "GET /actuator/health 200");
        assert!(!matches("-healthcheck -health", &e));
        assert!(matches("-healthcheck GET", &e));
        assert!(!matches("GET POST", &e), "all terms must match");
        // A lone "-" is text, not a negation.
        assert!(!matches("-", &e));
    }

    #[test]
    fn raw_search_looks_at_the_whole_line() {
        let e = ecs("ERROR", "Polling failed");
        let query = parse_query("SocketTimeoutException").unwrap();
        assert!(!query.matches(&e, MatchOptions::default()));
        assert!(query.matches(&e, MatchOptions { raw: true }));
    }

    #[test]
    fn quoted_field_values_and_colons_in_text() {
        let e = ecs("INFO", "m");
        assert!(matches("log.logger:\"com.example.camel.Route\"", &e));
        // A word that isn't a key (doesn't start with a letter) stays text.
        assert!(!matches("123:456", &e));
    }

    #[test]
    fn errors_point_at_the_problem() {
        let err = parse_query("level:LOUD timeout").unwrap_err();
        assert_eq!(err.message, "unknown level \"LOUD\"");
        assert_eq!((err.start, err.end), (6, 10));
        assert!(err.hint.unwrap().contains("WARN"));

        let err = parse_query("ok /broken(/").unwrap_err();
        assert!(err.message.starts_with("invalid regular expression"));
        assert_eq!((err.start, err.end), (3, 12));

        let err = parse_query("say \"hello").unwrap_err();
        assert_eq!(err.message, "unterminated quote");
        assert_eq!(err.start, 4);

        assert_eq!(
            parse_query("trace.id:").unwrap_err().message,
            "value missing after \"trace.id:\""
        );
        assert!(
            parse_query("pipeline.offset>=abc")
                .unwrap_err()
                .message
                .contains("not a number")
        );
    }

    #[test]
    fn highlight_terms_are_the_positive_text_terms() {
        let q = parse_query("Timeout -health \"read timed\" level:ERROR").unwrap();
        assert_eq!(q.highlight_terms(), ["timeout", "read timed"]);
    }
}
