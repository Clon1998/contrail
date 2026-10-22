//! AWS implementations of the `contrail-core` source traits.
//!
//! All `aws-sdk-*` types stay inside this crate and are mapped to domain types before they
//! leave it. Contrail is strictly read-only towards AWS and never stores credentials.

pub mod files;

pub use files::AwsFiles;
