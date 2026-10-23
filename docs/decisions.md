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
