//! Live sessions: keeping a log view up to date after its backfill.
//!
//! One tokio task per view runs a small state machine:
//!
//! ```text
//!  ┌──────────── gap backfill (last seen − 5 s … now) ────────────┐
//!  ▼                                                               │
//! Connecting ──► Live ──(session ended)──► Reconnecting ───────────┤
//!     │           │                                                │
//!     │           └─(paused)──► Paused ──(resumed)─────────────────┤
//!     └─(Live Tail unavailable)──► Polling (every 2 s) ────────────┘
//! ```
//!
//! Every insert into the view's buffer is reported to the UI as a [`LiveUpdate`]. The task
//! reports through a callback instead of a Tauri `Channel`, so tests can drive it directly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::logs::buffer::DEFAULT_CAPACITY;
use contrail_core::logs::multiline::DEFAULT_WINDOW;
use contrail_core::logs::{
    BufferStats, LiveError, LiveItem, LogEvent, LogSource, MultilineJoiner, RawEvent,
    StreamSelection, TimeRange, VisibleChange, process,
};
use contrail_core::timestamp::Timestamp;
use futures::StreamExt;
use serde::Serialize;
use specta::Type;
use time::{Duration, OffsetDateTime};
use tokio::sync::watch;

use crate::state::LogView;

/// The open log views, shared between commands and live tasks.
///
/// `Arc<Mutex<…>>`: one map, owned jointly (`Arc`) by the app state and every live task, and
/// locked (`Mutex`) for each short read or insert. The alternative — sending every batch over a
/// channel to a single owner — would need another task just to own the map.
pub type Views = Arc<Mutex<HashMap<u32, LogView>>>;

/// How far back a gap backfill starts before the last event seen (clock skew, late ingestion).
const OVERLAP: Duration = Duration::seconds(5);
/// How often the polling fallback asks for new events.
const POLL_EVERY: StdDuration = StdDuration::from_secs(2);
/// How often held-back plain-text events (possible stack trace starts) are released.
const FLUSH_EVERY: StdDuration = StdDuration::from_millis(500);
/// The longest wait between retries after errors.
const MAX_BACKOFF: StdDuration = StdDuration::from_secs(30);

/// What the live task is doing, shown in the log view's toolbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LiveState {
    Connecting,
    Live,
    /// Live Tail isn't available (permissions, session limit): asking every 2 seconds instead.
    Polling,
    /// The session ended; a new one is being started.
    Reconnecting,
    Paused,
    /// Stopped by an error that needs the user (e.g. expired credentials).
    Failed,
}

/// One message to the UI: the new state and what changed in the buffer.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveUpdate {
    pub state: LiveState,
    /// CloudWatch sampled the last update (more than 500 events per second).
    pub sampled: bool,
    pub stats: BufferStats,
    /// How many rows the list shows (all events, or the matches when filtering).
    pub visible: u32,
    /// How many events match the search, when there is one.
    pub matches: Option<u32>,
    /// The first listed row that changed (new or moved rows); `None` if no rows changed.
    pub first_changed: Option<u32>,
    /// Listed rows dropped at the top because the buffer was full (all indices shifted).
    pub evicted: u32,
    /// Why the state is what it is, when there's something to say (polling, errors).
    pub message: Option<String>,
}

/// What the UI wants the task to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Run,
    Pause,
    Stop,
}

/// A running live task. Dropping the handle stops the task.
pub struct LiveHandle {
    control: watch::Sender<Control>,
    task: tokio::task::JoinHandle<()>,
}

impl LiveHandle {
    pub fn set(&self, control: Control) {
        // Fails only if the task has already ended, which is fine.
        let _ = self.control.send(control);
    }
}

impl Drop for LiveHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Where the task reports to (a Tauri channel in the app, a recorder in tests).
pub type Sink = Arc<dyn Fn(LiveUpdate) + Send + Sync>;

/// Everything a live task needs; owned by the task.
pub struct LiveTask {
    pub source: Arc<dyn LogSource>,
    pub ctx: AwsCtx,
    pub selection: StreamSelection,
    pub views: Views,
    pub view_id: u32,
    /// The newest CloudWatch timestamp already in the view (the end of its backfill).
    pub last_seen: Timestamp,
    pub sink: Sink,
}

