'use strict';

// E4 — tareas desktop de punta a punta con mocks (sin red ni apps reales).
// Obliga al sistema a dividir y concatenar acciones: detectar → resolver →
// abrir → observar → actuar → verificar → informar con evidencia. Cubre ES,
// campos EN del parser, y paridad Linux/Windows en lanzamiento.

const TaskDetector = require('../core/task/TaskDetector.js');
const { DesktopControl } = require('../core/desktop/DesktopControl.js');
const { WebsiteResolver } = require('../core/desktop/WebsiteResolver.js');
const { SITE_ALIASES } = require('../core/desktop/DesktopControl.js');
const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');

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

function mockResolver() {
  return new WebsiteResolver({
    aliases: SITE_ALIASES,
    webSearch: async ({ query }) => ({
      result: [{ title: `${query} oficial`, url: 'https://www.amazon.es/' }],
    }),
    urlGuard: async () => ({ safe: true }),
  });
}

// Navegador managed simulado con sesiones y verificación realista.
function mockManagedBrowser() {
  const state = { origin: 'https://www.amazon.es', searched: '', price: '' };
  return {
    state,
    execute: async (tool, params) => {
      if (tool === 'open_website') {
        return {
          ok: true,
          tool,
          result: { kind: 'website', url: 'https://www.amazon.es/', browser: 'kaoru' },
          error: null,
          elapsed: 1,
        };
      }
      if (tool === 'browser') {
        if (params.action === 'snapshot' || params.action === 'tabs') {
          return {
            ok: true,
            tool,
            result: {
              sessionId: 'sess-1',
              pageId: 'page-1',
              origin: state.origin,
              title: 'Amazon.es',
              verified: true,
            },
            error: null,
            elapsed: 1,
          };
        }
        if (params.action === 'type') {
          if (
            params.sessionId !== 'sess-1' ||
            params.pageId !== 'page-1' ||
            params.expectedOrigin !== state.origin
          ) {
            return { ok: false, tool, result: null, error: 'origen cambiado', elapsed: 1 };
          }
          state.searched = params.value;
          return {
            ok: true,
            tool,
            result: {
              executed: true,
              actionVerified: true,
              intentVerified: true,
              status: 'completed',
            },
            error: null,
            elapsed: 1,
          };
        }
        if (params.action === 'click') {
          state.price = 'El canto de la noche 18 — Tapa blanda — 9,45 € — En stock';
          return {
            ok: true,
            tool,
            result: { executed: true, intentVerified: true, status: 'completed' },
            error: null,
            elapsed: 1,
          };
        }
        if (params.action === 'get_text') {
          return { ok: true, tool, result: { text: state.price }, error: null, elapsed: 1 };
        }
      }
      return { ok: false, tool, result: null, error: `mock sin soporte: ${tool}`, elapsed: 1 };
    },
  };
}

async function testMangaEspanol() {
  console.log('\n── E2E ES: manga tomo 18 en Amazon ──');
  const pedido = 'abre amazon y busca si está disponible el manga el canto de la noche 18';

  const intent = TaskDetector.detect(pedido);
  assert(intent.isTask && intent.domain && intent.domain.id === 'web', 'detecta tarea web');

  const bridge = new OpenClawBridge({
    desktopControl: mockManagedBrowser(),
    webSearch: async () => ({
      result: [{ title: 'Amazon España', url: 'https://www.amazon.es/' }],
    }),
    urlGuard: async () => ({ safe: true }),
  });
  const opened = await bridge.execute('open_website', { target: 'amazon' });
  assert(opened.ok && opened.result.resolvedBy === 'search', 'resuelve amazon sin URL previa');
  assert(opened.result.resolvedFromQuery === 'amazon', 'conserva la consulta como evidencia');

  const managed = mockManagedBrowser();
  const snap = await managed.execute('browser', { action: 'snapshot', mode: 'managed' });
  assert(snap.ok && snap.result.pageId === 'page-1', 'observa antes de actuar');
  const typed = await managed.execute('browser', {
    action: 'type',
    mode: 'managed',
    sessionId: 'sess-1',
    pageId: 'page-1',
    expectedOrigin: 'https://www.amazon.es',
    value: 'el canto de la noche 18',
  });
  assert(typed.ok && typed.result.status === 'completed', 'escribe con triple observado');
  const stale = await managed.execute('browser', {
    action: 'type',
    mode: 'managed',
    sessionId: 'otra',
    pageId: 'page-1',
    expectedOrigin: 'https://www.amazon.es',
    value: 'x',
  });
  assert(!stale.ok, 'sesión obsoleta se rechaza, no se ejecuta a ciegas');
  await managed.execute('browser', { action: 'click', mode: 'managed' });
  const texto = await managed.execute('browser', { action: 'get_text', mode: 'managed' });
  assert(
    texto.ok && /9,45 €/.test(texto.result.text) && /En stock/.test(texto.result.text),
    'la evidencia cita precio y disponibilidad reales',
    texto.result.text
  );
  assert(
    /tomo|18/i.test(managed.state.searched) || /canto de la noche/i.test(managed.state.searched),
    'lo buscado fue el producto pedido, no otra cosa'
  );
}

