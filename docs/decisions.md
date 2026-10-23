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
