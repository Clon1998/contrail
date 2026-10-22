# Rust notes

A running log of Rust patterns used in Contrail, written for a Java/Spring developer.
One short entry per pattern: what it is, why it's used here, where to find it.

## Cargo workspace ≈ Maven multi-module build

- **What:** the root `Cargo.toml` lists member crates (modules) and centrally pins dependency versions in
  `[workspace.dependencies]` (like `<dependencyManagement>` in a parent POM). Members write
  `serde = { workspace = true }`. Lints are shared the same way via `[workspace.lints]`.
- **Why:** one version of each dependency, one lint policy, one `Cargo.lock` for the whole app.
- **Where:** `Cargo.toml`, `crates/*/Cargo.toml`, `app/src-tauri/Cargo.toml`.

## `rust-toolchain.toml` ≈ `.sdkmanrc` / Maven toolchains

- **What:** pins the compiler version; rustup installs it on first use.
- **Why:** everyone (and CI) builds with the same compiler and the same `clippy` rules.
- **Where:** `rust-toolchain.toml`.

## Borrowed `&str` vs owned `String`

- **What:** `&str` is a borrowed, read-only view of text someone else owns; `String` is an owned, growable
  heap string. A function taking `&str` can be called with a `String`, a literal or a slice without copying.
  Returning `String` hands ownership of new data to the caller. There is no garbage collector: the owner
  frees the memory when it goes out of scope.
- **Why:** take the most general borrowed form as input, return owned data as output — the usual idiom.
- **Where:** `contrail_core::greeting` in `crates/contrail-core/src/lib.rs`.

## Unit tests live next to the code (`#[cfg(test)] mod tests`)

- **What:** a `tests` module inside the source file, compiled only for `cargo test`. It can see private items
  through `use super::*`. Integration tests (public API only) go into a crate's `tests/` folder instead.
- **Why:** no separate `src/test/java` tree; tests sit next to what they test.
- **Where:** bottom of `crates/contrail-core/src/lib.rs` and `app/src-tauri/src/commands.rs`.

## Library + thin binary crate

- **What:** the app crate has a library (`contrail_lib`, `app/src-tauri/src/lib.rs`) holding all code and a
  `main.rs` that only calls `contrail_lib::run()`.
- **Why:** code in the library can be unit-tested and reused (Tauri also needs the library for mobile targets).
- **Where:** `app/src-tauri/src/lib.rs`, `app/src-tauri/src/main.rs`.

## Attribute macros: `#[tauri::command]`

- **What:** an attribute macro generates code at compile time — here, the glue that deserializes the
  frontend's JSON arguments and serializes the return value. Comparable to what Spring does with
  `@RestController` + Jackson, but at compile time instead of via runtime reflection.
- **Where:** `app/src-tauri/src/commands.rs`; registered with `tauri::generate_handler!` in `app/src-tauri/src/lib.rs`.

## `build.rs` build scripts

- **What:** a small Rust program Cargo runs before compiling the crate (like a Maven plugin bound to
  `generate-sources`). Tauri's reads `tauri.conf.json` and capability files.
- **Where:** `app/src-tauri/build.rs`.

## Enums with data (sum types) + serde tags

- **What:** each enum variant can carry its own fields (`ProfileAuth::Sso { account_id, … }`,
  `ProfileAuth::StaticKeys`). Like a Java sealed interface with one record per case, and `match` must handle
  every variant (the compiler checks). `#[serde(tag = "kind")]` serializes as `{ "kind": "sso", … }`, which the
  generated TypeScript sees as a discriminated union.
- **Where:** `ProfileAuth` in `crates/contrail-core/src/profile.rs`, `SessionStatus` in `sso.rs`.

## Lifetimes on borrowed return values (`'a`)

- **What:** `fn sso_session<'a>(&'a self) -> Option<SsoSessionRef<'a>>` returns references *into* `self`
  instead of copies. The `'a` tells the compiler the result can't outlive the profile it borrows from, so a
  dangling reference is a compile error, not a runtime bug.
- **Where:** `ProfileAuth::sso_session` in `crates/contrail-core/src/profile.rs`.

## Newtypes

- **What:** a one-field tuple struct (`struct Timestamp(OffsetDateTime)`) gives an existing type its own
  behaviour (here: serialization as an RFC 3339 string, and a `string` in TypeScript) at zero runtime cost.
