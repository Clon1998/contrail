# Contrail

A fast, focused desktop log viewer for AWS ECS services.
Switch AWS SSO profiles, browse clusters → services → tasks, and jump straight into live,
readable logs — structured (ECS JSON) or plain — with session search.

> **Status:** early development (milestone M0: scaffold). Nothing useful to run yet.
> See [plan.md](plan.md) for scope and milestones.

Contrail is strictly **read-only** towards AWS and never stores credentials.

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
