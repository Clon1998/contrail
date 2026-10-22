# Contrail — Implementation Plan

> A fast, focused desktop log viewer for AWS ECS services.
> Switch AWS SSO profiles, browse clusters → services → tasks, and jump straight into
> live, readable logs — structured (ECS JSON) or plain — with session search.

**Owner:** Patrick · **License:** MIT · **Stack:** Tauri 2 (Rust) + Nuxt (SPA) — same approach as Frida
**Audience (v1):** Patrick and his team. Built in free time.

---

## 1. Problem & goals

The CloudWatch console makes tailing clumsy and its search weak. Splunk (fed via Firehose)
works for deep history, but structured logs make it hard to focus on the actual `message`.

**Goals (v1)**
1. One click from "which AWS account?" to "live logs of service X" — no log group names typed.
2. Logs are readable: message-first for ECS JSON, raw for plain text, stack traces intact.
3. Fast, session-scoped search and filtering over what's loaded.
4. Useful ECS context at a glance: task count, health, deployments, stop reasons.
5. Strictly read-only towards AWS.

**Non-goals (v1)**
- Long-range historical search (Splunk does that).
- Any mutating ECS action (stop/restart/scale/deploy).
- Multi-container tasks / sidecars (designed for, not built — see §10).
- Lambda / non-ECS log groups (later).

---

## 2. Environment facts (from Patrick)

| Topic | Fact | Consequence |
|---|---|---|
| Auth | 8 AWS accounts, all via SSO (IAM Identity Center) | Profiles come from `~/.aws/config`; SSO expiry + login flow is a first-class feature |
| Log routing | All ECS logs go to CloudWatch (`awslogs` driver), then Firehose → Splunk | We read CloudWatch only; log group/stream are resolvable from the task definition |
| Log format | Spring Boot structured logging, format `ecs` — but real samples show **three formats in prod**: nested ECS, dotted ECS (older Spring Boot), and Spring Boot's default plain-text console pattern | All three are first-class parsers (see §5.3); real samples in gitignored `fixtures/`, synthetic ones committed |
| Containers | One container per task, no sidecars | Task view = that container's stream; keep a `container` field in the model anyway |
| Permissions | Patrick is admin; Live Tail allowed | Live Tail is the default streaming mode |
| Platform | Desktop app, Mac/Linux/Windows, same as Frida | Tauri 2 + Nuxt in SPA mode |

---

## 3. Feature scope (v1)

### 3.1 Profiles & auth
- Parse `~/.aws/config` (+ `~/.aws/credentials`), honouring `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`.
- Profile switcher (search-as-you-type) showing account ID, region and SSO session status
  (valid / expiring soon / expired).
