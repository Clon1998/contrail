//! Re-joining Java stack traces that CloudWatch stored as one event per line.
//!
//! Plain-text loggers write an exception as many lines; the `awslogs` driver turns every line
//! into its own event. The joiner merges such continuation lines back into the event they belong
//! to and turns them into the event's `error`, like ECS JSON's `error.stack_trace`.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use time::Duration;

use super::{Level, LogError, LogEvent, LogKind};

/// Continuation lines must follow the previous line of their stream within this time.
pub const DEFAULT_WINDOW: Duration = Duration::seconds(2);

/// Lines that continue a stack trace: frames, `Caused by:`, `Suppressed:`, `... N more`, or any
/// indented line.
static CONTINUATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:\s+\S|Caused by: |\s*Suppressed: |\s*\.\.\. \d+ (?:more|common frames omitted))",
    )
    .expect("valid continuation pattern")
});

/// The first line of a stack trace: `com.example.SomeException: message` (or without message).
static EXCEPTION_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?P<type>(?:[A-Za-z_$][\w$]*\.)+[\w$]*(?:Exception|Error|Throwable)(?:\$[\w$]+)?)(?::\s*(?P<message>.*))?$")
        .expect("valid exception header pattern")
});

/// Joins continuation lines into the preceding event of the same stream.
///
/// Streaming: [`push`](Self::push) events in CloudWatch order; completed events come back once
/// it's clear nothing more belongs to them. [`flush_before`](Self::flush_before) releases events
/// whose window has passed (live tail), [`flush`](Self::flush) returns the rest (backfill).
pub struct MultilineJoiner {
    window: Duration,
    /// The last event per stream, which later lines may still be joined into.
    pending: HashMap<String, LogEvent>,
}

impl Default for MultilineJoiner {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW)
    }
}

impl MultilineJoiner {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            pending: HashMap::new(),
        }
    }

    /// Adds an event and returns the events that are complete now: the stream's previous event
    /// when `event` doesn't continue it, and `event` itself if nothing can be joined into it
    /// (JSON events carry their own stack trace, so they are never held back).
    pub fn push(&mut self, event: LogEvent) -> Vec<LogEvent> {
        // `get_mut` mutably borrows `self.pending`, so `self` can't be borrowed as a whole while
        // `previous` is alive: copy the window out first and pass it to a free function.
        let window = self.window;
        if let Some(previous) = self.pending.get_mut(&event.stream)
            && continues(window, previous, &event)
        {
            append(previous, event);
            return Vec::new();
        }
        let mut done: Vec<LogEvent> = self.pending.remove(&event.stream).into_iter().collect();
        if can_receive_continuations(&event) {
            self.pending.insert(event.stream.clone(), event);
        } else {
            done.push(event);
        }
        done
    }

    /// Returns the held-back events from before `cutoff` (nothing can be joined into them any
    /// more once their window has passed), in timestamp order.
    pub fn flush_before(&mut self, cutoff: crate::timestamp::Timestamp) -> Vec<LogEvent> {
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, e)| e.cw_timestamp < cutoff)
            .map(|(stream, _)| stream.clone())
            .collect();
        let mut done: Vec<LogEvent> = ready
            .iter()
            .filter_map(|stream| self.pending.remove(stream))
            .collect();
        done.sort_by_key(|e| e.cw_timestamp);
        done
    }

    /// Returns all events still held back (e.g. at the end of a backfill), in timestamp order.
    pub fn flush(&mut self) -> Vec<LogEvent> {
        let mut rest: Vec<LogEvent> = self.pending.drain().map(|(_, event)| event).collect();
        rest.sort_by_key(|e| e.cw_timestamp);
        rest
    }
}

/// Only plain-text events (and Spring-pattern lines) can get continuation lines.
fn can_receive_continuations(event: &LogEvent) -> bool {
    matches!(event.line.kind, LogKind::Plain | LogKind::Spring)
}

/// Whether `next` continues `previous` (same stream, checked by the caller).
fn continues(window: Duration, previous: &LogEvent, next: &LogEvent) -> bool {
    let close_in_time = next.cw_timestamp.0 - previous.cw_timestamp.0 <= window;
    // Structured lines (JSON, Spring pattern) always start a new event, and only plain-text
    // events can receive continuation lines.
    let joinable = next.line.kind == LogKind::Plain && can_receive_continuations(previous);
    if !close_in_time || !joinable {
        return false;
    }
    let text = next.line.message.as_str();
    let has_trace = previous.line.error.is_some();
    // A bare exception header only belongs to a warning/error line or an ongoing trace.
    let header_fits = has_trace || previous.line.level >= Some(Level::Warn);
    (has_trace && CONTINUATION.is_match(text)) || (header_fits && EXCEPTION_HEADER.is_match(text))
}

/// Merges `next` into `event`: the first exception header sets type and message, every line
/// goes into the stack trace.
fn append(event: &mut LogEvent, next: LogEvent) {
    let text = next.line.message;
    let error = event.line.error.get_or_insert(LogError {
        error_type: None,
        message: None,
        stack_trace: None,
    });
    if error.error_type.is_none()
        && let Some(caps) = EXCEPTION_HEADER.captures(&text)
    {
        error.error_type = caps.name("type").map(|m| m.as_str().to_owned());
        error.message = caps.name("message").map(|m| m.as_str().to_owned());
    }
    let trace = error.stack_trace.get_or_insert_with(String::new);
    if !trace.is_empty() {
        trace.push('\n');
    }
    trace.push_str(&text);
    event.raw.push('\n');
    event.raw.push_str(&next.raw);
}

