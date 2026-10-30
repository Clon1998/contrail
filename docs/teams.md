# Using Contrail in a team

How to roll Contrail out to a team: what each person needs, which AWS permissions to hand out, what it costs, and
what your services' logs should look like to get the most out of it. There is nothing to run centrally: each person
installs the app and uses their own AWS login.

## What each person needs

- **Contrail** ([Download](https://clon1998.github.io/contrail/download/)). It updates itself; the update check can
  be switched off in **Settings → About → Updates**.
- **Optionally the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)**:
  Contrail runs `aws sso login` for you when it's installed, and logs in itself otherwise (a code to confirm in the
  browser; the token goes to the CLI's cache).
- **AWS profiles** in `~/.aws/config`. SSO profiles (IAM Identity Center) are the main case; profiles with assume
  role, `credential_process` or static keys work too, because the AWS SDK resolves them like the CLI does.

## Share the AWS config

Most teams already have a shared `~/.aws/config` snippet, or can make one with `aws configure sso`. One
`sso-session` and a profile per account and role is all Contrail needs:

```ini
[sso-session company]
sso_start_url = https://example.awsapps.com/start
sso_region = eu-central-1
sso_registration_scopes = sso:account:access

[profile orders-dev]
sso_session = company
sso_account_id = 111111111111
sso_role_name = ReadOnly
region = eu-central-1

[profile orders-prod]
sso_session = company
sso_account_id = 222222222222
sso_role_name = ReadOnly
region = eu-central-1
```

Profiles that share an `sso-session` share one login. Using the **same profile names** across the team helps when
people talk about "orders-prod" or share a screenshot; Contrail keeps favorites and recent services per profile name.

## Permissions

Contrail only reads, unless you allow changes. Admin and broad read-only roles usually cover reading; for narrower roles, give
[`docs/iam-policy.json`](iam-policy.json) to whoever manages your SSO permission sets (also on the
[AWS permissions](https://clon1998.github.io/contrail/permissions/) page):

- `ContrailReadOnly` is what everyone needs: ECS describe/list, reading log events and Live Tail.
- `ContrailOptionalRevealSecrets` only to show values of secret environment variables. Leave it out, or narrow its
  `Resource` to the secrets the team may read; every read is in CloudTrail.
- `ContrailOptionalInsightsTrace` only for tracing across many services with Logs Insights.
- `ContrailOptionalChanges` only for teammates who may stop tasks and update services from Contrail (they also turn
  on **Allow changes to AWS** in the settings).

A role without `ContrailOptionalChanges` can't change anything, whatever the app does.

## What it costs

Contrail is free; the AWS calls it makes are billed to your accounts like any other use:

- **Live Tail** is billed per session minute. Contrail keeps that low by default: a view only follows live while its
  time window is 15 minutes or shorter, tails of views you haven't looked at for 10 minutes pause, and all tails
  pause 30 seconds after Contrail is hidden (resuming with a catch-up when you're back). The limits are in
  **Settings**. Without the `logs:StartLiveTail` permission, Contrail checks for new events every 2 seconds instead.
- **Logs Insights** (optional, for tracing across many services) is billed per GB scanned. It is only used when you
  tick **Use Logs Insights** in the trace dialog; the default trace search uses `FilterLogEvents`.
- Reading log events and describing ECS resources are ordinary API calls.

See [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) for the current prices.

## Logs that work well

Contrail reads the log group from the task definition, so services need the **`awslogs` log driver with an
`awslogs-stream-prefix`**. Beyond that, the more structure your logs have, the more Contrail can do:

- **ECS JSON** (Elastic Common Schema, nested or with dotted keys, as written by `logback-ecs-encoder` and similar)
  gives levels, loggers, threads, fields and stack traces. Spring Boot's default console pattern and plain text
  work too, with less structure.
- **Other JSON field names** can be mapped per service (the **Field mapping** button in the log toolbar), so `lvl`
  or `msg` work like `log.level` and `message`. Mappings are saved on each machine.
- **Correlation or trace IDs** (`correlationId` / `correlation_id` or `trace.id` / `traceId` / `trace_id`, alone or
  under any prefix, or Spring's `[traceId-spanId]`; a correlation ID wins when an event has both) enable the
  correlation column and **tracing across services**: logging the same ID in every service a request passes
  through is what makes that work.
- **Stack traces** that CloudWatch split into one event per line are joined again; logging them inside the JSON
  event (`error.stack_trace`) is still better.

[Search syntax](query-syntax.md) describes what you can search for once the fields are there.

## Trying it without AWS

`CONTRAIL_DEMO=1` (or `--demo`) starts Contrail with invented profiles, clusters and live logs and makes no AWS
calls at all. It is a quick way to show the app to a team before anyone sets up permissions.