- Region override per profile (defaults to the profile's region).
- SSO login: when the session is expired, a "Log in" button runs `aws sso login --profile <p>`
  (spawned process; browser opens as usual) and polls until the token cache is valid.
  - Detect whether the AWS CLI is installed; show a clear message if not.
  - Stretch (later): built-in OIDC device-authorization flow via `aws-sdk-ssooidc`, so the CLI isn't needed.
- `sts:GetCallerIdentity` check after switching, shown as "connected as …".

### 3.2 ECS navigation & metadata
- Tree: **Cluster → Service → Tasks** (running + recently stopped).
- Service card: desired / running / pending counts, deployment list with rollout state,
  task definition family:revision, image tag, launch type, CPU/memory.
- Task row: short task ID, last status, health status, started at, AZ, task def revision;
  stopped tasks show stop code + stopped reason + container exit code.
- Manual refresh plus light auto-refresh (e.g. every 30 s for the visible service only).
- ⌘K / Ctrl+K command palette: fuzzy-jump to any service across clusters of the current profile
  (and recently opened ones across profiles).
- Favorites (pinned services per profile), persisted locally.

### 3.3 Log views
- Log location resolved automatically from the task definition's `logConfiguration`
  (`awslogs-group`, `awslogs-stream-prefix`, `awslogs-region`).
  Stream name convention: `<prefix>/<containerName>/<taskId>`.
- **Service view:** all tasks of the service merged by timestamp; each line has a coloured task badge
  (short task ID). Includes recently stopped tasks within the chosen backfill window.
- **Task view:** a single task's stream.
- Open flow: choose backfill window (5 min / 15 min / 1 h / 6 h / custom, default 15 min) → backfill
  → switch to live.
- Controls: pause/resume, follow mode (auto-scroll until the user scrolls up), clear, "jump to now".
- When new tasks start in a service (deployment), the service view picks them up automatically
  (re-evaluate stream set on refresh and restart the tail with the new set).

### 3.4 Structured vs plain logs
- Every event is classified per line: ECS JSON, other JSON, or plain text.
- **Message-first rendering:** `time · level · [task] · message` with optional extra columns
  (logger, thread, trace.id, service.name, any MDC field).
- Click/Enter expands a line: pretty-printed JSON with syntax highlighting + copy buttons
  (copy message / copy JSON / copy as single line).
- Stack traces: `error.stack_trace` rendered as a collapsible block below the message;
  `error.type` + `error.message` shown inline in red.
- Plain text: a dedicated parser for **Spring Boot's default console pattern** (see §5.3) that extracts
  timestamp, level, app name, thread and logger, so plain services get the same message-first view.
  Other plain lines: ANSI colour support, level detection by regex (`ERROR|WARN|INFO|DEBUG|TRACE`),
  and multi-line re-joining (Java stack-trace continuation lines that CloudWatch split into separate events).
- Embedded JSON in messages (e.g. an HTTP error body inside an ERROR line) is detected and can be
  pretty-printed in the expanded view.
- Per-service "field mapping" override (which key is message/level/timestamp), with ECS defaults.

### 3.5 Session search & filters
- Operates on the in-memory buffer of the current view (no CloudWatch queries).
- Query syntax (small, documented in-app):
  - `timeout` — free text, case-insensitive, matches message (and full raw line when toggled)
  - `/time(out|d out)/` — regex
  - `level:ERROR`, `level>=WARN`
  - `trace.id:abc123`, `log.logger:*Camel*` (glob on any field)
  - `-healthcheck` — exclusion
  - terms combine with AND
- Level toggle chips (ERROR / WARN / INFO / DEBUG / TRACE) with counts.
- "Highlight only" vs "filter" mode; next/previous match navigation (F3 / Shift+F3, Enter in search box).
- Click any field value in an expanded line → add as filter.
- "Hide noise" list per service (persisted), e.g. health-check lines.
- Ring buffer, configurable max (default 100 000 events per view); oldest evicted, with an indicator.

### 3.6 Workflow
- Tabs: several views open at once (different services, profiles mixed is fine).
- Live tails of background tabs pause automatically after N minutes (default 10) to save Live Tail cost;
  resume on focus with a gap backfill.
- Export current (filtered) view as `.log` (messages) or `.jsonl` (raw events).
- Settings: buffer size, default backfill window, auto-pause minutes, theme (dark default / light),
  font size, timestamp format (local / UTC), columns.
- Keyboard-first: shortcuts for palette, search, follow toggle, level toggles, tab switching.

### 3.7 Look & feel
- "Modern / flashy" but dense: dark-first, mono font for log lines, subtle accent colour,
  smooth virtual scrolling at 100k lines.
- Branding: name **Contrail**, a simple contrail/plane-trail icon (original artwork, no airline marks).

---

## 4. Architecture

```
┌──────────────────────── Nuxt (SPA, ssr:false) ────────────────────────┐
│ pages/components (Nuxt UI) · Pinia stores · virtual log list           │
│   ↑ events via Tauri Channel (batched)   ↓ invoke() commands           │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ Tauri IPC
┌───────────────────────────────┴──────── src-tauri (app crate) ────────┐
│ commands/  state (AppState: sessions, views)  settings (plugin-store) │
└──────────────┬───────────────────────────────┬────────────────────────┘
               │                               │
     contrail-core (pure Rust)        contrail-aws / contrail-fake
     - domain model                   - impl traits with aws-sdk-* (real)
     - traits: AuthProvider,          - impl traits with generators (fake/demo)
       EcsSource, LogSource
     - parsers (ECS, JSON, plain)
     - multiline joiner
     - LogBuffer (ring) + query engine
```

### 4.1 Workspace layout
```
contrail/
├─ Cargo.toml                 # workspace
├─ crates/
│  ├─ contrail-core/          # no AWS deps; domain, traits, parsing, buffer, query
│  ├─ contrail-aws/           # real AWS implementations
│  └─ contrail-fake/          # fake implementations + realistic log generators
├─ src-tauri/                 # Tauri app crate: commands, state, wiring
├─ app/                       # Nuxt 4+ app dir (components, pages, stores, composables)
├─ tests/e2e/                 # Playwright (UI with mocked IPC) + WebdriverIO/tauri-driver
├─ docs/                      # architecture.md, rust-notes.md, iam-policy.json, query-syntax.md
├─ nuxt.config.ts · package.json · LICENSE (MIT) · README.md · CLAUDE.md
```

### 4.2 Key traits (contrail-core)
```rust
#[async_trait] // or native async fn in traits if sufficient
pub trait AuthProvider {
    async fn list_profiles(&self) -> Result<Vec<Profile>>;
    async fn session_status(&self, profile: &ProfileId) -> Result<SessionStatus>;
    async fn login(&self, profile: &ProfileId) -> Result<()>;
}

pub trait EcsSource {
    async fn list_clusters(&self, ctx: &AwsCtx) -> Result<Vec<Cluster>>;
    async fn list_services(&self, ctx: &AwsCtx, cluster: &ClusterArn) -> Result<Vec<ServiceSummary>>;
    async fn describe_service(&self, ctx: &AwsCtx, svc: &ServiceRef) -> Result<ServiceDetail>;
    async fn list_tasks(&self, ctx: &AwsCtx, svc: &ServiceRef, include_stopped: bool) -> Result<Vec<Task>>;
    async fn log_location(&self, ctx: &AwsCtx, task: &Task) -> Result<LogLocation>;
}

pub trait LogSource {
    async fn backfill(&self, ctx: &AwsCtx, sel: &StreamSelection, range: TimeRange) -> Result<Vec<RawEvent>>;
    fn live(&self, ctx: &AwsCtx, sel: &StreamSelection) -> BoxStream<'static, Result<LiveItem>>;
}
```
Exact signatures are the agent's call; the point is: **the app depends on traits, never on aws-sdk types directly.**

### 4.3 Log pipeline
1. **Resolve** `StreamSelection` = log group + list of stream names (service view: all task streams
   in window; task view: one).
2. **Backfill** via `FilterLogEvents` (paginated, `logStreamNames` ≤ 100, `startTime`/`endTime`).
3. **Live** via `StartLiveTail` (`logGroupIdentifiers` as ARNs, `logStreamNames`).
   - Handle `SessionStart`, `SessionUpdate` (incl. `sessionResults` + sampled flag), errors, and the
     session time limit → transparent reconnect with a small gap backfill.
   - Show a "sampled" badge if CloudWatch reports sampling.
   - Fallback: polling `FilterLogEvents` every 2 s with `startTime = lastSeen - overlap`.
   - **Verify all Live Tail limits against current AWS docs at implementation time**
     (max log groups, max stream names, session duration, sampling threshold).
4. **Dedupe** at backfill→live seam and on reconnect by `(stream, eventId)` or `(stream, timestamp, hash)`.
5. **Normalize** → `LogEvent { id, ts, ingestion_ts, task_id, stream, kind, level, message, fields, raw, error }`.
6. **Multi-line join** for plain text (continuation heuristics: leading whitespace + `at `, `Caused by:`,
   `... N more`, `\t`), same stream, within a short time window.
7. **Buffer** per view (ring buffer) with incremental index for level counts.
8. **Emit** to frontend in batches (e.g. every 50–100 ms or 500 events) over a Tauri `Channel`.

### 4.4 Buffer & query (where filtering runs)
- Buffer and query engine live in Rust (`contrail-core`) → unit-testable, fast, and good Rust learning material.
- Frontend keeps a virtual list; it requests windows: `get_view_rows(view_id, filter_id, offset, limit)`
  and receives `ViewStats { total, matched, per_level_counts }` updates.
- Query string parsed in Rust into an AST (`parse_query`) with good error messages (position + hint);
  filter compiled once, evaluated incrementally on new events.

### 4.5 Persistence (local only)
`tauri-plugin-store`: favorites, recent services, per-service field mappings and noise lists, settings,
column layouts. `tauri-plugin-window-state` for window geometry. **No credentials are ever stored by Contrail**
— the AWS SDK reads the standard SSO token cache.

---

## 5. Domain details

### 5.1 ECS service → log streams
- `DescribeServices` → task definition ARN(s) (one per active deployment).
- `DescribeTaskDefinition` → container definitions → `logConfiguration` (`logDriver == "awslogs"`).
- `ListTasks` (`desiredStatus=RUNNING`, plus `STOPPED` for the window) → `DescribeTasks` (batches of 100).
- Stream = `<awslogs-stream-prefix>/<containerName>/<taskId>`.
- If `logDriver != awslogs` or prefix missing → show a clear "can't resolve logs for this service" state.
- Cache task definitions (immutable per revision).

### 5.2 Metadata shown
Service: status, desired/running/pending, deployments (`rolloutState`, counts, created/updated),
task def family:revision, image (tag), CPU/memory, launch type/platform version.
Task: lastStatus, desiredStatus, healthStatus, createdAt/startedAt/stoppedAt, stopCode, stoppedReason,
container exitCode/reason, AZ, task def revision.

### 5.3 Log formats (from real, anonymized prod samples)
Real samples live in the gitignored `fixtures/` (company name replaced with `acme`, one event per line).
They are never committed. In M3, create **synthetic** look-alikes in `crates/contrail-core/tests/fixtures/`
(see CLAUDE.md) and build parser + snapshot tests on those; use the real ones only for local sanity checks.

| Fixture | Format | Seen in |
|---|---|---|
| `ecs-nested.jsonl` (50 events) | ECS, **nested** objects (newer Spring Boot) | `orders-output` 11.x |
| `ecs-dotted-errors.jsonl` (5 events) | ECS, **dotted** keys, ERROR/WARN with stack traces | `inventory-pipelines` 10.x |
| `plain-spring-default.log` (50 events) | Spring Boot default console pattern, plain text | `shipment-tracker` |

**A) ECS nested** — e.g.
```json
{"@timestamp":"…Z","log":{"level":"INFO","logger":"com.acme.pipeline…StatusManagerService"},"process":{"pid":1,"thread":{"name":"…-0-C-1"}},"service":{"name":"orders-output","version":"11.0.0-SNAPSHOT","environment":"PROD","node":{}},"message":"Document status change: […] PUBLISHED -> CONSUMING (…)","fw":{"state":"CONSUMING","correlationId":"…","topicName":"…","partition":0,"offset":230328,…},"ecs":{"version":"8.11"}}
```
**B) ECS dotted** — same fields as flat keys: `"log.level"`, `"log.logger"`, `"process.thread.name"`,
`"error.type"`, `"error.message"`, `"error.stack_trace"`.

