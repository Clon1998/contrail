//! Following one correlation or trace ID across services.

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::ServiceRef;
use contrail_core::logs::resolve_log_location;
use contrail_core::logs::trace::{Trace, TraceFailure, TraceTarget, trace, trace_insights};
use contrail_core::logs::{TimeRange, TimeWindow};
use futures::future::join_all;
use tauri::State;
use time::OffsetDateTime;

use crate::error::ApiResult;
use crate::state::AppState;

/// At most this many events per service (a document's trace is short; a busy trace ID isn't).
const EVENTS_PER_SERVICE: usize = 2_000;

/// Searches `services` for `id` in `window` and merges what they logged about it. With
/// `insights`, one Logs Insights query covers up to 50 services (faster, billed per GB scanned).
#[tauri::command]
#[specta::specta]
pub async fn trace_id(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    services: Vec<ServiceRef>,
    id: String,
    window: TimeWindow,
    insights: bool,
) -> ApiResult<Trace> {
    trace_services(&state, ctx, services, id, window, insights).await
}

async fn trace_services(
    state: &AppState,
    ctx: AwsCtx,
    services: Vec<ServiceRef>,
    id: String,
    window: TimeWindow,
    insights: bool,
) -> ApiResult<Trace> {
    let range: TimeRange = window.range(OffsetDateTime::now_utc())?;
    // Where each service logs: its task definition's awslogs settings, the whole stream prefix.
    // `join_all` runs the lookups at the same time (the task definitions are cached).
    let lookups = join_all(services.iter().map(|service| async {
        let detail = state
            .ecs
            .describe_service(&ctx, service)
            .await
            .map_err(|e| e.to_string())?;
        let task_definition = detail
            .task_definition
            .ok_or_else(|| "the task definition could not be read".to_owned())?;
        let location = resolve_log_location(&task_definition).map_err(|e| e.to_string())?;
        let account_id = service.cluster_arn.split(':').nth(4).map(str::to_owned);
        Ok::<_, String>(location.selection(&[], account_id, true))
    }))
    .await;

    let mut targets = Vec::new();
    let mut failures = Vec::new();
    for (service, lookup) in services.iter().zip(lookups) {
        match lookup {
            Ok(selection) => targets.push(TraceTarget {
                service: service.service_name.clone(),
                selection,
            }),
            Err(message) => failures.push(TraceFailure {
                service: service.service_name.clone(),
                message,
            }),
        }
    }
    let mut result = if insights {
        trace_insights(&*state.logs, &ctx, targets, &id, range, EVENTS_PER_SERVICE).await
    } else {
        trace(&*state.logs, &ctx, targets, &id, range, EVENTS_PER_SERVICE).await
    };
    result.failures.extend(failures);
    result.failures.sort_by(|a, b| a.service.cmp(&b.service));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo(cluster: &str, name: &str) -> ServiceRef {
        ServiceRef {
            cluster_arn: format!("arn:aws:ecs:eu-central-1:111122223333:cluster/{cluster}"),
            service_name: name.into(),
        }
    }

    #[tokio::test]
    async fn traces_a_demo_document_and_reports_unknown_services() {
        let state = AppState::demo();
        let ctx = AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        };
        // The demo's documents are DE40C0DE0000000<n>-…; find one in the orders service.
        let id = "DE40C0DE00000001";
        let result = trace_services(
            &state,
            ctx,
            vec![
                demo("demo-core", "orders-api"),
                demo("demo-core", "missing"),
            ],
            id.into(),
            TimeWindow::Last { minutes: 60 },
            false,
        )
        .await
        .unwrap();
        assert!(
            !result.hits.is_empty(),
            "the demo logs mention the document"
        );
        assert!(result.hits.iter().all(|h| h.event.raw.contains(id)));
        assert_eq!(result.services[0].service, "orders-api");
        assert!(
            result.services[0].last_state.is_some(),
            "status events count"
        );
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].service, "missing");
    }

    #[tokio::test]
    async fn insights_finds_the_same_demo_document() {
        let state = AppState::demo();
        let ctx = AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        };
        let id = "DE40C0DE00000001";
        // One fixed range for both searches: with "the last 60 minutes" each search had its own
        // window, and a demo event could slip out of the second one.
        let now = OffsetDateTime::now_utc();
        let window = TimeWindow::Range {
            from: (now - time::Duration::minutes(60)).into(),
            to: now.into(),
        };
        let search = |insights| {
            trace_services(
                &state,
                ctx.clone(),
                vec![demo("demo-core", "orders-api")],
                id.into(),
                window,
                insights,
            )
        };
        let filtered = search(false).await.unwrap();
        let insights = search(true).await.unwrap();
        assert!(!insights.hits.is_empty());
        assert_eq!(insights.hits.len(), filtered.hits.len());
        assert_eq!(insights.services[0].service, "orders-api");
    }
}
