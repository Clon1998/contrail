//! Loading a time window newest first, in slices going back in time.
//!
//! CloudWatch's `FilterLogEvents` reads oldest first and can't read several streams newest first.
//! To show the newest events of a long window quickly (and not read hours of logs nobody looks
//! at), a view loads short slices from the end of its window backwards until it has enough
//! events; scrolling up loads the next older slices the same way.

use time::Duration;

use crate::auth::AwsCtx;
use crate::error::SourceError;
use crate::timestamp::Timestamp;

use super::{LogSource, RawEvent, StreamSelection, TimeRange};

/// The first slice back from the end of the window; each further slice is [`GROWTH`] times longer
/// (quiet services reach far back in a few calls, busy ones stop after the first slices).
const FIRST_SLICE: Duration = Duration::minutes(2);
const GROWTH: i32 = 4;

/// What [`backfill_newest`] read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slices {
    /// Oldest first.
    pub events: Vec<RawEvent>,
    /// The start of the oldest slice read: everything from here to `until` is loaded.
    pub from: Timestamp,
    /// The slices reached `window_start`: the whole window is loaded.
    pub complete: bool,
    /// A slice held more than `limit` allowed: its newest events are missing.
    pub truncated: bool,
}

/// Reads `selection` backwards from `until` in growing slices until at least `target` events are
/// collected or `window_start` is reached, and never more than `limit` events.
///
/// `&dyn LogSource` is a trait object (like an interface-typed parameter in Java): the same code
/// runs against CloudWatch and the demo fake.
pub async fn backfill_newest(
    source: &dyn LogSource,
    ctx: &AwsCtx,
    selection: &StreamSelection,
    until: Timestamp,
    window_start: Timestamp,
    target: usize,
    limit: usize,
) -> Result<Slices, SourceError> {
    // Slices are read newest first; each one's events are oldest first. Collected per slice and
    // put in order at the end (prepending to one Vec each time would copy it again and again).
    let mut slices: Vec<Vec<RawEvent>> = Vec::new();
    let mut count = 0;
    let mut end = until.0;
    let mut step = FIRST_SLICE;
    let mut truncated = false;
    while end > window_start.0 && count < target && count < limit {
        let start = (end - step).max(window_start.0);
        let range = TimeRange {
            start: Timestamp(start),
            end: Timestamp(end),
        };
        let slice = source
            .backfill(ctx, selection, range, limit - count)
            .await?;
        truncated |= slice.truncated;
        count += slice.events.len();
        slices.push(slice.events);
        end = start;
        step *= GROWTH;
    }
    Ok(Slices {
        events: slices.into_iter().rev().flatten().collect(),
        from: Timestamp(end),
        complete: end <= window_start.0,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use futures::executor::block_on;
    use time::OffsetDateTime;
    use time::macros::datetime;

    use super::*;
    use crate::logs::Backfill;

    const END: OffsetDateTime = datetime!(2026-10-23 12:00 UTC);

    /// One event per `every` within any requested range; remembers the ranges asked for.
    struct Every {
        every: Duration,
        ranges: Mutex<Vec<TimeRange>>,
    }

    impl Every {
        fn new(every: Duration) -> Self {
            Self {
                every,
                ranges: Mutex::default(),
            }
        }
    }

    #[async_trait]
    impl LogSource for Every {
        async fn backfill(
            &self,
            _ctx: &AwsCtx,
            _selection: &StreamSelection,
            range: TimeRange,
            limit: usize,
        ) -> Result<Backfill, SourceError> {
            self.ranges.lock().unwrap().push(range);
            let mut events = Vec::new();
            // Events at END - k * every, oldest first within the range.
            let mut at = END - self.every;
            while at >= range.start.0 {
                if at < range.end.0 {
                    events.push(RawEvent {
                        stream: "s".into(),
                        timestamp: Timestamp(at),
                        message: format!("{}", (END - at).whole_seconds()),
                    });
                }
                at -= self.every;
            }
            events.reverse();
            let truncated = events.len() > limit;
            events.truncate(limit);
            Ok(Backfill { events, truncated })
        }
    }

    fn ctx() -> AwsCtx {
        AwsCtx {
            profile: "dev".into(),
            region: None,
        }
    }

    fn selection() -> StreamSelection {
        StreamSelection {
            log_group: "/ecs/app".into(),
            region: None,
            account_id: None,
            streams: vec![],
            stream_prefix: None,
        }
    }

    fn read(source: &Every, window: Duration, target: usize, limit: usize) -> Slices {
        block_on(backfill_newest(
            source,
            &ctx(),
            &selection(),
            Timestamp(END),
            Timestamp(END - window),
            target,
            limit,
        ))
        .unwrap()
    }

    #[test]
    fn a_busy_service_stops_after_the_newest_slice() {
        let source = Every::new(Duration::seconds(1));
        let slices = read(&source, Duration::hours(6), 100, 100_000);
        // The first 2-minute slice already holds 120 events: no need to read the other 5h58m.
        assert_eq!(source.ranges.lock().unwrap().len(), 1);
        assert_eq!(slices.events.len(), 120);
        assert_eq!(slices.from, Timestamp(END - Duration::minutes(2)));
        assert!(!slices.complete);
        let times: Vec<_> = slices.events.iter().map(|e| e.timestamp).collect();
        assert!(times.windows(2).all(|w| w[0] < w[1]), "oldest first");
    }

    #[test]
    fn a_quiet_service_reaches_back_in_growing_slices() {
        let source = Every::new(Duration::minutes(10));
        let slices = read(&source, Duration::hours(6), 1_000, 100_000);
        let lengths: Vec<_> = source
            .ranges
            .lock()
            .unwrap()
            .iter()
            .map(|r| (r.end.0 - r.start.0).whole_minutes())
            .collect();
        // 2, 8, 32, 128 minutes, then the rest of the 6 hours.
        assert_eq!(lengths, [2, 8, 32, 128, 190]);
        assert!(slices.complete);
        assert_eq!(slices.from, Timestamp(END - Duration::hours(6)));
        assert_eq!(slices.events.len(), 36);
        let times: Vec<_> = slices.events.iter().map(|e| e.timestamp).collect();
        assert!(
            times.windows(2).all(|w| w[0] < w[1]),
            "slices joined in order"
        );
    }

    #[test]
    fn never_reads_more_than_the_limit() {
        let source = Every::new(Duration::seconds(1));
        let slices = read(&source, Duration::hours(1), 10_000, 50);
        assert_eq!(slices.events.len(), 50);
        assert!(slices.truncated);
    }

    #[test]
    fn an_empty_window_reads_nothing() {
        let source = Every::new(Duration::seconds(1));
        let slices = read(&source, Duration::ZERO, 100, 100);
        assert!(slices.events.is_empty());
        assert!(slices.complete);
        assert!(source.ranges.lock().unwrap().is_empty());
    }
}
