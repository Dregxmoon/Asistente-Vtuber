# Mejoras para Kaoru — hacia autonomía 100% y nivel top-tier

> Auditoría viva del proyecto (código, conexiones, APIs, TODOs).
> Objetivo: que Kaoru sea una asistente de verdad — con control total, curiosa,
> kawaii y tierna — y que **ninguna tarea dependa de links o páginas predefinidas**.
> Ejemplo guía: *"abre mi LibreOffice Writer y escribe un ensayo sobre la conquista
> de América"* debe funcionar de punta a punta sin atajos hardcodeados.
>
> **Estado de esta revisión:** Fase A1 (resolver universal) y A4 (dominio desktop
> genérico) ya implementadas en código con tests verdes. El resto del plan sigue
> vigente y se amplía abajo con mejoras profundas de nivel top-tier (§7).

---

## 1. Mapa actual del proyecto

```text
Usuario (chat / voz / overlay Live2D)
  └─ src/chat/ + main.js (Electron 28, 2 ventanas, contextIsolation)
       └─ ipc/ (agent-run, agent-cancel, config, github, mcp, proactive…)
            └─ core/Core.js + core/core/ (agent.js, context.js, init.js)
                 ├─ core/grounding/ (GroundingEngine, IntentDetector, TaskDetector*)
                 ├─ core/planner/ (AgentLoop, BrowserBridge, OpenClawBridge, parsers)
                 ├─ core/desktop/ (DesktopControl, DesktopAutomation, adapters)
                 ├─ core/task/ (ToolRegistry, ToolResolver, TaskDetector)
                 ├─ core/llm/ (LLMProvider, catalog.js, ToolSchemas.js)
                 ├─ core/connectors/ (GoogleWorkspace, OAuth, Keychain)
                 ├─ core/mcp/ (MCPManager) + core/skills/ + skills/
                 ├─ core/identity/ (identity.json, MoodEngine) ← personalidad
                 ├─ core/behavior/ (BehaviorModel, gestos, proactividad)
                 ├─ core/memory/ + infrastructure/database/ (sqlite, sqlite-vec)
                 └─ openclaw-server.js (servidor local de tools, puerto 18789)
```

> (*) `TaskDetector` vive en `core/task/`, no en `grounding/` — se usa desde `core/core/context.js`.

### Conexiones y APIs externas (estado real)

| Área | Qué hay | Archivo responsable |
|---|---|---|
| LLM (8 + 1) | groq (primary), gemini, openai, anthropic, xai, nvidia, huggingface, deepseek + `codex-cli` | `core/llm/catalog.js`, `LLMProvider.js`, `CodexCliProvider.js` |
| Auth LLM | env → Keychain del SO → `config.llm.apiKeys`; solo booleanos, nunca se loguean keys | `LLMProvider._getApiKey`, `infrastructure/keychain/` |
| Fallback LLM | primary → fallback con 3 reintentos, backoff+jitter, degradación temporal | `LLMProvider._callWithFallback` |
| GitHub | repos, issues, PRs, Actions | `ipc/github-handlers.js`, `core/git/GitManager.js` |
| Google Workspace | Calendar, Gmail, Drive, Docs, Sheets, Tasks, Contacts vía OAuth local | `core/connectors/GoogleWorkspace.js`, `OAuthCallbackServer.js`, `ConnectorRegistry.js` |
| MCP | servidores stdio (`npx -y`) + HTTP-streamable, tools namespaced `mcp.servidor.tool` | `core/mcp/MCPManager.js`, `config.mcp.servers[]` |
| Voz | ASR local Vosk español (`models/vosk-es/`) + TTS por `tts_stream.py` (6 emociones) | `core/voice/AsrClient.js`, `asr_stream.py`, `tts_stream.py` |
| Servidor tools | exec/read/write/edit/grep/webfetch/websearch, rate-limit, `UrlGuard`, anti-inyección | `openclaw-server.js` (`OPENCLAW_PORT`, `OPENCLAW_API_KEY` fail-closed) |
| Navegador propio | Chromium Playwright: `background` (headless) + `managed` (visible y verificable) | `core/planner/BrowserBridge.js` |
| Escritorio | apps, ventanas AT-SPI2/UIA, captura, puntero, teclado, procesos, cámara (sin captura silenciosa) | `core/desktop/` |
| Skills | `code-review`, `git-workflow`, `testing-patterns` (muy de código, nada de escritorio) | `skills/`, `core/skills/` |
| Memoria | StateGraph sqlite + embeddings locales (sqlite-vec, all-MiniLM-L6-v2) | `core/memory/`, `infrastructure/database/` |

