//! A fake [`EcsSource`]: a fixed demo landscape of clusters, services and tasks.
//!
//! - `demo-core`: `orders-api` (healthy), `payments-worker` (crash-looping, stopped tasks),
//!   `billing-sync` (deployment in progress)
//! - `demo-edge`: `legacy-gateway` (EC2, plain-text logs), `event-ingest` (high volume)
//! - `demo-batch`: no services
//!
//! All names, IDs and ARNs are invented. Times are relative to "now".

use std::sync::Arc;

use async_trait::async_trait;
use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{
    ClusterSummary, ContainerDefinitionInfo, ContainerState, Deployment, EcsSource, ServiceDetail,
    ServiceEvent, ServiceRef, ServiceSummary, Task, TaskDefinitionInfo, sort_tasks,
};
use contrail_core::error::SourceError;
use contrail_core::timestamp::Timestamp;
use time::{Duration, OffsetDateTime};

use crate::FakeAuth;

const DEFAULT_REGION: &str = "eu-central-1";

/// A stopped task of a demo service.
struct StoppedSpec {
    minutes_ago: i64,
    stop_code: &'static str,
    reason: &'static str,
    exit_code: Option<i32>,
    container_reason: Option<&'static str>,
}

/// One demo service, described compactly; [`FakeEcs`] expands it into ECS shapes.
struct ServiceSpec {
    cluster: &'static str,
    name: &'static str,
    revision: u32,
    image_tag: &'static str,
    launch_type: &'static str,
    cpu: &'static str,
    memory: &'static str,
    desired: u32,
    /// Running tasks of the primary deployment and their health.
    running: &'static [&'static str],
    pending: u32,
    /// An older deployment still running tasks (a rollout in progress): revision, running.
    previous: Option<(u32, u32)>,
    stopped: &'static [StoppedSpec],
    events: &'static [&'static str],
}

const SERVICES: &[ServiceSpec] = &[
    ServiceSpec {
        cluster: "demo-core",
        name: "orders-api",
        revision: 42,
        image_tag: "1.14.2",
        launch_type: "FARGATE",
        cpu: "512",
        memory: "1024",
        desired: 3,
        running: &["HEALTHY", "HEALTHY", "HEALTHY"],
        pending: 0,
        previous: None,
        stopped: &[StoppedSpec {
            minutes_ago: 50,
            stop_code: "ServiceSchedulerInitiated",
            reason: "Scaling activity initiated by (deployment ecs-svc/1111111111111111111)",
            exit_code: Some(143),
            container_reason: None,
        }],
        events: &["has reached a steady state."],
    },
    ServiceSpec {
        cluster: "demo-core",
        name: "payments-worker",
        revision: 17,
        image_tag: "2.3.0",
        launch_type: "FARGATE",
        cpu: "1024",
        memory: "2048",
        desired: 2,
        running: &["UNKNOWN"],
        pending: 1,
        previous: None,
        stopped: &[
            StoppedSpec {
                minutes_ago: 2,
                stop_code: "EssentialContainerExited",
                reason: "Essential container in task exited",
                exit_code: Some(1),
                container_reason: None,
            },
            StoppedSpec {
                minutes_ago: 9,
                stop_code: "EssentialContainerExited",
                reason: "Essential container in task exited",
                exit_code: Some(1),
                container_reason: None,
            },
            StoppedSpec {
                minutes_ago: 17,
                stop_code: "TaskFailedToStart",
                reason: "CannotPullContainerError: pull image manifest has been retried 5 time(s)",
                exit_code: None,
                container_reason: Some("CannotPullContainerError: ref not found"),
            },
        ],
        events: &[
            "has started 1 tasks: (task 0f3a).",
            "has stopped 1 running tasks: (task 9c1d).",
            "has started 1 tasks: (task 7b2e).",
        ],
    },
    ServiceSpec {
        cluster: "demo-core",
        name: "billing-sync",
        revision: 8,
        image_tag: "0.9.0",
        launch_type: "FARGATE",
        cpu: "256",
        memory: "512",
        desired: 2,
        running: &["HEALTHY"],
        pending: 1,
        previous: Some((7, 2)),
        stopped: &[],
        events: &[
            "has started 1 tasks: (task 5e6f).",
            "updated computedDesiredCount for taskSet ecs-svc/2222222222222222222 to 2.",
        ],
    },
    ServiceSpec {
        cluster: "demo-edge",
        name: "legacy-gateway",
        revision: 113,
        image_tag: "2021.11",
        launch_type: "EC2",
        cpu: "256",
        memory: "768",
        desired: 2,
        running: &["UNKNOWN", "UNKNOWN"],
        pending: 0,
        previous: None,
        stopped: &[],
        events: &["has reached a steady state."],
    },
    ServiceSpec {
        cluster: "demo-edge",
        name: "event-ingest",
        revision: 5,
        image_tag: "3.0.1",
        launch_type: "FARGATE",
        cpu: "2048",
        memory: "4096",
        desired: 6,
        running: &[
            "HEALTHY", "HEALTHY", "HEALTHY", "HEALTHY", "HEALTHY", "HEALTHY",
        ],
        pending: 0,
        previous: None,
        stopped: &[],
        events: &["has reached a steady state."],
    },
];

