//! Records the demo ECS landscape (`contrail-fake`) as JSON for the frontend's fake backend.
//!
//! The UI tests and Playwright flows run without Tauri; instead of re-typing the demo data in
//! TypeScript, they load this recording. Like `bindings.ts`, `cargo test` regenerates it and CI
//! fails if the committed file is out of date.

use std::collections::BTreeMap;
use std::sync::Arc;

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{EcsSource, ServiceRef};
use contrail_core::logs::{LogBuffer, LogSource, TimeRange, process, resolve_log_location};
use contrail_core::timestamp::Timestamp;
use contrail_fake::{FakeAuth, FakeEcs, FakeLogs};
use serde_json::{Value, json};
use time::macros::datetime;

const DEMO_DATA_PATH: &str = "../ui/src/e2e/demo-ecs.json";
const DEMO_LOGS_PATH: &str = "../ui/src/e2e/demo-logs.json";

/// Services whose logs are recorded (one per format, plus billing-sync: it logs the same documents
/// as orders-api, so a trace leads through two services), and how many events of each.
const LOG_SERVICES: &[(&str, &str)] = &[
    ("demo-core", "billing-sync"),
    ("demo-core", "orders-api"),
    ("demo-core", "payments-worker"),
    ("demo-edge", "legacy-gateway"),
];
const LOG_EVENTS_PER_SERVICE: usize = 25;

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

/// The first events of a 15-minute backfill per [`LOG_SERVICES`] entry, with the statistics of
/// the whole backfill, as `open_service_logs` would produce them.
async fn record_logs() -> Value {
    let recorded_at = datetime!(2026-01-01 12:00 UTC);
    let auth = Arc::new(FakeAuth::new());
    let ecs = FakeEcs::with_fixed_now(auth.clone(), recorded_at);
    let logs = FakeLogs::new(auth);
    let ctx = AwsCtx {
        profile: "demo-dev".into(),
        region: None,
    };
    let range = TimeRange {
        start: Timestamp(recorded_at - time::Duration::minutes(15)),
        end: Timestamp(recorded_at),
    };

    let mut services = BTreeMap::new();
    for (cluster, name) in LOG_SERVICES {
        let service = ServiceRef {
            cluster_arn: format!("arn:aws:ecs:eu-central-1:111122223333:cluster/{cluster}"),
            service_name: (*name).to_owned(),
        };
        let detail = ecs.describe_service(&ctx, &service).await.unwrap();
        let location = resolve_log_location(&detail.task_definition.unwrap()).unwrap();
        let tasks = ecs.list_tasks(&ctx, &service, true).await.unwrap();
        let selection = location.selection(&tasks, None, true);
        let backfill = logs
            .backfill(&ctx, &selection, range, 100_000)
            .await
            .unwrap();
        let mut buffer = LogBuffer::new(100_000);
        buffer.insert(process(backfill.events));
        services.insert(
            format!("{cluster}/{name}"),
            json!({
                "location": location,
                "streams": selection.streams.len(),
                "stats": buffer.stats(),
                "truncated": backfill.truncated,
                "events": buffer.window(0, LOG_EVENTS_PER_SERVICE),
            }),
        );
    }
    json!({
        "recordedAt": "2026-01-01T12:00:00Z",
        "account": "111122223333",
        "region": "eu-central-1",
        "services": services,
    })
}

fn write_json(relative: &str, value: &Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    let mut json = serde_json::to_string_pretty(value).unwrap();
    json.push('\n');
    std::fs::write(&path, json)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", path.display()));
}

#[tokio::test]
async fn export_demo_data() {
    write_json(DEMO_DATA_PATH, &record().await);
}

#[tokio::test]
async fn export_demo_logs() {
    write_json(DEMO_LOGS_PATH, &record_logs().await);
}
