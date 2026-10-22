# Decisions

Short ADR-style notes on choices that deviate from, refine or correct `plan.md`.

## 2026-10-22 — Frida's frontend stack instead of Nuxt

The original plan specified Nuxt + Nuxt UI + Pinia, with the option to match Frida for consistency. M0 was first
scaffolded with Nuxt; Patrick then chose consistency with Frida. **Decision:** React + Vite + shadcn/ui + Tailwind 4 +
zustand, with Frida's lint/test setup (typescript-eslint, Prettier, Vitest + Testing Library, Playwright with mocked
IPC). One frontend stack across both projects; components and patterns can be shared. `plan.md` and `CLAUDE.md`
are updated. Switched during M0, when only a hello-world page existed.

## 2026-10-22 — TypeScript 6.x instead of 7.x

TypeScript 7 (the native Go port) is the npm `latest`, but tooling such as typescript-eslint builds on the
TypeScript JS API, and support for 7.x is not established. Frida stays on 6.0.x for the same reason.
**Decision:** pin TypeScript 6.0.x; revisit when typescript-eslint documents TypeScript 7 support.

## 2026-10-22 — Committed parser fixtures are synthetic

`plan.md` §5.3 said to copy the real samples from `fixtures/` into `crates/contrail-core/tests/fixtures/`.
That contradicts the rule in `CLAUDE.md` that real logs never leave the gitignored `fixtures/` folder.
**Decision:** `CLAUDE.md` wins; committed fixtures are synthetic look-alikes. `plan.md` is updated.
`.gitignore` anchors the rule as `/fixtures/` so the synthetic folder is not ignored by accident.

## 2026-10-22 — zustand added with the first store

zustand is part of the stack but M0 has no state to hold. It is added in M1 together with the profile store,
so no unused dependency is carried around.

## 2026-10-22 — Node.js 24

`package.json` `engines` requires Node ≥ 24 (Vite 8 itself needs `^20.19 || >=22.12`). CI uses the latest Node 24.

## 2026-10-22 — Same repository layout as Frida

The first scaffold followed the original plan: the frontend at the repository root, `src-tauri/` beside it. Patrick
wants Contrail organised like Frida so both projects read the same. **Decision:** Rust crates stay at the
root; `app/` holds the desktop app as a small pnpm workspace (`app/src-tauri` + the frontend as its own
package in `app/ui`). JS commands run from `app/` (or `app/ui/`), Cargo commands from the root.
`plan.md` §4.1 is updated.
