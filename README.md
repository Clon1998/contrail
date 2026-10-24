<p align="center">
  <img src="assets/icon.svg" width="96" alt="Contrail logo: two contrails across the sky">
</p>

<h1 align="center">Contrail</h1>

<p align="center">
  <em>Your ECS logs, live and readable.</em><br>
  A fast desktop log viewer for AWS ECS services. Read-only, no credentials stored.
</p>

<p align="center">
  <a href="https://clon1998.github.io/contrail/"><strong>Website</strong></a> ·
  <a href="https://clon1998.github.io/contrail/quick-start/">Quick start</a> ·
  <a href="https://clon1998.github.io/contrail/download/">Download</a>
</p>

---

Contrail replaces the round trip through the AWS console when you want to know what a service is doing: switch AWS
SSO profiles, browse clusters and services, and follow their logs live as readable, searchable lines. It is built
with Rust, Tauri 2 and React. There is no account, no server and no telemetry, it never changes anything in AWS, and
it never stores credentials.

## Features

- **Profiles and SSO.** All profiles from `~/.aws/config` with their login state; **Log in** runs
  `aws sso login` for you. Switch with Cmd/Ctrl+Shift+P, jump to any service with Cmd/Ctrl+K.
- **Everything about a service on one page**: running and recently stopped tasks with stop reasons and exit codes,
  deployments, the task definition, recent events and environment variables (secret-looking values masked;
  Secrets Manager and SSM values only on **Reveal**).
- **Logs that read well.** ECS JSON (nested or dotted), Spring Boot's console pattern and plain text are parsed;
  stack traces split into one event per line are joined again. 100,000 lines scroll smoothly; parsing, buffering
  and search run in Rust.
- **Live tail** with CloudWatch Live Tail (or polling without the permission), paused automatically while you
  don't look, because it is billed per minute.
- **Search** as you type: words, phrases, fields, levels, comparisons and regular expressions, as a filter or
  highlighted. Level chips and "Hide lines like this" remove the noise. The **Fields** panel counts the most common
  values of every field in the matching events; a click on one narrows the search. [Search syntax](docs/query-syntax.md)
- **Tracing across services**: follow a correlation or trace ID through the services of a cluster, on a timeline.
- Tabs per service, time windows (relative or fixed), export as `.log` or `.jsonl`, field mapping for other JSON
  layouts, dark and light themes, keyboard-first.
- **Updates itself**: a signed update check once a day (can be switched off), installed only when you say so.

Not supported (yet): EKS, Lambda and other non-ECS log groups, log drivers other than `awslogs`, long-range
historical search. See the [FAQ](docs/faq.md#what-doesnt-contrail-do).

## Install

Installers are attached to [GitHub Releases](https://github.com/Clon1998/contrail/releases) (the first public
release is still being prepared; until then, build it yourself or grab a CI build, see
[Development](docs/development.md#ci-builds)):

| Platform | File |
|---|---|
| macOS (Apple silicon / Intel) | `Contrail_<version>_aarch64.dmg` / `Contrail_<version>_x64.dmg` |
| Windows | `Contrail_<version>_x64-setup.exe` (installs per user, no admin rights) |
| Linux | `.AppImage`, `.deb` or `.rpm` |

The builds aren't code-signed yet. On macOS, right-click the app → **Open** the first time. On Windows, SmartScreen
asks once: **More info → Run anyway**. On Linux, make the AppImage executable with `chmod +x`.

Contrail needs the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) for
SSO logins.

## Getting started

1. Make sure your AWS profiles are in `~/.aws/config` (`%USERPROFILE%\.aws\config` on Windows), e.g. with
   `aws configure sso`.
2. Start Contrail, pick a profile and click **Log in** if its session has expired.
3. Choose a cluster and a service in the sidebar (or press Cmd/Ctrl+K) and open its **Logs** tab.
4. Type into the search box: `timeout level>=WARN -healthcheck`.

Teammates with narrower AWS roles need the read-only permissions in [docs/iam-policy.json](docs/iam-policy.json).
The [user guide](docs/user-guide.md) explains everything in more detail.

### Try it without AWS

`CONTRAIL_DEMO=1` (or `--demo`; `pnpm dev:demo` in `app/` from a clone) starts Contrail with invented profiles,
clusters and live logs and makes no AWS calls at all.

## Documentation

The same documents are on the [website](https://clon1998.github.io/contrail/), with search.

| Document | For |
|---|---|
| [User guide](docs/user-guide.md) | Profiles, services, logs, live tail, search, tracing, settings, shortcuts |
| [Using Contrail in a team](docs/teams.md) | AWS config, permissions, what it costs, logs that work well |
| [Security & privacy](docs/security.md) | What is read, stored and sent, read-only towards AWS, secrets, updates |
| [FAQ](docs/faq.md) | License, system requirements, limitations, stability, support |
| [Search syntax](docs/query-syntax.md) | Words, fields, levels, comparisons, regular expressions |
| [IAM policy](docs/iam-policy.json) | The read-only permissions Contrail needs, and the optional ones |
| [Development](docs/development.md) | Setup, running, tests, CI builds, the website |
| [Rust notes](docs/rust-notes.md) | The Rust patterns used in the code, explained for Java developers |
| [plan.md](plan.md) | The specification and milestones |
| [Decisions](docs/decisions.md) | Deviations from the plan and why |

## Development

You need Rust (stable), Node.js 24, pnpm 12 and your platform's
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Then:

```sh
cd app && pnpm install
pnpm dev                           # the app, with hot reload for the UI
```

Checks that CI runs (and every change must pass):

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd app && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

`pnpm build` in `app/` builds installers for your OS into `target/release/bundle/`. See
[development.md](docs/development.md) for everything else.

## Your data

Contrail reads your AWS config and the expiry of your SSO token cache, and stores only its preferences (favorites,
recent services, settings; never credentials or log content) in `prefs.json` in its app data folder
(`~/Library/Application Support/io.github.clon1998.contrail/` on macOS, `%APPDATA%\io.github.clon1998.contrail\` on
Windows, `~/.local/share/io.github.clon1998.contrail/` on Linux). It only talks to the AWS APIs of the profile you
selected and, once a day, to GitHub for the update check (switch it off in Settings → About → Updates). Details:
[Security & privacy](docs/security.md).

## License

[MIT](LICENSE). Use it, fork it, roll it out in your company; no warranty.
