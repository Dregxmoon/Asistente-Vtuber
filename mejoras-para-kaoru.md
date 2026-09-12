# Mejoras para Kaoru — hacia autonomía 100% y nivel top-tier

> Auditoría viva del proyecto (código, conexiones, APIs, TODOs).
> Objetivo: que Kaoru sea una asistente de verdad — con control total, curiosa,
> kawaii y tierna — y que **ninguna tarea dependa de links o páginas predefinidas**.
> Ejemplo guía: _"abre mi LibreOffice Writer y escribe un ensayo sobre la conquista
> de América"_ debe funcionar de punta a punta sin atajos hardcodeados.
>
> **Estado de esta revisión (rama testing):** implementado y verificado con tests
> verdes **y en vivo** (esta máquina: 70 apps, AT-SPI activo, Chromium real,
> Tesseract 5.5, Calculadora abierta/observada/cerrada de verdad, Amazon real
> leído en managed, último video de nissaxter resuelto en vivo) —
> A1+A4 originales más P0 (resolver compartido `WebsiteResolver` con
> scoring+caché, paridad bridge/control, dominio web por contexto, fix
> "está disponible el manga"), P1 (B2: 42 frases desktop ES+EN indexadas en
> `data/core.db`; B3: parser bilingüe), P2 (C4: política managed + recetas en el
> prompt; C2/C3: skills `shop-lookup` y `office-writer`; D1: aprobación por
> tarea con card única IPC), E4 (e2e con mocks ES/EN/Linux/Windows), 5 skills de
> OpenCode en `.opencode/skills/` y **multilenguaje por inferencia**:
> `LanguageProfile` (detección por turno), fusión intent→task por embeddings
> (EN sin regex inglés), protocolo canónico neutral en el serializer, guard
> `needsVerification`, locale dinámico del navegador, voz/ASR por idioma,
> clarificación con candidatos, **fallback Bing RSS** (Google/DDG bloquean
> scraping en vivo; probado: `amazon → amazon.com.mx` en 2.9s reales) y
> **nombres de apps localizados** (`Name[es]` + aliases: "calculadora" encuentra
> Calculator). Criterio cumplido: typecheck sin errores nuevos, ESLint limpio,
> 230/230 en `test_agent_loop`, regresión vecina verde. Hallazgo honesto: frases
> EN largas y compuestas diluyen los embeddings (0.32, no detecta) — pendiente
> B1 (modelo multilingüe) + más frases compuestas.

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

