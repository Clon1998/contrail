# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:
[Report a vulnerability](https://github.com/Clon1998/contrail/security/advisories/new) (the **Security** tab of the
repository). Include what you found, how to reproduce it, and which version and OS you used.

Contrail is maintained by one person in their spare time, so there is no guaranteed response time; expect an answer
within a couple of weeks. Fixes go into a new release, and the advisory is published once that release is out.

## Supported versions

Only the latest release gets security fixes. Contrail updates itself, so please stay on the latest version.

## Scope

Of particular interest: any call that changes an AWS resource (Contrail must stay read-only); credentials, tokens
or revealed secret values ending up in files, logs or error messages; log content reaching anything but the app's
own window; the update mechanism. How Contrail handles these is described in [docs/security.md](docs/security.md).