const CLUSTERS: &[&str] = &["demo-batch", "demo-core", "demo-edge"];

/// Demo ECS data. Shares the session state of [`FakeAuth`]: an expired demo profile can't list
/// anything until it has "logged in", just like with real AWS.
pub struct FakeEcs {
    auth: Arc<FakeAuth>,
}

impl FakeEcs {
    pub fn new(auth: Arc<FakeAuth>) -> Self {
        Self { auth }
    }

    /// Account ID and region for ARNs; fails like AWS does for unusable credentials.
    fn account(&self, ctx: &AwsCtx) -> Result<(String, String), SourceError> {
        let account = self.auth.check_credentials(&ctx.profile)?;
        let region = ctx
            .region
            .clone()
            .unwrap_or_else(|| DEFAULT_REGION.to_owned());
        Ok((account, region))
    }
}

fn cluster_arn(region: &str, account: &str, cluster: &str) -> String {
    format!("arn:aws:ecs:{region}:{account}:cluster/{cluster}")
}

fn find_service(service: &ServiceRef) -> Result<&'static ServiceSpec, SourceError> {
    let cluster = contrail_core::ecs::name_from_arn(&service.cluster_arn);
    SERVICES
        .iter()
        .find(|s| s.cluster == cluster && s.name == service.service_name)
        .ok_or_else(|| SourceError::NotFound(format!("service {}", service.service_name)))
}

