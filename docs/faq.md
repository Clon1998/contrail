# FAQ

## Is Contrail free? Can my company use it?

Yes. Contrail is open source under the [MIT license](../LICENSE): free for personal and commercial use, including
inside companies, with no account and no paid tier. Like all MIT software, it comes without warranty. The AWS calls
it makes are billed to your account as usual; see [what it costs](teams.md#what-it-costs).

## What are the system requirements?

| | |
|---|---|
| **macOS** | Apple silicon or Intel, macOS 11 (Big Sur) or newer. |
| **Windows** | Windows 10 or 11, 64-bit (x64). Uses Microsoft Edge WebView2, which Windows 11 includes; the installer fetches it on Windows 10 if needed. Installs per user, no admin rights needed. |
| **Linux** | 64-bit (x86_64) with WebKitGTK 4.1, e.g. Ubuntu 22.04, Debian 12, Fedora 39 or newer. `.deb`, `.rpm` or AppImage. |
| **AWS CLI v2** | Optional: SSO logins use `aws sso login` when it's installed, Contrail's own login otherwise. |

There are no ARM builds for Windows or Linux yet.

## Is it safe to point at production?

By default Contrail is read-only: it never stops, restarts, scales or deploys anything. Stopping tasks and updating
services only works after you turn on **Allow changes to AWS** in the settings, and each change asks for a
confirmation first. A role without the optional `ContrailOptionalChanges` statement of the
[IAM policy](iam-policy.json) can't change anything, whatever the app does. It keeps no credentials of its own.
Details: [Security & privacy](security.md).

## Is my data sent anywhere?

No. Contrail talks to the AWS APIs of the profile you selected and, once a day, checks GitHub for a new version
(you can switch that off). No telemetry, no analytics, no account. Log events stay in memory on your machine.

## Why not just use the AWS console or CloudWatch Logs Insights?

You can, and Contrail doesn't replace Logs Insights for long-range queries. It is for the everyday case: open a
service, see its tasks and why they stopped, and read its live logs as readable, searchable lines with levels,
fields and stack traces, across profiles and accounts, without console tabs or hunting for log groups.

## What doesn't Contrail do?

Contrail is a focused log viewer for ECS. Not supported (yet):

- **Other sources**: EKS, Lambda, EC2 or other log groups that don't belong to an ECS service.
- **Other log drivers**: only `awslogs` with a stream prefix (FireLens and others aren't read).
- **Sidecars**: in tasks with several containers, Contrail reads the first one that logs with `awslogs`.
- **History**: no long-range search across days of logs; a view holds up to 100,000 events (configurable).
  Use Logs Insights or your log platform for that.
- **Actions**: no stop, restart, scale or deploy. That's deliberate.
- **Builds**: the installers aren't code-signed; no ARM builds for Windows and Linux.

## Is it stable?

Contrail is at version 0.x: young, and features are still being added. It keeps no data of its own beyond
preferences, so there is nothing to migrate between versions: new preference fields get defaults, and an unreadable
preferences file is replaced with defaults instead of stopping the app.

## How do I roll it out to my team?

Each person installs the app and uses their own AWS profiles; there is nothing to run centrally. See
[Using Contrail in a team](teams.md) for the AWS config, permissions, costs and log formats.

## Where do I report a bug or ask for a feature?

In [GitHub Issues](https://github.com/Clon1998/contrail/issues). For a bug, the version (Settings → About), your
OS and the steps to reproduce help most. Never paste credentials, and check log lines for anything you'd rather not
share. Security issues: please report them privately, see [SECURITY.md](../SECURITY.md).

## Why "Contrail"?

Contrails are the trails aircraft leave in the sky: lines you read to see where something has been. The logo is
two of them.
