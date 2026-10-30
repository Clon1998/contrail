//! Clusters, services and tasks (read-only).

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{
    ClusterSummary, ServiceDetail, ServiceRef, ServiceSummary, ServiceUpdate, Task,
};
use contrail_core::logs::{StreamSelection, TimeRange, process, resolve_log_location};
use contrail_core::routes::{Endpoint, RouteProperty};
use contrail_core::timestamp::Timestamp;
use contrail_core::topology::{ConsumedTopic, STARTUP_PHRASES, startup_topology as read_startup};
use tauri::State;
use time::{Duration, OffsetDateTime};

use crate::error::{ApiError, ApiResult, ErrorCode};
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

/// The longest stop reason ECS accepts.
const MAX_STOP_REASON: usize = 255;

/// Refuses unless the user allows changes to AWS (a setting, off by default): Contrail stays
/// read-only until then, whatever the UI asks for.
fn changes_allowed(state: &AppState) -> ApiResult<()> {
    if state.prefs.get().settings.allow_changes {
        Ok(())
    } else {
        Err(ApiError::new(
            ErrorCode::ChangesDisabled,
            "Changes to AWS are switched off",
        )
        .with_hint("Settings → AWS → Allow changes to AWS."))
    }
}

/// Stops tasks of a cluster (one at a time, stopping at the first that fails), with `reason`
/// as the stop reason ECS records.
#[tauri::command]
#[specta::specta]
pub async fn stop_tasks(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
    task_ids: Vec<String>,
    reason: String,
) -> ApiResult<()> {
    stop_tasks_of(&state, &ctx, &cluster_arn, &task_ids, &reason).await
}

async fn stop_tasks_of(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
    task_ids: &[String],
    reason: &str,
) -> ApiResult<()> {
    changes_allowed(state)?;
    let reason = match reason.trim() {
        "" => "Stopped in Contrail",
        reason => reason,
    };
    // At most 255 characters, cut at a character boundary (`chars`, not bytes).
    let reason: String = reason.chars().take(MAX_STOP_REASON).collect();
    for task_id in task_ids {
        state
            .changes
            .stop_task(ctx, cluster_arn, task_id, &reason)
            .await?;
    }
    Ok(())
}

/// Changes a service's desired count and/or task definition, or starts a new deployment (the
/// console's quick update).
#[tauri::command]
#[specta::specta]
pub async fn update_service(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    service: ServiceRef,
    update: ServiceUpdate,
) -> ApiResult<()> {
    update_service_of(&state, &ctx, &service, &update).await
}

async fn update_service_of(
    state: &AppState,
    ctx: &AwsCtx,
    service: &ServiceRef,
    update: &ServiceUpdate,
) -> ApiResult<()> {
    changes_allowed(state)?;
    if update.is_empty() {
        return Err(ApiError::new(ErrorCode::InvalidInput, "nothing to change"));
    }
    Ok(state.changes.update_service(ctx, service, update).await?)
}

/// The revisions of a task definition family a quick update can deploy, newest first.
#[tauri::command]
#[specta::specta]
pub async fn task_definition_revisions(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    family: String,
) -> ApiResult<Vec<String>> {
    Ok(state.ecs.task_definition_revisions(&ctx, &family).await?)
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
    /// The topic is a plain Kafka topic (an output route with `rawTopic`), not the framework's
    /// integration topic `integration.<topic>`.
    pub raw: bool,
    /// The route is switched on.
    pub enabled: bool,
    /// Where that service's route gets its data from (input) or sends it to (outputs): type,
    /// system, whether it is on and its settings (for the map's details and search). Values of
    /// secrets are left out (see [`RouteProperty::masked`]): they never reach the UI.
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

/// What a service of the cluster reads and writes according to its startup lines.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTopology {
    pub service: String,
    /// The revision (`family:revision`) whose task was read.
    pub task_definition: String,
    /// The task whose log stream the lines came from, and when it started.
    pub task_id: String,
    pub started_at: Timestamp,
    pub reads: Vec<ConsumedTopic>,
    pub writes: Vec<String>,
}

/// How long after a task's start its startup lines are looked for.
const STARTUP_WINDOW: Duration = Duration::minutes(15);
/// At most this many events are read from that window per phrase of [`STARTUP_PHRASES`].
const STARTUP_EVENTS: usize = 1_000;

/// The topics the cluster's services without route variables (transformers) read and write,
/// from the lines the framework logs when they start. `None` when only the cache was asked and
/// the cluster wasn't scanned yet. Services that logged no such lines are left out.
#[tauri::command]
#[specta::specta]
pub async fn startup_topology(
    state: State<'_, AppState>,
    ctx: AwsCtx,
    cluster_arn: String,
    scan: TopicScan,
) -> ApiResult<Option<Vec<ServiceTopology>>> {
    find_startup_topology(&state, &ctx, &cluster_arn, scan).await
}

