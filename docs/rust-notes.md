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

## Paginators and concurrent batches (`chunks` + `try_join_all`)

- **What:** SDK list calls return pages; `into_paginator().items().send().collect::<Result<Vec<_>, _>>()`
  walks all pages and stops at the first error. Describe calls take limited batches, so the ARNs are split with
  `slice.chunks(10)`, each chunk becomes an `async move { … }` block (a future, not yet running), and
  `futures::future::try_join_all` runs them concurrently and fails fast — like `CompletableFuture.allOf` with
  short-circuiting on the first exception.
- **Where:** `list_services` in `crates/contrail-aws/src/ecs.rs`.

## Don't hold a `std::sync::Mutex` across `.await`

- **What:** the SDK client cache locks, checks, and *releases* the lock before awaiting the (slow) client
  creation, then locks again to insert. Holding a std mutex guard across an `.await` can block the executor
  thread (and the guard isn't `Send`). Two concurrent misses may both build a client; harmless here.
- **Where:** `AwsEcs::client` in `crates/contrail-aws/src/ecs.rs`.

## `Option` combinators instead of nested `if let`

- **What:** `deployments().iter().find(…).and_then(|d| d.task_definition()).or(svc.task_definition())` reads
  as "the primary deployment's task definition, else the service's" — like `Optional.flatMap(…).or(…)` in Java.
- **Where:** `describe_service` in `crates/contrail-aws/src/ecs.rs`.

## Sorting with tuple keys and `Reverse`

- **What:** `sort_by_key(|t| (t.last_status == "STOPPED", Reverse(time)))` sorts by several criteria at once:
  tuples compare element by element, `false < true` puts running tasks first, `Reverse` flips to newest first.
- **Where:** `sort_tasks` in `crates/contrail-core/src/ecs.rs`.

## `impl FnOnce(&mut T)` for "apply a change, then save"

- **What:** `PrefsStore::update(|p| p.add_recent(key))` takes a closure that is called once with a mutable
  borrow of the preferences while the lock is held; the store then writes the file. The caller can't forget
  to save or to lock. (`FnOnce` = may consume what it captures, e.g. `key`.)
- **Where:** `app/src-tauri/src/prefs_store.rs`, used in `app/src-tauri/src/commands/prefs.rs`.

## Atomic file writes

- **What:** write to `prefs.json.tmp`, then `rename` over `prefs.json`. Rename is atomic on the same file
  system, so a crash never leaves half a file behind.
- **Where:** `write_atomically` in `app/src-tauri/src/prefs_store.rs`.

## Tauri's `setup` hook

- **What:** `Builder::setup(|app| …)` runs once the app exists, when paths like `app_data_dir()` are known;
  the state is created there and registered with `app.manage(state)`. Errors returned with `?` abort start-up.
- **Where:** `run` in `app/src-tauri/src/lib.rs`.

## Test data generated from Rust (`#[cfg(test)] mod demo_data`)

- **What:** a test records the demo ECS landscape as JSON for the frontend's fake backend (like the
  `bindings.ts` export). A module behind `#[cfg(test)]` exists only in test builds.
- **Where:** `app/src-tauri/src/demo_data.rs`.

## Custom deserialization (`deserialize_with`)

- **What:** `#[serde(deserialize_with = "settings_or_default")]` runs a function instead of the derived
  deserializer for one field. Here it reads the field as generic JSON first and falls back to the defaults if
  it doesn't fit, so an unknown setting can't make the whole preferences file unreadable. The function is
  generic over serde's `Deserializer` (`D: serde::Deserializer<'de>`, where `'de` is the lifetime of the
  input being read).
- **Where:** `Prefs::from_json` in `crates/contrail-core/src/prefs.rs`.

## `LazyLock` for compiled regexes

- **What:** `static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(…).unwrap())` compiles a regex once,
  on first use, thread-safely — like a lazily initialized `static final` in Java. Compiling per call would be
  slow for 100k log lines.
- **Where:** `crates/contrail-core/src/logs/spring.rs`, `parse.rs`, `multiline.rs`.

## `Cow<str>`: borrow when possible, own when needed

- **What:** `strip_ansi` returns `Cow<'_, str>` ("clone on write"): the original `&str` when there was nothing to
  remove (no allocation), an owned `String` when something was. Most log lines have no colour codes.
- **Where:** `strip_ansi` in `crates/contrail-core/src/logs/parse.rs`.

## `let … else` and `if let … && let …`

- **What:** `let Ok(Value::Object(map)) = serde_json::from_str(line) else { return None; };` destructures or
  leaves the function — no nesting. Edition 2024 also allows chaining conditions with `let`:
  `if x.starts_with('{') && let Some(parsed) = parse_json(x) { … }`.
- **Where:** `parse_json` in `crates/contrail-core/src/logs/json.rs`, `parse_line` in `parse.rs`.

## The borrow checker and split borrows

- **What:** `self.pending.get_mut(…)` mutably borrows `self.pending`; while that reference is alive, calling a
  method on `&self` (which borrows *all* of `self`) is rejected. The fix: copy what's needed (`let window =
  self.window;`) and call a free function. Borrowing distinct fields separately is fine; borrowing the whole
  struct while part of it is mutably borrowed is not. Java has no such rule — and no protection against
  modifying a map while iterating it either.
- **Where:** `MultilineJoiner::push` in `crates/contrail-core/src/logs/multiline.rs`.

## `VecDeque` + `partition_point`

- **What:** `VecDeque` is a ring buffer (like `ArrayDeque`) with O(1) removal at the front, so evicting the
  oldest event is cheap. Late events are inserted at `partition_point(|e| key(e) <= key)` — a binary search for
  the first position where the condition stops holding.
- **Where:** `LogBuffer::insert` in `crates/contrail-core/src/logs/buffer.rs`.

## Untagged enums and specta type overrides

- **What:** `#[serde(untagged)] enum FieldValue { Text(String), Number(…), Bool(bool) }` serializes only the
  inner value, so JSON and TypeScript see `"x" | 42 | true`. `#[specta(type = f64)]` tells the bindings
  generator to describe a field as a different type (here `serde_json::Number` as a TypeScript `number`).
- **Where:** `FieldValue` in `crates/contrail-core/src/logs/mod.rs`; `Timestamp` uses the same idea.

## Atomics for counters

- **What:** `AtomicU32::fetch_add(1, Ordering::Relaxed)` hands out unique view IDs without a lock (like Java's
  `AtomicInteger.getAndIncrement()`). `Relaxed` is enough: only uniqueness matters, not ordering with other memory.
- **Where:** `next_view_id` in `app/src-tauri/src/state.rs`, used in `commands/logs.rs`.
