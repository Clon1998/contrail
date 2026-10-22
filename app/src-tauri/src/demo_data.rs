//! Records the demo ECS landscape (`contrail-fake`) as JSON for the frontend's fake backend.
//!
//! The UI tests and Playwright flows run without Tauri; instead of re-typing the demo data in
//! TypeScript, they load this recording. Like `bindings.ts`, `cargo test` regenerates it and CI
//! fails if the committed file is out of date.

use std::collections::BTreeMap;
use std::sync::Arc;

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{EcsSource, ServiceRef};
use contrail_fake::{FakeAuth, FakeEcs};
use serde_json::{Value, json};
use time::macros::datetime;

const DEMO_DATA_PATH: &str = "../ui/src/e2e/demo-ecs.json";

/// The demo landscape as seen by `demo-dev`, with all times relative to a fixed instant.
async fn record() -> Value {
    let recorded_at = datetime!(2026-01-01 12:00 UTC);
    let auth = Arc::new(FakeAuth::new());
    let ecs = FakeEcs::with_fixed_now(auth, recorded_at);
    let ctx = AwsCtx {
        profile: "demo-dev".into(),
        region: None,
    };

    let clusters = ecs.list_clusters(&ctx).await.unwrap();
    // BTreeMaps keep the keys sorted, so the file is stable between runs.
    let mut services = BTreeMap::new();
    let mut details = BTreeMap::new();
    let mut tasks = BTreeMap::new();
    for cluster in &clusters {
        let list = ecs.list_services(&ctx, &cluster.arn).await.unwrap();
        for service in &list {
            let service_ref = ServiceRef {
                cluster_arn: cluster.arn.clone(),
                service_name: service.name.clone(),
            };
            let key = format!("{}/{}", cluster.name, service.name);
            details.insert(
                key.clone(),
                ecs.describe_service(&ctx, &service_ref).await.unwrap(),
            );
            tasks.insert(key, ecs.list_tasks(&ctx, &service_ref, true).await.unwrap());
        }
        services.insert(cluster.arn.clone(), list);
    }

    json!({
        "recordedAt": "2026-01-01T12:00:00Z",
        "account": "111122223333",
        "region": "eu-central-1",
        "clusters": clusters,
        "services": services,
        "details": details,
        "tasks": tasks,
    })
}

#[tokio::test]
async fn export_demo_data() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(DEMO_DATA_PATH);
    let mut json = serde_json::to_string_pretty(&record().await).unwrap();
    json.push('\n');
    std::fs::write(&path, json)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", path.display()));
}