### TODOs / deuda (hallazgo honesto)

`rg TODO|FIXME|XXX|HACK` en `core/desktop|planner|task|grounding` da **0 marcadores
reales** (los hits son falsos positivos del español: "TODO lo ensamblado").
La deuda existe pero no está taggeada (ver §5–§7).

---

## 2. Problema raíz: links y páginas predefinidas (parcialmente resuelto)

Antes todo destino nuevo exigía tocar código:

```js
// core/desktop/DesktopControl.js — SITE_ALIASES con 8 sitios fijos
// "abre amazon" → throw 'Usa un sitio conocido o una URL https completa'
```

**Progreso real:**

- ✅ **A1 hecho** — `_resolveWebsiteTarget` en `core/planner/OpenClawBridge.js`:
  URL → alias (atajo) → búsqueda real + `UrlGuard`. `resolvedBy: url|alias|search`
  como evidencia. Matiz pendiente: vive solo en el bridge; `DesktopControl`
  directo aún rechaza destinos desconocidos.
- ✅ **A4 hecho** — patrón genérico `abre/lanza/inicia + <entidad libre>` en
  `core/task/TaskDetector.js` + fix del catch-all SHELL que robaba clasificación.
  `"abre mi libreoffice writer"` pasó de `domain:null` a `domain:system`.
- ⬜ **Pendiente:** "abre amazon" clasifica como `system` cuando es tarea **web**
  (WEB solo conoce sus alias fijos); el fallback toma el primer https que pasa el
  candado, no el mejor (amazon.com vs amazon.es); sin caché de resoluciones.

### Principio de diseño (vigente)

> **Nada hardcodeado. Todo resuelto en runtime.**
> `entender → resolver → abrir en el modo correcto → observar → actuar →
> verificar → informar`, para Amazon, YouTube, Spotify, juegos o apps con la
> misma tubería. Regla: si hay que LEER/VERIFICAR algo dentro → siempre `managed`,
> nunca `external` (ciego).

---

## 3. Caso guía: LibreOffice Writer + ensayo

*"Abre mi LibreOffice Writer y escribe un ensayo sobre la conquista de América"*

### Qué ya existe

- `launch_app` descubre `.desktop` reales y lanza por ID con `gtk-launch` sin
  interpretar `Exec` (seguro). `list_apps` resuelve el nombre exacto.
- `waitForWindow({ application })` confirma que la ventana apareció.
- `desktop_snapshot → ui_type / ui_press / ui_click → ui_wait(expected)` escribe y
  verifica vía AT-SPI2. Detección del caso guía ya clasifica `system`.
- El LLM genera el contenido y la personalidad lo presenta con calidez.

### Qué falta

1. Sin conocimiento operativo de Writer (`soffice`, "Sin título 1", `Ctrl+S` +
   diálogo). Propuesta: skill `office-writer` (receta, no links fijos).
2. Escritura larga frágil (`ui_type` límite 4000 chars, sin chunking). Propuesta:
   componer por partes en workspace y volcar al final, o generar `.odt` directo.
3. Sin "guardar de verdad" (solo `Ctrl+S` ciego). Propuesta: archivo en disco +
   verificación por existencia/tamaño como sello.
4. Aprobaciones: lanzar + escribir + guardar = 3+ diálogos. Propuesta: una
   aprobación por tarea (`task:office-writer:<archivo>`).

