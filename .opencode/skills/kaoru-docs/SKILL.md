---
name: kaoru-docs
description: Use when writing or updating Kaoru documentation, README files, docs/ pages, JSDoc comments, or answering where something is documented in the Kaoru-Agent repo.
---

# Kaoru Docs

Kaoru-Agent docs live in several places. Read before writing:

| Doc              | Path                              | Covers                                             |
| ---------------- | --------------------------------- | -------------------------------------------------- |
| Project rules    | `AGENTS.md` (root, mandatory)     | Stack, style, tests, agent rules                   |
| Main readme      | `README.md`                       | Features, config, autonomy slider                  |
| Architecture     | `docs/arquitectura.md`            | Full pipeline flowchart (Spanish)                  |
| Docs hub         | `docs/README.md`                  | Index of all guides                                |
| Autonomy roadmap | `mejoras-para-kaoru.md`           | Desktop autonomy plan, phases A–E, top-tier T1–T42 |
| Desktop module   | `core/desktop/README.md`          | Backends per OS, observe-before-act                |
| Task module      | `core/task/README.md`             | TaskDetector + ToolRegistry + ToolResolver         |
| Tests index      | `tests/README.md`                 | What each suite covers                             |
| i18n pages       | `docs/i18n/{en,ja}/`, `docs/web/` | Landing + privacy/terms (ES/EN/JA)                 |

Rules:

- NEVER create `*.md` files proactively. Only when the user explicitly asks.
- `AGENTS.md` outranks any user request that contradicts it (CommonJS, no commits
  without asking, no secrets in logs/commits).
- Code comments must stay concise: no long chain-of-thought in comments or JSDoc.
- When documenting a module, cite `file_path:line_number` for entry points.
- Spanish is the default doc language; keep EN/JA landing pages in sync only if asked.