Parser rules for A + B:
- Flatten nested objects to dotted paths before lookup, so both shapes map to one field model.
  Empty objects (`"node":{}`) are dropped.
- Field defaults: timestamp `@timestamp` (nanosecond precision — keep it), level `log.level`, message
  `message`, logger `log.logger`, thread `process.thread.name`, service `service.name`/`service.version`/
  `service.environment`, errors `error.type` / `error.message` / `error.stack_trace`, tracing `trace.id` / `span.id`.
- **Custom nested objects are common**: the internal pipeline framework adds a `fw.*` object (`fw.state`,
  `fw.previousState`, `fw.correlationId`, `fw.topicName`, `fw.partition`, `fw.offset`, `fw.routeId`, …).
  These must be first-class filterable fields (`fw.correlationId:…`, `fw.state:COMPLETED`) and selectable as
  columns. `fw.correlationId` is a good default "correlation" column when present.
- Numeric fields (`fw.offset`, `fw.partition`) stay numbers in the model.
- Stack traces: `error.stack_trace` contains `\n\t` and JSON-escaped `\/`; render as a collapsible block with
  `Caused by:` lines highlighted and `... N common frames omitted` dimmed. Traces can be 80+ frames — collapse by default.
- Fallbacks: if a line is JSON but not ECS, try common keys (`msg`, `level`, `timestamp`, `time`).
- Use the event's own `@timestamp` for display; keep CloudWatch timestamp for ordering ties.

