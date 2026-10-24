//! The field summary of a view ("interesting fields"): which fields the matching events have and
//! their most common values, plus an overview of the pipeline status events among them.
//!
//! One pass over the events. Keys and values are borrowed from the buffer while counting
//! (`&'a str`, `Cow<'a, str>`), so only the few values that end up in the summary are copied.

use std::borrow::Cow;
use std::collections::HashMap;

use serde::Serialize;
use specta::Type;

use super::{FieldValue, LogEvent};

/// Values listed per field (the most common ones).
pub const TOP_VALUES: usize = 10;
/// Distinct values counted per field. Beyond this a field is ID-like: new values are no longer
/// counted (its top values stay right for all values seen until then).
pub const MAX_DISTINCT: usize = 1_000;
/// Failure reasons listed.
pub const TOP_REASONS: usize = 10;
/// Correlation IDs listed per document outcome (the newest).
pub const MAX_IDS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldSummary {
    /// How many events were summarized (the matches of the search, or all).
    pub events: u32,
    /// Most common first (then by name).
    pub fields: Vec<FieldStats>,
    /// Only when some of the events are pipeline status events.
    pub pipeline: Option<PipelineSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldStats {
    pub key: String,
    /// Events that have the field.
    pub count: u32,
    /// Distinct values counted (at most [`MAX_DISTINCT`]).
    pub distinct: u32,
    /// There are more distinct values than were counted.
    pub more_distinct: bool,
    /// The most common values, most common first.
    pub top: Vec<ValueCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValueCount {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSummary {
    /// Status events among the summarized events.
    pub events: u32,
    /// Per state, in lifecycle order (unknown states last).
    pub states: Vec<ValueCount>,
    /// Per topic, the most active first.
    pub topics: Vec<TopicStates>,
    pub documents: DocumentSummary,
    /// The most common messages of `FAILED` events.
    pub failure_reasons: Vec<ValueCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicStates {
    pub topic: String,
    pub total: u32,
    /// In the same order as [`PipelineSummary::states`].
    pub states: Vec<ValueCount>,
}

/// The documents (correlation IDs) of the status events, by where their last event left them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub total: u32,
    /// The outcomes that occur, in the order of [`Outcome`].
    pub outcomes: Vec<DocumentGroup>,
    /// Documents that went through `RETRYING` (they're also counted under their outcome).
    pub retried: DocumentGroup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGroup {
    pub outcome: Outcome,
    pub count: u32,
    /// The newest [`MAX_IDS`] correlation IDs.
    pub ids: Vec<String>,
}

/// Where a document's last status event left it, as far as this service's logs show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Last seen in a non-final state (`RECEIVED`, `CONSUMING`, `RETRYING`): still being worked
    /// on, or stuck.
    InProgress,
    Failed,
    Completed,
    /// Handed on to Kafka: where an input service's part ends.
    Published,
    /// Only for [`DocumentSummary::retried`].
    Retried,
}

impl Outcome {
    fn of(last_state: &str) -> Self {
        if last_state.eq_ignore_ascii_case("COMPLETED") {
            Outcome::Completed
        } else if last_state.eq_ignore_ascii_case("FAILED") {
            Outcome::Failed
        } else if last_state.eq_ignore_ascii_case("PUBLISHED") {
            Outcome::Published
        } else {
            Outcome::InProgress
        }
    }
}

/// The states of the framework's lifecycle, in order.
const LIFECYCLE: &[&str] = &[
    "RECEIVED",
    "PUBLISHED",
    "CONSUMING",
    "RETRYING",
    "COMPLETED",
    "FAILED",
];

/// Counts of one field while summarizing. `'a` is the lifetime of the events: the map keys borrow
/// their text, so a value seen 50,000 times is never copied. Numbers and booleans have no text
/// to borrow and are formatted into an owned string (`Cow::Owned`).
#[derive(Default)]
struct FieldCounter<'a> {
    count: u32,
    values: HashMap<Cow<'a, str>, u32>,
    more_distinct: bool,
}

impl<'a> FieldCounter<'a> {
    fn add(&mut self, value: Cow<'a, str>) {
        self.count += 1;
        if let Some(count) = self.values.get_mut(&value) {
            *count += 1;
        } else if self.values.len() < MAX_DISTINCT {
            self.values.insert(value, 1);
        } else {
            self.more_distinct = true;
        }
    }
}

fn text(value: &FieldValue) -> Cow<'_, str> {
    match value {
        FieldValue::Text(text) => Cow::Borrowed(text),
        FieldValue::Number(number) => Cow::Owned(number.to_string()),
        FieldValue::Bool(b) => Cow::Borrowed(if *b { "true" } else { "false" }),
    }
}

/// The most common `limit` entries of a count map, most common first, then by value.
fn top<K: AsRef<str>>(counts: HashMap<K, u32>, limit: usize) -> Vec<ValueCount> {
    let mut entries: Vec<(K, u32)> = counts.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.as_ref().cmp(b.0.as_ref())));
    entries
        .into_iter()
        .take(limit)
        .map(|(value, count)| ValueCount {
            value: value.as_ref().to_owned(),
            count,
        })
        .collect()
}

