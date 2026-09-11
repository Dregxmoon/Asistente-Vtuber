---
name: kaoru-workflow
description: Use for any code change in Kaoru-Agent. Covers how to run tests with Electron Node, format, lint, typecheck, native module rebuilds, git branches produccion/testing, and commit rules.
---

# Kaoru Dev Workflow

## Before editing

- Deterministic edits only: `oldString` must match exactly once. If it doesn't
  exist or matches multiple times, stop and ask — never guess.
- New pipeline modules need `// @ts-check` and must pass `npm run typecheck`
  (tsc, `noImplicitAny`/`strictNullChecks`). No TypeScript-with-build.
- Pure CommonJS. No `spawnSync` — async `exec`/`spawn` only, never block main.

## Verify after editing

1. `node --check <touched files>`
2. Relevant suite(s) — **NEVER system `node`** for suites touching
   `better-sqlite3`/`sqlite-vec` (different ABI). Always:
   `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/<suite>.js`
3. `npx prettier --check <touched files>` (single quotes, width 100);
   fix with `--write`.
4. `npm run typecheck` and `npx eslint <touched files>` when touching pipeline code.

## Test runner

`npm test` runs `tests/run-all.js`, which **auto-discovers** `tests/test_*.js`
(+ `tests/e2e/`). New test files need no registration. Full regression needs
`data/core.db` (`npm run init-db`) and Chromium (`npx playwright install chromium`).

## Native modules

- `better-sqlite3`/`sqlite-vec` are V8-ABI → rebuild for Electron: `npm run rebuild`.
- `onnxruntime-node` is NAPI (stable ABI): **NEVER** electron-rebuild it. If
  `Module did not self-register` on first load → reinstall the package. If it
  happens on worker reload in the same process → restart the app (binding loads
  once per process; the embed worker is persistent). Diagnose with
  `EmbedService.checkNativeBindings()`.

## Git

- Branches: `produccion` (stable) ← `testing` (all changes land here first).
- NEVER `git commit`/`push` unless the user explicitly asks. Before committing:
  `git status`, `git diff`, `git log --oneline -10`; stage only intended files;
  never commit secrets. Concise commit message matching repo style.
- Never update git config, skip hooks, force-push, or create empty commits
  unless explicitly requested.
