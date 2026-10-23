# In-app updates and making Contrail public

In-app updates work like Frida's: an installed Contrail reads
`https://github.com/Clon1998/contrail/releases/latest/download/latest.json`, offers the newer version and
installs it after checking its signature. GitHub serves that file without a login **only for a public
repository**, so updates need two things from you: a signing key, and a public repository.

The app side is on `main` (Settings → About → Updates; a header button when an update exists). The release
side (signed updater files and `latest.json`) is on the branch `feat/m8-release`, which isn't merged yet.

## 1. Check the history before going public

Everything ever committed becomes public. Audit of all 193 commits on 2026-10-23:

| Finding | Where | Status |
|---|---|---|
| Your employer and team named in "Audience (v1)" | `plan.md` line 8, since the first commit | **still in the file**: your sentence, your call |
| A real service name and a log excerpt structured like the original samples | `plan.md` §5.3, first commit | replaced in the current file (`9735695`), still in history |
| The hash of a real SSO role in a test | `app/ui/src/lib/session.test.ts`, added 2026-10-23 | replaced (`9735695`), still in history |
| A correlation ID from a real log example in a test | `app/ui/src/components/logs/columns.test.ts`, `44a98fc` | replaced, still in history |
| Commit author e-mail `dev@mobileraker.com` | every commit | your own address |

Not found anywhere in the history: files from `fixtures/`, account IDs, IP addresses, internal host names,
company e-mail addresses, credentials.

Your options:

1. **Publish as it is.** The findings are small (one service name, one role hash, one document ID).
2. **Publish a fresh history:** create a new public repository from the current files (one initial commit) and
   keep this one private as the archive. No history rewrite of this repository (CLAUDE.md forbids rewriting
   published history), and nothing old becomes public.
3. Rewrite this repository's history (e.g. `git filter-repo`): not recommended, it breaks every clone.

Also decide about the `plan.md` "Audience" sentence before publishing.

A public repository also gets **free GitHub Actions minutes** for standard runners, which removes the minute
budget problem.

## 2. Create the update signing key (once)

The updater only installs files signed with this key (Tauri's own signature; installers stay unsigned).

```sh
cd app
pnpm tauri signer generate -w ~/.contrail-signing/contrail-updater.key
```

It asks for a password and writes `contrail-updater.key` (private) and `contrail-updater.key.pub` (public).

- **Back up the private key and its password** (e.g. in your password manager). If they are lost, installed
  copies can't verify future updates and everyone has to reinstall by hand.
- Put the **public** key into `app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (the whole content of
  the `.pub` file, one line) and commit it. Until then the app shows updates but says it can't install them.

## 3. Add the GitHub secrets

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.contrail-signing/contrail-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # paste the password when asked
```

(or GitHub → repository → Settings → Secrets and variables → Actions → New repository secret). The release
workflow signs updater files and uploads `latest.json` only when `TAURI_SIGNING_PRIVATE_KEY` exists.

## 4. Make the repository public

GitHub → repository → Settings → General → Danger Zone → Change visibility, or:

```sh
gh repo edit Clon1998/contrail --visibility public --accept-visibility-change-consequences
```

## 5. Release (when you decide to)

Merge `feat/m8-release` (release workflow, changelog, README, screenshots; its README needs merging with
today's README changes and the screenshots regenerating), then tag as described there. Installed copies see a
release once it is **published** (drafts and pre-releases aren't offered). The first version with the updater
has to be installed by hand; from then on Contrail updates itself.
