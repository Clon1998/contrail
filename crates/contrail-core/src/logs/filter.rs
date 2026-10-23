//! A view's search: which events match, kept up to date as events arrive.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::buffer::InsertReport;
use super::{Level, LogBuffer, LogEvent};
use crate::query::{MatchOptions, Query};

/// How a search applies to the list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterMode {
    /// Only matching events are listed.
    #[default]
    Filter,
    /// All events are listed; matches are marked and can be stepped through.
    Highlight,
}

/// How a change of the buffer looks in the list the UI shows (filtered or not).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VisibleChange {
    /// The first visible row that is new or moved.
    pub first_changed: Option<usize>,
    /// Visible rows removed at the top (the oldest events were evicted).
    pub evicted: usize,
}

/// A search over a view: query, hidden levels and noise, plus the indices of matching events.
pub struct ViewFilter {
    query: Query,
    options: MatchOptions,
    hidden_levels: Vec<Level>,
    /// Texts whose lines are hidden ("hide noise"), lower-cased.
    noise: Vec<String>,
    pub mode: FilterMode,
    /// Buffer indices of the matching events, ascending.
    matched: Vec<usize>,
}

impl ViewFilter {
    pub fn new(
        query: Query,
        options: MatchOptions,
        hidden_levels: Vec<Level>,
        noise: &[String],
        mode: FilterMode,
    ) -> Self {
        Self {
            query,
            options,
            hidden_levels,
            noise: noise
                .iter()
                .map(|n| n.to_lowercase())
                .filter(|n| !n.is_empty())
                .collect(),
            mode,
            matched: Vec::new(),
        }
    }

    /// Whether this filter changes anything at all (no query, levels or noise: show everything).
    pub fn is_trivial(&self) -> bool {
        self.query.is_empty() && self.hidden_levels.is_empty() && self.noise.is_empty()
    }

    pub fn accepts(&self, event: &LogEvent) -> bool {
        if event
            .line
            .level
            .is_some_and(|l| self.hidden_levels.contains(&l))
        {
            return false;
        }
        if !self.noise.is_empty() {
            let message = event.line.message.to_lowercase();
            if self.noise.iter().any(|n| message.contains(n.as_str())) {
                return false;
            }
        }
        self.query.matches(event, self.options)
    }

    /// Re-evaluates every event (after the search changed or a late insert).
    pub fn rebuild(&mut self, buffer: &LogBuffer) {
        self.matched = buffer
            .iter()
            .enumerate()
            .filter(|(_, e)| self.accepts(e))
            .map(|(i, _)| i)
            .collect();
    }

    /// Updates the matches after `buffer.insert` returned `report`; `previous_len` is the buffer
    /// length before the insert. Returns what changed in the visible list.
    pub fn after_insert(
        &mut self,
        buffer: &LogBuffer,
        report: InsertReport,
        previous_len: usize,
    ) -> VisibleChange {
        // Evicted events: drop their matches and shift the rest down.
        let dropped = self.matched.partition_point(|&i| i < report.evicted);
        self.matched.drain(..dropped);
        for index in &mut self.matched {
            *index -= report.evicted;
        }
        let visible_evicted = match self.mode {
            FilterMode::Filter => dropped,
            FilterMode::Highlight => report.evicted,
        };
        let Some(first) = report.first_index else {
            return VisibleChange {
                first_changed: None,
                evicted: visible_evicted,
            };
        };

        let kept_len = previous_len - report.evicted;
        if first >= kept_len {
            // Appended at the end (the normal live case): check only the new events.
            let before = self.matched.len();
            // Collect first: the iterator reads `self` (through `accepts`), so it can't run while
            // `self.matched` is being extended (a mutable borrow of part of `self`).
            let new: Vec<usize> = (first..buffer.len())
                .filter(|&i| buffer.get(i).is_some_and(|e| self.accepts(e)))
                .collect();
            self.matched.extend(new);
            let first_changed = match self.mode {
                FilterMode::Filter => (self.matched.len() > before).then_some(before),
                FilterMode::Highlight => Some(first),
            };
            return VisibleChange {
                first_changed,
                evicted: visible_evicted,
            };
        }
        // Something landed in the middle: re-evaluate; rows from there on may have moved.
        self.rebuild(buffer);
        let first_changed = match self.mode {
            FilterMode::Filter => self.matched.partition_point(|&i| i < first),
            FilterMode::Highlight => first,
        };
        VisibleChange {
            first_changed: Some(first_changed),
            evicted: visible_evicted,
        }
    }

    /// How many rows the UI lists.
    pub fn visible_len(&self, buffer: &LogBuffer) -> usize {
        match self.mode {
            FilterMode::Filter => self.matched.len(),
            FilterMode::Highlight => buffer.len(),
        }
    }

    /// The listed rows `offset..offset + limit`.
    pub fn window(&self, buffer: &LogBuffer, offset: usize, limit: usize) -> Vec<LogEvent> {
        match self.mode {
            FilterMode::Filter => self
                .matched
                .iter()
                .skip(offset)
                .take(limit)
                .filter_map(|&i| buffer.get(i).cloned())
                .collect(),
            FilterMode::Highlight => buffer.window(offset, limit),
        }
    }

