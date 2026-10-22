//! Core of Contrail: domain model, source traits, log parsing, buffering and querying.
//!
//! This crate deliberately has **no AWS dependencies**. The app talks to AWS only through the
//! traits defined here; `contrail-aws` and `contrail-fake` provide the implementations
//! (comparable to a Java interface module with two implementation modules).

pub mod auth;
pub mod ecs;
pub mod error;
mod ini;
pub mod logs;
pub mod prefs;
pub mod profile;
pub mod sso;
pub mod timestamp;
