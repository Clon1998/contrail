//! The real [`EcsSource`] on top of `aws-sdk-ecs`. Read-only: only `List*` and `Describe*` calls.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use aws_sdk_ecs::Client;
use aws_sdk_ecs::types::DesiredStatus;
use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{
    ClusterSummary, ContainerDefinitionInfo, ContainerState, Deployment, EcsSource, EnvVar,
    SecretRef, ServiceDetail, ServiceEvent, ServiceRef, ServiceSummary, Task, TaskDefinitionInfo,
    image_tag, name_from_arn, sort_tasks, task_definition_label,
};
use contrail_core::error::SourceError;
use contrail_core::timestamp::Timestamp;
use futures::future::try_join_all;
use time::OffsetDateTime;

use crate::clients::ClientCache;
use crate::error::map_sdk_error;

/// API limits of the `Describe*` calls (items per request).
const DESCRIBE_CLUSTERS_MAX: usize = 100;
const DESCRIBE_SERVICES_MAX: usize = 10;
const DESCRIBE_TASKS_MAX: usize = 100;
/// How many service events the overview shows.
const MAX_EVENTS: usize = 10;

/// ECS via the AWS SDK, with an SDK client per profile + region and a task definition cache.
#[derive(Default)]
pub struct AwsEcs {
    clients: ClientCache<Client>,
    /// Task definitions never change once registered, so they're cached by ARN.
    task_definitions: Mutex<HashMap<String, TaskDefinitionInfo>>,
}

impl AwsEcs {
    pub fn new() -> Self {
        Self::default()
    }

    async fn client(&self, ctx: &AwsCtx) -> Client {
        self.clients.get(ctx, Client::new).await
    }
}

#[async_trait]
impl EcsSource for AwsEcs {
    async fn list_clusters(&self, ctx: &AwsCtx) -> Result<Vec<ClusterSummary>, SourceError> {
        list_clusters(&self.client(ctx).await, &ctx.profile).await
    }

    async fn list_services(
        &self,
        ctx: &AwsCtx,
        cluster_arn: &str,
    ) -> Result<Vec<ServiceSummary>, SourceError> {
        list_services(&self.client(ctx).await, &ctx.profile, cluster_arn).await
    }

    async fn describe_service(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
    ) -> Result<ServiceDetail, SourceError> {
        let client = self.client(ctx).await;
        let (mut detail, primary) = describe_service(&client, &ctx.profile, service).await?;
        if let Some(arn) = primary {
            detail.task_definition = Some(self.task_definition(&client, &ctx.profile, &arn).await?);
        }
        Ok(detail)
    }

    async fn list_tasks(
        &self,
        ctx: &AwsCtx,
        service: &ServiceRef,
        include_stopped: bool,
    ) -> Result<Vec<Task>, SourceError> {
        list_tasks(
            &self.client(ctx).await,
            &ctx.profile,
            service,
            include_stopped,
        )
        .await
    }
}

impl AwsEcs {
    async fn task_definition(
        &self,
        client: &Client,
        profile: &str,
        arn: &str,
    ) -> Result<TaskDefinitionInfo, SourceError> {
        if let Some(cached) = self
            .task_definitions
            .lock()
            .expect("cache poisoned")
            .get(arn)
        {
            return Ok(cached.clone());
        }
        let info = describe_task_definition(client, profile, arn).await?;
        self.task_definitions
            .lock()
            .expect("cache poisoned")
            .insert(arn.to_owned(), info.clone());
        Ok(info)
    }
}

fn timestamp(value: Option<&aws_smithy_types::DateTime>) -> Option<Timestamp> {
    let nanos = value?.as_nanos();
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .map(Timestamp)
}

