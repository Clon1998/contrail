//! Fake implementations of the `contrail-core` source traits plus realistic log generators.
//!
//! Powers demo mode (`--demo` / `CONTRAIL_DEMO=1`), end-to-end tests and screenshots.
//! All names, account IDs and URLs are invented.

pub mod auth;
pub mod ecs;
pub mod logs;
pub mod secrets;

pub use auth::FakeAuth;
pub use ecs::FakeEcs;
pub use logs::FakeLogs;
pub use secrets::FakeSecrets;
