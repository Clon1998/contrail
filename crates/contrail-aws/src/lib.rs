//! AWS implementations of the `contrail-core` source traits.
//!
//! All `aws-sdk-*` types stay inside this crate and are mapped to domain types before they
//! leave it. Contrail is strictly read-only towards AWS and never stores credentials.

pub mod auth;
pub mod cli;
mod error;
pub mod files;
mod sts;

pub use auth::AwsAuth;
pub use files::AwsFiles;