**C) Spring Boot default console pattern (plain text)** — e.g.
```
2026-10-22T18:31:46.629Z ERROR 1 --- [shipment-tracker] [   scheduling-1] c.e.s.t.ShipmentPollingService          : Error while polling … Error: 404 Not Found: "{"title":"Shipment not found","status":404,…}"
```
- Pattern: `<ISO timestamp> <LEVEL padded> <pid> --- [<app name>] [<thread, left-padded>] <logger, right-padded> : <message>`.
  Parse into the same model (timestamp, level, `process.pid`, `service.name`, `process.thread.name`,
  `log.logger`, message); trim padding. Logger names are abbreviated (`c.e.s.t.…`) — show as-is.
- Be lenient: older Spring Boot versions omit the `[<app name>]` block; lines that don't match fall back to
  generic plain text.
- Messages may contain embedded JSON (here an HTTP problem-detail body) — detect the first balanced `{…}`
  and offer it pretty-printed in the expanded view.
- Note on samples: the AWS CLI's `--output text` joins events with tabs. Real CloudWatch events are one
  per event, as in the fixtures; don't build tab-splitting into the parser.

---

## 6. Testing strategy

Direct AWS access is not available in tests. Layers:

| Layer | Tool | What |
|---|---|---|
| Rust unit | `cargo test` (+ `insta` snapshots, `proptest` where useful) | parsers, flattening, multiline joiner, query parser/evaluator, ring buffer, dedupe, stream-name resolution, profile/config parsing |
| Rust component | `cargo test` with `contrail-fake` | log pipeline end-to-end (backfill → live → dedupe → buffer), reconnect logic, auto-pause |
| Rust AWS adapter | `wiremock`/`aws-smithy-mocks` (whichever fits current SDK best) | request building + response mapping for ECS + CloudWatch Logs calls |
| Emulator integration (optional, `#[ignore]` by default / separate CI job) | AWS emulator via `testcontainers` | ECS + CloudWatch Logs read paths against an emulator |
| Frontend unit | Vitest + `@nuxt/test-utils` + Vue Test Utils | stores, composables, components (log row rendering, filter chips, palette) |
| UI e2e | Playwright against the Nuxt dev server with Tauri IPC mocked (`@tauri-apps/api/mocks`), backed by recorded fake data | user flows: pick profile → service → view logs → search → expand → export |
| App e2e (smoke) | WebdriverIO + `tauri-driver` on Linux CI, app started in **demo mode** | app boots, tree loads from fake source, logs stream, search works |

