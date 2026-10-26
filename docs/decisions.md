# Decisions

Short ADR-style notes on choices that deviate from, refine or correct `plan.md`.

## 2026-10-22 — Frida's frontend stack instead of Nuxt

The original plan specified Nuxt + Nuxt UI + Pinia, with the option to match Frida for consistency. M0 was first
scaffolded with Nuxt; Patrick then chose consistency with Frida. **Decision:** React + Vite + shadcn/ui + Tailwind 4 +
zustand, with Frida's lint/test setup (typescript-eslint, Prettier, Vitest + Testing Library, Playwright with mocked
IPC). One frontend stack across both projects; components and patterns can be shared. `plan.md` and `CLAUDE.md`
are updated. Switched during M0, when only a hello-world page existed.

## 2026-10-22 — TypeScript 6.x instead of 7.x

TypeScript 7 (the native Go port) is the npm `latest`, but tooling such as typescript-eslint builds on the
TypeScript JS API, and support for 7.x is not established. Frida stays on 6.0.x for the same reason.
**Decision:** pin TypeScript 6.0.x; revisit when typescript-eslint documents TypeScript 7 support.

## 2026-10-22 — Committed parser fixtures are synthetic

`plan.md` §5.3 said to copy the real samples from `fixtures/` into `crates/contrail-core/tests/fixtures/`.
That contradicts the rule in `CLAUDE.md` that real logs never leave the gitignored `fixtures/` folder.
**Decision:** `CLAUDE.md` wins; committed fixtures are synthetic look-alikes. `plan.md` is updated.
`.gitignore` anchors the rule as `/fixtures/` so the synthetic folder is not ignored by accident.

## 2026-10-22 — zustand added with the first store

zustand is part of the stack but M0 has no state to hold. It is added in M1 together with the profile store,
so no unused dependency is carried around.

## 2026-10-22 — Node.js 24

`package.json` `engines` requires Node ≥ 24 (Vite 8 itself needs `^20.19 || >=22.12`). CI uses the latest Node 24.

## 2026-10-22 — Same repository layout as Frida

The first scaffold followed the original plan: the frontend at the repository root, `src-tauri/` beside it. Patrick
wants Contrail organised like Frida so both projects read the same. **Decision:** Rust crates stay at the
root; `app/` holds the desktop app as a small pnpm workspace (`app/src-tauri` + the frontend as its own
package in `app/ui`). JS commands run from `app/` (or `app/ui/`), Cargo commands from the root.
`plan.md` §4.1 is updated.

## 2026-10-22 — tauri-specta rc.25 (Frida's), not rc.26

rc.26 (released the day M1 started) emits separate `_Serialize`/`_Deserialize` TypeScript types for every
type with optional fields, which makes frontend code noisy. **Decision:** stay on Frida's rc.25 pair until a
newer release has settled. Timestamps use a `Timestamp` newtype instead of `#[serde(with)]`, which also
caused split types.

## 2026-10-22 — SSO session states include "refreshable"

With `[sso-session]` configs the cached access token lives about an hour, but the SDK refreshes it with the
refresh token without a login. Showing "expired" then would be wrong. **Decision:** an expired access token
with a refresh token (and an unexpired client registration) is `Refreshable` and shown as valid; only a real
call (GetCallerIdentity) proves the session is still alive, and a failure there offers "Log in".

## 2026-10-22 — Finding the AWS CLI outside the shell's PATH