/// Starts the task on the tokio runtime and returns its handle. With `Control::Pause` it waits
/// for a resume before connecting (views of long time windows start that way).
pub fn spawn(task: LiveTask, initial: Control) -> LiveHandle {
    let (control, receiver) = watch::channel(initial);
    let task = tokio::spawn(task.run(receiver));
    LiveHandle { control, task }
}

/// Why `follow` stopped consuming a live stream.
enum StreamEnd {
    /// The session ended normally or with `SessionEnded`: reconnect.
    Ended(Option<String>),
    /// Live Tail can't be used: poll instead.
    Unavailable(String),
    Failed(SourceError),
    /// Pause or stop was requested.
    Interrupted,
    /// The view was closed.
    ViewClosed,
}

impl LiveTask {
    async fn run(mut self, mut control: watch::Receiver<Control>) {
        let mut polling: Option<String> = None;
        let mut backoff = StdDuration::from_secs(1);
        let mut state = LiveState::Connecting;
        loop {
            // Copy the value out (`Control` is `Copy`): matching on `*control.borrow…()` directly
            // would keep the borrow guard alive for the whole `match`, and the arms need
            // `control` mutably again.
            let current = *control.borrow_and_update();
            match current {
                Control::Stop => return,
                Control::Pause => {
                    if !self.report(LiveState::Paused, false, None, None) {
                        return;
                    }
                    if !wait_until_running(&mut control).await {
                        return;
                    }
                    state = LiveState::Connecting;
                    continue;
                }
                Control::Run => {}
            }

            // Catch up on everything since the last event (a reconnect, resume or poll).
            self.report(state, false, None, polling.clone());
            match self.catch_up().await {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    if !self.handle_error(error, &mut control, &mut backoff).await {
                        return;
                    }
                    continue;
                }
            }

            if let Some(reason) = &polling {
                self.report(LiveState::Polling, false, None, Some(reason.clone()));
                if !sleep_unless_interrupted(POLL_EVERY, &mut control).await {
                    continue;
                }
                state = LiveState::Polling;
                continue;
            }

            let stream = match self.source.live(&self.ctx, &self.selection).await {
                Ok(stream) => stream,
                Err(LiveError::Unavailable(reason)) => {
                    tracing::info!(view = self.view_id, %reason, "live tail unavailable, polling");
                    polling = Some(format!("{reason}; checking every 2 seconds instead"));
                    continue;
                }
                Err(LiveError::SessionEnded(reason)) => {
                    self.report(LiveState::Reconnecting, false, None, Some(reason));
                    state = LiveState::Reconnecting;
                    continue;
                }
                Err(LiveError::Source(error)) => {
                    if !self.handle_error(error, &mut control, &mut backoff).await {
                        return;
                    }
                    continue;
                }
            };
            backoff = StdDuration::from_secs(1);
            match self.follow(stream, &mut control).await {
                StreamEnd::Ended(reason) => {
                    self.report(LiveState::Reconnecting, false, None, reason);
                    state = LiveState::Reconnecting;
                }
                StreamEnd::Unavailable(reason) => {
                    polling = Some(format!("{reason}; checking every 2 seconds instead"));
                }
                StreamEnd::Failed(error) => {
                    if !self.handle_error(error, &mut control, &mut backoff).await {
                        return;
                    }
                }
                StreamEnd::Interrupted => state = LiveState::Connecting,
                StreamEnd::ViewClosed => return,
            }
        }
    }

    /// Consumes a live stream until it ends, fails or is interrupted.
    async fn follow(
        &mut self,
        mut stream: contrail_core::logs::LiveStream,
        control: &mut watch::Receiver<Control>,
    ) -> StreamEnd {
        let mut joiner = MultilineJoiner::default();
        let mut sampled = false;
        let mut flush = tokio::time::interval(FLUSH_EVERY);
        loop {
            // `select!` waits for whichever happens first: a stream item, a control change or
            // the flush timer (like waiting on several futures and handling the winner).
            tokio::select! {
                item = stream.next() => match item {
                    Some(Ok(LiveItem::Started)) => {
                        if !self.report(LiveState::Live, sampled, None, None) {
                            return StreamEnd::ViewClosed;
                        }
                    }
                    Some(Ok(LiveItem::Events { events, sampled: now_sampled })) => {
                        sampled = now_sampled;
                        self.note_seen(&events);
                        let ready: Vec<LogEvent> = events
                            .into_iter()
                            .map(LogEvent::from_raw)
                            .flat_map(|e| joiner.push(e))
                            .collect();
                        match self.insert(ready) {
                            Some(report) => {
                                self.report(LiveState::Live, sampled, Some(report), None);
                            }
                            None => return StreamEnd::ViewClosed,
                        }
                    }
                    Some(Err(LiveError::SessionEnded(reason))) => return StreamEnd::Ended(Some(reason)),
                    Some(Err(LiveError::Unavailable(reason))) => return StreamEnd::Unavailable(reason),
                    Some(Err(LiveError::Source(error))) => return StreamEnd::Failed(error),
                    None => return StreamEnd::Ended(None),
                },
                changed = control.changed() => {
                    if changed.is_err() || *control.borrow() != Control::Run {
                        // Keep what was held back for joining.
                        if self.insert(joiner.flush()).is_none() {
                            return StreamEnd::ViewClosed;
                        }
                        return StreamEnd::Interrupted;
                    }
                }
                _ = flush.tick() => {
                    let cutoff = Timestamp(OffsetDateTime::now_utc() - DEFAULT_WINDOW);
                    let ready = joiner.flush_before(cutoff);
                    if !ready.is_empty() {
                        match self.insert(ready) {
                            Some(report) => {
                                self.report(LiveState::Live, sampled, Some(report), None);
                            }
                            None => return StreamEnd::ViewClosed,
                        }
                    }
                }
            }
        }
    }

    /// Backfills from just before the last event seen until now. `Ok(false)`: the view is gone.
    async fn catch_up(&mut self) -> Result<bool, SourceError> {
        let range = TimeRange {
            start: Timestamp(self.last_seen.0 - OVERLAP),
            end: Timestamp(OffsetDateTime::now_utc()),
        };
        let backfill = self
            .source
            .backfill(&self.ctx, &self.selection, range, DEFAULT_CAPACITY)
            .await?;
        self.note_seen(&backfill.events);
        match self.insert(process(backfill.events)) {
            Some(change) => {
                if change.first_changed.is_some() || change.evicted > 0 {
                    self.report(LiveState::Connecting, false, Some(change), None);
                }
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Credentials problems stop the task until the user does something (resume after logging
    /// in); anything else is retried with growing pauses. Returns `false` to end the task.
    async fn handle_error(
        &mut self,
        error: SourceError,
        control: &mut watch::Receiver<Control>,
        backoff: &mut StdDuration,
    ) -> bool {
        tracing::warn!(view = self.view_id, %error, "live tail error");
        // Errors only the user can fix: report them and wait.
        if matches!(
            error,
            SourceError::Credentials { .. } | SourceError::AccessDenied(_)
        ) {
            if !self.report(LiveState::Failed, false, None, Some(error.to_string())) {
                return false;
            }
            // Wait for a pause/resume from the UI (e.g. after logging in) before trying again.
            return wait_for_change(control).await;
        }
        if !self.report(
            LiveState::Reconnecting,
            false,
            None,
            Some(error.to_string()),
        ) {
            return false;
        }
        sleep_unless_interrupted(*backoff, control).await;
        *backoff = (*backoff * 2).min(MAX_BACKOFF);
        true
    }

    fn note_seen(&mut self, events: &[RawEvent]) {
        if let Some(newest) = events.iter().map(|e| e.timestamp).max() {
            self.last_seen = self.last_seen.max(newest);
        }
    }

    /// Inserts events into the view; `None` if the view was closed meanwhile.
    fn insert(&self, events: Vec<LogEvent>) -> Option<VisibleChange> {
        let mut views = self.views.lock().expect("views lock poisoned");
        let view = views.get_mut(&self.view_id)?;
        Some(view.insert(events))
    }

    /// Sends an update; `false` if the view was closed.
    fn report(
        &self,
        state: LiveState,
        sampled: bool,
        change: Option<VisibleChange>,
        message: Option<String>,
    ) -> bool {
        let (stats, visible, matches) = {
            let views = self.views.lock().expect("views lock poisoned");
            match views.get(&self.view_id) {
                Some(view) => (view.buffer.stats(), view.visible_len(), view.match_count()),
                None => return false,
            }
        };
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        (self.sink)(LiveUpdate {
            state,
            sampled,
            stats,
            visible: count(visible),
            matches: matches.map(count),
            first_changed: change.and_then(|c| c.first_changed).map(count),
            evicted: change.map_or(0, |c| count(c.evicted)),
            message,
        });
        true
    }
}

/// Waits until the control says `Run` again; `false` on `Stop`.
async fn wait_until_running(control: &mut watch::Receiver<Control>) -> bool {
    loop {
        match *control.borrow_and_update() {
            Control::Run => return true,
            Control::Stop => return false,
            Control::Pause => {}
        }
        if control.changed().await.is_err() {
            return false;
        }
    }
}

/// Waits for any control change; `false` on `Stop` or when the handle is gone.
async fn wait_for_change(control: &mut watch::Receiver<Control>) -> bool {
    control.changed().await.is_ok() && *control.borrow() != Control::Stop
}

/// Sleeps, returning early (with `false`) when the control changes.
async fn sleep_unless_interrupted(
    duration: StdDuration,
    control: &mut watch::Receiver<Control>,
) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => true,
        _ = control.changed() => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use contrail_core::logs::{Backfill, LiveStream, LogBuffer};
    use std::collections::VecDeque;
    use time::macros::datetime;

    const STREAM: &str = "ecs/orders-api/task1";

    fn at(second: i64) -> Timestamp {
        Timestamp(datetime!(2026-01-15 12:00 UTC) + Duration::seconds(second))
    }

    fn raw(second: i64, message: &str) -> RawEvent {
        RawEvent {
            stream: STREAM.into(),
            timestamp: at(second),
            message: format!(
                r#"{{"@timestamp":"2026-01-15T12:00:{second:02}Z","log.level":"INFO","message":"{message}"}}"#
            ),
        }
    }

    /// One scripted `live` call: the items of a session, or the error starting it.
    type Session = Result<Vec<Result<LiveItem, LiveError>>, LiveError>;

    /// A scripted source: each `live` call plays the next session, each `backfill` call returns
    /// the next prepared answer (or nothing).
    #[derive(Default)]
    struct Scripted {
        sessions: Mutex<VecDeque<Session>>,
        backfills: Mutex<VecDeque<Vec<RawEvent>>>,
        backfill_ranges: Mutex<Vec<TimeRange>>,
    }

    #[async_trait]
    impl LogSource for Scripted {
        async fn backfill(
            &self,
            _ctx: &AwsCtx,
            _selection: &StreamSelection,
            range: TimeRange,
            _limit: usize,
        ) -> Result<Backfill, SourceError> {
            self.backfill_ranges.lock().unwrap().push(range);
            let events = self
                .backfills
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default();
            Ok(Backfill {
                events,
                truncated: false,
            })
        }

        async fn live(
            &self,
            _ctx: &AwsCtx,
            _selection: &StreamSelection,
        ) -> Result<LiveStream, LiveError> {
            match self.sessions.lock().unwrap().pop_front() {
                // Like a real session, it stays open after its items (unless they end with an
                // error such as `SessionEnded`).
                Some(Ok(items)) => Ok(futures::stream::iter(items)
                    .chain(futures::stream::pending())
                    .boxed()),
                Some(Err(error)) => Err(error),
                // No more sessions scripted: a session that never sends anything.
                None => Ok(futures::stream::pending().boxed()),
            }
        }
    }

    struct Harness {
        source: Arc<Scripted>,
        views: Views,
        updates: Arc<Mutex<Vec<LiveUpdate>>>,
    }

    impl Harness {
        fn new(source: Scripted) -> Self {
            let views: Views = Arc::default();
            views.lock().unwrap().insert(
                1,
                LogView::new(
                    LogBuffer::new(1_000),
                    AwsCtx {
                        profile: "dev".into(),
                        region: None,
                    },
                    selection(),
                    at(0),
                ),
            );
            Self {
                source: Arc::new(source),
                views,
                updates: Arc::default(),
            }
        }

        fn spawn(&self) -> LiveHandle {
            self.spawn_with(Control::Run)
        }

        fn spawn_with(&self, initial: Control) -> LiveHandle {
            let updates = self.updates.clone();
            spawn(
                LiveTask {
                    source: self.source.clone(),
                    ctx: AwsCtx {
                        profile: "dev".into(),
                        region: None,
                    },
                    selection: selection(),
                    views: self.views.clone(),
                    view_id: 1,
                    last_seen: at(0),
                    sink: Arc::new(move |u| updates.lock().unwrap().push(u)),
                },
                initial,
            )
        }

        fn messages(&self) -> Vec<String> {
            self.views.lock().unwrap()[&1]
                .buffer
                .window(0, usize::MAX)
                .into_iter()
                .map(|e| e.line.message)
                .collect()
        }

        fn states(&self) -> Vec<LiveState> {
            let mut states: Vec<LiveState> = self
                .updates
                .lock()
                .unwrap()
                .iter()
                .map(|u| u.state)
                .collect();
            states.dedup();
            states
        }
    }

    fn selection() -> StreamSelection {
        StreamSelection {
            log_group: "/ecs/orders-api".into(),
            region: None,
            account_id: Some("111122223333".into()),
            streams: vec![STREAM.into()],
            stream_prefix: None,
        }
    }

    fn events(list: Vec<RawEvent>) -> Result<LiveItem, LiveError> {
        Ok(LiveItem::Events {
            events: list,
            sampled: false,
        })
    }

    /// Lets the task run until it waits for time to pass (tokio's clock is paused in these tests,
    /// and advances automatically once every task is idle).
    async fn settle() {
        tokio::time::sleep(StdDuration::from_millis(100)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn live_events_reach_the_buffer_and_the_ui() {
        let source = Scripted::default();
        source.sessions.lock().unwrap().push_back(Ok(vec![
            Ok(LiveItem::Started),
            events(vec![raw(1, "one"), raw(2, "two")]),
        ]));
        let harness = Harness::new(source);
        let _handle = harness.spawn();
        settle().await;

        assert_eq!(harness.messages(), ["one", "two"]);
        let states = harness.states();
        assert_eq!(states[0], LiveState::Connecting);
        assert!(states.contains(&LiveState::Live));
        let last = harness.updates.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.stats.total, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn reconnects_with_a_gap_backfill_and_no_duplicates() {
        let source = Scripted::default();
        // First session ends after one event (e.g. the 3-hour limit) …
        source.sessions.lock().unwrap().push_back(Ok(vec![
            Ok(LiveItem::Started),
            events(vec![raw(10, "ten")]),
            Err(LiveError::SessionEnded("timeout".into())),
        ]));
        // … the second one repeats an event that the gap backfill already delivered.
        source.sessions.lock().unwrap().push_back(Ok(vec![
            Ok(LiveItem::Started),
            events(vec![raw(11, "eleven"), raw(12, "twelve")]),
        ]));
        source.backfills.lock().unwrap().push_back(vec![]); // initial catch-up
        source
            .backfills
            .lock()
            .unwrap()
            .push_back(vec![raw(10, "ten"), raw(11, "eleven")]);
        let harness = Harness::new(source);
        let _handle = harness.spawn();
        settle().await;

        assert_eq!(harness.messages(), ["ten", "eleven", "twelve"]);
        assert!(harness.states().contains(&LiveState::Reconnecting));
        // The gap backfill starts 5 seconds before the last event seen.
        let ranges = harness.source.backfill_ranges.lock().unwrap().clone();
        assert_eq!(ranges[1].start, at(5));
    }

    #[tokio::test(start_paused = true)]
    async fn falls_back_to_polling_when_live_tail_is_unavailable() {
        let source = Scripted::default();
        source
            .sessions
            .lock()
            .unwrap()
            .push_back(Err(LiveError::Unavailable("AccessDeniedException".into())));
        source.backfills.lock().unwrap().push_back(vec![]);
        source
            .backfills
            .lock()
            .unwrap()
            .push_back(vec![raw(3, "polled")]);
        let harness = Harness::new(source);
        let _handle = harness.spawn();
        tokio::time::sleep(StdDuration::from_secs(5)).await;

        assert_eq!(harness.messages(), ["polled"]);
        assert!(harness.states().contains(&LiveState::Polling));
        let polling = harness
            .updates
            .lock()
            .unwrap()
            .iter()
            .find(|u| u.state == LiveState::Polling)
            .and_then(|u| u.message.clone())
            .unwrap();
        assert!(polling.contains("AccessDeniedException"));
        // Polling keeps asking every 2 seconds.
        assert!(harness.source.backfill_ranges.lock().unwrap().len() >= 3);
    }

    #[tokio::test(start_paused = true)]
    async fn pause_stops_inserting_and_resume_backfills_the_gap() {
        let source = Scripted::default();
        source.sessions.lock().unwrap().push_back(Ok(vec![
            Ok(LiveItem::Started),
            events(vec![raw(1, "before pause")]),
        ]));
        source.backfills.lock().unwrap().push_back(vec![]);
        // What was logged while paused, delivered by the gap backfill on resume.
        source
            .backfills
            .lock()
            .unwrap()
            .push_back(vec![raw(30, "while paused")]);
        let harness = Harness::new(source);
        let handle = harness.spawn();
        settle().await;

        handle.set(Control::Pause);
        settle().await;
        assert_eq!(harness.states().last(), Some(&LiveState::Paused));
        assert_eq!(harness.messages(), ["before pause"]);

        handle.set(Control::Run);
        settle().await;
        assert_eq!(harness.messages(), ["before pause", "while paused"]);
        assert_ne!(harness.states().last(), Some(&LiveState::Paused));
    }

    #[tokio::test(start_paused = true)]
    async fn expired_credentials_stop_until_resumed() {
        let source = Scripted::default();
        source
            .sessions
            .lock()
            .unwrap()
            .push_back(Err(LiveError::Source(SourceError::Credentials {
                profile: "dev".into(),
                message: "ExpiredToken".into(),
            })));
        let harness = Harness::new(source);
        let _handle = harness.spawn();
        tokio::time::sleep(StdDuration::from_secs(60)).await;

        assert_eq!(harness.states().last(), Some(&LiveState::Failed));
        // No retry storm while waiting for the user.
        assert_eq!(harness.source.backfill_ranges.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn missing_permissions_stop_until_resumed() {
        let source = Scripted::default();
        source
            .sessions
            .lock()
            .unwrap()
            .push_back(Err(LiveError::Source(SourceError::AccessDenied(
                "AccessDeniedException: logs:FilterLogEvents".into(),
            ))));
        let harness = Harness::new(source);
        let _handle = harness.spawn();
        tokio::time::sleep(StdDuration::from_secs(60)).await;

        assert_eq!(harness.states().last(), Some(&LiveState::Failed));
        assert_eq!(harness.source.backfill_ranges.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_task_started_paused_reads_nothing_until_resumed() {
        let harness = Harness::new(Scripted::default());
        let handle = harness.spawn_with(Control::Pause);
        settle().await;
        assert_eq!(harness.states(), vec![LiveState::Paused]);
        assert!(harness.source.backfill_ranges.lock().unwrap().is_empty());

        handle.set(Control::Run);
        settle().await;
        assert_eq!(harness.source.backfill_ranges.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn closing_the_view_ends_the_task() {
        let harness = Harness::new(Scripted::default());
        let handle = harness.spawn();
        settle().await;
        harness.views.lock().unwrap().remove(&1);
        // The pending session never ends; the next flush tick notices the view is gone only if
        // something is inserted, so stop explicitly like the close command does.
        handle.set(Control::Stop);
        settle().await;
        assert!(handle.task.is_finished());
    }
}