**Emulator note:** LocalStack's free community image was replaced in March 2026 by an image that requires
an auth token; ECS may need a paid tier. Evaluate a free emulator with ECS + CloudWatch Logs support
(e.g. Floci or fakecloud) first; LocalStack only if a token is available. Live Tail is a streaming API that
emulators are unlikely to support — the fake source is the main test path for it. Don't let emulator work
block milestones.

**Demo mode** (`contrail --demo` or env `CONTRAIL_DEMO=1`): uses `contrail-fake` with a few fake profiles,
clusters, services (incl. one crash-looping service with stopped tasks, one plain-text service, one
with stack traces, one high-volume) — drives e2e, screenshots and frontend development.

---

## 7. Milestones

Each milestone ends with: all tests green, lint clean, README/docs updated, merged to `main`.
Commits are small and conventional throughout (see CLAUDE.md).

### M0 — Scaffold & tooling
- Cargo workspace (core, aws, fake, src-tauri), Tauri 2 app, Nuxt (SPA, `ssr: false`), pnpm.
- MIT `LICENSE`, `README.md` skeleton, `docs/`.
- Lint/format: `rustfmt`, `clippy -D warnings`, ESLint (`@nuxt/eslint`), Prettier or ESLint stylistic, `vue-tsc` typecheck.
- Git hooks (lefthook or husky) for format + commitlint (Conventional Commits).
- GitHub Actions CI: Rust fmt/clippy/test, frontend lint/typecheck/test, on Linux (+ build check on macOS/Windows).
- Hello-world IPC command with a passing Rust test and a passing Vitest test.
- **Done when:** `pnpm tauri dev` opens a window; CI is green.

### M1 — Profiles & SSO auth
- Config parser for profiles + `sso-session` sections; profile list command.
- Session status from SSO token cache; GetCallerIdentity check.
- `aws sso login` integration with progress state and CLI-missing handling.
- UI: profile switcher, status badge, region selector, login button.
- **Done when:** with demo mode the flow is fully testable; with Patrick's real config, all 8 profiles appear
  and expired sessions can be logged into.