/// Joins a whole batch (e.g. a backfill): events are grouped per stream in CloudWatch order.
pub fn join_all(mut events: Vec<LogEvent>, window: Duration) -> Vec<LogEvent> {
    // A stable sort keeps CloudWatch's order for events with the same timestamp.
    events.sort_by_key(|e| e.cw_timestamp);
    let mut joiner = MultilineJoiner::new(window);
    let mut done: Vec<LogEvent> = events.into_iter().flat_map(|e| joiner.push(e)).collect();
    done.extend(joiner.flush());
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::RawEvent;
    use crate::timestamp::Timestamp;
    use time::macros::datetime;

    fn event(stream: &str, millis: i64, message: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: stream.to_owned(),
            timestamp: Timestamp(
                datetime!(2026-01-15 11:40:02 UTC) + Duration::milliseconds(millis),
            ),
            message: message.to_owned(),
        })
    }

    fn fixture() -> Vec<LogEvent> {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/plain-stacktrace-split.log"
        ))
        .unwrap();
        text.lines()
            .enumerate()
            .map(|(i, line)| event("ecs/ingest/task1", i as i64, line))
            .collect()
    }

    #[test]
    fn joins_a_split_stack_trace_into_the_error_line() {
        let joined = join_all(fixture(), DEFAULT_WINDOW);
        assert_eq!(joined.len(), 2);

        let error_event = &joined[0];
        assert_eq!(error_event.line.message, "Polling failed");
        let error = error_event.line.error.as_ref().unwrap();
        assert_eq!(
            error.error_type.as_deref(),
            Some("org.springframework.web.client.ResourceAccessException")
        );
        assert!(
            error
                .message
                .as_deref()
                .unwrap()
                .ends_with("Read timed out")
        );
        let trace = error.stack_trace.as_deref().unwrap();
        assert_eq!(trace.lines().count(), 9);
        assert!(trace.contains("Caused by: java.net.SocketTimeoutException"));
        assert!(trace.ends_with("\t... 12 common frames omitted"));
        assert_eq!(error_event.raw.lines().count(), 10);

        assert_eq!(joined[1].line.message, "Next poll in 30000 ms");
        assert!(joined[1].line.error.is_none());
    }

    #[test]
    fn keeps_streams_apart_and_respects_the_window() {
        let events = vec![
            event(
                "a",
                0,
                "2026-01-15T11:40:02.000Z ERROR 1 --- [main] c.e.X : boom",
            ),
            event("b", 1, "java.lang.IllegalStateException: other stream"),
            event("a", 5_000, "java.lang.IllegalStateException: too late"),
        ];
        let joined = join_all(events, DEFAULT_WINDOW);
        assert_eq!(joined.len(), 3);
        assert!(joined.iter().all(|e| e.line.error.is_none()));
    }

    #[test]
    fn needs_a_warning_before_a_bare_exception_header() {
        let events = vec![
            event(
                "a",
                0,
                "2026-01-15T11:40:02.000Z INFO 1 --- [main] c.e.X : listing types",
            ),
            event("a", 1, "java.lang.IllegalStateException"),
        ];
        assert_eq!(join_all(events, DEFAULT_WINDOW).len(), 2);
    }

    #[test]
    fn never_joins_structured_lines() {
        let events = vec![
            event(
                "a",
                0,
                "2026-01-15T11:40:02.000Z ERROR 1 --- [main] c.e.X : boom",
            ),
            event(
                "a",
                1,
                r#"{"@timestamp":"2026-01-15T11:40:02.001Z","log.level":"INFO","message":"  indented"}"#,
            ),
        ];
        assert_eq!(join_all(events, DEFAULT_WINDOW).len(), 2);
    }

    #[test]
    fn streaming_push_returns_the_previous_event_when_a_new_one_starts() {
        let mut joiner = MultilineJoiner::default();
        let error_line = "2026-01-15T11:40:02.000Z ERROR 1 --- [main] c.e.X : boom";
        assert!(joiner.push(event("a", 0, error_line)).is_empty());
        assert!(
            joiner
                .push(event("a", 1, "java.lang.IllegalStateException: x"))
                .is_empty()
        );
        assert!(
            joiner
                .push(event("a", 2, "\tat com.example.X.run(X.java:1)"))
                .is_empty()
        );
        let done = joiner.push(event(
            "a",
            3,
            "2026-01-15T11:40:02.003Z INFO 1 --- [main] c.e.X : next",
        ));
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0]
                .line
                .error
                .as_ref()
                .unwrap()
                .stack_trace
                .as_ref()
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(joiner.flush().len(), 1);
    }

    #[test]
    fn json_events_are_never_held_back() {
        let mut joiner = MultilineJoiner::default();
        let json = r#"{"@timestamp":"2026-01-15T11:40:02Z","log.level":"INFO","message":"m"}"#;
        assert_eq!(joiner.push(event("a", 0, json)).len(), 1);
        assert!(joiner.flush().is_empty());
    }

    #[test]
    fn flush_before_releases_events_whose_window_passed() {
        let mut joiner = MultilineJoiner::default();
        joiner.push(event(
            "a",
            0,
            "2026-01-15T11:40:02.000Z ERROR 1 --- [main] c.e.X : one",
        ));
        joiner.push(event(
            "b",
            1_500,
            "2026-01-15T11:40:03.500Z INFO 1 --- [main] c.e.X : two",
        ));
        let base = datetime!(2026-01-15 11:40:02 UTC);
        let ready = joiner.flush_before(Timestamp(base + Duration::seconds(1)));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].stream, "a");
        assert_eq!(joiner.flush().len(), 1);
    }
}
