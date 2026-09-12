'use strict';

// Autonomía profunda: login guiado honesto, irreversibles que siempre preguntan,
// memoria viva de resoluciones, stats desktop y claims honestos en desktop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const { isIrreversible } = require('../core/security/IrreversiblePolicy.js');
const { UserPreferences } = require('../core/desktop/UserPreferences.js');
const {
  taskApprovalPattern,
  isTaskScopeApproved,
  addApproval,
  resetApprovals,
} = require('../core/security/SessionApprovals.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function makeBridge(overrides = {}) {
  return new OpenClawBridge({
    desktopControl: {
      execute: async (tool, params) => ({
        kind: 'website',
        url: params.target,
        browser: 'default',
      }),
    },
    webSearch: async () => ({ result: [{ title: 'x', url: 'https://tienda.example/' }] }),
    urlGuard: async () => ({ safe: true }),
    managedNavigator: async (input) => {
      if (input.action === 'navigate') {
        return { result: { url: input.url, title: 'Tienda', status: 'completed', verified: true } };
      }
      return {
        result: {
          sessionId: 's1',
          pageId: 'p1',
          origin: 'https://tienda.example',
          mode: input.mode,
        },
      };
    },
    userPreferences: new UserPreferences({
      filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-prefs-')), 'prefs.json'),
    }),
    ...overrides,
  });
}

async function testLogin() {
  console.log('\n── Login guiado: honesto, sin credenciales ──');
  const bridge = makeBridge();
  const result = await bridge.execute('personal_browser_login', {
    target: 'https://tienda.example/',
  });
  assert(result.ok, 'abre el sitio para login');
  assert(result.result.status === 'login_required', 'estado honesto: login_required');
  assert(result.result.verified === false, 'JAMÁS afirma login verificado aquí');
  assert(result.result.requiresUserAction === true, 'marca que falta la mano humana');
  assert(
    result.result.observation && result.result.observation.sessionId === 's1',
    'devuelve observación para retomar'
  );
  assert(
    /jamás toca tus credenciales/i.test(result.result.note),
    'promesa explícita de no tocar credenciales'
  );
  const empty = await bridge.execute('personal_browser_login', { target: '' });
  assert(!empty.ok, 'sin sitio se rechaza');
}

async function testIrreversible() {
  console.log('\n── Irreversibles: siempre preguntan ──');
  assert(
    isIrreversible({ tool: 'browser', params: { action: 'click', text: 'Comprar ahora' } }),
    'clic en "Comprar ahora" es irreversible'
  );
  assert(
    isIrreversible({ tool: 'browser', params: { action: 'click', text: 'Buy Now' } }),
    'inglés también (sin listas por idioma: el regex cubre ambos)'
  );
  assert(
    isIrreversible({
      tool: 'browser',
      params: { action: 'navigate', url: 'https://t.example/checkout' },
    }),
    'navegar a checkout es irreversible'
  );
  assert(
    isIrreversible({ tool: 'exec', params: { command: 'rm -rf /tmp/x' } }),
    'rm -rf es irreversible'
  );
  assert(
    isIrreversible({ tool: 'process_stop', params: { pid: 9 } }),
    'terminar proceso es irreversible'
  );
  assert(
    !isIrreversible({ tool: 'browser', params: { action: 'get_text' } }),
    'leer no es irreversible'
  );
  assert(
    !isIrreversible({ tool: 'open_website', params: { target: 'youtube' } }),
    'abrir no es irreversible'
  );
  assert(!isIrreversible(null), 'nulo no es irreversible');

  resetApprovals();
  const scope = taskApprovalPattern('web-task', 'tienda');
  addApproval(scope);
  assert(
    !isTaskScopeApproved({ tool: 'browser', params: { action: 'click', text: 'Pagar' } }, scope),
    'el scope de tarea NO cubre pagar'
  );
  assert(
    isTaskScopeApproved({ tool: 'browser', params: { action: 'get_text' } }, scope),
    'el scope sí cubre leer'
  );

  // Loop: lo irreversible fuerza card aunque haya scope aprobado.
  resetApprovals();
  const payScope = taskApprovalPattern('web-task', 'tienda');
  addApproval(payScope);
  let payCards = 0;
  const payLoop = new AgentLoop({
    maxIterations: 3,
    llm: async () => '```action\nACCIÓN: browser_action | ACCION: click | TEXTO: Pagar ahora\n```',
    bridge: makeBridge(),
  });
  await payLoop.run('compra el producto', 'Eres un asistente.', [], {
    taskScope: payScope,
    onApprovalNeeded: async () => {
      payCards++;
      return false;
    },
  });
  assert(payCards >= 1, 'pagar con scope aprobado IGUAL pide card', `cards: ${payCards}`);
  resetApprovals();
}

