# Development

How to build and test Contrail, what CI checks, and how the website is made. Where code goes is described in
[plan.md](../plan.md); the Rust patterns used are explained in the [Rust notes](rust-notes.md).

## Prerequisites

- [Rust](https://rustup.rs) via rustup (the exact version is pinned in `rust-toolchain.toml` and installed
  automatically)
- Node.js ≥ 24 and [pnpm](https://pnpm.io) 12
- Tauri's [system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

## Running

```sh
cd app
pnpm install          # also installs the git hooks (lefthook)
pnpm dev              # run the app with hot reload (tauri dev)
pnpm dev:demo         # the same in demo mode: invented profiles, no AWS
pnpm build            # build installers for this OS (tauri build), into target/release/bundle/
```

## Checks

The same ones CI runs; every commit must pass them:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd app && pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e         # Playwright UI flows (in app/; uses a fake backend, no Tauri)
```

Tests never touch AWS: the AWS adapters are tested against SDK mocks, everything else against `contrail-fake`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by a commit-msg hook).

## Layout

| Path                    | What                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `crates/contrail-core/` | Domain model, source traits, parsing, buffer, query — no AWS deps  |
| `crates/contrail-aws/`  | AWS implementations of the core traits                             |
| `crates/contrail-fake/` | Fake implementations and log generators (demo mode, tests)         |
| `app/`                  | The desktop app: Tauri CLI and repo tooling (pnpm workspace root)  |
| `app/src-tauri/`        | Tauri app crate: commands, state, wiring                           |
| `app/ui/`               | React + Vite frontend (shadcn/ui, Tailwind); tests beside the code |
| `site/`                 | The website (Astro + Starlight), deployed to GitHub Pages          |
| `docs/`                 | User and developer documentation, [decisions](decisions.md)        |

## CI builds

CI (`.github/workflows/ci.yml`) and the website (`site.yml`) are separate workflows. Changes to only `site/`,
`docs/`, Markdown files or the issue templates don't run CI; changes to only the app don't rebuild the website.

Pushes run lint and tests only. **Installers** are built on pull requests (all platforms) or when you start CI by
hand: Actions → CI → **Run workflow**, tick the platforms (Windows and macOS Apple silicon by default) and whether
to run lint and tests first. From the terminal:

```sh
gh workflow run ci.yml                                   # Windows + macOS (Apple silicon)
gh workflow run ci.yml -f macos-arm64=false -f checks=false   # just a Windows installer, quickly
gh run download <run id> -n contrail-windows             # or download from the run's page (Artifacts)
```

The artifacts (`contrail-windows`, `contrail-macos-arm64`, `contrail-macos-x64`, `contrail-linux`) are kept
14 days. Windows gets an NSIS `.exe` that installs per user (no admin rights needed). macOS runner minutes count
ten times, so tick only what you need.

The builds are unsigned: Windows SmartScreen asks once ("More info" → "Run anyway"); on macOS, right-click the app
→ Open the first time.

## Website

`site/` is the website: an [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) site with a
landing page, quick start, downloads and pages generated from `docs/`.

```sh
cd site
pnpm install
pnpm dev              # http://localhost:4321/contrail/
pnpm build            # the static site in site/dist/
```

- **Pages from `docs/`** are listed in `site/site.config.mjs` and converted by `site/scripts/sync-docs.mjs` before
  each build, so `docs/` stays the single source (it also renders on GitHub). Links between docs become links
  between pages; links to other repository files go to GitHub.
- **Download buttons** come from the latest GitHub release at build time (`src/lib/release.ts`). If GitHub can't
  be reached, they link to the releases page.
- **Screenshots** are taken from the real UI against the demo backend, in light and dark. After visible UI changes:
  `pnpm --dir app/ui screenshots` (writes `site/src/assets/screenshots/` and the link preview card
  `site/public/og.png`), then commit the PNGs.
- Pushes to `main` that touch `site/` or `docs/` deploy it (`.github/workflows/site.yml`).
