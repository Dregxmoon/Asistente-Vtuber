# Skills del proyecto (`skills/`)

Conocimiento especializado inyectado contextualmente al agente, cargado por el sistema de skills de
`core/skills/`. Cada skill es una carpeta con su `SKILL.md` (front-matter `description:` + `domains:`).

| Skill               | Propósito                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `code-review/`      | Revisión de código: bugs, seguridad, performance, mantenibilidad y consistencia con las convenciones del proyecto; taxonomía de severidad Critical/Major/Minor     |
| `git-workflow/`     | Operaciones con git: commits, branches, merges/rebase, resolución de conflictos y flujo recomendado (Conventional Commits, operaciones seguras vs. con aprobación) |
| `testing-patterns/` | Patrones de tests del proyecto: estructura `tests/test_<nombre>.js`, helpers, assertions, mocking y reglas de CI                                                   |

Los `SKILL.md` siguen el mismo formato que los skills del usuario (ver `core/skills/README.md`).

Cuando una skill coincide con una tarea, sus instrucciones forman parte del contexto enviado al LLM.
No almacenes claves, tokens, datos personales innecesarios ni contenido de terceros sin permiso en
estos archivos. Consulta el [aviso de privacidad](../docs/web/privacy.html).
