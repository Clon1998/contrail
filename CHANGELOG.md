# Changelog

All notable changes to Contrail. Generated from the commit history ([Conventional Commits](https://www.conventionalcommits.org)).

## 0.1.0 — 2026-10-24

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
- **ui:** Filter the service tree by name
- **ui:** Pick a task from a dropdown in the logs toolbar
- **logs:** Time windows as last-N-minutes or a fixed range
- **ui:** Custom time windows; longer windows open paused
- **ui:** Newest-first order as a log setting
- **ui:** Level chips: middle click for only this level, context menu
- **search:** Regex mode for the search box
- **ui:** Show only the role in the header, details on hover
- **ui:** Keyboard shortcuts in the settings
- **ui:** Tooltips on buttons and controls
- **ecs:** Environment variables and secret references in the overview
- **logs:** Read a time window newest first in growing slices
- **logs:** Load the newest events first, older ones on demand
- **ui:** Show the state of older events at the end of the log list
- **ecs:** Show the image each task runs
- **ecs:** Reveal secret values on request
- **logs:** Recognise pipeline framework status events
- **ui:** State badges, state chips and "show this document"
- **logs:** Search one ID across several services
- **ui:** Trace an ID across the services of a cluster
- **logs:** Opt in to Logs Insights when tracing many services
- **ecs:** Rebuild routing-framework routes from env vars
- **ui:** Routes card with source, topic, targets and connected services
- **ui:** Remember a service's view after its tab closes
- **ui:** Let new live rows fade in briefly
- **app:** In-app updates from the GitHub releases
- **updater:** Add the update signing public key
- **site:** Add a website like Frida's
- **site:** Give the website its own look
- **site:** New pages in the sidebar and an evaluation section
- **routes:** Include route settings filled from secrets
- **ui:** Compact route rows, details on click
- **ui:** Open traces in a tab of their own
- **ui:** Draw a service's routes as a graph
- **routes:** Readers' consumer groups and one more step in the graph
- **routes:** Name input and output services, siblings on the topic
- **ui:** The service in its own route graph, next to its siblings
- **fake:** Give demo API requests a shared trace ID
- **time:** Read typed time windows like 15m, yesterday or 9-11
- **logs:** Make the time picker a typed command palette
- **ecs:** Look up task definitions by ARN
- **routes:** Keep a cluster's topic scan for the session
- **search:** Filter pipeline status events by topic
- **logs:** Summarize the fields of a view's matching events
- **logs:** Name the status prefix in the field summary
- **logs:** Add a Fields panel with the values of the matching events

### Fixes

- **ui:** Match profile search by substring instead of fuzzy
- **ui:** Use status colour tokens readable in light mode
- **ci:** Install Tauri system packages with apt again
- Commit the plain-text parser fixtures
- Tell missing IAM permissions apart from expired logins
- **ui:** Close tabs on middle mousedown
- **ui:** Keep rows on screen during live updates
- **aws:** Report only the root cause of credential failures
- **ui:** Offer a login when AWS rejects a session that looks valid
- **aws:** Run aws sso login without a console window on Windows
- **ui:** Keep the service overview within its width
- **ui:** Use the app's checkbox for the search options
- **logs:** Find correlation IDs under any prefix in the column
- **logs:** Fall back to traceId fields in the correlation column
- **logs:** Show new live rows without a placeholder flash
- **ui:** Keep slow row fetches instead of dropping them on live updates
- **ui:** Plain tooltips for every live tail state
- **ui:** Switch to the new search's rows without a placeholder flash
- **trace:** Show no outcome for a plain trace ID

### Performance

- **ui:** Prefetch log rows around the viewport

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
- Hand-off notes (state of M7/M8 and next steps)
- Record that a locally valid SSO session can be rejected
- Mention the service filter and the task picker in the README
- **plan:** Pipeline framework tracing and a route view as later ideas
- Record the Playwright container for CI
- Updates setup, public release steps and history audit
- Update the hand-off notes
- **plan:** Use invented service names in the log format notes
- Point the history audit to the gitignored cleanup brief
- Describe the website and its screenshots
- Security & privacy, teams, FAQ, SECURITY.md and issue templates
- Shorter readme in Frida's layout, user guide and development docs
- Website evaluation pages in the decisions log
- Describe the compact route rows
- Trace tabs and route rows in the user guide and decisions
- The route graph in the user guide and decisions
- Consumer groups and connected services in the route graph
- Input and output services in the route graph
- The service's place in its route graph
- **guide:** Drop the route view section
- **guide:** Drop the play symbol and the pipeline status note
- **teams:** List correlationId fields as trace IDs
- **site:** Add a step-by-step tracing guide
- Keep the status-event framework out of the public docs
- Install, first run, demo mode, screenshots and known limitations

### Refactoring

- Move the desktop app under app/ like Frida
- **ui:** Replace Nuxt with Frida's React stack
- **core:** Serialize session timestamps via a Timestamp newtype
- **core:** Share one error type for AWS-backed sources
- **core:** Keep Prefs fields required in TypeScript
- **core:** Type log field values for TypeScript
- **ui:** Use the view's profile for noise lists and mappings
- **ui:** Use the shadcn CLI's context menu component
- **ui:** Two-column service overview with cards
- **ui:** Share the is-typing check for single-key shortcuts

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
- **e2e:** Make the day-in-the-life noise step deterministic
- **ui:** Apply noise and hidden levels to live events in the fake backend
- **e2e:** Wait until the noise search is applied before expanding
- **ui:** Stop the fake backend's live tails after each test
- **e2e:** Wait for the connected panel after logging in
- **e2e:** Open the settings only once the app is up
- **e2e:** Match tooltips by text while the previous one closes
- **e2e:** Pause the live tail before counting rows in highlight mode
- **e2e:** Trigger the level chip's middle click with a mousedown
- **trace:** Compare both searches over one fixed time range
- **e2e:** Record billing-sync's demo logs too

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
- Run the Playwright job in the official Playwright container
- **site:** Deploy the website to GitHub Pages
- Skip the app checks for documentation-only changes
- Build installers only on demand, like Frida
- Generate the changelog from Conventional Commits
- Build and publish releases for v* tags
- Publish -rc tags as pre-releases
- Sign updater artifacts and upload latest.json in releases

### Chores

- Add MIT license, editorconfig and full gitignore
- Add lefthook git hooks with commitlint
- Replace real identifiers in a test and the plan
- **site:** Refresh screenshots with the trace tab
- **site:** Refresh screenshots
- **site:** Refresh screenshots
- **site:** Refresh screenshots

### Style

- **ui:** Thin scrollbars in the theme's colours
- **ui:** A divider with a small label for the end of the log list


