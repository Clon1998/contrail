# Contrail

A fast, focused desktop log viewer for AWS ECS services.
Switch AWS SSO profiles, browse clusters → services → tasks, and jump straight into live,
readable logs — structured (ECS JSON) or plain — with session search.

> **Status:** early development. Profiles, SSO login, ECS browsing and the log viewer with live tail work
> (M1–M7). Release builds come next.
> See [plan.md](plan.md) for scope and milestones.

Contrail is strictly **read-only** towards AWS and never stores credentials.

## Using it

- Contrail lists the profiles from `~/.aws/config` (or `AWS_CONFIG_FILE`) with their SSO session state.
- **Log in** runs `aws sso login --profile <name>` for you, so [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  must be installed. Contrail only reads the expiry of the SSO token cache; the AWS SDK handles credentials.
- Switch profiles with ⌘⇧P / Ctrl+Shift+P (search by name, account ID or region).
- Browse **Cluster → Service** in the sidebar; a service shows its tasks (running and recently stopped, with
  stop reasons and exit codes), deployments, task definition and recent events. It refreshes every 30 s.
- **⌘K / Ctrl+K** jumps to any service of the current profile, or to a recently opened one of any profile.
  Star a service to pin it to the sidebar. Favorites, recent services, the last profile and region overrides
  are kept in `prefs.json` in Contrail's app data folder (never credentials).
- The log viewer scrolls smoothly through up to 100,000 lines, starts at the newest, and expands a line into its
  fields, raw JSON, embedded JSON and stack trace (with copy buttons). A task's **Logs** button shows only that
  task; the columns button adds logger, thread or correlation/trace ID.
- **Time window:** 5 min, 15 min, 1 h, 6 h, or custom (the last N minutes/hours/days, or a fixed from–to range).
- After loading its window, a log view **follows live** (CloudWatch Live Tail; new tasks of the service are
  included automatically). Windows longer than 15 minutes open paused (press ▶ to follow); a fixed range is
  never followed. The toolbar shows the state and lets you pause. Without the `logs:StartLiveTail`
  permission Contrail checks for new events every 2 seconds instead. Live Tail is billed per session minute:
  by default tails pause while Contrail is hidden (after 30 s) and resume with a catch-up when you're back.
- A service's **Logs** tab loads the last minutes of all its tasks' logs (running and recently stopped) from
  CloudWatch: ECS JSON (nested or dotted), Spring Boot's console pattern and plain text are parsed, and Java
  stack traces that CloudWatch split into one event per line are joined again. The log group comes from the
  task definition (`awslogs` driver with a stream prefix).
- **Search** the loaded logs: `timeout level>=WARN trace.id:abc123 -healthcheck`, regular expressions, field
  globs and comparisons (or one regular expression with `.*`), as a filter or highlighted with next/previous
  (Enter, F3). Level chips hide levels (middle click: only this level; right click: more); "Hide lines like
  this" builds a per-service noise list. See [docs/query-syntax.md](docs/query-syntax.md).
- **Tabs:** every opened service stays open in a tab with its search and live tail (⌘/Ctrl+1…9, Ctrl+Tab).
- **Export** the listed lines as `.log` or `.jsonl`; **field mapping** for JSON logs with other field names.
- **Keyboard shortcuts:** press `?`, or see Settings → Shortcuts.
- **Permissions:** read-only; [docs/iam-policy.json](docs/iam-policy.json) lists exactly what Contrail calls.
- **Settings** (gear icon or ⌘, / Ctrl+,): theme (dark / light / system), accent colour, UI size, log font size,
  default log time window, newest-first order and timestamps in local time or UTC.
- Contrail only reads from AWS. Teammates without admin rights need the permissions in
  [docs/iam-policy.json](docs/iam-policy.json).

### Demo mode

`pnpm dev:demo` (in `app/`) or `CONTRAIL_DEMO=1` starts Contrail with invented profiles and sessions and no
AWS access at all. It powers the UI tests and screenshots.

## Test builds

Every CI run on `main` builds installers and attaches them to the run (Actions → the run → *Artifacts*, kept
14 days, or `gh run download <run id> -n contrail-windows`):

- **Windows:** `contrail-windows` contains an NSIS `.exe` that installs per user (no admin rights needed).
- **macOS (Apple Silicon):** `contrail-macos-arm64` contains a `.dmg`.

The builds are unsigned: Windows SmartScreen asks once ("More info" → "Run anyway"); on macOS, right-click the
app → Open the first time. Contrail needs the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
for SSO logins and reads `%USERPROFILE%\.aws\config` (Windows) or `~/.aws/config`.

## Development

Prerequisites:

- [Rust](https://rustup.rs) via rustup (the exact version is pinned in `rust-toolchain.toml` and installed automatically)
- Node.js ≥ 24 and [pnpm](https://pnpm.io) 12
- Tauri's [system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

```bash
cd app
pnpm install          # also installs the git hooks (lefthook)
pnpm dev              # run the app with hot reload (tauri dev)
pnpm build            # build installers for this OS (tauri build)
```

Checks (the same ones CI runs):

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd app && pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e         # Playwright UI flows (in app/; uses a fake backend, no Tauri)
```

### Layout

| Path                    | What                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `crates/contrail-core/` | Domain model, source traits, parsing, buffer, query — no AWS deps  |
| `crates/contrail-aws/`  | AWS implementations of the core traits                             |
| `crates/contrail-fake/` | Fake implementations and log generators (demo mode, tests)         |
| `app/`                  | The desktop app: Tauri CLI and repo tooling (pnpm workspace root)  |
| `app/src-tauri/`        | Tauri app crate: commands, state, wiring                           |
| `app/ui/`               | React + Vite frontend (shadcn/ui, Tailwind); tests beside the code |
| `docs/`                 | [Rust notes](docs/rust-notes.md), [decisions](docs/decisions.md)   |

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by a commit-msg hook).

## License

[MIT](LICENSE)
