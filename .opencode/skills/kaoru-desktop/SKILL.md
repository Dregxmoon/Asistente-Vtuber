---
name: kaoru-desktop
description: Use when working on desktop automation, autonomous control, open_website, launch_app, browser tasks, UI actions, or the autonomy roadmap in Kaoru (core/desktop, BrowserBridge, OpenClawBridge, TaskDetector).
---

# Kaoru Desktop & Autonomous Control

## Two control planes (never confuse them)

1. **User browser (`external`)** — `DesktopControl.openWebsite` via
   `shell.openExternal`/`xdg-open`. Keeps user sessions, but Kaoru goes **blind**
   (no DOM back). Use ONLY for "just open it".
2. **Managed browser (`managed`)** — `BrowserBridge.js` (own Playwright Chromium,
   background headless + visible). Observable, scoped (`sessionId/pageId/
expectedOrigin`), verifiable. **Mandatory whenever the task must READ or
   VERIFY anything inside the page.**

Rule: verificar ⇒ managed.

## Observe-act-verify contract (mandatory)

- `desktop_snapshot` → ephemeral `ui-N` refs (TTL 60s, latest-only) → `ui_*` /
  `window_*` action with optional `expected` postcondition → re-observe.
- `desktop_screenshot` → single-use `captureId` (30s) → `pointer_click` (visual
  fallback for canvas/games) → re-observe. Never invent coordinates or refs.
- Browser mutating actions require the exact observed triple; `*_verified` and
  `status:'completed'` are the only success proof. Text without evidence = fail.

## Key files

- `core/desktop/DesktopControl.js` — list/launch apps (`.desktop` discovery,
  `gtk-launch` by ID, Win32 helpers), `openWebsite` (https-only + UrlGuard),
  processes, camera (status/open only, never silent capture).
- `core/desktop/DesktopAutomation.js` — snapshot/refs/TTL, screenshot/click,
  `waitFor`/`waitForWindow`, `execute` with `expected` verification.
- `core/desktop/DesktopCapabilities.js` — capability families + kill-switch
  `capability:<id> = deny`.
- `core/planner/OpenClawBridge.js` — `_resolveWebsiteTarget` (URL → alias
  shortcut → web_search fallback + UrlGuard, `resolvedBy` evidence) dispatches
  all `DESKTOP_TOOLS` locally, no HTTP. `play_media` is YouTube-only by design
  (host/path/id validated).
- `core/task/TaskDetector.js` — regex intent (Spanish-first); generic
  open/launch pattern lives in SYSTEM; WEB still alias-locked (known gap).
- `core/planner/StructuredActionParser.js` — ` ```action ` blocks; canonical
  English fields (`ACTION/TARGET/APPLICATION/QUERY/URL/CONTROL`); Spanish
  aliases accepted. Never teach new Spanish-only field names.
- `core/grounding/LanguageProfile.js` — per-turn language detection; response
  language line; `localeFor` table. No behavior branches on language anywhere.

## Kaoru task skills (`skills/` + `core/skills/`)

Existing: `code-review`, `git-workflow`, `testing-patterns` (code-only).
Desktop skills live here too when added (`shop-lookup`, `office-writer`):
recipe = launch/open → wait window → snapshot → act → verify → report with
quoted evidence. Never hardcode stores, links, or pages — resolve at runtime.

## Tests

`tests/test_desktop_control.js`, `tests/test_desktop_automation.js`,
`tests/test_website_resolver.js`, `tests/test_task_detector_desktop.js`,
`tests/test_application_tool_parity.js`. Run with Electron Node
(see kaoru-workflow skill). CI matrix: Linux + Windows (`desktop-contracts`).