---

## 4. Personalidad: kawaii, tierna, curiosa, presente

| Dónde vive | Qué hace hoy |
|---|---|
| `core/identity/identity.json` | Alma vtuber kawaii, energía 90%, catchphrases, traits, `forbidden_phrases`, conductas ante duda/error/sorpresa |
| `core/identity/MoodEngine.js` + `identity.dynamics.json` | Moods con histéresis y decaimiento, alimentado por progreso del agente |
| `core/behavior/BehaviorModel.js` | Tonos (empathic/curious/playful/focused), longitud y urgencia |
| `core/behavior/Gesture*.js` | 23 gestos Live2D con alias ES/EN/中文/日本語, `llmDriven:true` |
| TTS (6 emociones) | Comparte vocabulario emocional con los gestos |

### Mejoras propuestas (personalidad × autonomía)

1. Celebrar progreso real, no humo (extender `_detectUnverifiedEditClaims` a
   desktop: sin `intentVerified` no hay "¡listo, ya está!").
2. Curiosidad operativa: ante ambigüedad (¿qué Amazon? ¿dónde guardo?), **una**
   pregunta concreta con dulzura en vez de adivinar o rendirse.
3. Presencia en tareas largas (`onPlan` + gestos `writing/thinking/excited`).
4. Memoria de gustos (tienda, formato, navegador) para no preguntar dos veces.
5. Tono serio cuando toca (CAPTCHA, app ausente) como ya prevé `identity.json`.

---

## 5. Plan por fases (estado actualizado)

### Fase A — Quitar lo hardcodeado

- [x] A1. Resolver destinos genérico (bridge; pendiente portarlo a
      `DesktopControl` directo + caché + scoring de relevancia).
- [ ] A2. `SITE_ALIASES`/`APP_ALIASES` como caché de atajos, no lista blanca.
- [ ] A3. Generalizar `play_media` (hoy YouTube-only) a Spotify/otros.
- [x] A4. Dominio desktop genérico (pendiente contraparte web genérica).

### Fase B — Multilingüe sin pila por idioma

- [ ] B1. Embeddings multilingües (`paraphrase-multilingual-MiniLM-L12-v2`).
- [ ] B2. Poblar `intent_catalog` con frases desktop/ofimática/navegación ES+EN.
- [ ] B3. Parser bilingüe (`ACTION/TARGET/APP` además de `ACCIÓN/SITIO`).
- [ ] B4. IDs canónicos en inglés interno; español solo presentación.

### Fase C — Skills de tarea

- [ ] C1. `desktop-task`: observar → actuar → verificar (universal).
- [ ] C2. `office-writer`: lanzar → esperar → escribir por bloques → guardar.
- [ ] C3. `shop-lookup`: buscar → `get_text` precio/stock → responder con evidencia.
- [ ] C4. Política external-vs-managed en el prompt ("verificar ⇒ managed").

### Fase D — Autonomía con seguridad

- [ ] D1. Aprobación por tarea (`task:<tipo>:<destino>`), no por clic.
- [ ] D2. Estrategia CAPTCHA/bloqueo visible + continuar manual.
- [ ] D3. Plan B sin AT-SPI (Wayland: captura + `pointer_click` + re-observar) y
      sin `.desktop` (binario directo).
- [ ] D4. Documentos a archivo (ODT/MD) + verificación en disco.

### Fase E — Presencia kawaii

- [ ] E1. Progreso narrado + gestos en tareas desktop.
- [ ] E2. Claims honestos en desktop.
- [ ] E3. Pregunta curiosa única ante ambigüedad.
- [ ] E4. Tests e2e Writer y shop-lookup con mocks.

---

## 6. Criterio de "funciona de verdad"

1. Destino correcto verificado (ventana/URL, no asumida).
2. Acción sobre observación vigente (ref no inventada).
3. **Evidencia** (`get_text` citado, archivo en disco, `playing:true`) — "se ve
   bien" no cuenta.
