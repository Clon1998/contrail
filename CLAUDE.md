# CLAUDE.md — Contrail

Contrail is a desktop log viewer for AWS ECS services (Tauri 2 + Rust backend, React SPA frontend).
**Read `plan.md` first** — it is the source of truth for scope, architecture and milestones.
Work through the milestones in order. Do not start a milestone before the previous one meets its "Done when".

## About the owner
- Patrick is an experienced **Java/Spring Boot developer, not a Rust developer**. He wants to **learn Rust by reading
  this codebase**. Write idiomatic, clear Rust; prefer readability over cleverness.
- Add short doc comments on non-obvious Rust concepts where they first appear (ownership/borrowing choices,
  lifetimes, `Arc<Mutex<…>>` vs channels, `async` streams, trait objects vs generics). Java analogies are welcome.
- Keep a running `docs/rust-notes.md`: one short entry per notable Rust pattern introduced (what, why, where in code).
- Contrail is Patrick's free-time project for himself and his team. MIT licensed from the first commit.

## Stack (use the latest stable versions at scaffold time — verify, then pin)
- **Rust**: latest stable toolchain, **edition 2024**, pinned via `rust-toolchain.toml`.
- **Tauri 2** (latest 2.x) + official plugins as needed (`store`, `window-state`, `shell`/process spawning, `dialog`, `clipboard-manager`).
- **AWS SDK for Rust**: `aws-config` (SSO support), `aws-sdk-ecs`, `aws-sdk-cloudwatchlogs` (incl. `start_live_tail`), `aws-sdk-sts`.
- **Async/runtime**: `tokio`; errors: `thiserror` in libraries, a serializable error type at the Tauri command boundary; logging: `tracing`.
- **Frontend**: **the same stack as Frida** — React (latest) + Vite SPA, TypeScript strict, shadcn/ui (Radix) +
  Tailwind CSS 4, zustand for state, lucide icons, a virtual-list library for the log view (e.g. TanStack Virtual).
  When in doubt about a frontend pattern, look at how Frida (`../frida-api-tool/app/ui`) does it.
- **Package manager**: pnpm.
- **Tests**: `cargo test`, `insta`, `proptest` (where useful), HTTP/SDK mocking for AWS adapters, Vitest + Testing Library,
  Playwright (UI with mocked Tauri IPC), WebdriverIO + `tauri-driver` (app smoke tests on Linux CI).
- Check docs for each dependency before using APIs you're unsure about; do not guess API shapes from memory.

## Architecture rules
- Workspace crates: `contrail-core` (no AWS deps: domain, traits, parsing, buffer, query), `contrail-aws`, `contrail-fake`, `app/src-tauri`;
  frontend in `app/ui` (same layout as Frida, see plan.md §4.1).
- The app depends on **traits** (`AuthProvider`, `EcsSource`, `LogSource`), never on `aws-sdk-*` types directly.
  AWS types are mapped to domain types inside `contrail-aws`.
- Log buffering, parsing and filtering run **in Rust**; the frontend renders windows of rows from a virtual list.
- Stream log events to the frontend in batches over Tauri `Channel`s; no per-event IPC.
- **Read-only towards AWS.** Never add calls that mutate AWS resources. Contrail never stores credentials.
- **Demo mode** (`--demo` / `CONTRAIL_DEMO=1`) uses `contrail-fake` and must always work — it powers e2e tests and screenshots.

## Testing rules
- No direct AWS access in tests, ever. Use fakes, SDK/HTTP mocks, or an optional emulator job.
- Every feature ships with tests at the right layer (see plan.md §6). Bug fixes start with a failing test.
- Emulator tests are opt-in (`#[ignore]` / separate CI job) and must not block milestones.
  LocalStack now requires an auth token; prefer a free emulator with ECS + CloudWatch Logs if one works well.
- `fixtures/` at the repo root holds **real production log samples. It is gitignored and must never be committed,
  copied into tracked folders, or quoted in commits, docs or code comments.** Use it read-only, only to learn the
  formats (nested ECS, dotted ECS with stack traces, Spring Boot default console pattern) and to sanity-check parsers locally.