    /// The number of matching events.
    pub fn match_count(&self) -> usize {
        self.matched.len()
    }

    /// Buffer indices of the matches (in highlight mode, the rows to mark and step through).
    pub fn matched(&self) -> &[usize] {
        &self.matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::RawEvent;
    use crate::query::parse_query;
    use crate::timestamp::Timestamp;
    use time::Duration;
    use time::macros::datetime;

    fn event(second: i64, level: &str, message: &str) -> LogEvent {
        LogEvent::from_raw(RawEvent {
            stream: "s".into(),
            timestamp: Timestamp(datetime!(2026-01-15 12:00 UTC) + Duration::seconds(second)),
            message: format!(
                r#"{{"@timestamp":"2026-01-15T12:00:{second:02}Z","log.level":"{level}","message":"{message}"}}"#
            ),
        })
    }

    fn filter(query: &str, mode: FilterMode) -> ViewFilter {
        ViewFilter::new(
            parse_query(query).unwrap(),
            MatchOptions::default(),
            Vec::new(),
            &[],
            mode,
        )
    }

    fn messages(f: &ViewFilter, buffer: &LogBuffer) -> Vec<String> {
        f.window(buffer, 0, usize::MAX)
            .into_iter()
            .map(|e| e.line.message)
            .collect()
    }

    fn insert(buffer: &mut LogBuffer, f: &mut ViewFilter, events: Vec<LogEvent>) -> VisibleChange {
        let before = buffer.len();
        let report = buffer.insert(events);
        f.after_insert(buffer, report, before)
    }

    #[test]
    fn filter_mode_lists_only_matches_and_follows_appends() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert([event(1, "INFO", "ok"), event(2, "ERROR", "boom")]);
        let mut f = filter("boom", FilterMode::Filter);
        f.rebuild(&buffer);
        assert_eq!(messages(&f, &buffer), ["boom"]);

        let change = insert(
            &mut buffer,
            &mut f,
            vec![event(3, "INFO", "ok"), event(4, "ERROR", "boom again")],
        );
        assert_eq!(messages(&f, &buffer), ["boom", "boom again"]);
        assert_eq!(change.first_changed, Some(1));
        assert_eq!(f.visible_len(&buffer), 2);

        // Nothing new matched: nothing visible changed.
        let change = insert(&mut buffer, &mut f, vec![event(5, "INFO", "ok")]);
        assert_eq!(change.first_changed, None);
    }

    #[test]
    fn late_events_rebuild_and_report_where_rows_moved() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert([event(1, "ERROR", "a boom"), event(5, "ERROR", "c boom")]);
        let mut f = filter("boom", FilterMode::Filter);
        f.rebuild(&buffer);
        let change = insert(&mut buffer, &mut f, vec![event(3, "ERROR", "b boom")]);
        assert_eq!(messages(&f, &buffer), ["a boom", "b boom", "c boom"]);
        assert_eq!(change.first_changed, Some(1));
    }

    #[test]
    fn evictions_shift_matches() {
        let mut buffer = LogBuffer::new(3);
        buffer.insert([
            event(1, "ERROR", "boom 1"),
            event(2, "INFO", "ok"),
            event(3, "ERROR", "boom 3"),
        ]);
        let mut f = filter("boom", FilterMode::Filter);
        f.rebuild(&buffer);
        let change = insert(&mut buffer, &mut f, vec![event(4, "ERROR", "boom 4")]);
        assert_eq!(change.evicted, 1, "one visible match fell out");
        assert_eq!(messages(&f, &buffer), ["boom 3", "boom 4"]);
        assert_eq!(f.matched(), [1, 2]);
    }

    #[test]
    fn highlight_mode_lists_everything_and_marks_matches() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert([
            event(1, "INFO", "ok"),
            event(2, "ERROR", "boom"),
            event(3, "INFO", "ok"),
        ]);
        let mut f = filter("boom", FilterMode::Highlight);
        f.rebuild(&buffer);
        assert_eq!(f.visible_len(&buffer), 3);
        assert_eq!(f.matched(), [1]);
        let change = insert(&mut buffer, &mut f, vec![event(4, "INFO", "ok")]);
        assert_eq!(change.first_changed, Some(3));
    }

    #[test]
    fn hidden_levels_and_noise() {
        let mut buffer = LogBuffer::new(100);
        buffer.insert([
            event(1, "DEBUG", "cache refreshed"),
            event(2, "INFO", "GET /actuator/health 200"),
            event(3, "INFO", "order created"),
        ]);
        let mut f = ViewFilter::new(
            Query::default(),
            MatchOptions::default(),
            vec![Level::Debug],
            &["actuator/HEALTH".to_owned()],
            FilterMode::Filter,
        );
        assert!(!f.is_trivial());
        f.rebuild(&buffer);
        assert_eq!(messages(&f, &buffer), ["order created"]);
    }
}
