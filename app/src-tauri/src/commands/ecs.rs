//! Clusters, services and tasks (read-only).

use contrail_core::auth::AwsCtx;
use contrail_core::ecs::{ClusterSummary, ServiceDetail, ServiceRef, ServiceSummary, Task};
use tauri::State;

use crate::error::ApiResult;
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
