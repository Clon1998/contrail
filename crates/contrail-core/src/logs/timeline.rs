//! The timeline above the log list: how many events fall into each stretch of time, by level.

use serde::Serialize;
use specta::Type;
use time::{Duration, OffsetDateTime};

use crate::timestamp::Timestamp;

use super::{Level, LogEvent};

/// The events of one bucket, by level (`none`: lines without a level).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LevelCounts {
    pub error: u32,
    pub warn: u32,
    pub info: u32,
    pub debug: u32,
    pub trace: u32,
    pub none: u32,
}

impl LevelCounts {
    fn add(&mut self, level: Option<Level>) {
        let count = match level {
            Some(Level::Error) => &mut self.error,
            Some(Level::Warn) => &mut self.warn,
            Some(Level::Info) => &mut self.info,
            Some(Level::Debug) => &mut self.debug,
            Some(Level::Trace) => &mut self.trace,
            None => &mut self.none,
        };
        *count += 1;
    }

    pub fn total(&self) -> u32 {
        self.error + self.warn + self.info + self.debug + self.trace + self.none
    }
}

/// Event counts over a time range in buckets of equal length, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    /// The start of the first bucket (on a round time, see [`bucket_length`]).
    pub start: Timestamp,
    /// The length of every bucket, in milliseconds (at most a week, so it fits a `u32`).
    pub bucket_ms: u32,
    pub buckets: Vec<LevelCounts>,
}

/// The bucket lengths a timeline picks from: round numbers people read at a glance.
const STEPS_MS: [u32; 20] = [
    1_000,
    2_000,
    5_000,
    10_000,
    15_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    2 * 3_600_000,
    3 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    86_400_000,
    2 * 86_400_000,
    7 * 86_400_000,
];

/// The shortest round bucket length that covers `span` in at most `max_buckets` buckets.
pub fn bucket_length(span: Duration, max_buckets: u32) -> u32 {
    let span_ms = span.whole_milliseconds().max(1);
    let max = i128::from(max_buckets.max(1));
    STEPS_MS
        .into_iter()
        // Rounded up (`div_ceil` isn't stable for signed integers yet).
        .find(|&step| (span_ms + i128::from(step) - 1) / i128::from(step) <= max)
        .unwrap_or(STEPS_MS[STEPS_MS.len() - 1])
}

/// The start of the bucket holding `at`: a multiple of `step_ms` on the clock of a time zone
/// `utc_offset` ahead of UTC, so hours and days start at :00 and midnight where the user is.
fn bucket_start(at: OffsetDateTime, step_ms: u32, utc_offset: Duration) -> OffsetDateTime {
    let local_ms = (at + utc_offset).unix_timestamp_nanos() / 1_000_000;
    let start_ms = local_ms.div_euclid(i128::from(step_ms)) * i128::from(step_ms);
    OffsetDateTime::from_unix_timestamp_nanos(start_ms * 1_000_000).expect("a valid time")
        - utc_offset
}