- **Where:** `crates/contrail-core/src/timestamp.rs`.

## Errors: `thiserror`, `Result` and `?`

- **What:** `#[derive(thiserror::Error)]` turns an enum into an error type with `Display` messages from
  `#[error("…")]` attributes. Functions return `Result<T, E>`; `?` returns early with the error, converting it
  via a `From` impl if the types differ (e.g. `AuthError` → `ApiError` at the Tauri boundary). No exceptions:
  every fallible call is visible in the signature.
- **Where:** `AuthError` in `crates/contrail-core/src/auth.rs`; `impl From<AuthError> for ApiError` in
  `app/src-tauri/src/error.rs`.

## Trait objects: `Arc<dyn AuthProvider>` and `#[async_trait]`

- **What:** `dyn AuthProvider` is "some type implementing the trait, decided at runtime" (dynamic dispatch, like
  a Java interface reference). `Arc` is a thread-safe, reference-counted shared pointer. The app chooses
  `AwsAuth` or `FakeAuth` at start-up and only sees the trait. Native `async fn` in traits can't be used through
  `dyn` yet, so `#[async_trait]` rewrites them into methods returning boxed futures.
- **Generics vs trait objects:** generics (`fn f<T: AuthProvider>(t: T)`) are resolved at compile time, one copy
  per type, no indirection; trait objects allow choosing at runtime. We need the latter here.
- **Where:** `crates/contrail-core/src/auth.rs`, `app/src-tauri/src/state.rs`.

## Interior mutability: `Mutex` behind `&self`

- **What:** `FakeAuth::login(&self)` only has a shared reference but must update its token map. A `Mutex`
  allows mutation through `&self` safely across threads (like `synchronized`). `std::sync::Mutex` is fine as
  long as the lock is never held across an `.await`; otherwise use `tokio::sync::Mutex`.
- **Where:** `crates/contrail-fake/src/auth.rs`.

## Callbacks as `&dyn Fn`

- **What:** `progress: &(dyn Fn(LoginProgress) + Send + Sync)` borrows a closure from the caller; the callee
  may call it many times but can't keep it. `Send + Sync` allow calling it from async code on other threads.
- **Where:** `AuthProvider::login`; the Tauri command passes a closure that forwards to a `Channel`
  (`app/src-tauri/src/commands/auth.rs`).

## Async processes: `tokio::process` and `tokio::join!`

- **What:** `tokio::process::Command` spawns a process without blocking a thread; `join!` awaits several
  futures concurrently (here: process exit, stdout and stderr), like `CompletableFuture.allOf`.
  `kill_on_drop(true)` kills the process if the future is dropped (e.g. cancelled).
- **Where:** `sso_login` in `crates/contrail-aws/src/cli.rs`.

## `impl Trait` in argument position

- **What:** `fn forward_lines(pipe: impl AsyncRead + Unpin, …)` accepts any type implementing the trait.
  The compiler generates one version per concrete type (monomorphization), unlike Java's erased generics.
- **Where:** `crates/contrail-aws/src/cli.rs`.

## Conditional compilation: `#[cfg(…)]`

- **What:** `#[cfg(unix)]`, `#[cfg(test)]`, `#[cfg(debug_assertions)]` include code only for some targets or
  builds (no runtime check). `cfg!(windows)` is the expression form.
- **Where:** `is_executable` in `crates/contrail-aws/src/cli.rs`; binding export in `app/src-tauri/src/lib.rs`.

## Generated TypeScript bindings (tauri-specta)

- **What:** `#[specta::specta]` on commands and `#[derive(specta::Type)]` on types let tauri-specta write
  `app/ui/src/bindings.ts` with typed functions for every command. Rename a field in Rust and the frontend
  stops compiling until it's updated.
- **Where:** `specta_builder` in `app/src-tauri/src/lib.rs`.

## Mocking the AWS SDK (`aws-smithy-mocks`)

- **What:** `mock!(Client::get_caller_identity).then_output(…)` + `mock_client!(aws_sdk_sts, [&rule])` builds a
  real SDK client whose responses come from the rule, without HTTP. Similar to Mockito, but at the SDK's
  interceptor level, so request building and response mapping are still exercised.
- **Where:** tests in `crates/contrail-aws/src/sts.rs`.
