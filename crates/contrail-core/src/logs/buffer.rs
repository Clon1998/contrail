//! The in-memory store of a log view: ordered by time, deduplicated, bounded.

use std::collections::{HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};

use serde::Serialize;
use specta::Type;

use super::{Level, LogEvent};

/// The default number of events a view keeps (the oldest are evicted beyond that).
pub const DEFAULT_CAPACITY: usize = 100_000;

/// Counts the UI shows next to the log list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BufferStats {
    pub total: u32,
    /// Events dropped because the buffer was full (oldest first).
    pub evicted: u32,
    pub trace: u32,
    pub debug: u32,
    pub info: u32,
    pub warn: u32,
    pub error: u32,
    /// Events without a recognisable level.
    pub unknown: u32,
}

impl BufferStats {
    fn count(&mut self, level: Option<Level>) -> &mut u32 {
        match level {
            Some(Level::Trace) => &mut self.trace,
            Some(Level::Debug) => &mut self.debug,
            Some(Level::Info) => &mut self.info,
            Some(Level::Warn) => &mut self.warn,
            Some(Level::Error) => &mut self.error,
            None => &mut self.unknown,
        }
    }
}

/// A ring buffer of log events, sorted by timestamp, without duplicates.
///
/// A `VecDeque` is a growable ring buffer (like Java's `ArrayDeque`): removing the oldest event
/// at the front is O(1), and it can still be indexed for the UI's windowed reads.
pub struct LogBuffer {
    capacity: usize,
    events: VecDeque<LogEvent>,
    /// Hashes of the events in the buffer, to drop the same event arriving twice (backfill
    /// overlapping with live tail, reconnects).
    seen: HashSet<u64>,
    next_seq: u32,
    stats: BufferStats,
}

/// What [`LogBuffer::insert`] did, so the UI knows which of its cached rows are stale.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InsertReport {
    pub added: usize,
    pub duplicates: usize,
    /// The lowest index (after the insert) at which an event was added: rows from here on moved.
    pub first_index: Option<usize>,
    /// Events dropped at the front because the buffer was full: all indices shifted by this.
    pub evicted: usize,
}

/// Identifies an event across deliveries: same stream, CloudWatch time and text.
fn dedupe_key(event: &LogEvent) -> u64 {
    let mut hasher = DefaultHasher::new();
    event.stream.hash(&mut hasher);
    event.cw_timestamp.hash(&mut hasher);
    event.raw.hash(&mut hasher);
    hasher.finish()
}

