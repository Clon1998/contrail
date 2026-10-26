//! AWS implementations of the `contrail-core` source traits.
//!
//! All `aws-sdk-*` types stay inside this crate and are mapped to domain types before they
//! leave it. Contrail is strictly read-only towards AWS and never stores credentials.

pub mod auth;
pub mod cli;
mod clients;
pub mod ecs;
mod error;
pub mod files;
pub mod logs;
pub mod secrets;
pub mod sso_device;
mod sts;

pub use auth::AwsAuth;
pub use ecs::AwsEcs;
pub use files::AwsFiles;
pub use logs::AwsLogs;
pub use secrets::AwsSecrets;
