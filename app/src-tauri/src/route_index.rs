//! What a scan of a cluster found, kept for the session: the routes of its services (from their
//! env vars) and the topics of its transformers (from their startup lines).
//!
//! Going from service to service through the route graph then needs no AWS call; the user scans
//! again ("Find connected services", "Scan again") when the cluster changed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use contrail_core::auth::AwsCtx;
use contrail_core::routes::Route;

use crate::commands::ecs::ServiceTopology;

/// The routes of one service of the cluster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceRoutes {
    pub service: String,
    pub routes: Vec<Route>,
}

/// What a scan found: the services that have routes, sorted by name.
pub type ClusterRoutes = Vec<ServiceRoutes>;

/// The last scan of each cluster, per profile and region (the same cluster ARN can be seen with
/// a region override or without one).
///
/// Generic over what a scan finds (`T`), like a Java `ClusterIndex<T>`: the same cache serves
/// the route scan and the startup topology scan ([`RouteIndex`]; `TopologyIndex` in `state`).
pub struct ClusterIndex<T> {
    /// Scans are kept behind an `Arc`, so a reader clones a pointer under the lock and filters
    /// after releasing it, while a new scan of the same cluster can replace the entry meanwhile.
    clusters: Mutex<HashMap<(AwsCtx, String), Arc<T>>>,
}

/// The routes found by the last topic scan of each cluster.
pub type RouteIndex = ClusterIndex<ClusterRoutes>;

/// Written by hand: `#[derive(Default)]` would require `T: Default`, which an empty map doesn't need.
impl<T> Default for ClusterIndex<T> {
    fn default() -> Self {
        Self {
            clusters: Mutex::default(),
        }
    }
}

impl<T> ClusterIndex<T> {
    /// The last scan of the cluster, if there was one this session.
    pub fn get(&self, ctx: &AwsCtx, cluster_arn: &str) -> Option<Arc<T>> {
        self.clusters
            .lock()
            .expect("route index poisoned")
            .get(&(ctx.clone(), cluster_arn.to_owned()))
            .cloned()
    }

    /// Keeps a new scan of the cluster in place of the old one.
    pub fn insert(&self, ctx: &AwsCtx, cluster_arn: &str, found: T) -> Arc<T> {
        let found = Arc::new(found);
        self.clusters
            .lock()
            .expect("route index poisoned")
            .insert((ctx.clone(), cluster_arn.to_owned()), found.clone());
        found
    }
}

/// The topics of a cluster's transformers, read from their startup lines.
#[derive(Default)]
pub struct TopologyIndex {
    /// The last topology scan of each cluster.
    pub clusters: ClusterIndex<Vec<ServiceTopology>>,
    /// What the startup lines of a task definition revision said, by its ARN. A revision never
    /// changes, so this outlives a scan: scanning again reads only services deployed since.
    revisions: Mutex<HashMap<String, ServiceTopology>>,
}

impl TopologyIndex {
    pub fn revision(&self, task_definition_arn: &str) -> Option<ServiceTopology> {
        self.revisions
            .lock()
            .expect("topology index poisoned")
            .get(task_definition_arn)
            .cloned()
    }

    pub fn insert_revision(&self, task_definition_arn: &str, found: ServiceTopology) {
        self.revisions
            .lock()
            .expect("topology index poisoned")
            .insert(task_definition_arn.to_owned(), found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(region: Option<&str>) -> AwsCtx {
        AwsCtx {
            profile: "dev".into(),
            region: region.map(str::to_owned),
        }
    }

    fn scan(service: &str) -> ClusterRoutes {
        vec![ServiceRoutes {
            service: service.into(),
            routes: Vec::new(),
        }]
    }

    #[test]
    fn keeps_the_last_scan_per_cluster_profile_and_region() {
        let index = RouteIndex::default();
        assert_eq!(index.get(&ctx(None), "core"), None);

        index.insert(&ctx(None), "core", scan("first"));
        index.insert(&ctx(None), "core", scan("second"));
        index.insert(&ctx(Some("us-west-2")), "core", scan("other region"));

        assert_eq!(*index.get(&ctx(None), "core").unwrap(), scan("second"));
        assert_eq!(
            *index.get(&ctx(Some("us-west-2")), "core").unwrap(),
            scan("other region")
        );
        assert_eq!(index.get(&ctx(None), "edge"), None);
    }
}
