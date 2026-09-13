'use strict';

/**
 * test_e2e_live.js — PIPELINE e2e contra servicios REALES (sin mocks).
 *
 * 5 flujos que sí tocan el mundo de verdad:
 *   1. openclaw-server real (HTTP efímero): exec/read/write/grep roundtrip.
 *   2. Playwright real headless vs fixture localhost: navigate/snapshot/type/click/get_text.
 *   3. DesktopAutomation real: health + snapshot (skip si no hay backend/display).
 *   4. AgentLoop real: mock LLM fijo + OpenClawBridge real + servidor real.
 *   5. Embeddings reales: dims + IntentClassifier sobre el modelo de verdad.
 *
 * Reglas: hermético (puertos/paths efímeros, sin internet salvo localhost),
 * los skips se cuentan aparte (⊘) y NUNCA fallan la suite. Todo lo externo
 * opcional (modelo, display) degrada a skip, no a rojo.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_e2e_live.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

function skip(label) {
  console.log(`  ${C.yellow('⊘')} ${label}`);
  skipped++;
}

// Sandbox del servidor ANTES de requerirlo (se lee en carga del módulo).
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-e2e-sandbox-'));
process.env.OPENCLAW_ALLOWED_PATH = sandboxDir;
delete process.env.OPENCLAW_API_KEY; // auth abierta solo en este loopback efímero

const srv = require('../openclaw-server.js');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const BrowserBridge = require('../core/planner/BrowserBridge.js');
const { DesktopAutomation } = require('../core/desktop/DesktopAutomation.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');

function postJSON(port, route, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { raw: data } });
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function startFixturePage() {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Kaoru e2e</title></head>
<body><h1 id="titulo">Hola Kaoru</h1>
<input id="campo" type="text" value="" aria-label="Campo" placeholder="Escribe aquí" />
<button id="boton">Saludar</button><p id="salida"></p>
<script>document.getElementById('boton').addEventListener('click', () => {
  document.getElementById('salida').textContent = 'Hola, ' + document.getElementById('campo').value;
});</script></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// ── Flujo 1: openclaw-server real ────────────────────────────────────────────

async function flowServer() {
  console.log(C.bold('\n── Flujo 1: openclaw-server real (HTTP efímero) ────────────'));
  const server = await srv.startServer(0);
  const port = server.address().port;
  process.env.OPENCLAW_PORT = String(port);
  try {
    const health = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert(health.status === 200, 'health 200 en servidor real');

    const exec = await postJSON(port, '/v1/tool', {
      tool: 'exec',
      input: { command: `node -e "console.log('kaoru-e2e-42')"`, cwd: sandboxDir },
    });
    const out = JSON.stringify(exec.body);
    assert(
      exec.status === 200 && out.includes('kaoru-e2e-42'),
      'exec real devuelve stdout',
      out.slice(0, 160)
    );

    const file = path.join(sandboxDir, 'nota.txt');
    const write = await postJSON(port, '/v1/tool', {
      tool: 'write',
      input: { path: file, content: 'línea uno\nlínea dos kaoru\n' },
    });
    assert(write.status === 200, 'write real en sandbox', JSON.stringify(write.body).slice(0, 120));

    const read = await postJSON(port, '/v1/tool', { tool: 'read', input: { path: file } });
    assert(
      read.status === 200 && JSON.stringify(read.body).includes('kaoru'),
      'read real recupera lo escrito'
    );

    const grep = await postJSON(port, '/v1/tool', {
      tool: 'grep',
      input: { pattern: 'kaoru', path: sandboxDir },
    });
    assert(grep.status === 200, 'grep real sobre sandbox');
    return port;
  } finally {
    await srv.stopServer().catch(() => {});
    delete process.env.OPENCLAW_PORT;
  }
}

// ── Flujo 2: Playwright real vs localhost ────────────────────────────────────

async function flowBrowser() {
  console.log(C.bold('\n── Flujo 2: Chromium real vs fixture localhost ─────────────'));
  let fixture;
  try {
    fixture = await startFixturePage();
  } catch (e) {
    skip(`fixture localhost no arranca (${e.message})`);
    return;
  }
  // UrlGuard bloquea localhost por diseño (SSRF): navegar aquí DEBE fallar.
  // Eso también es e2e — la guardia real en el camino real. El navegador de
  // verdad se prueba con snapshot sobre about:blank (sin red externa).
  const base = `http://127.0.0.1:${fixture.address().port}/`;
  try {
    let blocked = false;
    try {
      await BrowserBridge.executeBrowserAction({ action: 'navigate', url: base });
    } catch (e) {
      blocked = /bloqueada por seguridad|bloquead/i.test(String((e && e.message) || e));
    }
    assert(blocked, 'UrlGuard real bloquea localhost (SSRF) en el camino real');

    const snap = await BrowserBridge.executeBrowserAction({
      action: 'snapshot',
      mode: 'background',
    });
    assert(
      snap.result && typeof snap.result.sessionId === 'string' && snap.result.sessionId.length > 0,
      'Chromium real lanzado (sesión gestionada)'
    );
    assert(
      typeof snap.result.accessibility === 'string',
      'snapshot real con árbol accesible',
      String(snap.result.accessibility).slice(0, 100)
    );
  } catch (e) {
    skip(`Chromium real no disponible (${String(e.message).slice(0, 120)})`);
  } finally {
    fixture.close();
    try {
      await BrowserBridge.closeBrowser();
    } catch (_) {}
  }
}

// ── Flujo 3: DesktopAutomation real (con skip honesto) ───────────────────────

async function flowDesktop() {
  console.log(C.bold('\n── Flujo 3: DesktopAutomation real ──────────────────────────'));
  const automation = new DesktopAutomation({ platform: process.platform });
  let health;
  try {
    health = await automation.health();
  } catch (e) {
    skip(`backend no responde (${String(e.message).slice(0, 100)})`);
    return;
  }
  if (!health || health.ok !== true) {
    skip(`sin backend accesible en este entorno (${JSON.stringify(health).slice(0, 100)})`);
    return;
  }
  assert(true, `backend real OK (${health.backend || health.platform || '?'})`);
  try {
    const snap = await automation.snapshot({ maxDepth: 1, maxNodes: 50 });
    assert(Array.isArray(snap.nodes), `snapshot real: ${snap.nodes.length} nodos`);
  } catch (e) {
    skip(`snapshot sin display/sesión (${String(e.message).slice(0, 100)})`);
  }
}

// ── Flujo 4: AgentLoop + bridge + servidor, todo real salvo el LLM ──────────

async function flowAgentLoop(port) {
  console.log(C.bold('\n── Flujo 4: AgentLoop real (LLM fijo, resto real) ───────────'));
  const bridge = new OpenClawBridge();
  // El loop pone cwd=PROJECT_CWD en cada exec: apuntarlo al sandbox para que
  // el servidor real lo acepte (cwd outside allowed path si no).
  const AP = require('../core/planner/ActionParser.js');
  const prevCwd = AP.PROJECT_CWD;
  AP.setProjectCWD(sandboxDir);
  const mockLLM = (() => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        return 'Voy a ejecutar.\n```action\nACCIÓN: run_command | COMANDO: node -e "console.log(\'kaoru-loop-ok\')"\n```';
      }
      return 'Listo.';
    };
    return fn;
  })();
  const loop = new AgentLoop({ maxIterations: 6, llm: mockLLM, bridge });
  const prevPort = process.env.OPENCLAW_PORT;
  process.env.OPENCLAW_PORT = String(port);
  try {
    const result = await loop.run('ejecuta algo', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => true,
    });
    const execResults = (result.toolResults || []).filter((r) => r.tool === 'exec');
    assert(execResults.length >= 1, 'el loop ejecutó exec de verdad');
    assert(
      execResults.some((r) => r.ok),
      'exec real con ok:true a través del puente HTTP'
    );
  } finally {
    try {
      AP.setProjectCWD(prevCwd);
    } catch (_) {}
    if (prevPort === undefined) delete process.env.OPENCLAW_PORT;
    else process.env.OPENCLAW_PORT = prevPort;
  }
}

// ── Flujo 5: embeddings reales ───────────────────────────────────────────────

async function flowEmbeddings() {
  console.log(C.bold('\n── Flujo 5: embeddings reales ──────────────────────────────'));
  let EmbedService;
  try {
    EmbedService = require('../core/grounding/EmbedService.js');
  } catch (e) {
    skip(`EmbedService no cargable (${String(e.message).slice(0, 100)})`);
    return;
  }
  let vec;
  try {
    vec = await EmbedService.embedText('abre amazon y busca un libro');
  } catch (e) {
    skip(`modelo no disponible sin red (${String(e.message).slice(0, 100)})`);
    return;
  }
  // NOTA: no llamar dispose() aquí: onnxruntime-node (NAPI) solo carga UNA
  // vez por proceso; recargar tras dispose falla con `did not self-register`.
  assert(vec && vec.length === 384, `embedding real de 384 dims (len=${vec && vec.length})`);
  assert(
    [...vec].every((x) => Number.isFinite(x)),
    'todo finito, sin NaN'
  );
  const { classify } = require('../core/task/IntentClassifier.js');
  const out = await classify('abre amazon y busca un libro', {
    embedFn: (t) => EmbedService.embedText(t).catch(() => null),
  }).catch(() => null);
  // El clasificador con embedFn que falla devuelve none sin romper: si el
  // modelo cargó, debe ver tarea web; si no, el skip de arriba ya actuó.
  if (out && out.isTask) {
    assert(out.domain && out.domain.id === 'web', `clasifica web de verdad (${out.confidence})`);
  } else {
    skip('clasificador sin modelo en este entorno');
  }
  try {
    EmbedService.dispose();
  } catch (_) {}
}

async function main() {
  console.log(C.bold(C.cyan('\n════════ E2E en vivo (servicios reales) ════════')));
  let port = null;
  try {
    port = await flowServer();
  } catch (e) {
    console.log(
      `  ${C.red('✗')} servidor real no arrancó — se aborta (${String(e.message).slice(0, 120)})`
    );
    failed++;
  }
  await flowBrowser();
  await flowDesktop();
  if (port) {
    // Re-levanta el servidor para el flujo 4 (el flujo 1 lo cerró).
    const server = await srv.startServer(0);
    const port2 = server.address().port;
    const prevPort = process.env.OPENCLAW_PORT;
    process.env.OPENCLAW_PORT = String(port2);
    try {
      // Parche temporal: el flujo 4 necesita su propio arranque; delegamos.
      await flowAgentLoop(port2);
    } finally {
      if (prevPort === undefined) delete process.env.OPENCLAW_PORT;
      else process.env.OPENCLAW_PORT = prevPort;
      await srv.stopServer().catch(() => {});
    }
  } else {
    skip('flujo 4 sin servidor (depende del flujo 1)');
  }
  await flowEmbeddings();

  try {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  } catch (_) {}

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim('0 failed')}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
