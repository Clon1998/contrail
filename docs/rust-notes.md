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

## Async streams: `Pin<Box<dyn Stream>>`, `stream::unfold`, `StreamExt`

- **What:** a `Stream` is the async version of an `Iterator` (`next().await` instead of `next()`). Each source
  returns its own concrete stream type, so the port hides it behind `Pin<Box<dyn Stream<Item = …> + Send>>`
  (a boxed trait object; `Pin` guarantees it won't move in memory while being polled). `stream::unfold(state,
  step)` builds a stream from a state and an async step function, like a generator; `.chain()`, `.boxed()` and
  `.next()` come from `futures::StreamExt`.
- **Where:** `LiveStream` in `crates/contrail-core/src/logs/source.rs`; `FakeLogs::live`, `AwsLogs::live`.

## `tokio::select!`

- **What:** waits on several futures at once and runs the branch of whichever finishes first (the others are
  dropped/cancelled): here the next stream item, a control change (pause/stop) and a flush timer.
- **Where:** `LiveTask::follow` in `app/src-tauri/src/live.rs`.

## `watch` channels for "latest value" signals

- **What:** `tokio::sync::watch` holds one value that a sender updates and receivers observe (`changed().await`,
  `borrow()`). Ideal for "what should the task be doing now" (run/pause/stop); unlike a queue, only the latest
  value matters.
- **Where:** `Control` and `LiveHandle` in `app/src-tauri/src/live.rs`.

## Borrow guards live until the end of the statement

- **What:** `match *control.borrow_and_update() { … }` keeps the borrow guard alive for the whole `match`, so the
  arms can't borrow `control` again. Copying the value out first (`let current = *control.borrow_and_update();`)
  ends the borrow at the semicolon.
- **Where:** `LiveTask::run` in `app/src-tauri/src/live.rs`.

## `Drop` for cleanup (RAII)

- **What:** `impl Drop for LiveHandle` aborts the task when the handle goes away, so removing a view from the map
  is enough to stop its live tail — like try-with-resources, but automatic for every owner.
- **Where:** `LiveHandle` in `app/src-tauri/src/live.rs`.

## Testing time-based async code on a paused clock

- **What:** `#[tokio::test(start_paused = true)]` (tokio's `test-util` feature) freezes tokio's clock; `sleep`
  and intervals advance instantly once all tasks are idle. The reconnect/backoff/polling tests run in
  milliseconds and deterministically.
- **Where:** tests in `app/src-tauri/src/live.rs`.

## Property-based tests (`proptest`)

- **What:** instead of hand-picked examples, `proptest!` generates hundreds of inputs from strategies (string
  patterns like `"[a-z]{1,6}"`) and checks a property holds for all of them; failures are shrunk to a minimal
  example. Like jqwik/QuickCheck. Used for "the parser never panics", "`-x` is the complement of `x`".
- **Where:** `crates/contrail-core/tests/query_props.rs`.

## Collect before mutating what an iterator reads

- **What:** `self.matched.extend(iter.filter(|e| self.accepts(e)))` doesn't compile: the lazy iterator still
  borrows `self` while `extend` needs `self.matched` mutably. Collecting into a `Vec` first ends the shared
  borrow before the mutation.
- **Where:** `ViewFilter::after_insert` in `crates/contrail-core/src/logs/filter.rs`.

## A hand-written parser with positions

- **What:** the query language is tokenized and parsed by hand (no parser generator): each token remembers its
  byte offset, so errors can point at the exact place (`QueryError { start, end }`). Keys, operators and values
  are split with plain string methods (`strip_prefix`, `char_indices`).
- **Where:** `crates/contrail-core/src/query.rs`.

## Closures vs. `fn` for borrowed returns

