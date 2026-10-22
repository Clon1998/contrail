# Decisions

Short ADR-style notes on choices that deviate from, refine or correct `plan.md`.

## 2026-10-22 — Nuxt for the frontend, not Frida's React stack

Frida's frontend is React + Vite + shadcn/ui. `plan.md` and `CLAUDE.md` specify Nuxt + Nuxt UI for Contrail,
with an option to match Frida for consistency. **Decision:** stay on Nuxt as specified (Nuxt 4.6, Nuxt UI 4).
Revisit only if Patrick prefers a shared stack; switching is cheap until M4.

## 2026-10-22 — TypeScript 6.x instead of 7.x

TypeScript 7 (the native Go port) is the npm `latest`, but `vue-tsc` (used by `nuxt typecheck`) builds on
the TypeScript JS language-service API and support for 7.x is not established. **Decision:** pin
TypeScript 6.0.x; revisit when `vue-tsc` documents TypeScript 7 support.

## 2026-10-22 — Committed parser fixtures are synthetic

`plan.md` §5.3 said to copy the real samples from `fixtures/` into `crates/contrail-core/tests/fixtures/`.
That contradicts the rule in `CLAUDE.md` that real logs never leave the gitignored `fixtures/` folder.
**Decision:** `CLAUDE.md` wins; committed fixtures are synthetic look-alikes. `plan.md` is updated.
`.gitignore` anchors the rule as `/fixtures/` so the synthetic folder is not ignored by accident.

## 2026-10-22 — Pinia added with the first store

Pinia is part of the planned stack but M0 has no state to hold. It is added in M1 together with the
profile store, so no unused dependency is carried around.

## 2026-10-22 — Node.js ≥ 24.11

Nuxt 4.6 requires Node `^22.21 || ^24.11 || >=26`; `package.json` `engines` says so. CI uses the latest
Node 24.

## 2026-10-22 — Same repository layout as Frida

The first scaffold followed the original plan: Nuxt at the repository root, `src-tauri/` beside it. Patrick
wants Contrail organised like Frida so both projects read the same. **Decision:** Rust crates stay at the
root; `app/` holds the desktop app as a small pnpm workspace (`app/src-tauri` + the Nuxt frontend as its
own package in `app/ui`). JS commands run from `app/` (or `app/ui/`), Cargo commands from the root.
`plan.md` §4.1 is updated.