/// Summarizes `events` (oldest first, as a buffer holds them).
///
/// `impl IntoIterator<Item = &'a LogEvent>` accepts anything that yields event references: all
/// events of a buffer or only the matches of a search. It's a generic parameter, so the compiler
/// generates one copy per caller's iterator type (no runtime dispatch, unlike a `dyn Iterator`).
pub fn summarize<'a>(events: impl IntoIterator<Item = &'a LogEvent>) -> FieldSummary {
    let mut total = 0u32;
    let mut fields: HashMap<&'a str, FieldCounter<'a>> = HashMap::new();
    let mut pipeline = PipelineCounter::default();
    for event in events {
        total += 1;
        for field in &event.line.fields {
            fields
                .entry(&field.key)
                .or_default()
                .add(text(&field.value));
        }
        if let Some(status) = &event.status {
            pipeline.add(status);
        }
    }

    let mut fields: Vec<FieldStats> = fields
        .into_iter()
        .map(|(key, counter)| FieldStats {
            key: key.to_owned(),
            count: counter.count,
            distinct: counter.values.len() as u32,
            more_distinct: counter.more_distinct,
            top: top(counter.values, TOP_VALUES),
        })
        .collect();
    fields.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    FieldSummary {
        events: total,
        fields,
        pipeline: pipeline.finish(),
    }
}

#[derive(Default)]
struct PipelineCounter<'a> {
    events: u32,
    states: HashMap<&'a str, u32>,
    topics: HashMap<&'a str, HashMap<&'a str, u32>>,
    documents: HashMap<&'a str, DocumentState<'a>>,
    failure_reasons: HashMap<&'a str, u32>,
}

/// What one document's status events said so far (events arrive oldest first).
struct DocumentState<'a> {
    /// The state of its latest event, borrowed from that event.
    last_state: &'a str,
    /// When it was last seen, as a position among the status events (for "newest first").
    last_seen: u32,
    retried: bool,
}

impl<'a> PipelineCounter<'a> {
    fn add(&mut self, status: &'a super::StatusChange) {
        let state = status.state.as_str();
        *self.states.entry(state).or_default() += 1;
        if let Some(topic) = status.topic.as_deref() {
            *self
                .topics
                .entry(topic)
                .or_default()
                .entry(state)
                .or_default() += 1;
        }
        if state.eq_ignore_ascii_case("FAILED")
            && let Some(reason) = status.message.as_deref()
        {
            *self.failure_reasons.entry(reason.trim()).or_default() += 1;
        }
        if let Some(id) = status.correlation_id.as_deref() {
            let retrying = state.eq_ignore_ascii_case("RETRYING");
            let seen = self.events;
            self.documents
                .entry(id)
                .and_modify(|d| {
                    d.last_state = state;
                    d.last_seen = seen;
                    d.retried |= retrying;
                })
                .or_insert(DocumentState {
                    last_state: state,
                    last_seen: seen,
                    retried: retrying,
                });
        }
        self.events += 1;
    }