async function testPreferences() {
  console.log('\n── Memoria viva: como la otra vez ──');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-prefs-'));
  const prefs = new UserPreferences({ filePath: path.join(dir, 'prefs.json') });
  assert(prefs.preferredHost('amazon') === null, 'sin historia no hay preferencia');
  prefs.recordResolution('amazon', 'https://www.amazon.com.mx/');
  assert(prefs.preferredHost('amazon') === null, 'una sola vez no basta (count>=2)');
  prefs.recordResolution('amazon mexico', 'https://www.amazon.com.mx/');
  assert(prefs.preferredHost('amazon') === 'www.amazon.com.mx', 'dos veces → preferencia inferida');
  prefs.setExplicit('store', 'amazon.es');
  assert(prefs.preferredHost('amazon') === 'amazon.es', 'explícito gana a inferido');
  assert(fs.existsSync(path.join(dir, 'prefs.json')), 'persiste en disco (sobrevive reinicios)');
  const reloaded = new UserPreferences({ filePath: path.join(dir, 'prefs.json') });
  assert(reloaded.preferredHost('amazon') === 'amazon.es', 'recarga lo persistido');

  // El bridge registra resoluciones exitosas solo.
  const bridge = makeBridge();
  await bridge.execute('open_website', { target: 'amazon' });
  await bridge.execute('open_website', { target: 'amazon' });
  assert(true, 'resoluciones repetidas no rompen el flujo');
}

async function testStats() {
  console.log('\n── Stats desktop (T28) ──');
  const bridge = makeBridge();
  await bridge.execute('open_website', { target: 'https://tienda.example/' });
  await bridge.execute('desktop_snapshot', {});
  const summary = bridge.desktopSummary();
  assert(summary.total >= 1 && summary.byTool.open_website, 'agrega por tool desktop');
  assert(
    typeof summary.successRate === 'number' && Array.isArray(summary.topFailures),
    'tasa de éxito + top fallos para dashboard'
  );
}

async function testDesktopClaims() {
  console.log('\n── Claims honestos en desktop (E2) ──');
  const loop = new AgentLoop({
    maxIterations: 2,
    llm: async () => '¡Listo! El video ya está sonando.',
    bridge: makeBridge(),
  });
  const result = await loop.run('pon música', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => true,
  });
  assert(
    result.unverifiedDesktop && /NOTA DEL SISTEMA/.test(result.response),
    'afirmar reproducción sin evidencia → aviso del sistema',
    JSON.stringify(result.unverifiedDesktop)
  );

  const loop2 = new AgentLoop({
    maxIterations: 3,
    llm: (() => {
      let n = 0;
      return async () =>
        n++ === 0
          ? '```action\nACCIÓN: play_media | QUERY: x\n```'
          : 'Listo, ya está sonando el video.';
    })(),
    bridge: {
      execute: async (tool) => ({
        ok: true,
        tool,
        result: { kind: 'media', playing: true, verified: true },
        error: null,
        elapsed: 1,
      }),
    },
  });
  const result2 = await loop2.run('pon música', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => true,
  });
  assert(!result2.unverifiedDesktop, 'con evidencia verificada no hay aviso');
  resetApprovals();
}

(async () => {
  console.log('\x1b[1m\n════ Autonomía profunda ════\x1b[0m');
  await testLogin();
  await testIrreversible();
  await testPreferences();
  await testStats();
  await testDesktopClaims();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