/// A stable, ECS-looking 32-character hex ID derived from `seed` (FNV-1a hash).
fn hex_id(seed: &str) -> String {
    let mut out = String::with_capacity(32);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for round in 0u8..2 {
        for byte in seed.bytes().chain([round]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        out.push_str(&format!("{hash:016x}"));
    }
    out
}

fn ago(minutes: i64) -> Option<Timestamp> {
    Some(Timestamp(
        OffsetDateTime::now_utc() - Duration::minutes(minutes),
    ))
}

fn summary(spec: &ServiceSpec, region: &str, account: &str) -> ServiceSummary {
    let previous_running = spec.previous.map_or(0, |(_, running)| running);
    ServiceSummary {
        arn: format!(
            "arn:aws:ecs:{region}:{account}:service/{}/{}",
            spec.cluster, spec.name
        ),
        name: spec.name.to_owned(),
        cluster_arn: cluster_arn(region, account, spec.cluster),
        status: "ACTIVE".to_owned(),
        desired: spec.desired,
        running: spec.running.len() as u32 + previous_running,
        pending: spec.pending,
        launch_type: Some(spec.launch_type.to_owned()),
        task_definition: format!("{}:{}", spec.name, spec.revision),
    }
}

fn image(spec: &ServiceSpec, account: &str, region: &str) -> String {
    format!(
        "{account}.dkr.ecr.{region}.amazonaws.com/{}:{}",
        spec.name, spec.image_tag
    )
}

#[async_trait]
impl EcsSource for FakeEcs {
    async fn list_clusters(&self, ctx: &AwsCtx) -> Result<Vec<ClusterSummary>, SourceError> {
        let (account, region) = self.account(ctx)?;
        Ok(CLUSTERS
            .iter()
            .map(|&name| {
                let services = SERVICES.iter().filter(|s| s.cluster == name);
                ClusterSummary {
                    arn: cluster_arn(&region, &account, name),
                    name: name.to_owned(),
                    status: "ACTIVE".to_owned(),
                    active_services: services.clone().count() as u32,
                    running_tasks: services
                        .clone()
                        .map(|s| s.running.len() as u32 + s.previous.map_or(0, |p| p.1))
                        .sum(),
                    pending_tasks: services.map(|s| s.pending).sum(),
                }
            })
            .collect())
    }

    async fn list_services(
        &self,
        ctx: &AwsCtx,
        cluster_arn: &str,
    ) -> Result<Vec<ServiceSummary>, SourceError> {
        let (account, region) = self.account(ctx)?;
        let cluster = contrail_core::ecs::name_from_arn(cluster_arn);
        if !CLUSTERS.contains(&cluster) {
            return Err(SourceError::NotFound(format!("cluster {cluster}")));
        }
        let mut services: Vec<ServiceSummary> = SERVICES
            .iter()
            .filter(|s| s.cluster == cluster)
            .map(|s| summary(s, &region, &account))
            .collect();
        services.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(services)
    }

    async fn describe_service(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
    ) -> Result<ServiceDetail, SourceError> {
        let (account, region) = self.account(ctx)?;
        let spec = find_service(service)?;
        let task_definition = format!("{}:{}", spec.name, spec.revision);

        let in_progress = spec.previous.is_some();
        let mut deployments = vec![Deployment {
            id: format!("ecs-svc/{}", &hex_id(&task_definition)[..19]),
            status: "PRIMARY".to_owned(),
            rollout_state: Some(
                if in_progress {
                    "IN_PROGRESS"
                } else {
                    "COMPLETED"
                }
                .to_owned(),
            ),
            rollout_reason: Some(
                if in_progress {
                    "ECS deployment ecs-svc in progress."
                } else {
                    "ECS deployment ecs-svc completed."
                }
                .to_owned(),
            ),
            task_definition: task_definition.clone(),
            desired: spec.desired,
            running: spec.running.len() as u32,
            pending: spec.pending,
            failed: spec
                .stopped
                .iter()
                .filter(|s| s.stop_code != "ServiceSchedulerInitiated")
                .count() as u32,
            created_at: ago(if in_progress { 6 } else { 3 * 24 * 60 }),
            updated_at: ago(if in_progress { 1 } else { 3 * 24 * 60 - 5 }),
        }];
        if let Some((revision, running)) = spec.previous {
            let previous = format!("{}:{revision}", spec.name);
            deployments.push(Deployment {
                id: format!("ecs-svc/{}", &hex_id(&previous)[..19]),
                status: "ACTIVE".to_owned(),
                rollout_state: Some("COMPLETED".to_owned()),
                rollout_reason: None,
                task_definition: previous,
                desired: running,
                running,
                pending: 0,
                failed: 0,
                created_at: ago(9 * 24 * 60),
                updated_at: ago(6),
            });
        }

        let events = spec
            .events
            .iter()
            .enumerate()
            .map(|(i, message)| ServiceEvent {
                id: hex_id(&format!("{}-event-{i}", spec.name)),
                created_at: ago(i as i64 * 7 + 1),
                message: format!("(service {}) {message}", spec.name),
            })
            .collect();

        Ok(ServiceDetail {
            summary: summary(spec, &region, &account),
            created_at: ago(120 * 24 * 60),
            platform_version: (spec.launch_type == "FARGATE").then(|| "1.4.0".to_owned()),
            deployments,
            task_definition: Some(TaskDefinitionInfo {
                family: spec.name.to_owned(),
                revision: spec.revision,
                cpu: Some(spec.cpu.to_owned()),
                memory: Some(spec.memory.to_owned()),
                containers: vec![ContainerDefinitionInfo {
                    name: spec.name.to_owned(),
                    image: image(spec, &account, &region),
                    log_driver: Some("awslogs".to_owned()),
                }],
            }),
            events,
        })
    }

    async fn list_tasks(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
        include_stopped: bool,
    ) -> Result<Vec<Task>, SourceError> {
        let (account, region) = self.account(ctx)?;
        let spec = find_service(service)?;
        let zones = ["a", "b", "c"].map(|z| format!("{region}{z}"));

        let task = |key: &str, revision: u32, minutes_ago: i64| {
            let id = hex_id(&format!("{}-{key}", spec.name));
            Task {
                arn: format!("arn:aws:ecs:{region}:{account}:task/{}/{id}", spec.cluster),
                id: id.clone(),
                last_status: "RUNNING".to_owned(),
                desired_status: "RUNNING".to_owned(),
                health_status: None,
                created_at: ago(minutes_ago + 1),
                started_at: ago(minutes_ago),
                stopped_at: None,
                stop_code: None,
                stopped_reason: None,
                availability_zone: Some(zones[id.len() % 3].clone()),
                task_definition: format!("{}:{revision}", spec.name),
                launch_type: Some(spec.launch_type.to_owned()),
                containers: vec![ContainerState {
                    name: spec.name.to_owned(),
                    last_status: Some("RUNNING".to_owned()),
                    exit_code: None,
                    reason: None,
                    health_status: None,
                    image: Some(image(spec, &account, &region)),
                }],
            }
        };

        let mut tasks = Vec::new();
        for (i, health) in spec.running.iter().enumerate() {
            let mut t = task(&format!("run-{i}"), spec.revision, 30 + i as i64 * 45);
            t.availability_zone = Some(zones[i % 3].clone());
            t.health_status = Some((*health).to_owned());
            t.containers[0].health_status = Some((*health).to_owned());
            tasks.push(t);
        }
        for i in 0..spec.pending {
            let mut t = task(&format!("pending-{i}"), spec.revision, 0);
            t.last_status = "PENDING".to_owned();
            t.started_at = None;
            t.containers[0].last_status = Some("PENDING".to_owned());
            tasks.push(t);
        }
        if let Some((revision, running)) = spec.previous {
            for i in 0..running {
                let mut t = task(&format!("prev-{i}"), revision, 9 * 24 * 60 + i as i64);
                t.health_status = Some("HEALTHY".to_owned());
                tasks.push(t);
            }
        }
        if include_stopped {
            for (i, stopped) in spec.stopped.iter().enumerate() {
                let mut t = task(
                    &format!("stopped-{i}"),
                    spec.revision,
                    stopped.minutes_ago + 3,
                );
                t.last_status = "STOPPED".to_owned();
                t.desired_status = "STOPPED".to_owned();
                t.stopped_at = ago(stopped.minutes_ago);
                t.stop_code = Some(stopped.stop_code.to_owned());
                t.stopped_reason = Some(stopped.reason.to_owned());
                let container = &mut t.containers[0];
                container.last_status = Some("STOPPED".to_owned());
                container.exit_code = stopped.exit_code;
                container.reason = stopped.container_reason.map(str::to_owned);
                if stopped.stop_code == "TaskFailedToStart" {
                    t.started_at = None;
                }
                tasks.push(t);
            }
        }
        sort_tasks(&mut tasks);
        Ok(tasks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;

    fn fake() -> FakeEcs {
        FakeEcs::new(Arc::new(FakeAuth::with_login_delay(StdDuration::ZERO)))
    }

    fn ctx(profile: &str) -> AwsCtx {
        AwsCtx {
            profile: profile.to_owned(),
            region: None,
        }
    }

    fn service(cluster: &str, name: &str) -> ServiceRef {
        ServiceRef {
            cluster_arn: format!("arn:aws:ecs:eu-central-1:111122223333:cluster/{cluster}"),
            service_name: name.to_owned(),
        }
    }

    #[tokio::test]
    async fn lists_clusters_with_counts_and_account_arns() {
        let clusters = fake().list_clusters(&ctx("demo-dev")).await.unwrap();
        let names: Vec<&str> = clusters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["demo-batch", "demo-core", "demo-edge"]);
        let core = &clusters[1];
        assert_eq!(core.active_services, 3);
        assert_eq!(core.running_tasks, 3 + 1 + 1 + 2);
        assert_eq!(core.pending_tasks, 2);
        assert_eq!(
            core.arn,
            "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core"
        );
    }

    #[tokio::test]
    async fn expired_profiles_fail_like_aws() {
        let result = fake().list_clusters(&ctx("demo-prod")).await;
        assert!(matches!(result, Err(SourceError::Credentials { .. })));
    }

    #[tokio::test]
    async fn region_override_shows_in_arns() {
        let ctx = AwsCtx {
            profile: "demo-dev".into(),
            region: Some("us-west-2".into()),
        };
        let clusters = fake().list_clusters(&ctx).await.unwrap();
        assert!(clusters[0].arn.starts_with("arn:aws:ecs:us-west-2:"));
    }

    #[tokio::test]
    async fn crash_looping_service_has_stopped_tasks_with_reasons() {
        let ecs = fake();
        let svc = service("demo-core", "payments-worker");
        let running_only = ecs.list_tasks(&ctx("demo-dev"), &svc, false).await.unwrap();
        assert_eq!(running_only.len(), 2);
        assert!(running_only.iter().all(|t| t.last_status != "STOPPED"));

        let all = ecs.list_tasks(&ctx("demo-dev"), &svc, true).await.unwrap();
        let stopped: Vec<&Task> = all.iter().filter(|t| t.last_status == "STOPPED").collect();
        assert_eq!(stopped.len(), 3);
        assert_eq!(stopped[0].containers[0].exit_code, Some(1));
        assert_eq!(stopped[2].stop_code.as_deref(), Some("TaskFailedToStart"));
        // Running and pending first.
        assert_ne!(all[0].last_status, "STOPPED");
    }

    #[tokio::test]
    async fn rollout_in_progress_has_two_deployments() {
        let detail = fake()
            .describe_service(&ctx("demo-dev"), &service("demo-core", "billing-sync"))
            .await
            .unwrap();
        assert_eq!(detail.deployments.len(), 2);
        assert_eq!(
            detail.deployments[0].rollout_state.as_deref(),
            Some("IN_PROGRESS")
        );
        assert_eq!(detail.deployments[1].task_definition, "billing-sync:7");
        assert_eq!(detail.summary.running, 3);
        assert_eq!(
            detail.task_definition.unwrap().containers[0]
                .log_driver
                .as_deref(),
            Some("awslogs")
        );
    }

    #[tokio::test]
    async fn unknown_service_is_not_found() {
        let result = fake()
            .describe_service(&ctx("demo-dev"), &service("demo-core", "nope"))
            .await;
        assert_eq!(result, Err(SourceError::NotFound("service nope".into())));
    }

    #[test]
    fn hex_ids_are_stable_and_ecs_shaped() {
        let id = hex_id("orders-api-run-0");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, hex_id("orders-api-run-0"));
        assert_ne!(id, hex_id("orders-api-run-1"));
    }
}
