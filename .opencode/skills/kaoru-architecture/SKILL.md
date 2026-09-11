---
name: kaoru-architecture
description: Use when implementing features, fixing bugs, or explaining how Kaoru works. Covers the agent pipeline buildContext to AgentLoop, core modules, grounding, planners, memory, and how data flows between them.
---

# Kaoru Architecture

Runtime: Electron 28 (main + 2 windows, `contextIsolation:true`). Pure CommonJS
(`require`, NO `import`). JSDoc strict with `// @ts-check`; must pass
`npm run typecheck`. Prettier: single quotes, `printWidth: 100`.

## Request pipeline (chat message → response)

```text
src/chat/ → ipc/agent-run → Core.runAgent → core/core/context.js:buildContext()
  1. BehaviorModel.evaluate()      → tone/length/urgency (core/behavior/)
  2. IntentDetector.detect()       → tool intent via local embeddings + sqlite-vec
  3. TaskDetector.detect()         → isTask/domain/confidence (core/task/TaskDetector.js)
  4. GroundingEngine.buildContext()→ system prompt (serializers per provider)
  5. ToolResolver.resolveToolset() → toolset: Skill > MCP > OpenClaw precedence
→ AgentLoop.run()                  → LLM → tool → real result → LLM (max 25-40 iters)
→ OpenClawBridge.execute()         → local desktop / BrowserBridge / HTTP server
→ approvals (ask/allow/deny)       → response + execution summary
```

Key fact: `ToolResolver._buildPromptCatalog` currently **ignores `domain`** —
the full toolset reaches the model on that path. `ToolRegistry.serializeToPrompt`
**does** filter by `domain.id` on the legacy path. Keep both in mind when
changing domains.

## Module map (`core/`)

| Module                                                         | Role                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `core/` (Core.js, core/agent.js, context.js, init.js)          | agent entry, context assembly                                           |
| `grounding/`                                                   | prompt assembly, IntentDetector, EmbedService (worker, NAPI-safe)       |
| `planner/` (AgentLoop, OpenClawBridge, BrowserBridge, parsers) | execution loop, browser, action parsing                                 |
| `desktop/`                                                     | DesktopControl (apps/browser/process/camera) + DesktopAutomation (a11y) |
| `task/` (TaskDetector, ToolRegistry, ToolResolver)             | intent classification + tool catalog                                    |
| `llm/` (LLMProvider, catalog.js, ToolSchemas.js)               | 8+1 providers, fallback chain, native schemas                           |
| `desktop/` adapters                                            | LinuxAtSpiAdapter, WindowsUIAutomationAdapter (no macOS a11y)           |
| `security/` (UrlGuard, PathGuard, SessionApprovals)            | SSRF guard, workspace guard, approval patterns                          |
| `memory/`, `state-graph/`                                      | StateGraph sqlite, episodes, semantic recall                            |
| `identity/` (identity.json, MoodEngine)                        | kawaii vtuber personality, moods                                        |
| `behavior/`                                                    | BehaviorModel, GestureEngine, ProactiveEngine                           |
| `mcp/`, `skills/`, `plugins/`                                  | external tools, Kaoru skills, local plugins                             |
| `connectors/` (GoogleWorkspace, OAuth, Keychain)               | external integrations                                                   |
| `perception/`                                                  | OS/git/system sensors → EventBus → proactivity                          |

`openclaw-server.js` is the local tool server (port 18789, `OPENCLAW_API_KEY`
fail-closed). `main.js` is the Electron entry.

## Generation cancellation

`agent-run` creates one `AbortController`; `agent-cancel` aborts it. Signal flows
`Core.runAgent → AgentLoop.run → LLMProvider.post/postStream`. The loop checks
`signal.aborted` each iteration.
