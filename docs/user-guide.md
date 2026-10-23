# User guide

How Contrail works, from logging in to tracing a request across services. The
[quick start](https://clon1998.github.io/contrail/quick-start/) gets you to your first logs in a few minutes; this
page has the details.

## Profiles and login

- Contrail lists the profiles from `~/.aws/config` (or `AWS_CONFIG_FILE`) with their SSO session state.
- **Log in** runs `aws sso login --profile <name>` for you, so the
  [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) must be installed.
  Contrail only reads the expiry of the SSO token cache; the AWS SDK handles credentials.
- Switch profiles with **⌘⇧P / Ctrl+Shift+P** (search by name, account ID or region).

## Clusters and services

- Browse **Cluster → Service** in the sidebar (the filter box narrows it by name).
- A service shows its tasks (running and recently stopped, with stop reasons and exit codes), deployments, task
  definition, recent events and the environment variables (secret-looking values masked until clicked). It
  refreshes every 30 s.
- **Secrets:** variables filled from Secrets Manager or SSM show their reference; **Reveal** reads the value on that
  click only (each read shows up in CloudTrail). Values are kept in memory while shown, never stored or logged. It
  needs the optional `ContrailOptionalRevealSecrets` statement of the [IAM policy](iam-policy.json).
- **Routes** of routing-framework services (configured as `<PREFIX>_ROUTES_<n>_…` environment variables) are drawn
  as a graph: where data comes from → the topics → where it goes, each system once (several routes to one system
  meet there). Disabled routes and targets are dashed. Hover a node to highlight its routes; click it for their
  settings: a system shows what its routes share once (connection, user, password from Secrets Manager or SSM
  with **Reveal**) and what differs per route (a queue, a path). "Find connected services" adds the services on
  the other side of each topic; click one to open it.
- **⌘K / Ctrl+K** jumps to any service of the current profile, or to a recently opened one of any profile. Star a
  service to pin it to the sidebar.
- **Tabs:** every opened service stays open in a tab with its search and live tail (⌘/Ctrl+1…9, Ctrl+Tab).

## Reading logs

- A service's **Logs** tab loads the newest events of all its tasks (running and recently stopped) from CloudWatch.
  The log group comes from the task definition (`awslogs` driver with a stream prefix).
- ECS JSON (nested or dotted), Spring Boot's console pattern and plain text are parsed, and Java stack traces that
  CloudWatch split into one event per line are joined again. **Field mapping** (log toolbar) handles JSON logs with
  other field names.
- The list scrolls smoothly through up to 100,000 lines, starts at the newest, and expands a line into its fields,
  raw JSON, embedded JSON and stack trace (with copy buttons). The task picker in the toolbar (or a task's **Logs**
  button) shows only one task; the columns button adds logger, thread or correlation/trace ID.
- **Time window:** 5 min, 15 min, 1 h, 6 h, or custom (the last N minutes/hours/days, or a fixed from–to range). A
  view loads the newest events first; scrolling to the oldest row loads more ("Load all" in the toolbar loads the
  whole window). The end of the list says whether older events are loading, can be loaded, or whether it is the
  start of the window. Search and export cover the loaded events.
- **Export** the listed lines as `.log` or `.jsonl`.

## Live tail

- After loading its window, a log view **follows live** (CloudWatch Live Tail; new tasks of the service are
  included automatically). Windows longer than 15 minutes open paused (press ▶ to follow); a fixed range is never
  followed. The toolbar shows the state and lets you pause.
- Without the `logs:StartLiveTail` permission Contrail checks for new events every 2 seconds instead.
- Live Tail is billed per session minute: by default tails pause while Contrail is hidden (after 30 s) and resume
  with a catch-up when you're back, and tails of views you haven't looked at for 10 minutes pause too.

## Search

- Search the loaded logs: `timeout level>=WARN trace.id:abc123 -healthcheck`, regular expressions, field globs and
  comparisons (or one regular expression with `.*`), as a filter or highlighted with next/previous (Enter, F3).
  See [Search syntax](query-syntax.md).
- Level chips hide levels (middle click: only this level; right click: more); "Hide lines like this" builds a
  per-service noise list.
- **Pipeline status events** (a framework logging `<prefix>.state` + `<prefix>.correlationId` per document step):
  state badges, state chips (`state:FAILED`) and "Show this document" (`correlation:<id>`).

## Tracing across services

**Trace across services** on an expanded line with a correlation or trace ID opens a **trace tab**. Choose the
services of the cluster the request may have passed through (the one you came from is chosen) and the time around
the event, then search: Contrail searches each service's log group for the ID (`FilterLogEvents`) and shows the
way it took (services in order with their last state, and whether the document completed or failed) and every
event with the ID in one timeline.

- Events expand in place like log lines (fields, stack trace, raw JSON, copy buttons).
- A service on the way shows only its events; pressed again, all of them.
- **Open in …** opens that service's logs filtered to the ID; the trace tab stays open, with its result, until
  you close it (it isn't live: **Search again** repeats the search, **Services** changes the choice).
- Tracing the same ID again shows its tab. Trace tabs count towards the 10 open tabs and last for the session.
- With many services, "Use Logs Insights" searches up to 50 in one query (billed per GB scanned; needs the
  optional `ContrailOptionalInsightsTrace` statement of the [IAM policy](iam-policy.json)).

## Settings and updates

- **Settings** (gear icon or ⌘, / Ctrl+,): theme (dark / light / system), accent colour, UI size, log font size,
  default log time window, newest-first order, timestamps in local time or UTC, and the live tail pause limits.
- Favorites, recent services, the last profile and region overrides are kept in `prefs.json` in Contrail's app
  data folder (never credentials); see [Security & privacy](security.md#what-contrail-stores-and-where).
- **Updates:** Contrail checks the GitHub releases on start (once a day, can be switched off) and installs a newer
  version on request (Settings → About → Updates).
- **Keyboard shortcuts:** press `?`, or see Settings → Shortcuts.

## Demo mode

`CONTRAIL_DEMO=1` (or `--demo`; `pnpm dev:demo` from a clone) starts Contrail with invented profiles, clusters and
live logs and no AWS access at all. It powers the UI tests and the website's screenshots.