pub(crate) async fn find_startup_topology(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
    scan: TopicScan,
) -> ApiResult<Option<Vec<ServiceTopology>>> {
    let found = match scan {
        TopicScan::Cached => state.topology.clusters.get(ctx, cluster_arn),
        TopicScan::Fresh => {
            let found = scan_startup_topology(state, ctx, cluster_arn).await?;
            Some(state.topology.clusters.insert(ctx, cluster_arn, found))
        }
    };
    Ok(found.map(|found| found.to_vec()))
}

/// Reads the startup lines of every service of the cluster that has no routes in its env vars.
async fn scan_startup_topology(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
) -> ApiResult<Vec<ServiceTopology>> {
    use futures::StreamExt;

    let routes = match state.routes.get(ctx, cluster_arn) {
        Some(routes) => routes,
        None => {
            let routes = scan_cluster(state, ctx, cluster_arn).await?;
            state.routes.insert(ctx, cluster_arn, routes)
        }
    };
    let services = state.ecs.list_services(ctx, cluster_arn).await?;
    let mut found: Vec<ServiceTopology> = futures::stream::iter(
        services
            .into_iter()
            .filter(|s| !routes.iter().any(|r| r.service == s.name)),
    )
    .map(|service| async move {
        let found = service_topology(state, ctx, cluster_arn, &service).await;
        (service.name, found)
    })
    .buffer_unordered(TOPIC_SCAN_PARALLEL)
    .filter_map(|(service, found)| async move {
        // A service whose logs can't be read is skipped: the others still count.
        found
            .inspect_err(|err| tracing::warn!(%service, err = %err.message, "skipping service in topology scan"))
            .ok()
            .flatten()
    })
    .collect()
    .await;
    found.sort_by(|a, b| a.service.cmp(&b.service));
    Ok(found)
}