- **What:** `let key = |k: &Option<String>| k.as_deref()…` returning a `&str` fails with "lifetime may not live
  long enough": a closure's signature gets no lifetime elision, so the compiler can't tie the returned borrow to
  the argument. A small `fn key(name: &Option<String>) -> Option<&str>` gets the elision rule ("the output
  borrows from the single input") for free.
- **Where:** `key` in `crates/contrail-core/src/logs/mapping.rs`.

## Generic writers and blocking I/O in async code

- **What:** `write_events<W: Write>(…, out: W)` writes to anything implementing `std::io::Write` (a buffered
  file in the app, a `Vec<u8>` in tests), like taking a `java.io.Writer`. File I/O blocks the thread, so the
  async command runs it with `tokio::task::spawn_blocking` (tokio's pool for blocking work) instead of on an
  async worker, and copies the rows out of the mutex first so the lock is held only briefly.
- **Where:** `crates/contrail-core/src/logs/export.rs`, `export_view` in `app/src-tauri/src/commands/logs.rs`.

## Borrowing structs (`JsonRow<'a>`)

- **What:** a struct can hold references instead of owned data: `struct JsonRow<'a> { message: &'a str, … }`.
  The lifetime parameter says the row can't outlive the event it borrows from; serializing it copies nothing.
- **Where:** `JsonRow` in `crates/contrail-core/src/logs/export.rs`.

## Builder-style `with_*` methods that take `self`

- **What:** `LogView::new(…).with_mapping(mapping)` takes `mut self` by value, changes it and returns it:
  ownership moves through the call, so no `&mut` borrow or clone is needed (Java builders return `this`).
- **Where:** `LogView::with_mapping` in `app/src-tauri/src/state.rs`.

## Walking an error's cause chain (`source()` + `iter::successors`)

- **What:** `std::error::Error::source()` returns the wrapped cause, like Java's `getCause()`.
  `std::iter::successors(Some(err), |e| e.source())` turns that into an iterator, so `.last()` gives the
  root cause. `&(dyn Error + 'static)` is needed because `source()` returns `'static` trait objects.
- **Where:** `root_cause` in `crates/contrail-aws/src/error.rs` (short credential messages).

## Hand-written `Deserialize` (`impl<'de> Deserialize<'de>`)

- **What:** `Timestamp` parses an RFC 3339 string itself: deserialize a `String`, then parse it. `'de` is the
  lifetime of the input; a type could borrow from it (zero-copy), this one doesn't and just passes it along.
- **Where:** `crates/contrail-core/src/timestamp.rs` (used by `TimeWindow::Range`).

## Tagged enums across IPC (`#[serde(tag = "kind")]`)

- **What:** `TimeWindow` is `{ "kind": "last", "minutes": 15 }` or `{ "kind": "range", "from", "to" }` in JSON,
  a discriminated union in TypeScript. Like Jackson's `@JsonTypeInfo(property = "kind")` on a sealed interface.
- **Where:** `TimeWindow` in `crates/contrail-core/src/logs/source.rs`.

## Async functions over trait objects (`&dyn LogSource`)

- **What:** `backfill_newest(source: &dyn LogSource, …)` is a plain `async fn` that awaits calls on a trait
  object; the same loop runs against CloudWatch, the demo fake and a test double. Core has no tokio: its tests
  drive the future with `futures::executor::block_on` (a tiny executor, like calling `.join()` on a future).
- **Where:** `crates/contrail-core/src/logs/slices.rs`.

## Matching on a reference, then moving the value (`match &location`)

- **What:** `match &location { SecretsManager { region, .. } => { …; read_secret(location) } }` borrows
  `location` for the pattern; after the last use of `region` the borrow ends (non-lexical lifetimes), so
  `location` can be moved into a function inside the same arm.
- **Where:** `AwsSecrets::reveal` in `crates/contrail-aws/src/secrets.rs`.

## Chained `Option` helpers (`strip_suffix(..)?.strip_suffix('.')?` inside `find_map`)

- **What:** inside a closure returning `Option`, `?` returns `None` early (like Java's `Optional.flatMap` chains,
  but flat). `iter().find_map(|f| …)` returns the first `Some` the closure produces.
- **Where:** `from_fields` in `crates/contrail-core/src/logs/status.rs` (finding `<prefix>.state` fields).

## A one-shot channel as a cancel signal (`tokio::sync::oneshot` + `select!`)

- **What:** `install_update` keeps the sending half of a `oneshot` channel in the app state; `cancel_update`
  sends on it. `tokio::select!` waits for the download or the signal, whichever comes first; the losing future
  is dropped, which stops it (futures only run while polled). Like completing a `CompletableFuture` to
  interrupt work, without threads.
- **Where:** `download` in `app/src-tauri/src/commands/update.rs`.

## Sharing a cached value out of a `Mutex` (`Mutex<HashMap<K, Arc<V>>>`)

- **What:** the route index keeps each cluster's scan as an `Arc<ClusterRoutes>`. A reader locks the map, clones
  the `Arc` (a pointer and a counter bump, not the data) and unlocks; it filters afterwards without holding the
  lock, and a new scan can replace the entry meanwhile without disturbing it. Like handing out an immutable
  snapshot from a `ConcurrentHashMap` instead of copying the value under a `synchronized` block.
- **Where:** `RouteIndex` in `app/src-tauri/src/route_index.rs`.

## Counting without copying: borrowed map keys and `Cow`

- **What:** the field summary counts values in a `HashMap<Cow<'a, str>, u32>` whose keys borrow the text of the
  events in the buffer (`'a` is how long the events live). Text values are `Cow::Borrowed` (no allocation);
  numbers have no text to borrow and become `Cow::Owned(n.to_string())`. `Cow` ("clone on write") is an enum
  of the two, used where a value is usually borrowed but sometimes has to be owned. Only the top values are
  copied into the result, with `to_owned()`. In Java, every key would be a reference anyway; Rust makes the
  borrow explicit, and the compiler checks the map doesn't outlive the events.
- **Where:** `FieldCounter` in `crates/contrail-core/src/logs/fields.rs`.

## Generic `impl IntoIterator` instead of `dyn Iterator`

- **What:** `summarize(events: impl IntoIterator<Item = &'a LogEvent>)` takes all events of a buffer or only the
  matches of a search (two different iterator types). As a generic parameter, the compiler generates a copy of
  the function per type (monomorphization, no virtual calls), unlike a `Box<dyn Iterator>`, which is one
  function calling through a vtable, like a Java interface.
- **Where:** `summarize` in `crates/contrail-core/src/logs/fields.rs`, called from `LogView::field_summary`.

## `Option<&[T]>` as "only these, or all" and `Option::is_none_or`

- **What:** `topic_links(cluster, topics: Option<&[String]>, …)` serves both "the services on these topics"
  (`Some(&topics)`) and "every route of the cluster" (`None`, for the route map). The check is one line:
  `topics.is_none_or(|topics| topics.contains(t))`, true for `None` or when the closure says so. In Java one
  would pass `null` or an empty list meaning "all"; here the type says that "no filter" is a separate case, and
  an empty slice still means "no topics".
- **Where:** `topic_links` / `cluster_routes` in `app/src-tauri/src/commands/ecs.rs`.

## An enum with no data for a direction

- **What:** a trace hop's direction is `enum HopDirection { Writes, Reads }` rather than a `bool`
  (`is_writer`). A `match` on it must handle both cases (the compiler checks), and the serialized form is
  readable (`"writes"` / `"reads"` in TypeScript). Like a Java enum without fields.
- **Where:** `HopDirection` and `direction()` in `crates/contrail-core/src/logs/trace.rs`.

## A generic struct, and `Default` written by hand

- **What:** the session cache of a cluster's scans is `ClusterIndex<T>`, generic over what a scan found, like a
  Java `ClusterIndex<T>`. `type RouteIndex = ClusterIndex<ClusterRoutes>` gives one use a name (a type alias,
  no new type). `#[derive(Default)]` on a generic struct adds the bound `T: Default` to the generated impl, even
  though an empty map needs no default `T`; writing `impl<T> Default for ClusterIndex<T>` by hand avoids that.
- **Where:** `app/src-tauri/src/route_index.rs` (routes and the transformers' startup topology).

## A regex compiled once: `static … LazyLock<Regex>`

- **What:** `static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(…))` builds the regex on first
  use and shares it between threads afterwards, like a lazily initialised `static final Pattern` in Java.
  `Regex::new` inside a function would compile the pattern on every call.
- **Where:** `SECRET_NAME` / `RouteProperty::is_secret` in `crates/contrail-core/src/routes.rs`.

## Methods from a trait that must be in scope (`use base64::Engine`)

- **What:** `STANDARD.decode(…)` only compiles with `use base64::Engine;`: `decode` is a method of the `Engine`
  trait, and Rust only finds trait methods when the trait is imported (Java has no equivalent: an interface's
  methods are always visible on the object). The compiler's error says which trait to import.
- **Where:** `app/src-tauri/src/commands/files.rs`.

## `if let … && let …` (let chains, edition 2024)

- **What:** `if let (LoginProgress::Device { url, .. }, false) = (&progress, demo) && let Err(err) = open(url)`
  matches a pattern and, only if it matched, runs and matches the next expression, all in one `if`. Before edition
  2024 this needed nested `if let` blocks. Like a Java `if (x instanceof Device d && !demo)` with a second check
  that can use `d`.
- **Where:** the `sso_login` command in `app/src-tauri/src/commands/auth.rs`.
