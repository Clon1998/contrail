//! SDK clients cached per profile + region.

use std::collections::HashMap;
use std::sync::Mutex;

use aws_config::SdkConfig;
use contrail_core::auth::AwsCtx;

use crate::sts::sdk_config;

/// One SDK client of type `C` per [`AwsCtx`], created on first use.
///
/// Generic over the client type (`ClientCache<aws_sdk_ecs::Client>`, …): the compiler generates
/// a separate version per type, like a Java generic class but without type erasure.
pub(crate) struct ClientCache<C> {
    clients: Mutex<HashMap<AwsCtx, C>>,
}

impl<C> Default for ClientCache<C> {
    fn default() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }
}

impl<C: Clone> ClientCache<C> {
    /// The cached client for `ctx`, or a new one built by `make` from the SDK config.
    ///
    /// The lock is released before the `.await` (loading the config reads files) and only
    /// re-taken to store the result: never hold a `std::sync::Mutex` across an `.await`.
    pub(crate) async fn get(&self, ctx: &AwsCtx, make: impl FnOnce(&SdkConfig) -> C) -> C {
        if let Some(client) = self.clients.lock().expect("client cache poisoned").get(ctx) {
            // SDK clients are cheap to clone: they share their internals behind an `Arc`.
            return client.clone();
        }
        let client = make(&sdk_config(ctx).await);
        self.clients
            .lock()
            .expect("client cache poisoned")
            .insert(ctx.clone(), client.clone());
        client
    }
}
