# Handoff — state on 2026-10-23 (evening)

For the next agent (or person) continuing Contrail. Read `CLAUDE.md` and `plan.md` first; decisions are in
`docs/decisions.md`.

## Where things stand

| Milestone | State |
|---|---|
| M0–M7 | Done on `main`. Patrick tested against real AWS (live tail, login/AccessDenied, export, columns, tasks, secrets, overview) and fed back two rounds; all fixed. |
| After M7 (Patrick's feature list) | On `main`: filter-change flicker fix, pipeline framework view (state badges/chips, "show this document"), cross-service tracing (FilterLogEvents, Logs Insights opt-in), route view (routes from `<PREFIX>_ROUTES_<n>_…` env vars, services on the same topic), fade-in of live rows, view state remembered per service, in-app updates (app side). |
| M8 release | Branch `feat/m8-release`, **not merged** (Patrick: no release yet). Also holds the updater part of the release workflow (`d3406d5`). Its README conflicts with `main`'s README; screenshots need regenerating. |

## Open, needs Patrick

- **Updates / going public:** follow `docs/updates-and-public-release.md`: decide on the history-audit findings
  (and the employer sentence in `plan.md` line 8), generate the signing key, put the public key into
  `tauri.conf.json`, set the two secrets, switch the repository to public.
- **Release:** merge `feat/m8-release` when he asks, then tag.
- **Real-AWS checks of the new features:** tracing across his pipeline services (correlation IDs in `fw.*`) and
  APIs (`traceId`), Logs Insights opt-in, route view on route-generator services, "Find connected services".

## Also open

- WebdriverIO + tauri-driver smoke tests (plan §6) are not done.
- Later ideas in `plan.md` §10 (rebindable shortcuts, …); window-state plugin deferred.

## Working notes

- **GitHub Actions minutes are scarce** (private repo): push to `main` only once per batch of work, verify
  locally first (fmt, clippy, `cargo test --workspace`, `pnpm lint/typecheck/test`, `pnpm test:e2e`).
- Bitdefender excludes the project now; macOS "Developer Tools" exemption for the terminal is optional.
- `fixtures/` (gitignored) holds real samples and Patrick's framework/route docs (`fixtures/docs/`): read only,
  never quote in tracked files.
- Pitfalls: jsdom renders no virtual rows (check rows in Playwright); WebKit sends no `auxclick`; the search box
  debounces 200 ms; macOS reserves ⌘W; specta can't export `u64`; pnpm refuses packages younger than a day.