    fn finish(self) -> Option<PipelineSummary> {
        if self.events == 0 {
            return None;
        }
        let order = state_order(self.states.keys().copied());
        let in_order = |counts: &HashMap<&str, u32>| -> Vec<ValueCount> {
            order
                .iter()
                .filter_map(|&state| {
                    counts.get(state).map(|&count| ValueCount {
                        value: state.to_owned(),
                        count,
                    })
                })
                .collect()
        };
        let mut topics: Vec<TopicStates> = self
            .topics
            .iter()
            .map(|(topic, counts)| TopicStates {
                topic: (*topic).to_owned(),
                total: counts.values().sum(),
                states: in_order(counts),
            })
            .collect();
        topics.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.topic.cmp(&b.topic)));
        Some(PipelineSummary {
            events: self.events,
            states: in_order(&self.states),
            topics,
            documents: documents(self.documents),
            failure_reasons: top(self.failure_reasons, TOP_REASONS),
        })
    }
}

/// The lifecycle states first, in order, then any others by name.
fn state_order<'a>(states: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut order: Vec<&str> = states.collect();
    let rank = |s: &str| {
        LIFECYCLE
            .iter()
            .position(|l| l.eq_ignore_ascii_case(s))
            .unwrap_or(LIFECYCLE.len())
    };
    order.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    order
}

