//! The routes of every service of a cluster, kept for the session once a topic scan found them.
//!
//! Going from service to service through the route graph then needs no AWS call; the user scans
//! again ("Find connected services") when the cluster changed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use contrail_core::auth::AwsCtx;
use contrail_core::routes::Route;

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
#[derive(Default)]
pub struct RouteIndex {
    /// Scans are kept behind an `Arc`, so a reader clones a pointer under the lock and filters
    /// after releasing it, while a new scan of the same cluster can replace the entry meanwhile.
    clusters: Mutex<HashMap<(AwsCtx, String), Arc<ClusterRoutes>>>,
}

impl RouteIndex {
    /// The last scan of the cluster, if there was one this session.
    pub fn get(&self, ctx: &AwsCtx, cluster_arn: &str) -> Option<Arc<ClusterRoutes>> {
        self.clusters
            .lock()
            .expect("route index poisoned")
            .get(&(ctx.clone(), cluster_arn.to_owned()))
            .cloned()
    }

    /// Keeps a new scan of the cluster in place of the old one.
    pub fn insert(
        &self,
        ctx: &AwsCtx,
        cluster_arn: &str,
        routes: ClusterRoutes,
    ) -> Arc<ClusterRoutes> {
        let routes = Arc::new(routes);
        self.clusters
            .lock()
            .expect("route index poisoned")
            .insert((ctx.clone(), cluster_arn.to_owned()), routes.clone());
        routes
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
