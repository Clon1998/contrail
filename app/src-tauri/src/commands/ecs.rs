//! Clusters, services and tasks (read-only).

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{ClusterSummary, ServiceDetail, ServiceRef, ServiceSummary, Task};
use tauri::State;

use crate::error::ApiResult;
use crate::state::AppState;

/// All clusters of the profile's account in the selected region.
#[tauri::command]
#[specta::specta]
pub async fn list_clusters(
    state: State<'_, AppState>,
    ctx: AwsCtx,
) -> ApiResult<Vec<ClusterSummary>> {
    Ok(state.ecs.list_clusters(&ctx).await?)
}

/// All services of a cluster.
#[tauri::command]
#[specta::specta]
pub async fn list_services(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
) -> ApiResult<Vec<ServiceSummary>> {
    Ok(state.ecs.list_services(&ctx, &cluster_arn).await?)
}

/// The value of a secret-backed environment variable (`valueFrom` of the task definition), read
/// from Secrets Manager or SSM only when the user clicks "Reveal". Never logged or stored.
#[tauri::command]
#[specta::specta]
pub async fn reveal_secret(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    value_from: String,
) -> ApiResult<String> {
    Ok(state.secrets.reveal(&ctx, &value_from).await?)
}

/// Counts, deployments, task definition and recent events of one service.
#[tauri::command]
#[specta::specta]
pub async fn describe_service(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
) -> ApiResult<ServiceDetail> {
    Ok(state.ecs.describe_service(&ctx, &service).await?)
}

/// Running tasks, plus recently stopped ones with `include_stopped`.
#[tauri::command]
#[specta::specta]
pub async fn list_tasks(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
    include_stopped: bool,
) -> ApiResult<Vec<Task>> {
    Ok(state
        .ecs
        .list_tasks(&ctx, &service, include_stopped)
        .await?)
}

/// A service of the cluster that reads from or writes to one of the topics asked about.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicLink {
    pub topic: String,
    pub service: String,
    /// The service brings data in to the topic (input route) or takes it out (output route).
    pub direction: TopicDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TopicDirection {
    In,
    Out,
}

/// How many services are described at the same time when looking for topic links.
const TOPIC_SCAN_PARALLEL: usize = 5;

/// The services of `cluster_arn` whose routes use one of `topics` (except `exclude`).
#[tauri::command]
#[specta::specta]
pub async fn services_on_topics(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
    topics: Vec<String>,
    exclude: String,
) -> ApiResult<Vec<TopicLink>> {
    find_topic_links(&state, &ctx, &cluster_arn, &topics, &exclude).await
}

async fn find_topic_links(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
    topics: &[String],
    exclude: &str,
) -> ApiResult<Vec<TopicLink>> {
    use futures::StreamExt;

    let services = state.ecs.list_services(ctx, cluster_arn).await?;
    let details: Vec<_> = futures::stream::iter(services.into_iter().filter(|s| s.name != exclude))
        .map(|service| async move {
            let reference = ServiceRef {
                cluster_arn: cluster_arn.to_owned(),
                service_name: service.name.clone(),
            };
            (
                service.name,
                state.ecs.describe_service(ctx, &reference).await,
            )
        })
        .buffer_unordered(TOPIC_SCAN_PARALLEL)
        .collect()
        .await;

    let mut links = Vec::new();
    // A service that can't be described is skipped: the others still count.
    for (service, detail) in details {
        let Ok(detail) = detail else { continue };
        let containers = detail
            .task_definition
            .map(|t| t.containers)
            .unwrap_or_default();
        for routes in containers.into_iter().filter_map(|c| c.routes) {
            for route in routes.routes {
                let Some(topic) = route.topic.filter(|t| topics.contains(t)) else {
                    continue;
                };
                let direction = if route.input.is_some() {
                    TopicDirection::In
                } else {
                    TopicDirection::Out
                };
                links.push(TopicLink {
                    topic,
                    service: service.clone(),
                    direction,
                });
            }
        }
    }
    links.sort_by(|a, b| (&a.topic, &a.service).cmp(&(&b.topic, &b.service)));
    Ok(links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finds_the_other_side_of_a_topic() {
        let state = AppState::demo();
        let ctx = AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        };
        let cluster = "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-edge";
        let links = find_topic_links(
            &state,
            &ctx,
            cluster,
            &["demo.events".into()],
            "event-ingest",
        )
        .await
        .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].service, "legacy-gateway");
        assert_eq!(links[0].direction, TopicDirection::Out);
    }
}