fn documents(documents: HashMap<&str, DocumentState<'_>>) -> DocumentSummary {
    let total = documents.len() as u32;
    let mut by_outcome: HashMap<Outcome, Vec<(u32, &str)>> = HashMap::new();
    let mut retried = Vec::new();
    for (id, document) in &documents {
        let entry = (document.last_seen, *id);
        by_outcome
            .entry(Outcome::of(document.last_state))
            .or_default()
            .push(entry);
        if document.retried {
            retried.push(entry);
        }
    }
    let group = |outcome: Outcome, mut ids: Vec<(u32, &str)>| {
        // Newest first.
        ids.sort_by_key(|&(seen, _)| std::cmp::Reverse(seen));
        DocumentGroup {
            outcome,
            count: ids.len() as u32,
            ids: ids
                .into_iter()
                .take(MAX_IDS)
                .map(|(_, id)| id.to_owned())
                .collect(),
        }
    };
    let mut outcomes: Vec<DocumentGroup> = by_outcome
        .into_iter()
        .map(|(outcome, ids)| group(outcome, ids))
        .collect();
    outcomes.sort_by_key(|g| g.outcome);
    DocumentSummary {
        total,
        outcomes,
        retried: group(Outcome::Retried, retried),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::RawEvent;
    use crate::timestamp::Timestamp;
    use time::Duration;
    use time::macros::datetime;

    fn event(second: i64, json: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: "ecs/app/task1".into(),
            timestamp: Timestamp(datetime!(2026-01-15 12:00 UTC) + Duration::seconds(second)),
            message: json.to_owned(),
        })
    }

    /// A structured status event of document `id` on `topic`.
    fn status(second: i64, id: &str, topic: &str, state: &str, reason: &str) -> LogEvent {
        event(
            second,
            &format!(
                r#"{{"message":"Document status change","pipeline":{{"state":"{state}","correlationId":"{id}","topicName":"{topic}","message":"{reason}"}}}}"#
            ),
        )
    }

    fn field<'s>(summary: &'s FieldSummary, key: &str) -> &'s FieldStats {
        summary.fields.iter().find(|f| f.key == key).unwrap()
    }

    fn counts(values: &[ValueCount]) -> Vec<(&str, u32)> {
        values.iter().map(|v| (v.value.as_str(), v.count)).collect()
    }

    #[test]
    fn counts_fields_and_their_most_common_values() {
        let events = [
            event(
                0,
                r#"{"message":"a","log.logger":"com.example.Orders","n":1}"#,
            ),
            event(
                1,
                r#"{"message":"b","log.logger":"com.example.Orders","n":2}"#,
            ),
            event(
                2,
                r#"{"message":"c","log.logger":"com.example.Billing","ok":true}"#,
            ),
            event(3, "plain text, no fields"),
        ];
        let summary = summarize(&events);
        assert_eq!(summary.events, 4);
        assert_eq!(summary.pipeline, None);
        // Most common first, then by name.
        let keys: Vec<&str> = summary.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, ["log.logger", "n", "ok"]);

        let logger = field(&summary, "log.logger");
        assert_eq!((logger.count, logger.distinct), (3, 2));
        assert_eq!(
            counts(&logger.top),
            [("com.example.Orders", 2), ("com.example.Billing", 1)]
        );
        // Numbers and booleans as the search writes them.
        assert_eq!(counts(&field(&summary, "n").top), [("1", 1), ("2", 1)]);
        assert_eq!(counts(&field(&summary, "ok").top), [("true", 1)]);
    }

    #[test]
    fn stops_counting_new_values_of_id_like_fields() {
        let events: Vec<LogEvent> = (0..MAX_DISTINCT as i64 + 5)
            .map(|i| {
                event(
                    0,
                    &format!(r#"{{"message":"m","trace.id":"t{i}","k":"same"}}"#),
                )
            })
            .collect();
        let summary = summarize(&events);
        let trace = field(&summary, "trace.id");
        assert_eq!(trace.count, MAX_DISTINCT as u32 + 5);
        assert_eq!(trace.distinct, MAX_DISTINCT as u32);
        assert!(trace.more_distinct);
        assert_eq!(trace.top.len(), TOP_VALUES);
        assert!(!field(&summary, "k").more_distinct);
    }

    #[test]
    fn summarizes_states_topics_documents_and_failure_reasons() {
        let events = [
            status(0, "doc-1", "orders", "CONSUMING", "consumed"),
            status(1, "doc-1", "orders", "COMPLETED", "done"),
            status(2, "doc-2", "orders", "CONSUMING", "consumed"),
            status(
                3,
                "doc-2",
                "orders",
                "FAILED",
                "Processing failed: bad input",
            ),
            status(4, "doc-3", "invoices", "CONSUMING", "consumed"),
            status(5, "doc-3", "invoices", "RETRYING", "route stopping"),
            status(6, "doc-3", "invoices", "CONSUMING", "consumed"),
            status(7, "doc-4", "invoices", "CONSUMING", "consumed"),
            status(
                8,
                "doc-4",
                "invoices",
                "FAILED",
                "Processing failed: bad input",
            ),
            event(9, r#"{"message":"not a status event"}"#),
        ];
        let summary = summarize(&events);
        let pipeline = summary.pipeline.unwrap();
        assert_eq!(pipeline.events, 9);
        // Lifecycle order, not by count.
        assert_eq!(
            counts(&pipeline.states),
            [
                ("CONSUMING", 5),
                ("RETRYING", 1),
                ("COMPLETED", 1),
                ("FAILED", 2)
            ]
        );

        let topics: Vec<_> = pipeline
            .topics
            .iter()
            .map(|t| (t.topic.as_str(), t.total, counts(&t.states)))
            .collect();
        assert_eq!(
            topics,
            [
                (
                    "invoices",
                    5,
                    vec![("CONSUMING", 3), ("RETRYING", 1), ("FAILED", 1)]
                ),
                (
                    "orders",
                    4,
                    vec![("CONSUMING", 2), ("COMPLETED", 1), ("FAILED", 1)]
                ),
            ]
        );

        assert_eq!(
            counts(&pipeline.failure_reasons),
            [("Processing failed: bad input", 2)]
        );

        let documents = &pipeline.documents;
        assert_eq!(documents.total, 4);
        let outcomes: Vec<_> = documents
            .outcomes
            .iter()
            .map(|g| (g.outcome, g.ids.clone()))
            .collect();
        assert_eq!(
            outcomes,
            [
                // doc-3 was retried and is being consumed again.
                (Outcome::InProgress, vec!["doc-3".to_owned()]),
                // Newest first.
                (
                    Outcome::Failed,
                    vec!["doc-4".to_owned(), "doc-2".to_owned()]
                ),
                (Outcome::Completed, vec!["doc-1".to_owned()]),
            ]
        );
        assert_eq!(documents.retried.ids, ["doc-3"]);
    }

    #[test]
    fn unknown_states_come_after_the_lifecycle() {
        let events = [
            status(0, "d", "t", "ARCHIVED", "x"),
            status(1, "e", "t", "RECEIVED", "x"),
            status(2, "e", "t", "PUBLISHED", "x"),
        ];
        let pipeline = summarize(&events).pipeline.unwrap();
        assert_eq!(
            counts(&pipeline.states),
            [("RECEIVED", 1), ("PUBLISHED", 1), ("ARCHIVED", 1)]
        );
        let outcomes: Vec<_> = pipeline
            .documents
            .outcomes
            .iter()
            .map(|g| g.outcome)
            .collect();
        // An unknown last state counts as in progress; PUBLISHED is where an input service ends.
        assert_eq!(outcomes, [Outcome::InProgress, Outcome::Published]);
    }
}