/// The sort order: event time, then CloudWatch time, then arrival.
fn order_key(
    event: &LogEvent,
) -> (
    crate::timestamp::Timestamp,
    crate::timestamp::Timestamp,
    u32,
) {
    (event.timestamp, event.cw_timestamp, event.seq)
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            events: VecDeque::new(),
            seen: HashSet::new(),
            next_seq: 1,
            stats: BufferStats::default(),
        }
    }

    /// Adds events (in any order), skipping duplicates and evicting the oldest beyond capacity.
    pub fn insert(&mut self, events: impl IntoIterator<Item = LogEvent>) -> InsertReport {
        let mut report = InsertReport::default();
        for mut event in events {
            if !self.seen.insert(dedupe_key(&event)) {
                report.duplicates += 1;
                continue;
            }
            event.seq = self.next_seq;
            self.next_seq += 1;
            *self.stats.count(event.line.level) += 1;
            self.stats.total += 1;

            // Usually newer than everything (append); late events are inserted in place.
            let key = order_key(&event);
            let index = if self.events.back().is_none_or(|last| order_key(last) <= key) {
                self.events.push_back(event);
                self.events.len() - 1
            } else {
                let index = self.events.partition_point(|e| order_key(e) <= key);
                self.events.insert(index, event);
                index
            };
            report.first_index = Some(report.first_index.map_or(index, |first| first.min(index)));
            report.added += 1;
        }
        while self.events.len() > self.capacity {
            if let Some(oldest) = self.events.pop_front() {
                self.seen.remove(&dedupe_key(&oldest));
                *self.stats.count(oldest.line.level) -= 1;
                self.stats.total -= 1;
                self.stats.evicted += 1;
                report.evicted += 1;
            }
        }
        // Indices after eviction: everything moved down by the number of evicted events.
        report.first_index = report
            .first_index
            .map(|first| first.saturating_sub(report.evicted));
        report
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn stats(&self) -> BufferStats {
        self.stats.clone()
    }

    /// Up to `limit` events starting at `offset` (oldest first), for the UI's visible window.
    pub fn window(&self, offset: usize, limit: usize) -> Vec<LogEvent> {
        self.events
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::RawEvent;
    use crate::timestamp::Timestamp;
    use time::Duration;
    use time::macros::datetime;

    fn event(stream: &str, second: i64, message: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: stream.to_owned(),
            timestamp: Timestamp(datetime!(2026-01-15 12:00 UTC) + Duration::seconds(second)),
            message: message.to_owned(),
        })
    }

    fn messages(buffer: &LogBuffer) -> Vec<String> {
        buffer
            .window(0, usize::MAX)
            .into_iter()
            .map(|e| e.line.message)
            .collect()
    }

    #[test]
    fn keeps_events_in_time_order_even_when_they_arrive_late() {
        let mut buffer = LogBuffer::new(10);
        buffer.insert([event("a", 1, "one"), event("a", 3, "three")]);
        buffer.insert([event("b", 2, "two"), event("b", 4, "four")]);
        assert_eq!(messages(&buffer), ["one", "two", "three", "four"]);
    }

    #[test]
    fn drops_duplicates_from_overlapping_deliveries() {
        let mut buffer = LogBuffer::new(10);
        buffer.insert([event("a", 1, "one"), event("a", 2, "two")]);
        let report = buffer.insert([event("a", 2, "two"), event("a", 3, "three")]);
        assert_eq!((report.added, report.duplicates), (1, 1));
        assert_eq!(buffer.len(), 3);
        // Same text at the same time on another stream is a different event.
        assert_eq!(buffer.insert([event("b", 2, "two")]).added, 1);
    }

    #[test]
    fn evicts_the_oldest_and_keeps_counts_right() {
        let mut buffer = LogBuffer::new(3);
        buffer.insert((0..5).map(|i| event("a", i, &format!("INFO message {i}"))));
        assert_eq!(
            messages(&buffer),
            ["INFO message 2", "INFO message 3", "INFO message 4"]
        );
        let stats = buffer.stats();
        assert_eq!((stats.total, stats.evicted, stats.info), (3, 2, 3));
        // An evicted event may come back (e.g. a long backfill), it isn't "seen" any more.
        assert_eq!(buffer.insert([event("a", 0, "INFO message 0")]).added, 1);
    }

    #[test]
    fn counts_levels_and_assigns_unique_sequence_numbers() {
        let mut buffer = LogBuffer::new(10);
        buffer.insert([
            event("a", 1, "ERROR boom"),
            event("a", 2, "WARN hmm"),
            event("a", 3, "plain"),
        ]);
        let stats = buffer.stats();
        assert_eq!((stats.error, stats.warn, stats.unknown), (1, 1, 1));
        let seqs: Vec<u32> = buffer.window(0, 10).iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [1, 2, 3]);
    }

    #[test]
    fn reports_where_inserts_landed_and_evictions() {
        let mut buffer = LogBuffer::new(4);
        buffer.insert([
            event("a", 1, "one"),
            event("a", 3, "three"),
            event("a", 4, "four"),
        ]);
        // A late event lands at index 1; appends would land at the end.
        let report = buffer.insert([event("b", 2, "two")]);
        assert_eq!(report.first_index, Some(1));
        assert_eq!(report.evicted, 0);

        let report = buffer.insert([event("a", 5, "five")]);
        assert_eq!(report.evicted, 1);
        assert_eq!(report.first_index, Some(3));
    }

    #[test]
    fn windows_are_bounded() {
        let mut buffer = LogBuffer::new(10);
        buffer.insert((0..5).map(|i| event("a", i, &format!("m{i}"))));
        assert_eq!(buffer.window(3, 10).len(), 2);
        assert!(buffer.window(9, 10).is_empty());
    }
}
