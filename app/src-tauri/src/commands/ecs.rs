//! Clusters, services and tasks (read-only).

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{ClusterSummary, ServiceDetail, ServiceRef, ServiceSummary, Task};
use contrail_core::routes::Endpoint;
use tauri::State;

use crate::error::ApiResult;
use crate::route_index::{ClusterRoutes, ServiceRoutes};
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

/// A route of a service of the cluster: the topic it writes or reads, and its other end.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicLink {
    pub topic: String,
    pub service: String,
    /// The service brings data in to the topic (input route) or takes it out (output route).
    pub direction: TopicDirection,
    /// The consumer group of an output route.
    pub group: Option<String>,
    /// The route is switched on.
    pub enabled: bool,
    /// Where that service's route gets its data from (input) or sends it to (outputs): type,
    /// system and whether it is on. Their properties are left out; the graph doesn't show them.
    pub endpoints: Vec<Endpoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TopicDirection {
    In,
    Out,
}

/// Where `services_on_topics` gets the cluster's routes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TopicScan {
    /// Only from an earlier scan this session: no AWS call, nothing when there was none.
    Cached,
    /// Scans the cluster again and keeps the result for the session.
    Fresh,
}

/// How many task definitions are read at the same time when scanning a cluster.
const TOPIC_SCAN_PARALLEL: usize = 5;

/// The services of `cluster_arn` whose routes use one of `topics` (except `exclude`). `None`
/// when only the cache was asked and the cluster wasn't scanned yet.
#[tauri::command]
#[specta::specta]
pub async fn services_on_topics(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
    topics: Vec<String>,
    exclude: String,
    scan: TopicScan,
) -> ApiResult<Option<Vec<TopicLink>>> {
    find_topic_links(&state, &ctx, &cluster_arn, Some(&topics), &exclude, scan).await
}

/// Every route of every service of `cluster_arn`, for the cluster's route map. `None` when only
/// the cache was asked and the cluster wasn't scanned yet (the scan is the same as for
/// `services_on_topics`, so either one fills the cache for the other).
#[tauri::command]
#[specta::specta]
pub async fn cluster_routes(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
    scan: TopicScan,
) -> ApiResult<Option<Vec<TopicLink>>> {
    find_topic_links(&state, &ctx, &cluster_arn, None, "", scan).await
}

/// The links of the cluster's services on `topics` (all topics with `None`), except `exclude`'s.
async fn find_topic_links(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
    topics: Option<&[String]>,
    exclude: &str,
    scan: TopicScan,
) -> ApiResult<Option<Vec<TopicLink>>> {
    let cluster = match scan {
        TopicScan::Cached => state.routes.get(ctx, cluster_arn),
        TopicScan::Fresh => {
            let routes = scan_cluster(state, ctx, cluster_arn).await?;
            Some(state.routes.insert(ctx, cluster_arn, routes))
        }
    };
    Ok(cluster.map(|cluster| topic_links(&cluster, topics, exclude)))
}

/// The routes of all services of the cluster: one batched listing, then each service's task
/// definition (cached by ARN, so a second scan only lists the services again).
async fn scan_cluster(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
) -> ApiResult<ClusterRoutes> {
    use futures::StreamExt;

    let services = state.ecs.list_services(ctx, cluster_arn).await?;
    let mut found: ClusterRoutes = futures::stream::iter(services)
        .map(|service| async move {
            let definition = state
                .ecs
                .task_definition(ctx, &service.task_definition_arn)
                .await;
            (service.name, definition)
        })
        .buffer_unordered(TOPIC_SCAN_PARALLEL)
        .filter_map(|(service, definition)| async move {
            // A service whose task definition can't be read is skipped: the others still count.
            let definition = definition
                .inspect_err(|err| tracing::warn!(%service, %err, "skipping service in topic scan"))
                .ok()?;
            let routes: Vec<_> = definition
                .containers
                .into_iter()
                .filter_map(|c| c.routes)
                .flat_map(|r| r.routes)
                .collect();
            (!routes.is_empty()).then_some(ServiceRoutes { service, routes })
        })
        .collect()
        .await;
    found.sort_by(|a, b| a.service.cmp(&b.service));
    Ok(found)
}