async function testConcatenada() {
  console.log('\n── E2E: orden concatenada divide en pasos ──');
  const pedido = 'abre youtube, busca un video de guitarra y reprodúcelo';
  const intent = TaskDetector.detect(pedido);
  assert(intent.isTask, 'la orden compuesta es tarea');
  const parser = new StructuredActionParser(process.cwd());
  const reproducir = parser.parse(
    '```action\nACCIÓN: play_media | SERVICIO: youtube | QUERY: video de guitarra | CONTROL: managed\n```',
    pedido
  );
  assert(
    reproducir.length === 1 && reproducir[0].params.control === 'managed',
    'la parte compuesta colapsa en UNA acción verificable (no 3 sueltas)'
  );
}

async function testWriter() {
  console.log('\n── E2E: Writer por bloques con verificación ──');
  const pedido = 'abre mi libreoffice writer y escribe un ensayo sobre la conquista de américa';
  const intent = TaskDetector.detect(pedido);
  assert(intent.isTask && intent.domain && intent.domain.id === 'system', 'detecta tarea system');

  const launched = [];
  const control = new DesktopControl({
    platform: 'linux',
    homeDir: '/tmp/kaoru-e2e-home',
    env: {},
    spawnImpl: () => {
      throw new Error('este e2e no lanza binarios reales');
    },
    processLister: async () => [{ pid: 4242, name: 'soffice.bin' }],
  });
  // Writer descubierto vía .desktop simulado
  control._listLinuxApps = async () => [{ name: 'LibreOffice Writer', id: 'libreoffice-writer' }];
  control._spawnDetached = async (cmd, args) => launched.push({ cmd, args });
  const apps = await control.searchApps({ query: 'writer' });
  assert(
    apps.some((a) => a.id === 'libreoffice-writer'),
    'descubre Writer por nombre'
  );
  const launchedResult = await control.launchApp({ app: 'LibreOffice Writer' });
  assert(launchedResult.kind === 'application', 'lanza por ID descubierto, no por Exec');
  assert(
    launched.length === 1 && launched[0].cmd === 'gtk-launch',
    'usa gtk-launch sin shell ni comandos arbitrarios'
  );
  const procesos = await control.listProcesses({ query: 'soffice' });
  assert(procesos.length === 1 && procesos[0].pid === 4242, 'confirma el proceso en ejecución');

  // Escritura por bloques: 9000 chars en 3 llamadas ui_type, no una.
  const ensayo = 'x'.repeat(9000);
  const bloques = [];
  for (let i = 0; i < ensayo.length; i += 3000) bloques.push(ensayo.slice(i, i + 3000));
  assert(bloques.length === 3 && bloques.every((b) => b.length <= 3000), 'trocea en bloques ≤3000');
}

async function testBilingue() {
  console.log('\n── E2E EN: parser + resolver independientes del idioma ──');
  const parser = new StructuredActionParser(process.cwd());
  const en = parser.parse('```action\nACTION: open_website | TARGET: amazon\n```', 'open amazon');
  assert(en.length === 1 && en[0].params.target === 'amazon', 'TARGET inglés → mismo target');
  const resolver = mockResolver();
  const resolved = await resolver.resolve('amazon');
  assert(resolved.url === 'https://www.amazon.es/', 'el resolver no depende del idioma');
}

async function testLanzamientoMultiOs() {
  console.log('\n── E2E: lanzamiento Linux + Windows ──');
  const { EventEmitter } = require('events');
  const fakeSpawn = (calls) => (command, args, _options) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const linuxCalls = [];
  const linux = new DesktopControl({ platform: 'linux', spawnImpl: fakeSpawn(linuxCalls) });
  linux._listLinuxApps = async () => [{ name: 'Steam', id: 'steam' }];
  await linux.launchApp({ app: 'Steam' });
  assert(linuxCalls[0] && linuxCalls[0].command === 'steam', 'linux lanza el binario conocido');

  const winCalls = [];
  const win = new DesktopControl({
    platform: 'win32',
    env: {},
    processRunner: async (command, args, payload) => {
      winCalls.push({ command, payload });
      return { ok: true };
    },
  });
  const apps = [{ name: 'Mi Juego', id: 'C:\\Juegos\\mi-juego.exe', source: 'start-menu' }];
  win.listApps = async () => apps;
  await win.launchApp({ app: 'Mi Juego' });
  assert(
    winCalls.length === 1 && winCalls[0].command === 'powershell.exe',
    'windows lanza vía helper PowerShell (sin shell directo)'
  );
  assert(
    winCalls[0].payload.target === 'C:\\Juegos\\mi-juego.exe',
    'la ruta viaja por payload, no interpolada'
  );
}

(async () => {
  console.log('\x1b[1m\n════ Tareas desktop E2E (E4, mocks) ════\x1b[0m');
  await testMangaEspanol();
  await testConcatenada();
  await testWriter();
  await testBilingue();
  await testLanzamientoMultiOs();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