/// Counts `events` from `from` to `to` into at most about `max_buckets` buckets, aligned to the
/// time zone `utc_offset_minutes` ahead of UTC. Events outside the range are left out; their
/// order doesn't matter (newest first works as well as oldest first).
pub fn timeline<'a>(
    events: impl IntoIterator<Item = &'a LogEvent>,
    from: Timestamp,
    to: Timestamp,
    max_buckets: u32,
    utc_offset_minutes: i32,
) -> Timeline {
    let offset = Duration::minutes(i64::from(utc_offset_minutes));
    let step = bucket_length(to.0 - from.0, max_buckets);
    let start = bucket_start(from.0, step, offset);
    let step_ms = i128::from(step);
    let span_ms = (to.0 - start).whole_milliseconds().max(0);
    // At least one bucket; the last one holds `to` itself.
    let count = usize::try_from(span_ms / step_ms + 1).unwrap_or(1);
    let mut buckets = vec![LevelCounts::default(); count];
    for event in events {
        let at = event.timestamp.0;
        if at < from.0 || at > to.0 {
            continue;
        }
        let index = (at - start).whole_milliseconds() / step_ms;
        if let Some(bucket) = usize::try_from(index).ok().and_then(|i| buckets.get_mut(i)) {
            bucket.add(event.line.level);
        }
    }
    Timeline {
        start: Timestamp(start),
        bucket_ms: step,
        buckets,
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;
    use crate::logs::{LogKind, ParsedLine};

    fn event(at: OffsetDateTime, level: Option<Level>) -> LogEvent {
        LogEvent {
            seq: 0,
            timestamp: Timestamp(at),
            cw_timestamp: Timestamp(at),
            stream: "s".into(),
            task_id: "t".into(),
            line: ParsedLine {
                kind: LogKind::Plain,
                timestamp: None,
                level,
                message: "m".into(),
                fields: Vec::new(),
                error: None,
                json_span: None,
            },
            raw: "m".into(),
            status: None,
        }
    }

    #[test]
    fn picks_the_shortest_round_bucket_that_fits() {
        assert_eq!(bucket_length(Duration::minutes(15), 120), 10_000);
        assert_eq!(bucket_length(Duration::hours(1), 120), 30_000);
        assert_eq!(bucket_length(Duration::days(2), 100), 30 * 60_000);
        assert_eq!(bucket_length(Duration::seconds(30), 120), 1_000);
        // Longer than any step allows: the longest step.
        assert_eq!(bucket_length(Duration::days(10_000), 10), 7 * 86_400_000);
    }

    #[test]
    fn counts_by_level_into_round_buckets_in_any_order() {
        let from = Timestamp(datetime!(2026-10-26 12:00:07 UTC));
        let to = Timestamp(datetime!(2026-10-26 12:00:59 UTC));
        let events = [
            // Newest first, like a list shown that way.
            event(datetime!(2026-10-26 12:00:55 UTC), Some(Level::Error)),
            event(datetime!(2026-10-26 12:00:21 UTC), Some(Level::Warn)),
            event(datetime!(2026-10-26 12:00:20 UTC), None),
            event(datetime!(2026-10-26 12:00:08 UTC), Some(Level::Info)),
            // Outside the range.
            event(datetime!(2026-10-26 12:00:01 UTC), Some(Level::Info)),
        ];
        let t = timeline(&events, from, to, 10, 0);
        assert_eq!(t.bucket_ms, 10_000);
        // Starts on a round time before `from`.
        assert_eq!(t.start, Timestamp(datetime!(2026-10-26 12:00:00 UTC)));
        let totals: Vec<u32> = t.buckets.iter().map(LevelCounts::total).collect();
        // Empty buckets are there too (12:00:30, 12:00:40).
        assert_eq!(totals, [1, 0, 2, 0, 0, 1]);
        assert_eq!(t.buckets[2].warn, 1);
        assert_eq!(t.buckets[2].none, 1);
        assert_eq!(t.buckets[5].error, 1);
    }

    #[test]
    fn hours_and_days_start_where_the_user_is() {
        let from = Timestamp(datetime!(2026-10-26 00:00 UTC));
        let to = Timestamp(datetime!(2026-10-28 00:00 UTC));
        // India is UTC+5:30: local midnight is 18:30 UTC the day before.
        let t = timeline(std::iter::empty(), from, to, 3, 330);
        assert_eq!(t.bucket_ms, 86_400_000);
        assert_eq!(t.start, Timestamp(datetime!(2026-10-25 18:30 UTC)));
        // UTC: midnight.
        let t = timeline(std::iter::empty(), from, to, 3, 0);
        assert_eq!(t.start, from);
        // Hours west of UTC (New York in winter, UTC−5): 1 h buckets at :00 local = :00 UTC.
        let t = timeline(
            std::iter::empty(),
            from,
            Timestamp(datetime!(2026-10-26 10:00 UTC)),
            12,
            -300,
        );
        assert_eq!(t.bucket_ms, 3_600_000);
        assert_eq!(t.start, from);
    }

    #[test]
    fn an_event_at_the_end_counts() {
        let from = Timestamp(datetime!(2026-10-26 12:00 UTC));
        let to = Timestamp(datetime!(2026-10-26 12:01 UTC));
        let t = timeline(&[event(to.0, Some(Level::Info))], from, to, 6, 0);
        assert_eq!(t.buckets.last().map(LevelCounts::total), Some(1));
        assert_eq!(t.buckets.iter().map(LevelCounts::total).sum::<u32>(), 1);
    }

    #[test]
    fn counts_100k_events_quickly() {
        let from = datetime!(2026-10-26 12:00 UTC);
        let events: Vec<LogEvent> = (0..100_000)
            .map(|i| event(from + Duration::milliseconds(i * 9), Some(Level::Info)))
            .collect();
        let started = std::time::Instant::now();
        let t = timeline(
            &events,
            Timestamp(from),
            Timestamp(from + Duration::minutes(15)),
            240,
            60,
        );
        // The UI asks at most once a second while live; even unoptimised test builds stay far below.
        assert!(
            started.elapsed() < std::time::Duration::from_millis(200),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            t.buckets.iter().map(LevelCounts::total).sum::<u32>(),
            100_000
        );
    }
}