### M2 — ECS discovery & metadata
- `EcsSource` (aws + fake): clusters, services, tasks (running + stopped), service detail.
- UI: sidebar tree, service overview panel (counts, deployments, health), task list with stop reasons.
- ⌘K palette, favorites, recent.
- **Done when:** navigation works in demo mode with e2e coverage; real-account smoke test by Patrick.

### M3 — Log pipeline core (Rust-heavy)
- Log location resolution from task definitions.
- Parsers: ECS (dotted + nested), Spring Boot default console pattern, generic JSON, plain (level regex, ANSI kept).
  Snapshot tests on every event in the synthetic fixtures (`crates/contrail-core/tests/fixtures/`).
- Multi-line joiner, ring buffer, dedupe, backfill via `FilterLogEvents`.
- Fake generators for realistic ECS/plain logs incl. stack traces.
- **Done when:** extensive unit tests + snapshot tests on fixtures; backfill works in demo and real mode (debug UI ok).

### M4 — Log viewer UI
- Virtualized log list (100k rows smooth), message-first rows, task badges, level colours.
- Expand row → JSON view, stack trace block, copy actions.
- Column configuration; service view vs task view; backfill window picker; follow mode; pause.
- **Done when:** Playwright flows cover open → read → expand → copy; manual perf check at 100k lines.

### M5 — Live streaming
- `StartLiveTail` adapter with session handling, reconnect, sampling indicator.
- Polling fallback; automatic switch on Live Tail errors.
- Stream-set refresh on deployments; background-tab auto-pause + gap backfill on resume.
- **Done when:** fake-source tests cover reconnect/dedupe/auto-pause; Patrick confirms live tail on a real service.

### M6 — Session search & filters
- Query parser (AST + error positions), evaluator, incremental filtering, level counts.
- UI: search bar with syntax help, highlight vs filter mode, match navigation, level chips,
  click-to-filter on fields, noise list.
- **Done when:** query engine has thorough unit/property tests; e2e covers the main query types.

### M7 — Workflow polish
- Tabs, export (.log/.jsonl), settings page, field mapping editor, keyboard shortcuts overview, themes.
- Error states & empty states reviewed (no permissions, no logs, non-awslogs driver, expired SSO mid-tail).
- **Done when:** a "day in the life" e2e scenario passes; UX review with Patrick.

### M8 — Release
- GitHub Actions release workflow (`tauri-action`) building macOS (arm64 + x64), Windows, Linux artifacts
  on tag `v*`; changelog generated from Conventional Commits.
- README: install, first run, demo mode, required IAM permissions (`docs/iam-policy.json`), screenshots
  from demo mode, known limitations (unsigned builds → Gatekeeper/SmartScreen notes).
- **Done when:** `v0.1.0` tagged and installable on Patrick's machine.

---

## 8. Required IAM permissions (read-only)
```
sts:GetCallerIdentity
ecs:ListClusters, ecs:DescribeClusters, ecs:ListServices, ecs:DescribeServices,
ecs:ListTasks, ecs:DescribeTasks, ecs:DescribeTaskDefinition
logs:FilterLogEvents, logs:GetLogEvents, logs:DescribeLogStreams, logs:DescribeLogGroups,
logs:StartLiveTail
```
Ship as `docs/iam-policy.json` so teammates without admin can request exactly this.

---

## 9. Risks & open points
- **Live Tail cost/limits** — billed per session minute; mitigated by auto-pause of background tabs and an
  "always pause when window hidden" setting. Verify current pricing/limits in AWS docs.
- **High-volume services** — Live Tail may sample; polling may lag. Show sampling clearly.
- **SSO without AWS CLI** — v1 depends on the CLI for login; built-in device flow is a stretch goal.
- **Real log samples** — covered by `fixtures/` (three formats). Add more if new formats show up.
- **Unsigned binaries** — fine for personal/team use; code signing deferred.
- **Emulator maturity** — keep emulator tests optional so they never block progress.

## 10. Later / v2 ideas
- Multi-container tasks / sidecars (container selector; model already carries `container`).
- Cross-service trace view: follow one `trace.id` across several services.
- Saved filters / query history; split view; Lambda log groups; CloudWatch Logs Insights quick queries.
- Built-in SSO device flow; CLI companion (`contrail tail <service>`); open-source release.
