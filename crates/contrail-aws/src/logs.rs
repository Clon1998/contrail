//! The real [`LogSource`]: CloudWatch Logs `FilterLogEvents` (read-only).

use async_trait::async_trait;
use aws_sdk_cloudwatchlogs::Client;
use contrail_core::auth::AwsCtx;
use contrail_core::error::SourceError;
use contrail_core::logs::{Backfill, LogSource, RawEvent, StreamSelection, TimeRange};
use contrail_core::timestamp::Timestamp;
use time::OffsetDateTime;

use crate::clients::ClientCache;
use crate::error::map_sdk_error;

/// `FilterLogEvents` accepts at most this many stream names per request.
const MAX_STREAMS_PER_REQUEST: usize = 100;

/// CloudWatch Logs via the AWS SDK.
#[derive(Default)]
pub struct AwsLogs {
    clients: ClientCache<Client>,
}

impl AwsLogs {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl LogSource for AwsLogs {
    async fn backfill(
        &self,
        ctx: &AwsCtx,
        selection: &StreamSelection,
        range: TimeRange,
        limit: usize,
    ) -> Result<Backfill, SourceError> {
        // The log group may live in another region than the service (`awslogs-region`).
        let log_ctx = AwsCtx {
            profile: ctx.profile.clone(),
            region: selection.region.clone().or_else(|| ctx.region.clone()),
        };
        let client = self.clients.get(&log_ctx, Client::new).await;
        backfill(&client, &ctx.profile, selection, range, limit).await
    }
}

fn millis(timestamp: Timestamp) -> i64 {
    (timestamp.0.unix_timestamp_nanos() / 1_000_000) as i64
}

fn from_millis(millis: i64) -> Option<Timestamp> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .map(Timestamp)
}

async fn backfill(
    client: &Client,
    profile: &str,
    selection: &StreamSelection,
    range: TimeRange,
    limit: usize,
) -> Result<Backfill, SourceError> {
    let mut result = Backfill::default();
    // Batches run one after another so the limit applies across all of them.
    for streams in selection.streams.chunks(MAX_STREAMS_PER_REQUEST) {
        let mut pages = client
            .filter_log_events()
            .log_group_name(&selection.log_group)
            .set_log_stream_names(Some(streams.to_vec()))
            .start_time(millis(range.start))
            .end_time(millis(range.end))
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            let page = page.map_err(|err| map_sdk_error(profile, err))?;
            for event in page.events() {
                if result.events.len() >= limit {
                    result.truncated = true;
                    break;
                }
                let (Some(stream), Some(timestamp), Some(message)) = (
                    event.log_stream_name(),
                    event.timestamp().and_then(from_millis),
                    event.message(),
                ) else {
                    continue;
                };
                result.events.push(RawEvent {
                    stream: stream.to_owned(),
                    timestamp,
                    message: message.to_owned(),
                });
            }
            if result.truncated {
                break;
            }
        }
        if result.truncated {
            break;
        }
    }
    // Each request is ordered by time; batches need merging.
    result.events.sort_by_key(|e| e.timestamp);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_cloudwatchlogs::operation::filter_log_events::FilterLogEventsOutput;
    use aws_sdk_cloudwatchlogs::types::FilteredLogEvent;
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use time::Duration;
    use time::macros::datetime;

    fn range() -> TimeRange {
        let start = datetime!(2026-01-15 12:00 UTC);
        TimeRange {
            start: Timestamp(start),
            end: Timestamp(start + Duration::minutes(15)),
        }
    }

    fn event(stream: &str, millis: i64, message: &str) -> FilteredLogEvent {
        FilteredLogEvent::builder()
            .log_stream_name(stream)
            .timestamp(1_768_478_400_000 + millis)
            .message(message)
            .build()
    }

    fn selection(streams: usize) -> StreamSelection {
        StreamSelection {
            log_group: "/ecs/orders-api".into(),
            region: None,
            streams: (0..streams)
                .map(|i| format!("ecs/orders-api/task{i:03}"))
                .collect(),
        }
    }

    #[tokio::test]
    async fn follows_pages_and_sends_range_and_streams() {
        let rule = mock!(Client::filter_log_events)
            .match_requests(|req| {
                req.log_group_name() == Some("/ecs/orders-api")
                    && req.start_time() == Some(1_768_478_400_000)
                    && req.end_time() == Some(1_768_478_400_000 + 15 * 60_000)
                    && req.log_stream_names().len() == 2
            })
            .sequence()
            .output(|| {
                FilterLogEventsOutput::builder()
                    .events(event("ecs/orders-api/task000", 1, "first"))
                    .next_token("page-2")
                    .build()
            })
            .output(|| {
                FilterLogEventsOutput::builder()
                    .events(event("ecs/orders-api/task001", 2, "second"))
                    .build()
            })
            .build();
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::Sequential, [&rule]);

        let result = backfill(&client, "dev", &selection(2), range(), 100)
            .await
            .unwrap();

        let messages: Vec<&str> = result.events.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, ["first", "second"]);
        assert_eq!(result.events[0].stream, "ecs/orders-api/task000");
        assert!(!result.truncated);
        assert_eq!(rule.num_calls(), 2);
    }

    #[tokio::test]
    async fn splits_more_than_100_streams_and_merges_by_time() {
        let rule = mock!(Client::filter_log_events).then_compute_output(|req| {
            assert!(req.log_stream_names().len() <= 100);
            // The first batch has the later event, to check the merge.
            let first_batch = req
                .log_stream_names()
                .contains(&"ecs/orders-api/task000".to_owned());
            let (stream, millis) = if first_batch {
                ("ecs/orders-api/task000", 50)
            } else {
                ("ecs/orders-api/task120", 10)
            };
            FilterLogEventsOutput::builder()
                .events(event(stream, millis, stream))
                .build()
        });
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::MatchAny, [&rule]);

        let result = backfill(&client, "dev", &selection(150), range(), 100)
            .await
            .unwrap();

        assert_eq!(rule.num_calls(), 2);
        let streams: Vec<&str> = result.events.iter().map(|e| e.stream.as_str()).collect();
        assert_eq!(
            streams,
            ["ecs/orders-api/task120", "ecs/orders-api/task000"]
        );
    }

    #[tokio::test]
    async fn stops_at_the_limit() {
        let rule = mock!(Client::filter_log_events).then_output(|| {
            FilterLogEventsOutput::builder()
                .set_events(Some(
                    (0..10)
                        .map(|i| event("ecs/orders-api/task000", i, "m"))
                        .collect(),
                ))
                .next_token("more")
                .build()
        });
        let client = mock_client!(aws_sdk_cloudwatchlogs, RuleMode::MatchAny, [&rule]);

        let result = backfill(&client, "dev", &selection(1), range(), 15)
            .await
            .unwrap();

        assert_eq!(result.events.len(), 15);
        assert!(result.truncated);
        assert_eq!(rule.num_calls(), 2, "no further pages after the limit");
    }
}
