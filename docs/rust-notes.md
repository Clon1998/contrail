# Rust notes

A running log of Rust patterns used in Contrail, written for a Java/Spring developer.
One short entry per pattern: what it is, why it's used here, where to find it.

## Cargo workspace ≈ Maven multi-module build

- **What:** the root `Cargo.toml` lists member crates (modules) and centrally pins dependency versions in
  `[workspace.dependencies]` (like `<dependencyManagement>` in a parent POM). Members write
  `serde = { workspace = true }`. Lints are shared the same way via `[workspace.lints]`.
- **Why:** one version of each dependency, one lint policy, one `Cargo.lock` for the whole app.
- **Where:** `Cargo.toml`, `crates/*/Cargo.toml`, `src-tauri/Cargo.toml`.

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
- **Where:** bottom of `crates/contrail-core/src/lib.rs` and `src-tauri/src/commands.rs`.

## Library + thin binary crate

- **What:** the app crate has a library (`contrail_lib`, `src-tauri/src/lib.rs`) holding all code and a
  `main.rs` that only calls `contrail_lib::run()`.
- **Why:** code in the library can be unit-tested and reused (Tauri also needs the library for mobile targets).
- **Where:** `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`.

## Attribute macros: `#[tauri::command]`

- **What:** an attribute macro generates code at compile time — here, the glue that deserializes the
  frontend's JSON arguments and serializes the return value. Comparable to what Spring does with
  `@RestController` + Jackson, but at compile time instead of via runtime reflection.
- **Where:** `src-tauri/src/commands.rs`; registered with `tauri::generate_handler!` in `src-tauri/src/lib.rs`.

## `build.rs` build scripts

- **What:** a small Rust program Cargo runs before compiling the crate (like a Maven plugin bound to
  `generate-sources`). Tauri's reads `tauri.conf.json` and capability files.
- **Where:** `src-tauri/build.rs`.
