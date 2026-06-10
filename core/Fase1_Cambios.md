
# Fase 1 — Memoria Persistente

  

## 1. Instalar dependencia

  

```bash

npm  install  better-sqlite3

npm  install  electron-rebuild  --save-dev

npx  electron-rebuild  -f  -w  better-sqlite3

```

  

> `electron-rebuild` recompila better-sqlite3 contra el Node.js de Electron.

> En Windows puede tardar 2-3 minutos. Requiere Visual Studio Build Tools instalado.

> Si no tienes Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/

  

---

  

## 2. Archivos NUEVOS a copiar al repositorio

  

```

core/

├── MarchCore.js ← NUEVO

├── state-graph/

│ ├── StateGraph.js ← NUEVO

│ ├── StateUpdater.js ← NUEVO

│ └── SessionManager.js ← NUEVO

└── grounding/

└── GroundingEngine.js ← NUEVO (reemplaza la lógica de GroundingMinimo)

```

  

**GroundingMinimo.js se mantiene** — GroundingEngine lo usa como fallback si el grafo no está disponible.

  

---

  

## 3. Cambios en `main.js`

  

### A. Agregar al inicio (después de los requires existentes):

  

```js

const MarchCore =  require('./core/MarchCore.js');

```

  

### B. En `app.whenReady().then(...)`, ANTES de `createChatWindow()`:

  

```js

// Inicializar el núcleo de March (StateGraph + Grounding + Session)

MarchCore.init(app);

```

  

### C. En `createChatWindow()`, después de que se crea la ventana:

  

```js

// Iniciar sesión de memoria

MarchCore.startSession().catch(e  =>  console.error('[session] error:', e.message));

```

  

### D. En `chatWindow.on('closed', ...)`:

  

```js

chatWindow.on('closed', () => {

// Cerrar sesión y guardar memoria

MarchCore.closeSession().catch(e  =>  console.error('[session] close error:', e.message));

chatWindow = null;

if (mainWindow &&  !mainWindow.isDestroyed()) mainWindow.show();

if (tray) tray.setContextMenu(buildTrayMenu());

});

```

  

### E. Agregar handlers IPC nuevos (después de los existentes):

  

```js

// Registrar turnos de conversación en la memoria

ipcMain.on('memory-add-turn', (e, { role, content }) => {

MarchCore.addTurn(role, content);

});

  

// Stats de memoria para debug

ipcMain.handle('memory-stats', () =>  MarchCore.getStats());

```

  

---

  

## 4. Cambios en `src/chat.html`

  

### A. Reemplazar el require de GroundingMinimo por GroundingEngine:

  

**Buscar:**

```js

const Grounding =  require('../core/llm/GroundingMinimo.js');

```

  

**Reemplazar con:**

```js

const { GroundingEngine } =  require('../core/grounding/GroundingEngine.js');

const { getStateGraph } =  require('../core/state-graph/StateGraph.js');

  

// El StateGraph se inicializó en main.js — aquí lo obtenemos por path

// En Fase 1 el grounding se construye via IPC para no duplicar la DB

// Por simplicidad, usamos el buildContext que incluye fallback automático

const Grounding =  require('../core/grounding/GroundingEngine.js');

```

  

### B. En `processMessage()`, después de `pushToSession('user', trimmed)`:

  

```js

// Registrar en memoria persistente

ipcRenderer.send('memory-add-turn', { role: 'user', content: trimmed });

```

  

### C. En `processMessage()`, después de `pushToSession('assistant', response)`:

  

```js

// Registrar respuesta en memoria persistente

ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });

```

  

### D. El método `buildContext` en `processMessage()` no cambia —

`GroundingEngine` exporta `buildContext` con la misma firma que `GroundingMinimo`.

  

---

  

## 5. Verificar que funciona

  

Al abrir el chat, en la consola de Electron deberías ver:

  

```

[march-core] inicializado

[state-graph] inicializado: C:\Users\...\AppData\Roaming\...\march.db

[session] sesión 1 iniciada

```

  

Al cerrar el chat (con al menos 2 mensajes):

  

```

[session] cerrando sesión 1 (4 turnos)...

[state-updater] analizando sesión (4 mensajes)...

[state-updater] guardados: 2 nodos, episodio: sí

```

  

En la segunda apertura, el system prompt de March incluirá la sección

`# SESIONES ANTERIORES` con lo que el LLM decidió recordar.

  

---

  

## 6. Posibles problemas en Windows

  

### Error: `Cannot find module 'better-sqlite3'`

```bash

npx  electron-rebuild  -f  -w  better-sqlite3

```

  

### Error de compilación en electron-rebuild

Instala Visual Studio Build Tools (gratuito):

https://visualstudio.microsoft.com/visual-cpp-build-tools/

Seleccionar: "Desktop development with C++"

  

### La DB no se crea

Verificar que `app.getPath('userData')` devuelve una ruta válida.

La DB se crea en: `C:\Users\{usuario}\AppData\Roaming\{appId}\march.db`

  

---

  

## 7. Lo que tiene March al terminar Fase 1

  

- ✅ Memoria entre sesiones via SQLite

- ✅ March analiza qué vale la pena recordar (LLM)

- ✅ Decay automático: los recuerdos sin uso se archivan

- ✅ Proyectos, preferencias y usuarios persisten

- ✅ Episodios pasados aparecen en el contexto del LLM

- ✅ `GroundingMinimo.js` se mantiene como fallback

  

## 8. Lo que NO tiene todavía (Fase 2)

  

- OS Sensor (app activa, ventana)

- búsqueda semántica (sqlite-vec)

- Contradiction Resolver

- Prompt Serializer separado por modelo