4. Mensaje claro: resultado + evidencia + pendientes.
5. Sin destino predefinido en código, en el idioma del usuario.

---

## 7. Mejoras profundas nivel top-tier (nuevo)

Lo anterior lleva a Kaoru al 100% de *tareas*. Esto la lleva al nivel de
*software top-tier*: fiable, rápida, segura y adorable incluso cuando todo sale mal.

### 7.1 Orquestación y planificación (cerebro ejecutivo)

- [ ] **T1. Planificador multi-paso con replanificación.** Hoy `AgentLoop` (máx
      25–40 iteraciones) improvisa paso a paso. Un plan explícito
      (`plan.steps[]` con dependencias, criterios de éxito y plan B por paso)
      + replan ante fallo verificado evita martillar el mismo error y permite
      "abre Amazon, compara tomo 18 en 3 tiendas y avísame del más barato".
- [ ] **T2. Descomposición automática.** Detectar tareas compuestas
      ("abre X **y** haz Y **y** avísame") y partirlas en subtareas con su propia
      evidencia, ejecutables en serie o paralelo (subagentes ya existen pero sin
      receta desktop).
- [ ] **T3. Presupuesto por tarea.** Tiempo, iteraciones y costo LLM acotados por
      tarea con degradación elegante ("llevo 2 min sin verificar stock, te muestro
      lo que tengo y sigo en segundo plano"). Hoy o termina o abandona.
- [ ] **T4. Continuidad entre sesiones.** Reanudar tareas (`resumePoint` ya existe
      en el ledger) desde el chat o tras reiniciar la app, con estado visible
      ("ayer dejamos el ensayo a mitad — ¿seguimos?").

### 7.2 Percepción y grounding (ojos y oídos)

- [ ] **T5. Fusión de observaciones.** Combinar AT-SPI + captura + DOM del
      navegador en un solo modelo de "qué hay en pantalla" con coordenadas y
      roles unificados. Hoy son tres mundos separados (snapshot, screenshot,
      browser-snapshot).
- [ ] **T6. Localizadores resilientes.** Si un `ref ui-N` expira, re-resolver por
      (rol + nombre + ventana) en vez de exigir snapshot completo de nuevo.
      Menos fricción, menos iteraciones quemadas.
- [ ] **T7. OCR + visión como respaldo.** Cuando AT-SPI no ve nada (canvas,
      juegos, PDFs escaneados, Wayland), OCR local + `pointer_click` verificado
      con captura posterior. Hoy el clic visual existe pero sin lectura.
- [ ] **T8. Comprensión de documentos.** Leer el contenido real de Writer/PDF/web
      (no solo el árbol UI) para resumir, continuar o verificar ("¿el ensayo ya
      menciona a Tenochtitlan?").

### 7.3 Ejecución robusta (manos que no tiemblan)

- [ ] **T9. Acciones idempotentes y reintentables.** Cada acción desktop con
      `retry` acotado + verificación posterior + rollback local (cerrar pestaña
      abierta por error, deshacer type erróneo con `Ctrl+Z` verificado).
- [ ] **T10. Transacciones de tarea.** Agrupar mutaciones (abrir + escribir +
      guardar) con confirmación atómica: o todo verificado o estado anterior
      restaurado + informe honesto. El `WorkspaceCheckpoint` ya hace esto para
      código — extenderlo a escritorio.
- [ ] **T11. Modo "manos quietas".** Pausar proactividad y gestos invasivos
      mientras el usuario escribe en la misma app que Kaoru controla (evita
      carreras por el foco/teclado). `ContextGate` ya conoce flow — usarlo aquí.
- [ ] **T12. Cola de tareas.** "Haz X, luego Y, luego Z" en background con
      notificaciones kawaii al completar cada una, sin bloquear el chat.

### 7.4 Seguridad y confianza (autonomía sin miedo)

- [ ] **T13. Modelo de capacidades por app/sitio.** No es lo mismo escribir en
      Writer que clicar "comprar" en Amazon. Acciones irreversibles (comprar,
      pagar, borrar, enviar) exigen confirmación explícita con resumen humano
      aunque el modo sea `act`. Hoy `highImpact` es binario.
- [ ] **T14. Simulación en seco (dry-run).** "¿Qué harías si…?" muestra el plan
      paso a paso sin ejecutar, con riesgos marcados. Ideal antes de tareas
      delicadas y para ganar confianza.
- [ ] **T15. Auditoría visible.** Historial por tarea: qué se abrió, qué se
      clicó, qué evidencia se obtuvo, con timestamp. `MutationJournal` y
      `RunMetrics` ya recogen datos — falta la vista de usuario.
- [ ] **T16. Límites anti-daño.** Lista de acciones jamás autónomas (vaciar
      papelera, `rm -rf`, cerrar sesión, comprar sin confirmar) ni siquiera en
      modo `act`. Hoy dependen solo del prompt.

### 7.5 Memoria y personalización (asistente que te conoce)

- [ ] **T17. Perfil de usuario vivo.** Tienda favorita, formato de ensayos,
      navegador, idioma, horarios, apps más usadas — aprendido de outcomes, no
      solo preguntado. `memory_search` ya existe; falta el circuito
      tarea → preferencia guardada → próxima tarea más corta.
- [ ] **T18. Memoria de tareas.** "Como la otra vez" debe funcionar: reutilizar
      la receta exitosa anterior (tienda, pasos, selectores) antes de improvisar.
- [ ] **T19. Corrección como entrenamiento.** Cuando el usuario corrige
      ("no, era amazon.es, no .com"), guardar la regla y confirmarla la próxima
      vez ("¿uso amazon.es como siempre?"). Cierra el loop de aprendizaje.
- [ ] **T20. Proactividad útil, no molesta.** Avisar "el tomo 18 ya está
      disponible" (re-chequeo programado con consentimiento) es el `ProactiveEngine`
      aplicado a desktop. Hoy la proactividad no toca escritorio.

### 7.6 UX y presencia (se siente viva)

- [ ] **T21. Narrativa de progreso.** Streaming real de "abriendo Amazon…
      buscando… leyendo precio… ¡verificado!" con gestos Live2D sincronizados.
      El cableado (`onToken`, `onPlan`, `agentStates`) existe — falta el guion
      desktop.
- [ ] **T22. Vista de tarea.** Tarjeta en el chat por tarea activa: pasos con
      ✓/…/✗, evidencia adjunta (captura, precio, ruta de archivo), botones
      Detener / Continuar manual / Deshacer.
- [ ] **T23. Handoff humano impecable.** Cuando algo requiere manos humanas
      (CAPTCHA, login, pago), dejar todo preparado (navegador abierto, carrito
      listo, texto copiado) + instrucciones de 1 frase + retomar al volver.
- [ ] **T24. Celebración proporcional.** Confeti kawaii ante "¡tomo 18 en stock!",
      tono sereno ante errores de dinero/datos. `MoodEngine` + TTS ya lo permiten.

### 7.7 Voz y multimodal (hablar mientras hace)

- [ ] **T25. Comando por voz continuo.** "Kaoru, abre Writer y escribe…" con
      confirmación por voz y dictado directo a la app (ASR Vosk ya corre local).
- [ ] **T26. Lectura en voz alta de resultados.** "El tomo 18 está disponible a
      12,99 €" con TTS + gesto `excited`. Hoy TTS y desktop no se hablan.
- [ ] **T27. Entrada por imagen.** Arrastrar captura/foto ("¿esto está disponible
      más barato?") → OCR/búsqueda visual → respuesta. Cierra el loop multimodal.

### 7.8 Observabilidad y auto-mejora (aprende sola)

- [ ] **T28. Métricas por tarea desktop.** Tasa de éxito, pasos promedio,
      fallos por clase (`_failureClass` ya clasifica: `human_challenge`,
      `stale_observation`, `timeout`…), tiempo por fase. Hoy solo hay métricas
      genéricas de run.
- [ ] **T29. Auto-reporte de fricción.** Si una tarea quema >N iteraciones o
      falla 2 veces igual, generar propuesta de mejora (nueva frase intent,
      nuevo alias, nueva skill) para revisión — el `LearningEngine` ya produce
      feedback, falta conectarlo a desktop.
- [ ] **T30. Benchmarks de autonomía.** Suite que mida "10 tareas típicas
      (Amazon, Writer, Spotify, Steam…) de punta a punta con mocks" y su % de
      éxito por versión. Lo que no se mide no mejora.

### 7.9 Rendimiento y recursos (rápida y ligera)

- [ ] **T31. Arranque perezoso.** Playwright, AT-SPI y embeddings solo al primer
      uso real (warmup inteligente), no al iniciar la app. Menos RAM, inicio
      instantáneo.
- [ ] **T32. Cachés con invalidez correcta.** Resoluciones web, snapshots y
      listados de apps cacheados por TTL corto + invalidación ante mutación
      (el `_readCache/_execCache` del loop es el precedente).
- [ ] **T33. Costo LLM acotado.** Snapshots y DOM truncados/resumidos antes del
      prompt (el presupuesto `AGENT_MAX_SYSTEM_CHARS` ya existe — aplicarlo con
      resúmenes extractivos, no solo truncado).

### 7.10 Compatibilidad y plataforma (funciona en tu máquina)

- [ ] **T34. Paridad Wayland.** Plan B de primera clase (captura + OCR + clic
      visual verificado) cuando AT-SPI no responde, detectado en `health()`.
- [ ] **T35. Paridad Windows/macOS.** `DesktopControl` ya abstrae por plataforma;
      cerrar huecos (macOS sin accesibilidad, listeners de ventana) con matriz CI
      que lo verifique (`desktop-contracts` ya corre Linux/Windows).
- [ ] **T36. Detección de entorno.** Si falta Playwright/Chromium, Writer o
      permisos de accesibilidad, decirlo al inicio con comando de instalación
      exacto, no fallar a mitad de tarea.

### 7.11 Testing y calidad (confianza demostrable)

- [ ] **T37. Contratos por herramienta.** Cada tool desktop con esquema,
      precondiciones y postcondiciones testeadas (el patrón de
      `test_desktop_control/automation` extendido a resolver, skills y
      transacciones).
- [ ] **T38. Fuzzing de entradas.** "Ábreme …" con tildes, mayúsculas, otros
      idiomas, inyecciones (`; rm -rf`, `javascript:`) — debe rechazar o resolver
      con seguridad, nunca ejecutar.
- [ ] **T39. Tests de no-regresión de personalidad.** `forbidden_phrases` y tono
      verificados automáticamente en respuestas de tareas (kawaii sin humo).

### 7.12 Ecosistema (crece sin tocar el núcleo)

- [ ] **T40. Plugin `desktop-extra`.** Recetas de la comunidad (tiendas por país,
      apps regionales, atajos) como plugins locales con tools + hooks, sin
      modificar `core/`. `PluginManager` ya carga plugins — falta el primero.
- [ ] **T41. MCP de productividad.** Conectar Nextcloud/Notion/Obsidian/local-FS
      como fuentes y destinos de documentos, para que "escribe el ensayo" pueda
      terminar en tu nube real con verificación.
- [ ] **T42. Skills versionadas y compartibles.** Empaquetar `office-writer` o
      `shop-lookup` con su versión, tests y changelog para reutilizar entre
      máquinas.

---

*Documento vivo: A1/A4 hechos con tests verdes (`test_website_resolver.js`,
`test_task_detector_desktop.js`). Siguiente valor máximo: patrón web genérico
(§2) + skill `shop-lookup` (C3) para cerrar el ejemplo del manga de punta a punta.* 💫
