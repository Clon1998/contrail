//! ECS as Contrail shows it: clusters, services, deployments and tasks, plus the source port.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth::AwsCtx;
use crate::error::SourceError;
use crate::timestamp::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSummary {
    pub arn: String,
    pub name: String,
    /// `ACTIVE`, `PROVISIONING`, `INACTIVE`, …
    pub status: String,
    pub active_services: u32,
    pub running_tasks: u32,
    pub pending_tasks: u32,
}

/// Identifies a service: ECS service names are only unique within a cluster.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRef {
    pub cluster_arn: String,
    pub service_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSummary {
    pub arn: String,
    pub name: String,
    pub cluster_arn: String,
    /// `ACTIVE`, `DRAINING` or `INACTIVE`.
    pub status: String,
    pub desired: u32,
    pub running: u32,
    pub pending: u32,
    /// `FARGATE`, `EC2` or `EXTERNAL`; `None` when a capacity provider strategy decides.
    pub launch_type: Option<String>,
    /// The current task definition as `family:revision`.
    pub task_definition: String,
}

/// Everything the service overview shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetail {
    pub summary: ServiceSummary,
    pub created_at: Option<Timestamp>,
    pub platform_version: Option<String>,
    /// Newest first; the `PRIMARY` deployment is the one being rolled out (or done).
    pub deployments: Vec<Deployment>,
    /// The task definition of the primary deployment.
    pub task_definition: Option<TaskDefinitionInfo>,
    /// The most recent service events ("has reached a steady state", placement errors, …).
    pub events: Vec<ServiceEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub id: String,
    /// `PRIMARY`, `ACTIVE` (being replaced) or `INACTIVE`.
    pub status: String,
    /// `COMPLETED`, `IN_PROGRESS` or `FAILED`.
    pub rollout_state: Option<String>,
    pub rollout_reason: Option<String>,
    /// `family:revision`.
    pub task_definition: String,
    pub desired: u32,
    pub running: u32,
    pub pending: u32,
    pub failed: u32,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinitionInfo {
    pub family: String,
    pub revision: u32,
    /// CPU units and memory in MiB, as ECS reports them (strings, e.g. `"512"`).
    pub cpu: Option<String>,
    pub memory: Option<String>,
    pub containers: Vec<ContainerDefinitionInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDefinitionInfo {
    pub name: String,
    pub image: String,
    /// The image's tag (or short digest) for display, see [`image_tag`].
    pub image_tag: String,
    /// `awslogs` when logs go to CloudWatch.
    pub log_driver: Option<String>,
    /// The log driver's options (`awslogs-group`, `awslogs-stream-prefix`, `awslogs-region`, …).
    pub log_options: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEvent {
    pub id: String,
    pub created_at: Option<Timestamp>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub arn: String,
    /// The last part of the ARN, as shown in the console.
    pub id: String,
    /// `PROVISIONING`, `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, …
    pub last_status: String,
    pub desired_status: String,
    /// `HEALTHY`, `UNHEALTHY` or `UNKNOWN` (no health check).
    pub health_status: Option<String>,
    pub created_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub stopped_at: Option<Timestamp>,
    /// e.g. `EssentialContainerExited`, `TaskFailedToStart`, `ServiceSchedulerInitiated`.
    pub stop_code: Option<String>,
    pub stopped_reason: Option<String>,
    pub availability_zone: Option<String>,
    /// `family:revision`.
    pub task_definition: String,
    pub launch_type: Option<String>,
    /// One per container. Contrail's services have one, but the model doesn't assume it.
    pub containers: Vec<ContainerState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainerState {
    pub name: String,
    pub last_status: Option<String>,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
    pub health_status: Option<String>,
    pub image: Option<String>,
}

/// Where clusters, services and tasks come from: AWS or the demo fake. Read-only by design.
#[async_trait]
pub trait EcsSource: Send + Sync {
    /// All clusters of the account/region, sorted by name.
    async fn list_clusters(&self, ctx: &AwsCtx) -> Result<Vec<ClusterSummary>, SourceError>;

    /// All services of a cluster, sorted by name.
    async fn list_services(
        &self,
        ctx: &AwsCtx,
        cluster_arn: &str,
    ) -> Result<Vec<ServiceSummary>, SourceError>;

    async fn describe_service(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
    ) -> Result<ServiceDetail, SourceError>;

    /// The service's tasks: running ones first (newest first), then, with `include_stopped`,
    /// the recently stopped ones ECS still remembers (about an hour), newest first.
    async fn list_tasks(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
        include_stopped: bool,
    ) -> Result<Vec<Task>, SourceError>;
}

/// The last `/`-separated part of an ARN: a cluster, service or task name/ID.
///
/// `arn:aws:ecs:eu-central-1:111122223333:task/my-cluster/0123abcd` → `0123abcd`
pub fn name_from_arn(arn: &str) -> &str {
    arn.rsplit('/').next().unwrap_or(arn)
}

/// `…:task-definition/orders-api:42` → `orders-api:42`.
pub fn task_definition_label(arn: &str) -> &str {
    name_from_arn(arn)
}

/// The tag (or a short digest) of a container image, for display.
///
/// `…/orders-api:1.4.2` → `1.4.2`; `repo@sha256:abcdef0123…` → `sha256:abcdef012345`;
/// no tag → `latest`. A `:` before the last `/` is a registry port, not a tag.
pub fn image_tag(image: &str) -> String {
    if let Some((_, digest)) = image.split_once('@') {
        return digest.chars().take(19).collect();
    }
    match image.rsplit_once(':') {
        Some((_, tag)) if !tag.contains('/') => tag.to_owned(),
        _ => "latest".to_owned(),
    }
}

/// Orders tasks as the UI shows them: running before stopped, newest first within each group.
pub fn sort_tasks(tasks: &mut [Task]) {
    // `sort_by_key` with a tuple key: `false` sorts before `true`, and `Reverse` flips the time
    // order. `Option` sorts `None` first, which `Reverse` turns into last.
    tasks.sort_by_key(|t| {
        (
            t.last_status == "STOPPED",
            std::cmp::Reverse(t.stopped_at.or(t.started_at).or(t.created_at)),
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn names_from_arns() {
        assert_eq!(
            name_from_arn("arn:aws:ecs:eu-central-1:111122223333:task/demo-core/0123abcd"),
            "0123abcd"
        );
        assert_eq!(
            name_from_arn("arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core"),
            "demo-core"
        );
        assert_eq!(name_from_arn("plain"), "plain");
        assert_eq!(
            task_definition_label(
                "arn:aws:ecs:eu-central-1:111122223333:task-definition/orders-api:42"
            ),
            "orders-api:42"
        );
    }

    #[test]
    fn image_tags() {
        assert_eq!(
            image_tag("111122223333.dkr.ecr.eu-central-1.amazonaws.com/orders-api:1.4.2"),
            "1.4.2"
        );
        assert_eq!(image_tag("registry.example.com:5000/team/app"), "latest");
        assert_eq!(image_tag("nginx"), "latest");
        assert_eq!(
            image_tag("repo@sha256:abcdef0123456789abcdef"),
            "sha256:abcdef012345"
        );
    }

    fn task(id: &str, status: &str, started: i64, stopped: Option<i64>) -> Task {
        let at = |minute: i64| {
            Some(Timestamp(
                datetime!(2026-10-22 12:00 UTC) + time::Duration::minutes(minute),
            ))
        };
        Task {
            arn: format!("arn:aws:ecs:r:1:task/c/{id}"),
            id: id.into(),
            last_status: status.into(),
            desired_status: status.into(),
            health_status: None,
            created_at: at(started),
            started_at: at(started),
            stopped_at: stopped.and_then(at),
            stop_code: None,
            stopped_reason: None,
            availability_zone: None,
            task_definition: "app:1".into(),
            launch_type: None,
            containers: vec![],
        }
    }

    #[test]
    fn running_tasks_first_then_stopped_newest_first() {
        let mut tasks = vec![
            task("stopped-old", "STOPPED", 0, Some(5)),
            task("running-old", "RUNNING", 1, None),
            task("stopped-new", "STOPPED", 2, Some(20)),
            task("running-new", "RUNNING", 10, None),
            task("pending", "PENDING", 30, None),
        ];
        sort_tasks(&mut tasks);
        let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "pending",
                "running-new",
                "running-old",
                "stopped-new",
                "stopped-old"
            ]
        );
    }
}