| Área             | Qué hay                                                                                          | Archivo responsable                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| LLM (8 + 1)      | groq (primary), gemini, openai, anthropic, xai, nvidia, huggingface, deepseek + `codex-cli`      | `core/llm/catalog.js`, `LLMProvider.js`, `CodexCliProvider.js`                         |
| Auth LLM         | env → Keychain del SO → `config.llm.apiKeys`; solo booleanos, nunca se loguean keys              | `LLMProvider._getApiKey`, `infrastructure/keychain/`                                   |
| Fallback LLM     | primary → fallback con 3 reintentos, backoff+jitter, degradación temporal                        | `LLMProvider._callWithFallback`                                                        |
| GitHub           | repos, issues, PRs, Actions                                                                      | `ipc/github-handlers.js`, `core/git/GitManager.js`                                     |
| Google Workspace | Calendar, Gmail, Drive, Docs, Sheets, Tasks, Contacts vía OAuth local                            | `core/connectors/GoogleWorkspace.js`, `OAuthCallbackServer.js`, `ConnectorRegistry.js` |
| MCP              | servidores stdio (`npx -y`) + HTTP-streamable, tools namespaced `mcp.servidor.tool`              | `core/mcp/MCPManager.js`, `config.mcp.servers[]`                                       |
| Voz              | ASR local Vosk español (`models/vosk-es/`) + TTS por `tts_stream.py` (6 emociones)               | `core/voice/AsrClient.js`, `asr_stream.py`, `tts_stream.py`                            |
| Servidor tools   | exec/read/write/edit/grep/webfetch/websearch, rate-limit, `UrlGuard`, anti-inyección             | `openclaw-server.js` (`OPENCLAW_PORT`, `OPENCLAW_API_KEY` fail-closed)                 |
| Navegador propio | Chromium Playwright: `background` (headless) + `managed` (visible y verificable)                 | `core/planner/BrowserBridge.js`                                                        |
| Escritorio       | apps, ventanas AT-SPI2/UIA, captura, puntero, teclado, procesos, cámara (sin captura silenciosa) | `core/desktop/`                                                                        |
| Skills           | `code-review`, `git-workflow`, `testing-patterns` (muy de código, nada de escritorio)            | `skills/`, `core/skills/`                                                              |
| Memoria          | StateGraph sqlite + embeddings locales (sqlite-vec, all-MiniLM-L6-v2)                            | `core/memory/`, `infrastructure/database/`                                             |

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
verificar → informar`, para Amazon, YouTube, Spotify, juegos o apps con la
> misma tubería. Regla: si hay que LEER/VERIFICAR algo dentro → siempre `managed`,
> nunca `external` (ciego).

---

## 3. Caso guía: LibreOffice Writer + ensayo

_"Abre mi LibreOffice Writer y escribe un ensayo sobre la conquista de América"_

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

| Dónde vive                                               | Qué hace hoy                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `core/identity/identity.json`                            | Alma vtuber kawaii, energía 90%, catchphrases, traits, `forbidden_phrases`, conductas ante duda/error/sorpresa |
| `core/identity/MoodEngine.js` + `identity.dynamics.json` | Moods con histéresis y decaimiento, alimentado por progreso del agente                                         |
| `core/behavior/BehaviorModel.js`                         | Tonos (empathic/curious/playful/focused), longitud y urgencia                                                  |
| `core/behavior/Gesture*.js`                              | 23 gestos Live2D con alias ES/EN/中文/日本語, `llmDriven:true`                                                 |
| TTS (6 emociones)                                        | Comparte vocabulario emocional con los gestos                                                                  |

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

- [x] A1. Resolver destinos genérico: `core/desktop/WebsiteResolver.js`
      compartido (URL → alias → búsqueda con scoring + caché TTL + UrlGuard),
      usado por `OpenClawBridge` y `DesktopControl` (`test_website_resolver.js`).
- [x] A2. Alias como atajos: el resolver los trata como shortcut; el fallback
      genérico es lo que da el 100% (sin ampliar listas a mano).
- [ ] A3. Generalizar `play_media` (hoy YouTube-only) a Spotify/otros.
- [x] A4. Dominio desktop genérico + contraparte web por contexto
      (`WEB_HINTS_RE`, `test_task_detector_desktop.js`) + fix "está disponible".

### Ronda inferencia total (sin palabras, sin LLM nuevo)

- [x] **Intenciones por inferencia** (`core/task/IntentClassifier.js`): coseno
      contra ejemplos realistas por dominio (ES+EN), umbral + margen calibrados
      en vivo (ES/EN/JA). El regex queda como fallback si fallan embeddings.
      Cableado en `core/core/context.js`: regex → fusión intent → clasificador
      → (opt-in) árbitro. Ningún idioma nuevo toca código.
- [x] **Árbitro LLM opt-in** (`core/task/IntentArbitrator.js`): JSON estricto,
      timeout 8s, fallback a null. Para negación y multi-intención.
      **Por qué no un LLM pequeño local**: el modelo pequeño local YA es el de
      embeddings (offline, ms, 0 deps); un generativo sumaría ~400MB, ~1GB RAM
      y segundos por mensaje para lo que Groq hace mejor.

### Ronda profunda (verificada en vivo + suites)

- [x] **B1 real:** `core/grounding/EmbedModel.js` (fuente única) +
      `paraphrase-multilingual-MiniLM-L12-v2` en los 5 call sites + reindex
      total (DB 220→287) + calibración con queries reales ES/EN/JA. JA→ES cruza
      a 0.65; EN compuesto llega a 0.54-0.60 (límite del modelo, documentado).
      Regresiones del swap corregidas con frases compuestas y descripciones de
      skills bilingües con ejemplos (convención nueva). Nota: el caché del
      modelo vive en `node_modules/@xenova/transformers/.cache/` (~150MB, se
      re-descarga con `npm ci` limpio).
- [x] **Login guiado Ruta 1** (`personal_browser_login`): abre el sitio en
      navegador verificable, devuelve observación para retomar, estado honesto
      `login_required` + `verified:false` siempre. Kaoru jamás escribe
      credenciales. Receta en el prompt.
- [x] **Card de tarea en el renderer** (`src/chat/ipc.js` + `process.js`):
      título "¿HAGO TODA ESTA TAREA?", alcance visible, mismos botones y canal.
      Sin `taskScope` pinta el card clásico (compatible hacia atrás).
- [x] **T13/T16 irreversibles** (`core/security/IrreversiblePolicy.js`):
      comprar/pagar/borrar/publicar/rm-rf exigen "sí" explícito siempre — ni
      taskScope ni autoApprove los silencian; la card lleva aviso ⚠.
- [x] **D3 OCR** (`core/desktop/OcrFallback.js` + `ocrQuery` + tool `ocr_query`):
      TSV de Tesseract → puntos de pantalla con la geometría de la captura,
      misma vigencia/TTL que el clic, sin shell. Vivo: 249 palabras de pantalla
      real ("saturday 14:30"). Cadena Wayland: screenshot → ocr_query →
      pointer_click → re-observar.
- [x] **T17-lite preferencias** (`core/desktop/UserPreferences.js`):
      recuerda host ganador por términos (count>=2) + explícitos que ganan,
      JSON atómico 0600 en `~/.config/kaoru/`, bonus +6 en el scoring ("como la
      otra vez"). El bridge registra resoluciones exitosas solo.
- [x] **T28 stats** (`OpenClawBridge.desktopSummary()` + handler IPC
      `agent-desktop-stats` pendiente de UI): tasa por tool desktop + top fallos.
- [x] **E2 claims desktop**: `_detectUnverifiedDesktopClaims` + nota del sistema + campo `unverifiedDesktop` (probado: humo detectado, evidencia pasa).

### Fase B — Multilingüe por inferencia (sin ramas por idioma)

Principio implementado: el idioma vive solo en el texto del usuario y la
respuesta final; tools, protocolo y decisiones usan interlingua canónica en
inglés. Cero `if idioma == X` en el código.

- [x] B1. Embeddings multilingües (`paraphrase-multilingual-MiniLM-L12-v2` vía
      `EmbedModel.js`, reindex + calibración; ver Ronda profunda).
- [x] B2. 42 frases desktop ES+EN indexadas (`init_vectors.js` + `data/core.db`
      220→262; verificado con `--test`: ES medium, EN high).
- [x] B3. Parser bilingüe (`TARGET/APPLICATION/WINDOW/NAME`,
      `test_structured_parser_bilingual.js`).
- [x] B4. `LanguageProfile` (`core/grounding/LanguageProfile.js`): detección por
      turno (scripts Unicode genéricos + stopwords mínimos de detección),
      override de preferencias, `localeFor` (locale/voz/ASR/TLDs en una tabla).
- [x] B5. Fusión intent→task por embeddings (`fuseTaskIntent` en
      `core/core/context.js`): "open amazon" es tarea web sin regex inglés.
- [x] B6. Protocolo canónico neutral en `GroqSerializer` (nota
      `TOOL PROTOCOL (canonical)` + ejemplos EN; ES conservados como aliases) y
      línea de idioma de respuesta por turno (llega a `AgentLoop` vía
      `opts.responseLanguage`, sobrevive al truncado).
- [x] B7. Voz y locale que mutan con el usuario: `chat-detect-language` (IPC),
      voz TTS por texto, ASR `models/vosk-<lang>/` con fallback español,
      `BrowserBridge.setDefaultLocale` por run.
- [x] B8. Guard `needsVerification` (schema + parser + bridge fuerzan managed) y
      `localeHints` en el scoring del resolver (su tienda, su país).
- [x] B9. Clarificación curiosa: el resolver devuelve candidatos en el error y
      la regla 12 del loop ordena preguntar UNA cosa concreta en su idioma.
- [x] B10. Navegador personal por CDP (`core/planner/PersonalBrowser.js`):
      detecta cuál USA el usuario (corriendo gana a default), propone vincularlo
      y lo lanza con depuración sobre SU perfil. Jamás mata procesos ni toca
      perfiles fuera de raíces esperadas. Tools `personal_browser_detect/link/status/close` + modo
      `personal` en `browser` (mismas acciones verificables, ahora con sus sesiones).
- [x] B11. Anti-bloqueos honestos: `_detectChallenge` tras navegar/actuar +
      `wait_for_clearance` (el humano pasa el CAPTCHA una vez, Kaoru retoma).
      Kaoru nunca resuelve CAPTCHAs sola.
- [x] B12. Ojos para canales: `findLatestChannelVideo` (pestaña /videos en orden
      de subida, selectores de canal real `ytd-rich-item-renderer`, probado en
      vivo con nissaxter) + `play_media` con `CANAL` + skill `media-channel`.
- [x] B13. Apps localizadas: `Name[es]` como primario según locale + aliases
      ("calculadora" encuentra Calculator); fallback Bing RSS verificado en vivo
      (`amazon → amazon.com.mx` en 2.9s cuando Google/DDG bloquean).

### Fase C — Skills de tarea

- [ ] C1. `desktop-task`: observar → actuar → verificar (universal).
- [x] C2. `skills/office-writer/SKILL.md`: lanzar → esperar → bloques → guardar.
- [x] C3. `skills/shop-lookup/SKILL.md`: buscar → `get_text` → evidencia.
- [x] C4. Política "verificar ⇒ managed" + recetas en `AGENT_LOOP_SYSTEM`.

### Fase D — Autonomía con seguridad

- [x] D1. Aprobación por tarea (`task:<tipo>:<destino>`, `TASK_SCOPED_TOOLS`,
      `opts.taskScope` en `AgentLoop`; `test_task_approvals.js`: 0 cards vs 2) + propuesta automática una vez por run (`opts.onTaskApprovalNeeded`,
      derivada de tool+params sin idioma) + card única en IPC
      (`agent-approval-needed` con `taskScope`, compatible hacia atrás;
      `test_multilingual_inference.js`).
- [x] D2. Parcial: receta shop-lookup + honestidad ante CAPTCHA en prompt y
      skill; falta `handoff` estructurado con retomar.
- [ ] D3. Plan B sin AT-SPI (Wayland) y sin `.desktop`.
- [ ] D4. Generación de documentos a archivo (ODT/MD) + verificación en disco.

### Fase E — Presencia kawaii

- [ ] E1. Progreso narrado + gestos en tareas desktop.
- [ ] E2. Claims honestos en desktop.
- [ ] E3. Pregunta curiosa única ante ambigüedad.
- [x] E4. Tests e2e con mocks (`test_desktop_task_e2e.js`: ES/EN/Linux/Windows).

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

Lo anterior lleva a Kaoru al 100% de _tareas_. Esto la lleva al nivel de
_software top-tier_: fiable, rápida, segura y adorable incluso cuando todo sale mal.

### 7.1 Orquestación y planificación (cerebro ejecutivo)

- [ ] **T1. Planificador multi-paso con replanificación.** Hoy `AgentLoop` (máx
      25–40 iteraciones) improvisa paso a paso. Un plan explícito
      (`plan.steps[]` con dependencias, criterios de éxito y plan B por paso) + replan ante fallo verificado evita martillar el mismo error y permite
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

_Documento vivo: A1/A4 hechos con tests verdes (`test_website_resolver.js`,
`test_task_detector_desktop.js`). Siguiente valor máximo: patrón web genérico
(§2) + skill `shop-lookup` (C3) para cerrar el ejemplo del manga de punta a punta._ 💫