/// The startup lines of the most recently started task of the service's current revision, read
/// once per revision. `None` if they say nothing (not a framework app, or the start of the
/// stream is past the log group's retention).
async fn service_topology(
    state: &AppState,
    ctx: &AwsCtx,
    cluster_arn: &str,
    service: &ServiceSummary,
) -> ApiResult<Option<ServiceTopology>> {
    if let Some(known) = state.topology.revision(&service.task_definition_arn) {
        // Two services can run the same revision.
        return Ok(Some(ServiceTopology {
            service: service.name.clone(),
            ..known
        }));
    }
    let service_ref = ServiceRef {
        cluster_arn: cluster_arn.to_owned(),
        service_name: service.name.clone(),
    };
    let tasks = state.ecs.list_tasks(ctx, &service_ref, true).await?;
    let Some((task, started)) = tasks
        .iter()
        .filter(|t| t.task_definition == service.task_definition)
        .filter_map(|t| Some((t, t.started_at?)))
        .max_by_key(|(_, started)| *started)
    else {
        return Ok(None);
    };
    let definition = state
        .ecs
        .task_definition(ctx, &service.task_definition_arn)
        .await?;
    let location = resolve_log_location(&definition)?;
    let range = TimeRange {
        start: started,
        end: Timestamp((started.0 + STARTUP_WINDOW).min(OffsetDateTime::now_utc())),
    };
    // One search per phrase: a filter pattern matches one phrase, and the lines have different
    // ones ("Creating …" consumers, "Starting FrameworkProducer …").
    let mut raw = Vec::new();
    for phrase in STARTUP_PHRASES {
        let selection = StreamSelection {
            filter_pattern: Some(phrase.to_owned()),
            ..location.selection(std::slice::from_ref(task), None, false)
        };
        let backfill = state
            .logs
            .backfill(ctx, &selection, range, STARTUP_EVENTS)
            .await?;
        raw.extend(backfill.events);
    }
    raw.sort_by_key(|e| e.timestamp);
    let events = process(raw);
    let topology = read_startup(events.iter().map(|e| e.line.message.as_str()));
    if topology.is_empty() {
        return Ok(None);
    }
    let found = ServiceTopology {
        service: service.name.clone(),
        task_definition: service.task_definition.clone(),
        task_id: task.id.clone(),
        started_at: started,
        reads: topology.reads,
        writes: topology.writes,
    };
    state
        .topology
        .insert_revision(&service.task_definition_arn, found.clone());
    Ok(Some(found))
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
                raw: route.input.is_none() && route.raw_topic,
                enabled: route.enabled,
                endpoints: endpoints
                    .iter()
                    .map(|e| Endpoint {
                        properties: e.properties.iter().map(RouteProperty::masked).collect(),
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
    async fn changes_refuse_until_the_setting_allows_them() {
        let state = AppState::demo();
        let core = "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core";
        let orders = ServiceRef {
            cluster_arn: core.into(),
            service_name: "orders-api".into(),
        };
        let task = state.ecs.list_tasks(&ctx(), &orders, false).await.unwrap()[0]
            .id
            .clone();
        let scale = ServiceUpdate {
            desired_count: Some(1),
            task_definition: None,
            force_new_deployment: false,
        };

        // Off by default: nothing reaches ECS.
        let refused = stop_tasks_of(&state, &ctx(), core, std::slice::from_ref(&task), "")
            .await
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::ChangesDisabled);
        let refused = update_service_of(&state, &ctx(), &orders, &scale)
            .await
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::ChangesDisabled);
        let running = state.ecs.list_tasks(&ctx(), &orders, false).await.unwrap();
        assert!(running.iter().any(|t| t.id == task), "still running");

        state
            .prefs
            .update(|p| p.settings.allow_changes = true)
            .unwrap();
        stop_tasks_of(&state, &ctx(), core, std::slice::from_ref(&task), "  ")
            .await
            .unwrap();
        let all = state.ecs.list_tasks(&ctx(), &orders, true).await.unwrap();
        let stopped = all.iter().find(|t| t.id == task).unwrap();
        assert_eq!(
            stopped.stopped_reason.as_deref(),
            Some("Task stopped by user: Stopped in Contrail"),
            "an empty reason gets a default"
        );
        update_service_of(&state, &ctx(), &orders, &scale)
            .await
            .unwrap();
        let detail = state.ecs.describe_service(&ctx(), &orders).await.unwrap();
        assert_eq!(detail.summary.desired, 1);

        let nothing = ServiceUpdate {
            desired_count: None,
            task_definition: None,
            force_new_deployment: false,
        };
        let refused = update_service_of(&state, &ctx(), &orders, &nothing)
            .await
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidInput);
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
        // Their targets come along (for the graph's next column), with their settings.
        let systems: Vec<_> = links[0]
            .endpoints
            .iter()
            .map(|e| e.system.as_deref())
            .collect();
        assert_eq!(systems, [Some("Audit Archive"), Some("Search Index")]);
        assert!(links[0].endpoints.iter().all(|e| !e.properties.is_empty()));
        // A password in a plain variable is left out; the other settings are there.
        let gateway = links
            .iter()
            .find(|l| l.service == "legacy-gateway")
            .unwrap();
        let settings: Vec<_> = gateway
            .endpoints
            .iter()
            .flat_map(|e| &e.properties)
            .map(|p| (p.key.as_str(), p.value.as_str()))
            .collect();
        assert!(settings.contains(&("password", "")), "{settings:?}");
        assert!(settings.contains(&("url", "https://api.example.com/in")));
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

        async fn task_definition_revisions(
            &self,
            ctx: &AwsCtx,
            family: &str,
        ) -> Result<Vec<String>, SourceError> {
            self.record("task_definition_revisions");
            self.inner.task_definition_revisions(ctx, family).await
        }
    }

    #[tokio::test]
    async fn transformers_are_found_from_their_startup_lines() {
        let state = AppState::demo();
        assert_eq!(
            find_startup_topology(&state, &ctx(), EDGE, TopicScan::Cached)
                .await
                .unwrap(),
            None,
            "nothing scanned yet"
        );
        let found = find_startup_topology(&state, &ctx(), EDGE, TopicScan::Fresh)
            .await
            .unwrap()
            .unwrap();
        // Only the service without route variables; route services are left alone.
        let [enricher] = found.as_slice() else {
            panic!("expected only event-enricher, got {found:?}");
        };
        assert_eq!(enricher.service, "event-enricher");
        assert_eq!(enricher.writes, ["integration.demo.events.enriched"]);
        let reads: Vec<_> = enricher
            .reads
            .iter()
            .map(|r| (r.topic.as_str(), r.group.as_deref(), r.concurrency))
            .collect();
        assert_eq!(
            reads,
            [("integration.demo.events", Some("event-enricher"), Some(3))]
        );
        assert!(enricher.task_definition.starts_with("event-enricher:"));
        // The same result from the cache.
        assert_eq!(
            find_startup_topology(&state, &ctx(), EDGE, TopicScan::Cached)
                .await
                .unwrap(),
            Some(found)
        );
    }

    #[tokio::test]
    async fn a_revisions_startup_lines_are_read_once() {
        let mut state = AppState::demo();
        let ecs = Arc::new(Counting {
            inner: contrail_fake::FakeEcs::new(Arc::new(contrail_fake::FakeAuth::new())),
            calls: Mutex::default(),
        });
        state.ecs = ecs.clone();
        let first = find_startup_topology(&state, &ctx(), EDGE, TopicScan::Fresh)
            .await
            .unwrap();
        assert!(ecs.take().contains(&"list_tasks"));
        // Scanning again lists the services, but the revision didn't change: no task is read.
        let again = find_startup_topology(&state, &ctx(), EDGE, TopicScan::Fresh)
            .await
            .unwrap();
        assert_eq!(ecs.take(), ["list_services"]);
        assert_eq!(first, again);
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
