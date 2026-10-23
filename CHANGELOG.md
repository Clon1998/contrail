# Changelog

All notable changes to Contrail. Generated from the commit history ([Conventional Commits](https://www.conventionalcommits.org)).

## 0.1.0 — 2026-10-23

### Features

- **app:** Scaffold Nuxt SPA frontend with Nuxt UI
- **app:** Add Tauri 2 desktop shell
- **ipc:** Add hello-world greet command
- **core:** Add profile model and AWS config parser
- **core:** Derive SSO session status from the token cache
- **core:** Define the AuthProvider trait
- **fake:** Add fake auth provider for demo mode
- **aws:** Read profiles and SSO tokens from the local AWS files
- **aws:** Run aws sso login with CLI detection
- **aws:** Add AwsAuth with sts GetCallerIdentity check
- **app:** Wire auth commands and demo mode into Tauri
- **ui:** Add profile store with session status and login flow
- **ui:** Add profile bar with switcher, session badge and login
- **core:** Add ECS domain model and EcsSource trait
- **fake:** Add demo clusters, services and tasks
- **aws:** Add AwsEcs for clusters, services and tasks
- **app:** Add ECS commands
- **app:** Persist preferences (profile, regions, favorites, recent)
- **ui:** Remember the last profile and region overrides
- **ui:** Add the cluster and service tree
- **core:** Expose image tags of task definition containers
- **ui:** Add the service overview
- **ui:** Add the ⌘K service palette with recent services
- Add app settings to the preferences
- **ui:** Apply colour mode, accent and time zone
- **ui:** Add the settings dialog
- **core:** Parse ECS JSON, Spring Boot console and plain log lines
- **core:** Add log events, the multi-line joiner and the ring buffer
- **core:** Resolve log streams from task definitions
- **fake:** Generate demo logs in the three production formats
- **aws:** Backfill logs with FilterLogEvents
- **app:** Open log views with a backfill
- Add the default backfill window to the settings
- **ui:** Add a Logs tab with a debug log list
- Add UI size and log font size settings
- **ui:** Rebuild the settings dialog on Frida's layout
- **app:** Open log views for a single task
- **ui:** Add ANSI, stack trace and JSON helpers for log rows
- **ui:** Add the virtualized log viewer and task views
- **core:** Prepare the joiner and buffer for live streaming
- **core:** Add the live tail port
- **fake:** Stream demo logs live
- **aws:** Add the StartLiveTail adapter
- **aws:** Read whole services by their stream prefix
- **app:** Run live sessions for log views
- Add live tail auto-pause settings
- **ui:** Follow log views live with pause and auto-pause
- **core:** Parse and evaluate search queries
- **core:** Add incremental view filters
- **app:** Filter log views
- Save "hide noise" lists per service
- **ui:** Search, filter and highlight log views
- **ui:** Keep opened services in tabs
- Export a log view as .log or .jsonl
- **ui:** Keyboard shortcuts overview
- **ui:** Explain a stopped live tail and offer a retry
- Buffer size setting and remembered log columns
- **logs:** Field mapping per service

### Fixes

- **ui:** Match profile search by substring instead of fuzzy
- **ui:** Use status colour tokens readable in light mode
- **ci:** Install Tauri system packages with apt again
- Commit the plain-text parser fixtures
- Tell missing IAM permissions apart from expired logins
- **ui:** Close tabs on middle mousedown

### Documentation

- Add project plan and agent guide
- **plan:** Use synthetic fixtures for committed parser tests
- Add README, Rust notes and decision log
- **plan:** Adopt Frida's repository layout
- **plan:** Switch the frontend stack to Frida's
- Merge milestones into main and push to trigger CI
- Document M1 (Rust notes, decisions, demo mode, login)
- Document M2 (navigation, preferences, IAM policy, Rust notes)
- **plan:** Persist preferences as typed JSON, not plugin-store
- Document the M4 log viewer
- Record decisions for M5–M8 (release, Live Tail pausing, updater)
- Document M5 live tail (Rust notes, decisions, plan, README)
- Document M6 search (syntax reference, Rust notes, decisions)
- Document M7 (tabs, export, field mapping, decisions, Rust notes)

### Refactoring

- Move the desktop app under app/ like Frida
- **ui:** Replace Nuxt with Frida's React stack
- **core:** Serialize session timestamps via a Timestamp newtype
- **core:** Share one error type for AWS-backed sources
- **core:** Keep Prefs fields required in TypeScript
- **core:** Type log field values for TypeScript

### Tests

- **e2e:** Add Playwright UI flows with the fake backend
- **ui:** Record demo ECS data for the fake backend
- **e2e:** Cover ECS navigation, palette and favorites
- **e2e:** Cover the settings dialog
- **core:** Add synthetic log fixtures for the parsers
- **app:** Cover opening log views in demo mode
- **e2e:** Cover the Logs tab; document M3
- **e2e:** Cover the log viewer, task views and 100k lines
- **e2e:** Cover live tailing, pause/resume and follow mode
- **app:** Check a demo view goes live and grows
- **core:** Property tests for the query language
- **e2e:** Cover the main query types and search features
- **ui:** Count levels correctly in the fake backend's live updates
- **e2e:** Cover tabs, export, field mapping and shortcuts
- **e2e:** A day in the life
- **e2e:** Wait for the app to start in the day-in-the-life flow

### Build and CI

- Set up Cargo workspace with core, aws and fake crates
- Add GitHub Actions workflow for Rust, frontend and builds
- Run the Tauri app from pnpm dev and pnpm build
- Generate typed TS bindings with tauri-specta
- **ui:** Add shadcn command, popover, select, tooltip and zustand
- Run the Playwright UI flows
- Cache the Tauri system packages between runs
- Don't cancel runs on main when a new milestone is pushed
- Build Windows and macOS installers as run artifacts
- **ui:** Add TanStack Virtual for the log list

### Chores

- Add MIT license, editorconfig and full gitignore
- Add lefthook git hooks with commitlint


