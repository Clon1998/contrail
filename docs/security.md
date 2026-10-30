# Security & privacy

What Contrail reads, stores and sends, and how it treats credentials and secret values. Written for the person who
has to approve a tool before a team may use it. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## In short

- A desktop app with **no server component, no account, no cloud sync and no telemetry**.
- **Read-only towards AWS unless you allow changes.** By default Contrail never calls an API that changes a resource; the
  [IAM policy](iam-policy.json) lists every action it uses.
- **Contrail never stores credentials of its own.** Logins go through the AWS CLI, or through Contrail's built-in
  SSO login, which writes the SSO token to the same cache file the CLI uses (below); credentials come from the
  AWS SDK's own chain, exactly as for the `aws` command.
- Secret values of environment variables are read only on an explicit click and never written anywhere.
- Open source under the [MIT license](../LICENSE): you can read, build and audit every line.

## What Contrail reads on your machine

| What | Why |
|---|---|
| `~/.aws/config` (or `AWS_CONFIG_FILE`) | The list of profiles, their regions and SSO settings |
| `~/.aws/credentials` (or `AWS_SHARED_CREDENTIALS_FILE`) | **Only the section names**, so profiles defined there are listed. Key values are never read into Contrail's code or kept |
| `~/.aws/sso/cache/` | Only the expiry of the SSO token, to show whether a profile is logged in |

**What it writes there:** only the built-in SSO login (used when the AWS CLI isn't installed, or switched on in
**Settings → AWS**) writes one file, `~/.aws/sso/cache/<SHA-1 of the session name or start URL>.json`: the same
file, name and format `aws sso login` writes (access token, its expiry and, for `sso-session` profiles, the refresh
token and client registration). It is written atomically and readable only by you (mode 0600 on macOS and Linux),
like the CLI's. Logging out works as with the CLI (`aws sso logout`, or delete the file).

On Windows `~` is `%USERPROFILE%`. Credentials themselves are resolved by the AWS SDK for Rust, the same way the
AWS CLI does it (SSO, assume role, `credential_process`, static keys).

## What Contrail stores, and where

| What | Where |
|---|---|
| Last profile, region overrides, favorites, recent services, settings, "hide lines like this" lists, field mappings, transformers' topics, searches run before and saved searches | `prefs.json` in the app data folder (below) |
| Log events, search results, revealed secret values | Memory only, gone when the view or the app closes |
| Exported logs (`.log` / `.jsonl`) | Only where you save them |

The app data folder is `~/Library/Application Support/io.github.clon1998.contrail/` on macOS,
`%APPDATA%\io.github.clon1998.contrail\` on Windows and `~/.local/share/io.github.clon1998.contrail/` on Linux.
`prefs.json` holds service and profile names, never credentials, tokens or log content. It does hold the searches
you ran (the last 50 per service, 100 in all) and the ones you saved, and a search can contain an ID you
searched for (a correlation ID, an order number). **Clear history** in the search bar's saved-searches menu
removes the history. Contrail writes no log files; its diagnostics go to the console output only.

## Links

A `contrail://` link (**Share → Copy link**) holds names only: profile, region, cluster ARN, service, task, time
window and search text. No credentials or tokens; the search text can contain an ID you searched for, so share
links like any other note about your systems. Installing Contrail registers the `contrail://` scheme with the
operating system so links open in it. Opening a link only switches profile and region and opens the view: the same
read-only calls as clicking there yourself. Contrail opens web pages in your browser only for the SSO login and
for AWS console links (`https://*.console.aws.amazon.com`); it refuses any other address.

## What goes over the network

Only these connections, each started by something you did:

- **AWS APIs** of the selected profile and region, with that profile's credentials: STS (`GetCallerIdentity`, to
  check a login), ECS (list and describe clusters, services, tasks, task definitions), CloudWatch Logs (read log
  events, Live Tail, and Logs Insights only when you choose it for a trace), and Secrets Manager or SSM Parameter
  Store only when you click **Reveal** on a secret. The AWS SDK also talks to the IAM Identity Center portal to turn
  an SSO login into role credentials.
- **`aws sso login`**, which Contrail starts for you when you click **Log in**: the AWS CLI opens your browser and
  does the login itself. Without the CLI, Contrail's built-in login talks to IAM Identity Center's OIDC endpoint
  (`oidc.<sso region>.amazonaws.com`: RegisterClient, StartDeviceAuthorization, CreateToken; unsigned calls that
  change nothing in the account) and opens the login page in your browser.
- **The update check**: at most once a day, a download of
  `https://github.com/Clon1998/contrail/releases/latest/download/latest.json`. Switch it off in **Settings →
  About → Updates**.

There is no analytics, crash reporting or usage tracking.

## Read-only towards AWS, unless you allow changes

Contrail uses `List*`, `Describe*`, `Get*`, `FilterLogEvents`, `StartLiveTail` and (optionally) `StartQuery`. By
default it never stops, restarts, scales or deploys anything, and never creates, changes or deletes a resource.

**Settings → AWS → Allow changes to AWS** (off by default) lets it stop tasks and update services (desired count,
task definition revision, a new deployment), each only after a confirmation that lists what changes. While the
setting is off, the buttons aren't there and the app refuses such calls; the calls that change ECS are kept apart in
the code (`EcsChanges`) from everything that reads. They need the optional `ContrailOptionalChanges` statement of the
[IAM policy](iam-policy.json): a role without it can't change anything, whatever the app tried. Every change shows
up in CloudTrail under your role.

## Secret values

- Plain environment variables whose **names** look like credentials (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY` …)
  are masked in a service's overview until you click them, so they don't show up in a screen share. (Anyone who
  can describe the task definition can read them, in Contrail as in the AWS console.)
- Variables filled from Secrets Manager or SSM show only their **reference**. **Reveal** reads the value on that
  click (`secretsmanager:GetSecretValue` or `ssm:GetParameter`), keeps it in memory while it is shown, and clears
  it on **Hide** or when the view closes. It is never stored, logged or included in error messages.
- The permissions for **Reveal** are a separate, optional statement of the [IAM policy](iam-policy.json):
  leave it out, or narrow its `Resource` to what your team may read. Each read shows up in CloudTrail.

Log events are shown as they are in CloudWatch: if a service logs secrets, Contrail displays them, like the AWS
console would.

## The app itself

The user interface runs in the operating system's web view with a Content Security Policy that allows only the
app's own code: no remote scripts, and no network access from the interface. All AWS calls are made by the Rust
backend.

## Updates and builds

- Release builds are made by GitHub Actions from the tagged source in the repository, not on a developer's
  machine.
- The installers **aren't code-signed yet** (no Apple notarization, no Windows Authenticode). macOS asks once
  (right-click → Open), Windows SmartScreen asks once ("More info" → "Run anyway").
- **Updates** are verified against Contrail's update signing key (built into the app) before anything is installed,
  and only installed when you confirm. Updates come only from published GitHub releases.
- You can always build Contrail yourself from source (see [Download](https://clon1998.github.io/contrail/download/)).
