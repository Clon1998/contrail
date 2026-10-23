# Handoff — state on 2026-10-23

For the next agent (or person) continuing Contrail. Read `CLAUDE.md` and `plan.md` first; decisions are in
`docs/decisions.md`. Patrick paused autonomous work here to test against a real AWS account.

## Where things stand

| Milestone | State |
|---|---|
| M0–M6 | Merged into `main`, CI green (M6 run 39880633714, incl. Windows/macOS installers). |
| M7 workflow polish | Merged into `main` (merge `0ab11d3`, pushed). **CI run 39885085268 failed**: Playwright, WebKit, `e2e/day-in-the-life.e2e.ts` (noise step). Rust and frontend jobs passed; installers were skipped. |
| M7 fixes | **On local `main`, not pushed** (5 commits after `0ab11d3`, see below). |
| M8 release | On local branch `feat/m8-release` (4 commits, not merged, not pushed). |

### Unpushed commits on `main` (fix for the red M7 run)

- `37ba0d9` test(e2e): make the day-in-the-life noise step deterministic
- `83063ee` fix(ui): keep rows on screen during live updates. Real bug: each live update dropped the cached
  page holding the first new row, so the newest rows flickered to placeholders and an expanded row
  re-mounted every second. Also discards page fetches that started before rows changed (epoch counter).
  Unit tests in `app/ui/src/stores/logs.test.ts`.
- `3b6decc` refactor(ui): use the view's profile for noise lists and mappings
- `593d63c` test(ui): fake backend applies noise and hidden levels to live events. It used to re-add all
  matches when noise hid every match.
- `4d671fa` test(e2e): wait until the noise search is applied before expanding

**Not verified:** the full local suite was not completed after these commits; the machine was overloaded by
OS/antivirus processes (load average ~150–290, Vitest workers timed out). Unit tests passed before the overload.

### Commits on `feat/m8-release`

- `881da5b` build: changelog via git-cliff (`cliff.toml`, `CHANGELOG.md`; rc tags ignored)
- `d80c595` ci: `.github/workflows/release.yml` for `v*` tags (draft release with git-cliff notes →
  tauri-action v1 builds macOS arm64 + x64, Windows NSIS, Linux on Ubuntu 22.04 → publish)
- `33bac0b` docs: README (install, first run, demo mode, screenshots, IAM, known limitations), screenshots
  in `docs/screenshots/` from the opt-in spec `app/ui/e2e/screenshots.e2e.ts`, release commands in CLAUDE.md
- `acec1ab` ci: `-rc` tags become pre-releases

Both workflows pass actionlint (v1.7.12).

## Next steps

1. On `main`: run the full suite when the machine is idle (check `uptime`). Run
   `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test`, then in `app/` run `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` a few times. If green, push `main` and watch CI
   (`gh run watch`). M7 is done only when that run is green.
2. Merge `feat/m8-release` into `main` (`--no-ff`) and push; wait for green CI.
3. Tag `v0.1.0-rc.1` on `main` and push the tag; watch `release.yml`. Check the asset names against the
   README install table (it assumes Tauri's defaults, e.g. `Contrail_0.1.0_aarch64.dmg`,
   `Contrail_0.1.0_x64-setup.exe`), and the Windows install path in the README demo-mode section.
4. Regenerate `CHANGELOG.md` (command in CLAUDE.md), commit `chore(release): v0.1.0`, push, tag `v0.1.0`
   and push it. Patrick approved publishing v0.1.0 (private repo, unsigned installers).
5. Open from plan.md: M7 "UX review with Patrick". WebdriverIO + tauri-driver smoke tests (plan §6) are not
   done. The window-state plugin is deferred (decisions.md).

## Pitfalls seen in this session

- See memory `contrail-ci-notes` / docs/decisions.md: slow apt mirror, specta limits (no u64), pnpm minimum
  release age, `*.log` ignore, `git push | grep` SIGPIPE.
- jsdom renders no virtual-list rows (no layout): check row content in Playwright, not Vitest.
- WebKit sends no `auxclick`, so middle click is handled on mousedown; Playwright's WebKit middle click is unreliable.
- Inputs with `list=` have the ARIA role `combobox`.
- The search box debounces 200 ms. Tests must wait for a signal only the new search produces; the match
  count may still show the previous search.
- macOS reserves ⌘W (Close Window), so tabs have no close shortcut.

## What Patrick checks with real AWS (after M5–M7)

- Live tail on a busy service: "sampled" badge, pause when hidden / background tab, catch-up on resume.
- Search on real ECS JSON and Spring logs, noise lists, click-to-filter.
- Tabs across services, export (`.log` / `.jsonl`), field mapping on non-ECS JSON logs.
- A role without e.g. `logs:FilterLogEvents`: it must say "missing permission", not "log in again".
- An expired SSO session during a live tail: banner, log in, Retry.