/// The routes of the cluster's services (but `exclude`) on one of `topics` (all with `None`),
/// sorted by topic and service.
fn topic_links(
    cluster: &ClusterRoutes,
    topics: Option<&[String]>,
    exclude: &str,
) -> Vec<TopicLink> {
    let mut links = Vec::new();
    for ServiceRoutes { service, routes } in cluster.iter().filter(|s| s.service != exclude) {
        for route in routes {
            let wanted = |t: &&String| topics.is_none_or(|topics| topics.contains(t));
            let Some(topic) = route.topic.as_ref().filter(wanted) else {
                continue;
            };
            let (direction, endpoints) = match &route.input {
                Some(input) => (TopicDirection::In, std::slice::from_ref(input)),
                None => (TopicDirection::Out, route.outputs.as_slice()),
            };
            links.push(TopicLink {
                topic: topic.clone(),
                service: service.clone(),
                direction,
                group: route.group.clone(),
                enabled: route.enabled,
                endpoints: endpoints
                    .iter()
                    .map(|e| Endpoint {
                        properties: Vec::new(),
                        ..e.clone()
                    })
                    .collect(),
            });
        }
    }
    links.sort_by(|a, b| (&a.topic, &a.service).cmp(&(&b.topic, &b.service)));
    links
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use contrail_core::ecs::{EcsSource, TaskDefinitionInfo};
    use contrail_core::error::SourceError;

    use super::*;

    const EDGE: &str = "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-edge";

    fn ctx() -> AwsCtx {
        AwsCtx {
            profile: "demo-dev".into(),
            region: None,
        }
    }

    #[tokio::test]
    async fn finds_the_other_side_of_a_topic() {
        let state = AppState::demo();
        let links = find_topic_links(
            &state,
            &ctx(),
            EDGE,
            Some(&["demo.events".into()]),
            "event-ingest",
            TopicScan::Fresh,
        )
        .await
        .unwrap()
        .unwrap();
        let found: Vec<_> = links
            .iter()
            .map(|l| (l.service.as_str(), l.direction, l.group.as_deref()))
            .collect();
        assert_eq!(
            found,
            [
                (
                    "audit-archiver",
                    TopicDirection::Out,
                    Some("audit-archiver")
                ),
                (
                    "legacy-gateway",
                    TopicDirection::Out,
                    Some("legacy-gateway")
                ),
                // Another input service writing the same topic.
                ("partner-poller", TopicDirection::In, None),
            ]
        );
        // Their targets come along (for the graph's next column), without their settings.
        let systems: Vec<_> = links[0]
            .endpoints
            .iter()
            .map(|e| e.system.as_deref())
            .collect();
        assert_eq!(systems, [Some("Audit Archive"), Some("Search Index")]);
        assert!(links[0].endpoints.iter().all(|e| e.properties.is_empty()));
    }

    /// The demo ECS source, recording which calls reach it.
    struct Counting {
        inner: contrail_fake::FakeEcs,
        calls: Mutex<Vec<&'static str>>,
    }

    impl Counting {
        fn take(&self) -> Vec<&'static str> {
            std::mem::take(&mut self.calls.lock().unwrap())
        }

        fn record(&self, call: &'static str) {
            self.calls.lock().unwrap().push(call);
        }
    }

    #[async_trait]
    impl EcsSource for Counting {
        async fn list_clusters(&self, ctx: &AwsCtx) -> Result<Vec<ClusterSummary>, SourceError> {
            self.record("list_clusters");
            self.inner.list_clusters(ctx).await
        }

        async fn list_services(
            &self,
            ctx: &AwsCtx,
            cluster_arn: &str,
        ) -> Result<Vec<ServiceSummary>, SourceError> {
            self.record("list_services");
            self.inner.list_services(ctx, cluster_arn).await
        }

        async fn describe_service(
            &self,
            ctx: &AwsCtx,
            service: &ServiceRef,
        ) -> Result<ServiceDetail, SourceError> {
            self.record("describe_service");
            self.inner.describe_service(ctx, service).await
        }

        async fn task_definition(
            &self,
            ctx: &AwsCtx,
            arn: &str,
        ) -> Result<TaskDefinitionInfo, SourceError> {
            self.record("task_definition");
            self.inner.task_definition(ctx, arn).await
        }

        async fn list_tasks(
            &self,
            ctx: &AwsCtx,
            service: &ServiceRef,
            include_stopped: bool,
        ) -> Result<Vec<Task>, SourceError> {
            self.record("list_tasks");
            self.inner.list_tasks(ctx, service, include_stopped).await
        }
    }

    #[tokio::test]
    async fn the_route_map_gets_every_route_of_the_cluster() {
        let state = AppState::demo();
        let links = find_topic_links(&state, &ctx(), EDGE, None, "", TopicScan::Fresh)
            .await
            .unwrap()
            .unwrap();
        let topics: std::collections::BTreeSet<_> =
            links.iter().map(|l| l.topic.as_str()).collect();
        assert!(topics.contains("demo.events") && topics.contains("orders.created"));
        // Every route service, the transformer (no route variables) not among them.
        let services: std::collections::BTreeSet<_> =
            links.iter().map(|l| l.service.as_str()).collect();
        assert_eq!(
            services.into_iter().collect::<Vec<_>>(),
            [
                "audit-archiver",
                "event-ingest",
                "legacy-gateway",
                "partner-poller",
                "search-feeder"
            ]
        );
    }

    #[tokio::test]
    async fn a_scan_is_kept_for_the_whole_cluster_until_the_next_one() {
        let mut state = AppState::demo();
        let auth = Arc::new(contrail_fake::FakeAuth::new());
        let ecs = Arc::new(Counting {
            inner: contrail_fake::FakeEcs::new(auth),
            calls: Mutex::default(),
        });
        state.ecs = ecs.clone();
        let links = |exclude: &'static str, scan| {
            let state = &state;
            async move {
                find_topic_links(
                    state,
                    &ctx(),
                    EDGE,
                    Some(&["demo.events".into()]),
                    exclude,
                    scan,
                )
                .await
                .unwrap()
            }
        };

        // Nothing scanned yet: the cache alone has nothing and asks nobody.
        assert_eq!(links("event-ingest", TopicScan::Cached).await, None);
        assert!(ecs.take().is_empty());

        // A scan lists the services once, then reads each one's task definition.
        let fresh = links("event-ingest", TopicScan::Fresh).await.unwrap();
        let calls = ecs.take();
        assert_eq!(calls[0], "list_services");
        assert!(calls[1..].iter().all(|&c| c == "task_definition"));
        assert_eq!(calls.len(), 1 + 6, "one listing, six task definitions");

        // Another service of the cluster (the next one through the graph) needs no call.
        let cached = links("legacy-gateway", TopicScan::Cached).await.unwrap();
        assert!(ecs.take().is_empty());
        assert!(cached.iter().any(|l| l.service == "event-ingest"));
        assert!(cached.iter().all(|l| l.service != "legacy-gateway"));
        // And back to the first one.
        assert_eq!(links("event-ingest", TopicScan::Cached).await, Some(fresh));
        assert!(ecs.take().is_empty());

        // Scanning again lists the services again.
        links("event-ingest", TopicScan::Fresh).await.unwrap();
        assert_eq!(ecs.take()[0], "list_services");
    }
}