/// ECS counts are `i32` in the SDK but never negative.
fn count(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

fn text(value: Option<&str>) -> String {
    value.unwrap_or_default().to_owned()
}

async fn list_clusters(client: &Client, profile: &str) -> Result<Vec<ClusterSummary>, SourceError> {
    let arns: Vec<String> = client
        .list_clusters()
        .into_paginator()
        .items()
        .send()
        .collect::<Result<_, _>>()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;

    let batches = arns.chunks(DESCRIBE_CLUSTERS_MAX).map(|batch| async move {
        client
            .describe_clusters()
            .set_clusters(Some(batch.to_vec()))
            .send()
            .await
            .map_err(|err| map_sdk_error(profile, err))
    });
    let mut clusters: Vec<ClusterSummary> = try_join_all(batches)
        .await?
        .iter()
        .flat_map(|output| output.clusters())
        .map(|c| ClusterSummary {
            arn: text(c.cluster_arn()),
            name: text(c.cluster_name()),
            status: text(c.status()),
            active_services: count(c.active_services_count()),
            running_tasks: count(c.running_tasks_count()),
            pending_tasks: count(c.pending_tasks_count()),
        })
        .collect();
    clusters.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(clusters)
}

fn service_summary(service: &aws_sdk_ecs::types::Service) -> ServiceSummary {
    ServiceSummary {
        arn: text(service.service_arn()),
        name: text(service.service_name()),
        cluster_arn: text(service.cluster_arn()),
        status: text(service.status()),
        desired: count(service.desired_count()),
        running: count(service.running_count()),
        pending: count(service.pending_count()),
        launch_type: service.launch_type().map(|l| l.as_str().to_owned()),
        task_definition: task_definition_label(service.task_definition().unwrap_or_default())
            .to_owned(),
    }
}

async fn list_services(
    client: &Client,
    profile: &str,
    cluster_arn: &str,
) -> Result<Vec<ServiceSummary>, SourceError> {
    let arns: Vec<String> = client
        .list_services()
        .cluster(cluster_arn)
        .into_paginator()
        .items()
        .send()
        .collect::<Result<_, _>>()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;

    // DescribeServices takes at most 10 services; the batches run concurrently.
    let batches = arns.chunks(DESCRIBE_SERVICES_MAX).map(|batch| async move {
        client
            .describe_services()
            .cluster(cluster_arn)
            .set_services(Some(batch.to_vec()))
            .send()
            .await
            .map_err(|err| map_sdk_error(profile, err))
    });
    let mut services: Vec<ServiceSummary> = try_join_all(batches)
        .await?
        .iter()
        .flat_map(|output| output.services())
        .map(service_summary)
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(services)
}

async fn describe_one_service(
    client: &Client,
    profile: &str,
    service: &ServiceRef,
) -> Result<aws_sdk_ecs::types::Service, SourceError> {
    let output = client
        .describe_services()
        .cluster(&service.cluster_arn)
        .services(&service.service_name)
        .send()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;
    output
        .services()
        .first()
        .cloned()
        .ok_or_else(|| SourceError::NotFound(format!("service {}", service.service_name)))
}

/// The service without its task definition, plus the ARN of the task definition of the
/// `PRIMARY` deployment (or the service's own), which [`AwsEcs`] resolves through its cache.
async fn describe_service(
    client: &Client,
    profile: &str,
    service: &ServiceRef,
) -> Result<(ServiceDetail, Option<String>), SourceError> {
    let svc = describe_one_service(client, profile, service).await?;
    let primary = svc
        .deployments()
        .iter()
        .find(|d| d.status() == Some("PRIMARY"))
        .and_then(|d| d.task_definition())
        .or(svc.task_definition())
        .map(str::to_owned);
    let deployments = svc
        .deployments()
        .iter()
        .map(|d| Deployment {
            id: text(d.id()),
            status: text(d.status()),
            rollout_state: d.rollout_state().map(|r| r.as_str().to_owned()),
            rollout_reason: d.rollout_state_reason().map(str::to_owned),
            task_definition: task_definition_label(d.task_definition().unwrap_or_default())
                .to_owned(),
            desired: count(d.desired_count()),
            running: count(d.running_count()),
            pending: count(d.pending_count()),
            failed: count(d.failed_tasks()),
            created_at: timestamp(d.created_at()),
            updated_at: timestamp(d.updated_at()),
        })
        .collect();
    let events = svc
        .events()
        .iter()
        .take(MAX_EVENTS)
        .map(|e| ServiceEvent {
            id: text(e.id()),
            created_at: timestamp(e.created_at()),
            message: text(e.message()),
        })
        .collect();
    let detail = ServiceDetail {
        summary: service_summary(&svc),
        created_at: timestamp(svc.created_at()),
        platform_version: svc.platform_version().map(str::to_owned),
        deployments,
        task_definition: None,
        events,
    };
    Ok((detail, primary))
}

async fn describe_task_definition(
    client: &Client,
    profile: &str,
    arn: &str,
) -> Result<TaskDefinitionInfo, SourceError> {
    let output = client
        .describe_task_definition()
        .task_definition(arn)
        .send()
        .await
        .map_err(|err| map_sdk_error(profile, err))?;
    let td = output
        .task_definition()
        .ok_or_else(|| SourceError::NotFound(format!("task definition {arn}")))?;
    Ok(TaskDefinitionInfo {
        family: text(td.family()),
        revision: count(td.revision()),
        cpu: td.cpu().map(str::to_owned),
        memory: td.memory().map(str::to_owned),
        containers: td
            .container_definitions()
            .iter()
            .map(|c| ContainerDefinitionInfo {
                name: text(c.name()),
                image: text(c.image()),
                image_tag: image_tag(c.image().unwrap_or_default()),
                log_driver: c
                    .log_configuration()
                    .map(|l| l.log_driver().as_str().to_owned()),
                log_options: c
                    .log_configuration()
                    .and_then(|l| l.options())
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default(),
                environment: {
                    let mut vars: Vec<EnvVar> = c
                        .environment()
                        .iter()
                        .map(|kv| EnvVar {
                            name: text(kv.name()),
                            value: text(kv.value()),
                        })
                        .collect();
                    vars.sort_by(|a, b| a.name.cmp(&b.name));
                    vars
                },
                secrets: c
                    .secrets()
                    .iter()
                    .map(|s| SecretRef {
                        name: s.name().to_owned(),
                        value_from: s.value_from().to_owned(),
                    })
                    .collect(),
                environment_files: c
                    .environment_files()
                    .iter()
                    .map(|f| f.value().to_owned())
                    .collect(),
            })
            .collect(),
    })
}

async fn task_arns(
    client: &Client,
    profile: &str,
    service: &ServiceRef,
    status: DesiredStatus,
) -> Result<Vec<String>, SourceError> {
    client
        .list_tasks()
        .cluster(&service.cluster_arn)
        .service_name(&service.service_name)
        .desired_status(status)
        .into_paginator()
        .items()
        .send()
        .collect::<Result<_, _>>()
        .await
        .map_err(|err| map_sdk_error(profile, err))
}

fn map_task(t: &aws_sdk_ecs::types::Task) -> Task {
    let arn = text(t.task_arn());
    Task {
        id: name_from_arn(&arn).to_owned(),
        last_status: text(t.last_status()),
        desired_status: text(t.desired_status()),
        health_status: t.health_status().map(|h| h.as_str().to_owned()),
        created_at: timestamp(t.created_at()),
        started_at: timestamp(t.started_at()),
        stopped_at: timestamp(t.stopped_at()),
        stop_code: t.stop_code().map(|c| c.as_str().to_owned()),
        stopped_reason: t.stopped_reason().map(str::to_owned),
        availability_zone: t.availability_zone().map(str::to_owned),
        task_definition: task_definition_label(t.task_definition_arn().unwrap_or_default())
            .to_owned(),
        launch_type: t.launch_type().map(|l| l.as_str().to_owned()),
        containers: t
            .containers()
            .iter()
            .map(|c| ContainerState {
                name: text(c.name()),
                last_status: c.last_status().map(str::to_owned),
                exit_code: c.exit_code(),
                reason: c.reason().map(str::to_owned),
                health_status: c.health_status().map(|h| h.as_str().to_owned()),
                image: c.image().map(str::to_owned),
                image_tag: c.image().map(image_tag),
                image_digest: c.image_digest().map(str::to_owned),
            })
            .collect(),
        arn,
    }
}

async fn list_tasks(
    client: &Client,
    profile: &str,
    service: &ServiceRef,
    include_stopped: bool,
) -> Result<Vec<Task>, SourceError> {
    // `desiredStatus=RUNNING` also covers tasks that are still starting (PENDING, …).
    let mut arns = task_arns(client, profile, service, DesiredStatus::Running).await?;
    if include_stopped {
        arns.extend(task_arns(client, profile, service, DesiredStatus::Stopped).await?);
    }

    let batches = arns.chunks(DESCRIBE_TASKS_MAX).map(|batch| async move {
        client
            .describe_tasks()
            .cluster(&service.cluster_arn)
            .set_tasks(Some(batch.to_vec()))
            .send()
            .await
            .map_err(|err| map_sdk_error(profile, err))
    });
    let mut tasks: Vec<Task> = try_join_all(batches)
        .await?
        .iter()
        .flat_map(|output| output.tasks())
        .map(map_task)
        .collect();
    sort_tasks(&mut tasks);
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ecs::operation::describe_clusters::DescribeClustersOutput;
    use aws_sdk_ecs::operation::describe_services::DescribeServicesOutput;
    use aws_sdk_ecs::operation::describe_task_definition::DescribeTaskDefinitionOutput;
    use aws_sdk_ecs::operation::describe_tasks::DescribeTasksOutput;
    use aws_sdk_ecs::operation::list_clusters::ListClustersOutput;
    use aws_sdk_ecs::operation::list_services::ListServicesOutput;
    use aws_sdk_ecs::operation::list_tasks::ListTasksOutput;
    use aws_sdk_ecs::types::{
        Cluster, Container, ContainerDefinition, DeploymentRolloutState, EnvironmentFile,
        EnvironmentFileType, HealthStatus, KeyValuePair, LaunchType, LogConfiguration, LogDriver,
        Secret, Service, TaskStopCode,
    };
    use aws_smithy_mocks::{RuleMode, mock, mock_client};
    use aws_smithy_types::DateTime;

    const CLUSTER: &str = "arn:aws:ecs:eu-central-1:111122223333:cluster/core";

    fn svc_ref(name: &str) -> ServiceRef {
        ServiceRef {
            cluster_arn: CLUSTER.into(),
            service_name: name.into(),
        }
    }

    fn service_builder(name: &str) -> aws_sdk_ecs::types::builders::ServiceBuilder {
        Service::builder()
            .service_arn(format!(
                "arn:aws:ecs:eu-central-1:111122223333:service/core/{name}"
            ))
            .service_name(name)
            .cluster_arn(CLUSTER)
            .status("ACTIVE")
            .desired_count(2)
            .running_count(2)
            .pending_count(0)
            .launch_type(LaunchType::Fargate)
            .task_definition(format!(
                "arn:aws:ecs:eu-central-1:111122223333:task-definition/{name}:3"
            ))
    }

    fn service(name: &str) -> Service {
        service_builder(name).build()
    }

    #[tokio::test]
    async fn lists_and_describes_clusters_sorted_by_name() {
        let list = mock!(Client::list_clusters).then_output(|| {
            ListClustersOutput::builder()
                .cluster_arns("arn:aws:ecs:eu-central-1:111122223333:cluster/zeta")
                .cluster_arns(CLUSTER)
                .build()
        });
        let describe = mock!(Client::describe_clusters).then_compute_output(|req| {
            let clusters = req.clusters().iter().map(|arn| {
                Cluster::builder()
                    .cluster_arn(arn)
                    .cluster_name(name_from_arn(arn))
                    .status("ACTIVE")
                    .active_services_count(4)
                    .running_tasks_count(9)
                    .pending_tasks_count(1)
                    .build()
            });
            DescribeClustersOutput::builder()
                .set_clusters(Some(clusters.collect()))
                .build()
        });
        let client = mock_client!(aws_sdk_ecs, RuleMode::MatchAny, [&list, &describe]);

        let clusters = list_clusters(&client, "dev").await.unwrap();

        let names: Vec<&str> = clusters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["core", "zeta"]);
        assert_eq!(clusters[0].active_services, 4);
        assert_eq!(clusters[0].running_tasks, 9);
        assert_eq!(describe.num_calls(), 1);
    }

    #[tokio::test]
    async fn describes_services_in_batches_of_ten() {
        let names: Vec<String> = (1..=12).map(|i| format!("svc-{i:02}")).collect();
        let arns: Vec<String> = names
            .iter()
            .map(|n| format!("arn:aws:ecs:eu-central-1:111122223333:service/core/{n}"))
            .collect();
        let list = mock!(Client::list_services).then_output(move || {
            ListServicesOutput::builder()
                .set_service_arns(Some(arns.clone()))
                .build()
        });
        let describe = mock!(Client::describe_services).then_compute_output(|req| {
            assert!(
                req.services().len() <= 10,
                "DescribeServices takes at most 10"
            );
            let services = req.services().iter().map(|arn| service(name_from_arn(arn)));
            DescribeServicesOutput::builder()
                .set_services(Some(services.collect()))
                .build()
        });
        let client = mock_client!(aws_sdk_ecs, RuleMode::MatchAny, [&list, &describe]);

        let services = list_services(&client, "dev", CLUSTER).await.unwrap();

        assert_eq!(describe.num_calls(), 2);
        let listed: Vec<String> = services.iter().map(|s| s.name.clone()).collect();
        assert_eq!(listed, names);
        assert_eq!(services[0].task_definition, "svc-01:3");
        assert_eq!(services[0].launch_type.as_deref(), Some("FARGATE"));
    }

    #[tokio::test]
    async fn describes_a_service_with_deployments_events_and_cached_task_definition() {
        let describe = mock!(Client::describe_services).then_output(|| {
            let deployment = |id: &str, status: &str, rev: u32, state| {
                aws_sdk_ecs::types::Deployment::builder()
                    .id(id)
                    .status(status)
                    .task_definition(format!(
                        "arn:aws:ecs:eu-central-1:111122223333:task-definition/orders:{rev}"
                    ))
                    .desired_count(2)
                    .running_count(1)
                    .pending_count(1)
                    .failed_tasks(0)
                    .rollout_state(state)
                    .created_at(DateTime::from_secs(1_790_000_000))
                    .build()
            };
            let events = (0..15).map(|i| {
                aws_sdk_ecs::types::ServiceEvent::builder()
                    .id(format!("event-{i}"))
                    .message(format!("(service orders) message {i}"))
                    .created_at(DateTime::from_secs(1_790_000_000 - i))
                    .build()
            });
            let svc = service_builder("orders")
                .deployments(deployment(
                    "ecs-svc/2",
                    "PRIMARY",
                    4,
                    DeploymentRolloutState::InProgress,
                ))
                .deployments(deployment(
                    "ecs-svc/1",
                    "ACTIVE",
                    3,
                    DeploymentRolloutState::Completed,
                ))
                .set_events(Some(events.collect()))
                .platform_version("1.4.0")
                .build();
            DescribeServicesOutput::builder().services(svc).build()
        });
        let task_def = mock!(Client::describe_task_definition).then_output(|| {
            DescribeTaskDefinitionOutput::builder()
                .task_definition(
                    aws_sdk_ecs::types::TaskDefinition::builder()
                        .family("orders")
                        .revision(4)
                        .cpu("512")
                        .memory("1024")
                        .container_definitions(
                            ContainerDefinition::builder()
                                .name("orders")
                                .image(
                                    "111122223333.dkr.ecr.eu-central-1.amazonaws.com/orders:1.2.3",
                                )
                                .log_configuration(
                                    LogConfiguration::builder()
                                        .log_driver(LogDriver::Awslogs)
                                        .options("awslogs-group", "/ecs/orders")
                                        .options("awslogs-stream-prefix", "ecs")
                                        .build()
                                        .unwrap(),
                                )
                                .environment(
                                    KeyValuePair::builder()
                                        .name("SPRING_PROFILES_ACTIVE")
                                        .value("prod")
                                        .build(),
                                )
                                .environment(KeyValuePair::builder().name("EMPTY").build())
                                .secrets(
                                    Secret::builder()
                                        .name("DB_PASSWORD")
                                        .value_from("arn:aws:ssm:eu-central-1:111122223333:parameter/orders/db")
                                        .build()
                                        .unwrap(),
                                )
                                .environment_files(
                                    EnvironmentFile::builder()
                                        .value("arn:aws:s3:::example-config/orders.env")
                                        .r#type(EnvironmentFileType::S3)
                                        .build()
                                        .unwrap(),
                                )
                                .build(),
                        )
                        .build(),
                )
                .build()
        });
        let client = mock_client!(aws_sdk_ecs, RuleMode::MatchAny, [&describe, &task_def]);
        let ecs = AwsEcs::new();

        let (detail, primary) = describe_service(&client, "dev", &svc_ref("orders"))
            .await
            .unwrap();
        assert_eq!(detail.deployments.len(), 2);
        assert_eq!(detail.deployments[0].task_definition, "orders:4");
        assert_eq!(
            detail.deployments[0].rollout_state.as_deref(),
            Some("IN_PROGRESS")
        );
        assert_eq!(detail.events.len(), MAX_EVENTS);
        assert_eq!(detail.platform_version.as_deref(), Some("1.4.0"));

        let arn = primary.unwrap();
        assert!(arn.ends_with("orders:4"), "uses the PRIMARY deployment");
        assert_eq!(describe.num_calls(), 1);
        let info = ecs.task_definition(&client, "dev", &arn).await.unwrap();
        ecs.task_definition(&client, "dev", &arn).await.unwrap();
        assert_eq!(task_def.num_calls(), 1, "task definitions are cached");
        assert_eq!(info.revision, 4);
        assert_eq!(info.containers[0].log_driver.as_deref(), Some("awslogs"));
        assert_eq!(info.containers[0].image_tag, "1.2.3");
        assert_eq!(
            info.containers[0].log_options["awslogs-group"],
            "/ecs/orders"
        );
        let container = &info.containers[0];
        assert_eq!(
            container.environment,
            vec![
                EnvVar {
                    name: "EMPTY".into(),
                    value: String::new()
                },
                EnvVar {
                    name: "SPRING_PROFILES_ACTIVE".into(),
                    value: "prod".into()
                },
            ],
            "sorted by name"
        );
        assert_eq!(container.secrets[0].name, "DB_PASSWORD");
        assert!(
            container.secrets[0]
                .value_from
                .ends_with("parameter/orders/db")
        );
        assert_eq!(
            container.environment_files,
            vec!["arn:aws:s3:::example-config/orders.env".to_owned()]
        );
    }

    #[tokio::test]
    async fn missing_permissions_are_not_a_login_problem() {
        use aws_sdk_ecs::error::ErrorMetadata;
        use aws_sdk_ecs::operation::list_clusters::ListClustersError;
        let list = mock!(Client::list_clusters).then_error(|| {
            ListClustersError::generic(
                ErrorMetadata::builder()
                    .code("AccessDeniedException")
                    .message("not authorized to perform: ecs:ListClusters")
                    .build(),
            )
        });
        let client = mock_client!(aws_sdk_ecs, [&list]);
        assert_eq!(
            list_clusters(&client, "dev").await,
            Err(SourceError::AccessDenied(
                "AccessDeniedException: not authorized to perform: ecs:ListClusters".into()
            ))
        );
    }

    #[tokio::test]
    async fn missing_service_is_not_found() {
        let describe = mock!(Client::describe_services)
            .then_output(|| DescribeServicesOutput::builder().build());
        let client = mock_client!(aws_sdk_ecs, [&describe]);
        assert_eq!(
            describe_service(&client, "dev", &svc_ref("gone"))
                .await
                .map(|(detail, _)| detail),
            Err(SourceError::NotFound("service gone".into()))
        );
    }

    #[tokio::test]
    async fn lists_running_and_stopped_tasks() {
        let task_arn = |id: &str| format!("arn:aws:ecs:eu-central-1:111122223333:task/core/{id}");
        let list = mock!(Client::list_tasks).then_compute_output(move |req| {
            let id = match req.desired_status() {
                Some(DesiredStatus::Stopped) => "stopped1",
                _ => "running1",
            };
            ListTasksOutput::builder().task_arns(task_arn(id)).build()
        });
        let describe = mock!(Client::describe_tasks).then_compute_output(|req| {
            let tasks = req.tasks().iter().map(|arn| {
                let stopped = arn.ends_with("stopped1");
                let mut task = aws_sdk_ecs::types::Task::builder()
                    .task_arn(arn)
                    .last_status(if stopped { "STOPPED" } else { "RUNNING" })
                    .desired_status(if stopped { "STOPPED" } else { "RUNNING" })
                    .health_status(HealthStatus::Healthy)
                    .availability_zone("eu-central-1a")
                    .task_definition_arn(
                        "arn:aws:ecs:eu-central-1:111122223333:task-definition/orders:4",
                    )
                    .started_at(DateTime::from_secs(1_790_000_000))
                    .containers(
                        Container::builder()
                            .name("orders")
                            .last_status(if stopped { "STOPPED" } else { "RUNNING" })
                            .set_exit_code(stopped.then_some(1))
                            .image("111122223333.dkr.ecr.eu-central-1.amazonaws.com/orders:1.2.3")
                            .image_digest("sha256:4f2a9c1e0b7d6a5e4f3c2b1a09876543210fedcba9876543210fedcba987654")
                            .build(),
                    );
                if stopped {
                    task = task
                        .stopped_at(DateTime::from_secs(1_790_000_600))
                        .stop_code(TaskStopCode::EssentialContainerExited)
                        .stopped_reason("Essential container in task exited");
                }
                task.build()
            });
            DescribeTasksOutput::builder()
                .set_tasks(Some(tasks.collect()))
                .build()
        });
        let client = mock_client!(aws_sdk_ecs, RuleMode::MatchAny, [&list, &describe]);

        let running = list_tasks(&client, "dev", &svc_ref("orders"), false)
            .await
            .unwrap();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].id, "running1");
        assert_eq!(running[0].health_status.as_deref(), Some("HEALTHY"));
        assert_eq!(running[0].task_definition, "orders:4");
        let container = &running[0].containers[0];
        assert_eq!(container.image_tag.as_deref(), Some("1.2.3"));
        assert!(
            container
                .image_digest
                .as_deref()
                .unwrap()
                .starts_with("sha256:4f2a")
        );

        let all = list_tasks(&client, "dev", &svc_ref("orders"), true)
            .await
            .unwrap();
        assert_eq!(all.len(), 2);
        let stopped = &all[1];
        assert_eq!(stopped.id, "stopped1");
        assert_eq!(
            stopped.stop_code.as_deref(),
            Some("EssentialContainerExited")
        );
        assert_eq!(stopped.containers[0].exit_code, Some(1));
        assert!(stopped.stopped_at.is_some());
    }
}
