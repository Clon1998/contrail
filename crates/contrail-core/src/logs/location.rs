//! Where a service's logs are: the CloudWatch log group and stream names from its task
//! definition's `awslogs` configuration.

use serde::Serialize;
use specta::Type;

use crate::ecs::{Task, TaskDefinitionInfo};

use super::source::StreamSelection;

/// The CloudWatch location of a container's logs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLocation {
    pub log_group: String,
    /// `awslogs-region`; `None` means the region of the service.
    pub region: Option<String>,
    pub stream_prefix: String,
    pub container: String,
}

impl LogLocation {
    /// The stream of one task: `<prefix>/<container>/<task id>` (the `awslogs` convention).
    pub fn stream_for(&self, task_id: &str) -> String {
        format!("{}/{}/{task_id}", self.stream_prefix, self.container)
    }

    /// The streams of the given tasks (running and recently stopped ones). `whole_service` adds
    /// the stream prefix of the service, so live tails also pick up tasks started later.
    pub fn selection(
        &self,
        tasks: &[Task],
        account_id: Option<String>,
        whole_service: bool,
    ) -> StreamSelection {
        StreamSelection {
            log_group: self.log_group.clone(),
            region: self.region.clone(),
            account_id,
            streams: tasks.iter().map(|t| self.stream_for(&t.id)).collect(),
            stream_prefix: whole_service
                .then(|| format!("{}/{}/", self.stream_prefix, self.container)),
            filter_pattern: None,
        }
    }
}

/// Why a service's logs can't be found in CloudWatch.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LocationError {
    #[error("the task definition has no containers")]
    NoContainers,
    #[error("container \"{container}\" logs with \"{driver}\", not to CloudWatch (awslogs)")]
    NotAwslogs { container: String, driver: String },
    #[error("container \"{container}\" has no {option} in its awslogs configuration")]
    MissingOption {
        container: String,
        option: &'static str,
    },
}

/// Finds the log location of a task definition: the first container that logs with `awslogs`.
pub fn resolve_log_location(
    task_definition: &TaskDefinitionInfo,
) -> Result<LogLocation, LocationError> {
    let first = task_definition
        .containers
        .first()
        .ok_or(LocationError::NoContainers)?;
    let Some(container) = task_definition
        .containers
        .iter()
        .find(|c| c.log_driver.as_deref() == Some("awslogs"))
    else {
        return Err(LocationError::NotAwslogs {
            container: first.name.clone(),
            driver: first
                .log_driver
                .clone()
                .unwrap_or_else(|| "no log driver".to_owned()),
        });
    };
    // A closure that borrows `container`: looks up a required option or explains what's missing.
    let option = |option: &'static str| {
        container
            .log_options
            .get(option)
            .filter(|v| !v.is_empty())
            .cloned()
            .ok_or_else(|| LocationError::MissingOption {
                container: container.name.clone(),
                option,
            })
    };
    Ok(LogLocation {
        log_group: option("awslogs-group")?,
        region: option("awslogs-region").ok(),
        // Without a prefix, streams are named after the (EC2) container ID, which Contrail can't
        // derive from the task. Fargate always requires a prefix.
        stream_prefix: option("awslogs-stream-prefix")?,
        container: container.name.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::ContainerDefinitionInfo;

    fn container(
        name: &str,
        driver: Option<&str>,
        options: &[(&str, &str)],
    ) -> ContainerDefinitionInfo {
        ContainerDefinitionInfo {
            name: name.to_owned(),
            image: "repo:1".to_owned(),
            image_tag: "1".to_owned(),
            log_driver: driver.map(str::to_owned),
            log_options: options
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            environment: Vec::new(),
            secrets: Vec::new(),
            environment_files: Vec::new(),
        }
    }

    fn task_definition(containers: Vec<ContainerDefinitionInfo>) -> TaskDefinitionInfo {
        TaskDefinitionInfo {
            family: "orders-api".to_owned(),
            revision: 42,
            cpu: None,
            memory: None,
            containers,
        }
    }

    #[test]
    fn resolves_group_prefix_and_region() {
        let td = task_definition(vec![container(
            "orders-api",
            Some("awslogs"),
            &[
                ("awslogs-group", "/ecs/orders-api"),
                ("awslogs-region", "eu-west-1"),
                ("awslogs-stream-prefix", "ecs"),
            ],
        )]);
        let location = resolve_log_location(&td).unwrap();
        assert_eq!(location.log_group, "/ecs/orders-api");
        assert_eq!(location.region.as_deref(), Some("eu-west-1"));
        assert_eq!(location.stream_for("0123abcd"), "ecs/orders-api/0123abcd");
    }

    #[test]
    fn picks_the_awslogs_container() {
        let td = task_definition(vec![
            container("sidecar", Some("firelens"), &[]),
            container(
                "app",
                Some("awslogs"),
                &[("awslogs-group", "g"), ("awslogs-stream-prefix", "p")],
            ),
        ]);
        let location = resolve_log_location(&td).unwrap();
        assert_eq!(location.container, "app");
        assert_eq!(location.region, None);
    }

    #[test]
    fn explains_unresolvable_configurations() {
        let not_awslogs = task_definition(vec![container("app", Some("splunk"), &[])]);
        assert_eq!(
            resolve_log_location(&not_awslogs).unwrap_err().to_string(),
            "container \"app\" logs with \"splunk\", not to CloudWatch (awslogs)"
        );
        let no_prefix = task_definition(vec![container(
            "app",
            Some("awslogs"),
            &[("awslogs-group", "g")],
        )]);
        assert_eq!(
            resolve_log_location(&no_prefix),
            Err(LocationError::MissingOption {
                container: "app".into(),
                option: "awslogs-stream-prefix"
            })
        );
        assert_eq!(
            resolve_log_location(&task_definition(vec![])),
            Err(LocationError::NoContainers)
        );
    }
}
