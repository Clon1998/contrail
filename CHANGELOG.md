# Changelog

All notable changes to Contrail. Generated from the commit history ([Conventional Commits](https://www.conventionalcommits.org)).

## 0.3.0 — 2026-10-30

### Features

- **logs:** Show on the timeline where the rows on screen are
- **ecs:** Open a service in the ECS console
- **ecs:** Stop tasks and update services, apart from the read-only source
- **ecs:** Commands for changes, refused unless the user allows them
- **ui:** Stop picked tasks and update a service, after a confirmation
- **ui:** The service's actions beside its tabs
- **ui:** Service actions in a menu next to its name
- **logs:** Clear the timeline focus on the timeline itself
- **logs:** Count how documents ended per topic and consumer group
- **logs:** Route health of a log view, as a command
- **ui:** Route health on a service's Routes card (M18, evaluation)

### Fixes

- **ui:** One smooth shimmer across all skeletons

### Performance

- **logs:** Show the newest events first, load the rest in the background

### Documentation

- Plan opt-in changes to ECS (M22)
- Read-only by default, changes with a setting and an IAM statement
- **rust-notes:** Try_join! and one Arc behind two trait objects
- **plan:** Route health built on the Routes card, without the route map

### Tests

- **e2e:** Apply the cleared search before expanding a row

## 0.2.0 — 2026-10-27

### Features

- **logs:** Read the consumer group of status events
- **trace:** The topics a document went through, per service
- **fake:** Demo documents that pass through demo-edge
- **trace:** Complete a document once every topic it reached was read
- **fake:** Keep demo-edge's status events to its documents
- **ui:** Build a trace's graph from its hops
- **ui:** Targets next to their service in a trace's graph
- **ui:** Draw a trace on the route graph
- **ecs:** Every route of a cluster for its route map
- **prefs:** Transformers entered by hand
- **ui:** Build a cluster's route graph with its transformers
- **ui:** Move a graph's starting nodes next to where they lead
- **ui:** A cluster's route map in a tab of its own
- **logs:** Shorten logger names like Spring Boot
- **logs:** Wrap long messages with a toggle
- **logs:** Keep the list's place when it's hidden and shown again
- **ecs:** Show a service seen before right away
- **ui:** A skeleton instead of a spinner while a service loads
- **routes:** Read the topics a service uses from its startup lines
- **fake:** The demo transformer logs its consumers and producers
- **ecs:** Find a cluster's transformers from their startup lines
- **ui:** Draw transformers found in their startup logs
- **ecs:** Route settings on the cluster map, without secrets
- **ui:** Follow routes through services and search their settings
- **ui:** Lay out the route map with ELK
- **ui:** The cluster route map on a zoomable canvas
- **ui:** A structured route card on the route map
- **ui:** Node details beside the route map, a short hover card
- **ui:** Keep the selected node in view when its details open
- **ui:** Move the route map back when the details close
- **ui:** The route map comes back as it was after another tab
- **ui:** Hide switched-off routes on the route map
- **ui:** Step through the route map's search matches
- **ui:** Export the route map as a PNG or SVG image
- **prefs:** Search history and saved searches
- **logs:** Recall earlier searches with the arrow keys
- **logs:** Saved searches in the search bar
- **ui:** Run saved searches from ⌘K
- **logs:** Count a view's events over time for the timeline
- **logs:** A timeline of events above the log list
- **auth:** Log in to SSO without the AWS CLI
- **links:** Links to a log view and to the CloudWatch console
- **links:** Open contrail:// links and make console links
- **links:** Open AWS console pages, and only those
- **ui:** Share a view as a link or in the CloudWatch console
- **logs:** Focus the list on a part of the window from the timeline
- **logs:** Show the date with row times when events predate today
- **routes:** Find in the route map with Ctrl/Cmd+F
- **routes:** Find in a service's route graph with Ctrl/Cmd+F
- **ui:** Show skeletons instead of spinners while content loads
- **profiles:** Offer to log in where a call failed for an expired session
- **logs:** Find the lines of the same stream around an event
- **logs:** Show the lines of the same task around an expanded line
- **logs:** Turn a service's deployments, stopped tasks and events into markers
- **logs:** Show deployments, stopped tasks and service events between the lines
- **brand:** New aircraft-and-log-trail logo
- **site:** The full logo in the header and its log-line trails in the hero

### Fixes

- **logs:** Keep the list's place in the middle of a long view
- **ui:** Centre one-line nodes on the route map vertically
- **ui:** The disabled-routes toggle says what a click does
- **build:** Pin rust-ini 0.21.1 for the deep-link plugin on Linux
- **ui:** Match the route map's topics by kind, integration or Kafka
- **routes:** Take transformer topics from the lines with Kafka names
- **e2e:** Count focused rows in the fake's live updates
- **logs:** Read the timeline drag start from a ref
- **routes:** Tell integration and plain Kafka topics apart in a service's graph
- **logs:** A slimmer timeline with thin bars

### Documentation

- **plan:** Milestones M9–M20 after v0.1.0
- **plan:** Schedule grouping similar lines, drop environment compare
- Record how a trace is drawn on the route graph
- Record the cluster route map and its transformers
- **rust-notes:** Optional slices as filters and a direction enum
- **plan:** Log view polish, transformer topology and route map v2
- **site:** Refresh screenshots with the wrap toggle
- Record the log view polish and transformers from startup lines
- Record route-following and settings on the route map
- **plan:** Saved queries, timeline, SSO login and links next
- Earlier and saved searches, and what that stores
- **site:** Refresh screenshots with the saved searches button
- The timeline, and refreshed screenshots
- The built-in SSO login writes the CLI's token cache
- The AWS CLI is optional now
- **rust-notes:** Let chains
- Sharing views as links and in the console
- Today's features in the README and on the website
- **site:** Refresh the app screenshots
- Record that the timeline focuses the list instead of the window

### Refactoring

- **ui:** Move the route graph view into its own component
- **ui:** Lay out graphs of any length in columns

### Tests

- **e2e:** Trace the recorded demo documents through their cluster
- **aws:** Run the tests that write and start scripts one at a time
- **e2e:** Clear the search before leaving it in the recall test
- **routes:** A transformer's start as a parser fixture
- **routes:** Neutral names in the transformer startup fixture
- **e2e:** Remove two races behind retried CI failures
- **e2e:** Scroll a live list again until the row shows

### Build and CI

- **ui:** Add React Flow and elkjs for the route map
- Fail the UI flows when a test passes only on retry

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
- Describe updates and releases as set up

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
- **release:** Redeploy the website after publishing a release

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