Apps started from the macOS Finder/Dock get a minimal `PATH` without Homebrew. **Decision:** look in `PATH`
first, then in the usual install folders (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.local/bin`,
`C:\Program Files\Amazon\AWSCLIV2`).

## 2026-10-22 — Profile selection and region overrides are not persisted yet

M1 keeps the selected profile and region overrides in memory. Persistence (`tauri-plugin-store`) arrives in
M2 together with favorites and recent services, which need it anyway.

## 2026-10-22 — Respect pnpm's minimum release age

pnpm refuses packages published in the last day (supply-chain protection) and offers to add an exception.
**Decision:** don't add exceptions; pick the previous release instead (e.g. zustand 5.0.15, Frida's version).

## 2026-10-22 — Preferences as typed JSON instead of tauri-plugin-store

`plan.md` §4.5 suggested `tauri-plugin-store`. **Decision:** a typed `Prefs` struct in `contrail-core`
(last profile, region overrides, favorites, recent services) saved by the app as `prefs.json` in the app data
folder, with small commands (`get_prefs`, `toggle_favorite`, …), as Frida does. The rules (dedupe, newest
first, max 10) are unit-tested in Rust, the TypeScript types are generated, and the UI tests fake five
commands instead of the plugin's protocol. Demo mode keeps preferences in memory only.

## 2026-10-22 — Demo ECS data recorded from Rust for the UI tests

The frontend's fake backend (Vitest, Playwright) needs the same clusters, services and tasks as demo mode.
**Decision:** `cargo test` records `FakeEcs` (with a fixed clock) into `app/ui/src/e2e/demo-ecs.json`; the
fake backend relabels account/region per profile and shifts the times to "now". CI fails if the file is out
of date, so Rust and TypeScript demo data can't drift.

## 2026-10-22 — Log pipeline: what M3 does and doesn't do yet

- **Stream selection:** all tasks of a service (running and those ECS still lists as stopped) use the log
  location of the service's *primary* task definition. If a deployment changed the log group or stream prefix,
  tasks of the old revision are read from the wrong place. Rare; revisit when it shows up.
- **Backfill limit:** at most 100,000 events (the buffer size) per view, read oldest first; if the window holds
  more, the newest are missing and the view says "truncated". M5 (live tail) and smaller windows mitigate it.
- **Field values** are typed (`string | number | boolean`) instead of raw JSON: specta can't export
  `serde_json::Value` (64-bit integers); fields with `null` are dropped.
- **Multi-line joining** only applies to plain-text and Spring-pattern events (JSON carries its own stack
  trace), within 2 seconds per stream.
- **UI:** a simple debug list of the newest 1,000 events; the virtualized viewer is M4.
- **Fixtures:** synthetic ones are committed (`crates/contrail-core/tests/fixtures/`); the real samples were only
  used locally to check that every line parses (it does).

## 2026-10-22 — M4 log viewer: scope notes

- **Rows stay in Rust.** The UI asks for pages of 500 rows as they scroll into view (`get_log_rows`); only
  the visible window (plus margin) exists in the DOM (TanStack Virtual). Checked with a generated 100,000-line
  view in the Playwright tests.
- **Pause** only makes sense with a live stream, so it moves to M5 with the live tail. Follow mode (start at
  the newest event, "Jump to latest" after scrolling up) is in M4.
- **Optional columns** (logger, thread, correlation/trace ID) are chosen per session; saving column layouts
  per service comes with M7's settings work.
- **Task view:** a task's "Logs" button opens a view of that task's stream only; the chip in the toolbar
  returns to all tasks.

## 2026-10-22 — Patrick's answers for M5–M8

- **Release:** when M8 is done, tag `v0.1.0` and publish a GitHub Release (private repo) with unsigned
  installers for Windows, macOS and Linux.
- **Live Tail cost:** by default pause live tails when the window is hidden, and background views after
  10 minutes; resume with a gap backfill. Both adjustable in the settings.
- **Updater:** none in v0.1 (needs a signing key); installs come from the GitHub Release.
- **App identifier:** stays `io.github.clon1998.contrail`.

## 2026-10-23 — Live tail by stream prefix instead of stream-set refreshes

Live Tail accepts `logStreamNamePrefixes` (and `FilterLogEvents` a `logStreamNamePrefix`). A whole-service view
tails `<prefix>/<container>/`, so tasks started by later deployments are included automatically; the planned
periodic stream-set refresh isn't needed. A task view uses its exact stream name. Verified against the SDK docs:
log groups must be given as ARNs (account from the cluster ARN), at most 10 groups, stream names only with one
group, one update per second with at most 500 events (then sampled), sessions end after 3 hours.

**Fallbacks:** `AccessDenied`, `LimitExceeded` and `InvalidOperation` switch the view to polling
`FilterLogEvents` every 2 seconds; a session timeout or streaming error reconnects after a catch-up backfill
(from 5 s before the last event; the buffer drops the overlap). Expired credentials stop the tail until it is
resumed (e.g. after logging in).

## 2026-10-23 — M6 search: scope notes

- **Where filtering runs:** in Rust (`ViewFilter`), incrementally for appended live events; a late event in the
  middle re-evaluates the view (fast enough at 100k events).
- **Case:** text, phrases, regular expressions and field equality ignore case; globs too.
- **Noise:** "hide noise" texts are substrings of the message (case-insensitive), saved per service in the
  preferences; the noise menu turns hiding on/off and removes entries.
- **Highlighting** marks only plain text terms in the message (not regex matches or fields).
- **Fake backend:** the UI tests use a simplified TypeScript version of the query language; the real semantics
  are tested in Rust (unit and property tests).

## 2026-10-23 — M7 workflow polish

- **Tabs are services.** Selecting a service opens (or shows) its tab; each tab owns a logs store (zustand
  vanilla store via React context) with its view, search and live tail, so switching keeps everything. At most
  10 tabs (the least recently used closes). Background tabs pause their tail after the "background" setting.
  Switching profile or region closes all tabs (views belong to one account/region).
- **No Cmd/Ctrl+W:** on macOS the default app menu binds ⌘W to "Close window", so closing tabs uses the ✕ button
  or a middle click (handled on mousedown: WebKit sends no `auxclick`). ⌘/Ctrl+1…9 and Ctrl+Tab switch tabs.
- **Export** writes the listed rows (the matches when filtering, everything in highlight mode) as raw lines
  (`.log`) or JSON Lines with time, level, task, stream, message, fields, error. The save dialog plugin is the
  only file-system permission (`dialog:allow-save`); Rust writes the file.
- **Columns** are a setting shared by all views (they were per view and reset on every open).
- **Buffer size** is a setting (10k–500k events, default 100k), used for views opened afterwards.
- **Field mapping** (per service): message/level/timestamp keys for JSON logs; applied in Rust as events
  enter a view; saving reloads the view. The previously detected message stays as a `message` field.
- **AccessDenied ≠ expired login.** It was mapped to a credentials error; it now has its own error code with a
  hint to `docs/iam-policy.json`, and a live tail hitting it stops and waits (banner with Retry).
- **Window state plugin** (plan §5) is deferred: not needed for v0.1.

## 2026-10-23 — Real-account feedback: a "valid" session can still be rejected

Patrick's first real-account test started with a session the token cache called valid/refreshable, but the SSO
portal answered `UnauthorizedException: Session token not found or invalid` (the session had ended server-side).
The earlier assumption ("refreshable ⇒ show as valid") holds for the local view only. **Decision:** the local
state stays a first guess; a credentials error from the identity check overrides it ("session rejected", login
offered in the main panel). Credential errors show only their root cause; the SDK chain goes to the debug log.
`aws sso login` runs without a console window on Windows.

## 2026-10-23 — Custom time windows; only short windows follow live by default

Patrick's feedback: looking at the last hours rarely needs a live tail (billed per minute). **Decision:** the
window is a `TimeWindow` (`last N minutes` or a fixed `from–to` range). Windows up to 15 minutes follow live
right away; longer relative windows open with the tail paused (▶ resumes with a catch-up); a fixed range is
never followed. `start_live` takes the initial pause state, so a paused view never opens a Live Tail session.

## 2026-10-23 — Views load the newest events first, older ones on demand

M3 backfilled the whole window oldest first up to the buffer size, so a long window on a busy service was cut
off before its **newest** events, and every open read the full window (slow, and mostly unread). Patrick
suggested loading on demand. **Decision:** a view reads its window backwards in slices (2 min, then 4× longer,
`backfill_newest`) until it has ~2,000 events; scrolling near the oldest loaded row (or "Load older" / "Load
all") reads the next ~5,000. Loading stops when the buffer is full (inserting older events would evict them
again). Search and export cover the loaded events; the toolbar says how far back that is. CloudWatch can't
read across streams newest first, hence the time slices. Live updates now also carry up to 500 changed rows,
and evictions shift the UI's row cache instead of clearing it, so new rows don't flash.

## 2026-10-23 — Revealing secret values on request

Patrick asked to see the values of secret-backed variables in the overview. **Decision:** a **Reveal** button
per secret reads it on that click (`secretsmanager:GetSecretValue` with the JSON key / version from
`valueFrom`, or `ssm:GetParameter` with decryption). Still read-only towards AWS; values live in the UI's
memory while shown, are cleared on Hide or when the view closes, and are never stored or logged (errors carry
AWS's message only). The permissions are an optional statement in `docs/iam-policy.json`; without them the
row says "missing permission". Each read is visible in CloudTrail, which the button's tooltip mentions.

## 2026-10-23 — Playwright CI job runs in Microsoft's Playwright container

`playwright install --with-deps` installs WebKit's system libraries with apt, and the Ubuntu runner's apt
mirror stalled the job for 20+ minutes (normally ~1 minute). **Decision:** the UI-flow job runs in
`mcr.microsoft.com/playwright:v<version>-noble`, which has the browsers and libraries preinstalled (no apt, no
browser download), with a 30-minute timeout. The image tag must equal `@playwright/test`'s version; a CI step
fails when they drift, so a Playwright upgrade also updates the tag.

## 2026-10-23 — Cross-service tracing: FilterLogEvents, Logs Insights opt-in

Patrick chose: tracing searches each chosen service's log group with `FilterLogEvents` and the ID as a quoted
filter pattern (no extra permission, no scan cost; up to 4 services at a time because of CloudWatch's request
rate). A checkbox switches to **Logs Insights** (one query per region and 50 log groups, billed per GB scanned,
optional `logs:StartQuery`/`logs:GetQueryResults`). The trace key is whatever ID the line carries: the
pipeline framework's correlation ID, or an API's trace ID. A chain is *completed* when every service's last
status is COMPLETED, *failed* when any is FAILED, otherwise *open*.

## 2026-10-23 — In-app updates; Contrail to become public

Patrick wants Frida-style in-app updates. GitHub serves `releases/latest/download/latest.json` without a token
only for public repositories, and a token inside the app would leak, so **Contrail will become public**
(Patrick switches the visibility himself after the history audit in `docs/updates-and-public-release.md`).
The app uses `tauri-plugin-updater` (check on start at most once a day, a setting; "Check now"; install with
progress and cancel); release builds sign updater artifacts and tauri-action uploads `latest.json` when the
signing-key secret exists. The public key in `tauri.conf.json` stays empty until Patrick generates the key;
until then installing explains why it can't.

## 2026-10-23 — Pages for teams evaluating Contrail; README like Frida's

Like Frida's website pass: pages for the people who decide whether a team may use Contrail. `docs/security.md`
(what is read, stored and sent; read-only towards AWS; secret values; unsigned builds and signed updates),
`docs/teams.md` (shared AWS config, permission set, Live Tail and Logs Insights costs, log formats that work well)
and `docs/faq.md` (requirements: macOS 11+, as for Frida; limitations), plus `SECURITY.md` (private vulnerability
reports) and issue templates. They are in the website's sidebar and linked from an "Evaluating Contrail for your
team?" section on the landing page. No "migrating" page: Contrail replaces the AWS console, not another tool.
The README follows Frida's layout: its long feature walkthrough moved to `docs/user-guide.md`, the development
details to `docs/development.md`, both also on the website.

## 2026-10-23 — CI builds installers only on demand, like Frida

Every push to `main` built a Windows and a macOS installer; macOS runner minutes count ten times, and the Actions
budget is small. **Decision:** CI takes Frida's setup: pushes run lint and tests only (and none for changes to only
docs or the website), pull requests also build all platforms, and a manual run ("Run workflow" / `gh workflow run
ci.yml`) builds the ticked platforms (Windows and macOS Apple silicon by default; macOS Intel and Linux on request),
optionally without lint and tests. A newer push cancels the running push build. Contrail keeps its own fixes on
top (pinned toolchain, apt retries, the Playwright container, the generated-files check).

## 2026-10-24 — Traces open in a tab; compact route rows

Patrick's feedback after testing: the trace dialog lost its result as soon as he opened a service, and was too
small to read the events. **Decision (his choices):** a trace opens in a tab of its own next to the service
tabs, with one merged timeline of all services' events that expand in place, a filter per service, and "Open
in …" that leaves the tab open. Trace tabs last for the session (like service tabs) and aren't live. `Tab` is
now a union of service and trace tabs; each trace tab has its own store. The route view is a graph (Patrick
found rows too table-like): sources → topics → targets in three columns, each system once, lines drawn as SVG
between ordinary HTML nodes (no graph library: three columns need no layout engine or pan and zoom). Disabled
routes and targets are dashed; settings open on click, a system's shared settings once.
Settings filled from Secrets Manager or SSM (a route's password) are now part of the route, with Reveal.

## 2026-10-24 — Consumer groups and one more step in the route graph

Patrick pointed out that every output service has its own consumer group, so a group belongs to the reader,
not to the topic. **Decision:** a service's own group is shown once above its graph (on the topics only when its
routes use different groups); "Find connected services" also returns the other services' groups, whether their
route is on, and their endpoints (type and system, no settings), so the graph shows each reader with its group
and where it sends the data (and where writers get theirs), in up to five columns. Hover highlights the paths
through a node rather than the routes sharing it. The overview puts routes and environment below the tasks over
the full width, so the graph has room. The demo cluster `demo-edge` gets a second reader, `audit-archiver`.

Same day, Patrick: a route-generator service has **only input or only output routes**, never both; services that
read and write topics ("transformers") exist, but what they read is only in Java code, so Contrail can't show
them. **Decision:** the graph names the service an input or an output service. Services on the other side of a
topic are steps on the way (writers upstream of an output service, readers downstream of an input service);
services on the same side (other readers of an output service's topic, other writers of an input service's)
are listed on the topic instead. The demo's `demo-edge` gets a second writer, `partner-poller`.

Later the same day, Patrick preferred the siblings next to the service rather than as a note on the topic.
**Decision:** the graph has the same five columns for every service (Sources → Written by → Topics → Read by →
Targets); the service shown is a node in its column, next to the other services on its topics, and is selected
at first so its paths are highlighted.

## 2026-10-24 — Topic scans are kept for the session

Patrick tested a real cluster: every service reached through the graph needed another click on "Find connected
services" (and going back to the first tab too), and each scan described every service of the cluster again,
one `DescribeServices` per service on top of the batched listing. **Decision:** the scan uses the batched
listing (10 services per call) plus each service's task definition by ARN, which the AWS adapter caches (a
registered revision never changes). Its result, the routes of every service of the cluster, is kept in the
app state per profile, region and cluster for the session, with no expiry: routes only change with a deployment,
and the button always scans again. A service's Routes card reads that cache when it opens, so the next service
through the graph (or the tab you came from) shows its connected services without an AWS call.

## 2026-10-24 — A Fields panel instead of the state chips

Patrick asked for a Splunk-like field sidebar. **Decision:** a panel on the right (toggle: Fields button or F)
summarizes the events that **match the search** (drill-down: a click adds `field:value`, the counts narrow),
computed in Rust in one pass over the buffer (about 60 ms for 100,000 events in a release build; refreshed when a
search is applied and at most once a second while events arrive, only while the panel is open). Per field: how
many events have it and its top 10 values; at most 1,000 distinct values are counted per field, so ID-like fields
cost bounded memory and are shown as "all different". Whether the panel is open is remembered per service for
the session (with the search), not saved to disk.

For pipeline status events the panel adds its own section, chosen from what the status fields mean: the states
(the chips moved here from the search bar, which Patrick found confusing there), the states per topic, the
documents (correlation IDs) by where their last event left them (in progress, failed, completed, published,
plus retried), and the reasons of failed events. Transitions (`previousState → state`) were left out: they mostly
repeat the fixed lifecycle. The status fields still show in the generic field list. A new `topic:` term filters
status events by topic (plain-text status lines have no topic field to filter on). Level chips stay in the
search bar.

## 2026-10-23 — M8 release

- **Release pipeline:** a `v*` tag runs `.github/workflows/release.yml`: draft release with git-cliff notes →
  tauri-action builds (macOS arm64 and x64 on the arm64 runner via `--target`, Windows NSIS, Linux on Ubuntu
  22.04 for older glibc) → publish. Assets keep Tauri's default file names.
- **Unsigned** for v0.1 (no Apple Developer ID / Windows certificate); the README explains the first-start
  warnings. Updater files *are* signed (Tauri's own key, see "In-app updates" above): with the
  `TAURI_SIGNING_PRIVATE_KEY` secret set, the workflow also uploads `latest.json`.
- **Changelog:** git-cliff from Conventional Commits (`cliff.toml`), committed as `CHANGELOG.md` with each
  release; merge commits and `chore(release)` are left out.
- **Screenshots** come from the fake backend (demo data) via `pnpm --dir ui screenshots` (the website's spec);
  the branch's own README screenshot spec was dropped when merging, as the README now links the website.

## 2026-10-24 — M9: a trace drawn on the route graph (evaluation)

Built on `feat/m9-trace-on-route-graph`; merged only if Patrick finds it useful after the screenshots.

- **Hops come from the status events**, not from the route scan: each `(service, topic, direction)` of a
  trace is one hop with its last state. Direction: no consumer group and a producer state (`RECEIVED`,
  `PUBLISHED`, or a failure right after one) → wrote; everything else → read. Status events now carry the
  consumer group. This way transformers (no route variables) show up on the document's way by themselves.
- **The graph needs no extra AWS call**: services and topics come from the hops. The cluster's route scan
  (cached for the session, or "Find connected services") adds the external systems and the readers of the
  document's topics that logged nothing ("no event" when searched, "not searched" otherwise, with a button to
  search them too). Writers of the same topic are siblings, not missing hops, and are left out; so are
  switched-off routes. Services are matched by name (the trace already searches per service), not by log group.
- **Outcome rule changed**: with hops, a document is *completed* when every write was published, every topic it
  was written to was read by a searched service, and every read completed. Before, an input service's last
  state (`PUBLISHED`) kept every trace that started there *open*.
- **Layout**: columns by longest path (input → topic → transformer → topic → output), targets right next to
  their service (lined up at the end, the lines of early readers crossed the rest of the graph), columns as wide
  as their names. The per-service route graph uses the same view (`RouteGraphView.tsx`).
- **Demo**: demo-edge got a transformer (`event-enricher`) and a reader of its topic (`search-feeder`); one
  document every 30 s passes through all of them, every sixth stuck retrying in `audit-archiver`, every tenth
  failing in `search-feeder`. Random status events stay in demo-core.
- Not in the public docs (user guide, website), like the rest of the status-event support.

## 2026-10-24 — M10: a cluster's route map

- **Opened from the cluster** in the tree (a button on the cluster's row, shown on hover or focus) as a tab
  of its own (`routes|<cluster ARN>`), next to service and trace tabs. With only a route map open, the main
  area shows the tabs even though no service is selected.
- **Data:** `cluster_routes` returns every route link of the cluster from the same session-cached topic scan
  as "Find connected services" (either fills the cache for the other). Opening a map scans when there was no
  scan yet; "Scan again" refreshes it. Only route services are drawn; the others are listed under the map
  ("n services have no routes"), each with a shortcut to enter it as a transformer.
- **Transformers by hand:** reads/writes topics saved in the preferences **by service name**, not per profile
  or cluster: a service reads and writes the same topics in every environment. The editor lives in the route
  map (plan.md said settings): that's where the gap shows. Automatic detection from a startup log line is
  planned (see plan.md, M10 follow-up).
- **Layout:** the same layered view as traces: columns by longest path, nodes nothing leads to (sources,
  topics only read here) moved next to their first successor, columns at least 9rem wide so big clusters
  scroll instead of squeezing. The search keeps the paths through every match (up- and downstream, not
  siblings). Zoom was left out: the lines are measured from the rendered nodes, and a CSS scale breaks that;
  scrolling and the search cover large clusters for now.
- **Branch:** built on top of `feat/m9-trace-on-route-graph`, because the demo's transformer comes from M9's
  demo data. If M9 isn't merged, M10 is rebased onto `main` keeping only M9's demo and data commits
  (nothing of either branch is pushed before that).

## 2026-10-26 — Team feedback: log view polish (M10.1)

- **Logger column:** shortened like Logback's class name abbreviation (packages to their first letter from the
  left until it fits, then cut from the front), full name in the tooltip.
- **Wrap lines:** a setting (`wrapLines`), toggled from the toolbar or with W. Only a row's first line wraps;
  multi-line messages (stack traces) stay in the expanded row.
- **Keeping the list's place:** hiding the list unmounts it. It saves the event at its top (sequence number and
  pixel offset) in the tab's logs store and goes back there when shown again, unless it was following the
  newest event. Jumps and "older rows added" that happened before the list mounted are not replayed.
  The top event is worked out when the list is hidden (rows reached by a fast scroll load after the last
  scroll event), and the virtualizer starts at the saved offset (`initialOffset`): it scrolls there whenever it
  attaches to the element, which undid a scroll made from an effect.
- **Overview cache:** service detail and tasks are cached per service for the session. Data younger than 30 s
  is shown without a call; older data is shown and refreshed quietly. The 30 s timer refreshes quietly too.
- **Loading states:** skeletons (shimmer) instead of spinners, starting with the Overview.

## 2026-10-26 — Transformers from their startup lines (M10.2)

- **No framework change needed:** the framework already logs, when a service starts, each Kafka consumer (raw
  and integration topics), its listener container (topic, concurrency, consumer group) and each producer.
  Contrail reads those lines instead of the topology event sketched for the M10 follow-up.
- **Which services:** only those without route variables (route services have theirs in env vars). For each,
  the most recently started task of the current revision, read with `FilterLogEvents` over its first 15
  minutes with the filter phrase `Creating` (no new permission). Nothing found (not a framework app, stream
  start past retention) → the service stays undrawn, as before.
- **Caching:** per task definition ARN for the session (a revision never changes), plus the last result per
  cluster like the route scan. "Scan again" lists the services again but reads only new revisions.
- **Precedence:** topics entered by hand win over the startup lines; the details show where the topics of a
  transformer come from (startup logs of which task, or by hand). Origin is per transformer, not per edge.
- **Demo:** the fake can't know when its tasks started (events are a pure function of stream and time), so
  `event-enricher` repeats its startup lines every 15 minutes; any 15-minute window holds them once.
