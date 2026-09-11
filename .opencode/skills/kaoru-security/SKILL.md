---
name: kaoru-security
description: Use when touching permissions, approvals, URLs, file paths, credentials, or any high-impact tool in Kaoru. Covers KeychainManager, UrlGuard, PathGuard, isHighImpact, SessionApprovals, and capability kill-switches.
---

# Kaoru Security

## Secrets (hard rules)

- NEVER log, print, or commit API keys or tokens.
- Credential access goes through `KeychainManager` / `_getApiKey` (env →
  OS keychain → config overlay). Status helpers return booleans only.
- `openclaw-server.js` is fail-closed without `OPENCLAW_API_KEY`.

## Execution gates (defense in depth, all must hold)

1. **Capability kill-switch** — `capability:<family> = deny`
   (`core/desktop/DesktopCapabilities.js`) blocks the whole family first.
   Families: applications, browser, screen, pointer, keyboard, processes, camera.
2. **Impact classification** — `isHighImpact(tool, params)`
   (`core/planner/ActionParser.js`): ALL desktop tools + `browser` are high
   impact. `exec` is allowlisted (safe-readonly patterns only); everything else
   asks.
3. **Session approval** — `core/security/SessionApprovals.js:approvalPattern`
   scopes consent (`launch_app:firefox`, `open_website:external:default:host`,
   `play_media:managed:kaoru:youtube:query`). Task-scoped patterns
   (`task:<tipo>:<destino>`) cover whole multi-step tasks with one approval.
4. **URL safety** — `isUrlSafe` (`core/security/UrlGuard.js`): https-only, no
   embedded credentials, SSRF/host blocklist, 3s timeout, 30s host cache in
   `BrowserBridge`. Every resolver result must pass it before opening.
5. **Path safety** — `isImmutablePath` + workspace containment
   (`core/security/PathGuard.js`): uploads/downloads stay inside the project;
   sensitive paths (`.ssh`, `.env`, cookies, wallets) force approval/deny.

## Untrusted content

Web/desktop-extracted text is NEVER trusted: wrap with `wrapUntrusted` /
`wrapUntrustedItems` (`core/grounding/untrustedContent.js`) before it reaches
the LLM. `BrowserBridge` already wraps snapshots, page text, and search results.

## Structured parser hygiene

`StructuredActionParser.js` strips `__proto__/constructor/prototype` from
LLM JSON, sanitizes shell args (`SHELL_METACHAR_RE`), and extracts balanced
JSON for `PARAMS`. Keep these when adding fields or actions.