- Committed parser fixtures live in `crates/contrail-core/tests/fixtures/` and are **synthetic**: same structure,
  padding, field types and edge cases as the real samples, but neutral content (e.g. `com.example.*` packages,
  invented service/topic/bucket names, a neutral `pipeline.*` object instead of the custom framework fields,
  random IDs, no airline codes or flight keys). Include a plain-text stack trace split into one event per line
  for the multi-line joiner.
- Fake log generators (`contrail-fake`) produce output in exactly these three formats, with the same neutral content.

## Git workflow — act like a professional developer
- **Conventional Commits** for every commit: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`, `ci:`, `build:`, `perf:`,
  with a scope where useful (`feat(logs): parse nested ECS JSON`). Imperative mood, ≤ 72-char subject, body explains *why* when not obvious.
- **Small, focused commits**: one logical change each (e.g. "add query parser for field terms" + its tests). Commit as you go,
  not one big commit per milestone. Tests belong in the same commit as the code they cover, or immediately before it (TDD).
- Every commit must build, pass `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
  Never commit failing tests, commented-out code, or debug prints.
- One branch per milestone (`feat/m3-log-pipeline`). When its "Done when" is met locally, merge it into `main`
  (`git merge --no-ff`) and push `main` to `origin` (github.com/Clon1998/contrail, private): that push triggers CI.
  Watch the run (`gh run watch`); if it fails, fix it on `main` with a normal commit before starting the next
  milestone. A milestone counts as done only with CI green. Don't push feature branches or open PRs unless
  Patrick asks.
- Never rewrite published history. Never commit secrets, real account IDs, ARNs, real log content or anything from `fixtures/`.
- Update `README.md` / `docs/` in the same change when behaviour or setup changes. The hand-written site pages
  (`site/src/content/docs/*.mdx`, e.g. the tracing guide) count too: a visible change to a feature they show means
  updating their text and running `pnpm --dir ui screenshots`.

## Commands (keep this section current as the project evolves)
```bash
# Rust: from the repo root
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all

# App: from app/ (pnpm workspace root; app/ui is the React frontend package)
pnpm install                   # also installs git hooks (lefthook: fmt/lint on commit, commitlint, full suite on push)
pnpm dev                       # run the app (tauri dev: Vite dev server on :1420 + Tauri window)
pnpm dev:demo                  # run in demo mode (fake profiles, no AWS; also CONTRAIL_DEMO=1)
pnpm build                     # build installers for this OS (tauri build)
pnpm build --debug --no-bundle # quick full build check (what CI runs on macOS/Windows)
pnpm lint && pnpm typecheck && pnpm test   # frontend (delegates to app/ui; *.test.ts(x) beside the code)
pnpm format                    # auto-fix ESLint + Prettier
pnpm --dir ui dev              # frontend only, in a browser (no Tauri IPC)
pnpm test:e2e                  # Playwright UI flows (fake backend, WebKit + Chromium)
pnpm --dir ui screenshots      # refresh the website's app screenshots after visible UI changes

# Website: from site/ (Astro + Starlight, deployed to GitHub Pages by .github/workflows/site.yml)
pnpm install && pnpm dev       # landing page, quick start, download + pages from docs/ (site.config.mjs)

# Release: from the repo root on main (CI green), after updating versions and CHANGELOG.md
pnpm --dir app dlx git-cliff@2.14.2 --config ../cliff.toml --repository .. --tag vX.Y.Z -o ../CHANGELOG.md
git tag vX.Y.Z && git push origin vX.Y.Z   # .github/workflows/release.yml builds and publishes
```

## Working style
- Before each milestone, briefly restate its goal and list the commits you intend to make; then execute.
- After each milestone, summarize what was built, what was tested, anything deferred, and what Patrick should
  check manually against a real AWS account (he'll do those smoke tests himself).
- When something in plan.md turns out to be wrong (API limit, library limitation), don't silently diverge:
  note it in `docs/decisions.md` (short ADR style) and adjust the plan.
- Ask Patrick when a decision is genuinely his (UX trade-offs, scope changes). Otherwise pick the sensible default and note it.
- UI: dark-first, dense, keyboard-friendly, smooth at 100k log lines. Original branding only (no airline logos or marks).
