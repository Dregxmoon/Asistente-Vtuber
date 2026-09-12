'use strict';

// Navegador personal (CDP) + último video de canal + anti-bloqueos honestos.
// Todo con dobles: jamás toca el navegador real del usuario en tests.

const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const BrowserBridge = require('../core/planner/BrowserBridge.js');
const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');
const { isHighImpact } = require('../core/planner/ActionParser.js');

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
      execute: async (tool, params) => {
        if (tool === 'process_list') {
          return [
            { pid: 10, name: 'code' },
            { pid: 20, name: 'chromium' },
          ];
        }
        return { tool, params };
      },
      detectDefaultBrowserId: async () => 'chromium.desktop',
      launchBrowserDebug: async (params) => ({
        kind: 'personal_browser',
        browser: params.browser,
        port: params.port,
        status: 'spawned',
      }),
    },
    personalConnector: async () => ({ connected: true }),
    channelFinder: async (channel) =>
      `https://www.youtube.com/watch?v=abc123_DEF_${channel.length}`,
    channelPlayer: async (url, label) => ({
      kind: 'media',
      service: 'youtube',
      query: label,
      url,
      browser: 'kaoru-managed-chromium',
      playing: true,
      verified: true,
    }),
    mediaPlayer: async (query) => ({
      kind: 'media',
      service: 'youtube',
      query,
      url: 'https://www.youtube.com/watch?v=abc123_DEF&autoplay=1',
      browser: 'kaoru-managed-chromium',
      playing: true,
      verified: true,
    }),
    ...overrides,
  });
}

async function testDetect() {
  console.log('\n── personal_browser_detect ──');
  const bridge = makeBridge();
  const result = await bridge.execute('personal_browser_detect', {});
  assert(result.ok, 'detección exitosa');
  assert(
    result.result.proposal && result.result.proposal.browser === 'chromium',
    'propone chromium (corre ahora)',
    JSON.stringify(result.result.proposal)
  );
  assert(/vinc/i.test(result.result.note), 'nota accionable');
}

async function testLink() {
  console.log('\n── personal_browser_link (con consentimiento previo en test) ──');
  const bridge = makeBridge();
  // Sin perfil real en tmp de test → el resolve falla honesto. Inyectamos
  // perfil válido usando el home real es peligroso; se prueba el rechazo:
  const rejected = await bridge.execute('personal_browser_link', { browser: 'firefox' });
  assert(
    !rejected.ok && /perfil|soportado/i.test(rejected.error),
    'firefox se rechaza con mensaje honesto',
    rejected.error
  );
  assert(isHighImpact('personal_browser_link', {}), 'vincular exige aprobación');
  assert(isHighImpact('personal_browser_detect', {}), 'detectar exige aprobación (privacidad)');
}

async function testStatusClose() {
  console.log('\n── status / close (sin navegador) ──');
  const bridge = makeBridge();
  const status = await bridge.execute('personal_browser_status', {});
  assert(status.ok && status.result.connected === false, 'desconectado por defecto');
  const closed = await bridge.execute('personal_browser_close', {});
  assert(
    closed.ok && closed.result.disconnected === true && /sigue abierto/.test(closed.result.note),
    'cerrar = desconectar, el navegador del usuario sigue abierto'
  );
}

async function testChannel() {
  console.log('\n── play_media con CANAL (lo más reciente) ──');
  const bridge = makeBridge();
  const result = await bridge.execute('play_media', { query: '', channel: 'nissaxter' });
  assert(result.ok && result.result.verified === true, 'reproduce el último video verificado');
  assert(
    result.result.query === 'nissaxter' && /autoplay=1/.test(result.result.url),
    'etiqueta el canal y pide autoplay',
    result.result.url
  );
  const sinNada = await bridge.execute('play_media', { query: '', channel: '' });
  assert(!sinNada.ok, 'sin query ni canal se rechaza');
}

async function testParser() {
  console.log('\n── Parser: CANAL + personal_* ──');
  const parser = new StructuredActionParser(process.cwd());
  const media = parser.parse(
    '```action\nACCIÓN: play_media | CANAL: nissaxter | CONTROL: managed\n```',
    'ponme lo más reciente de nissaxter'
  );
  assert(media.length === 1 && media[0].params.channel === 'nissaxter', 'CANAL español → channel');
  const mediaEn = parser.parse(
    '```action\nACTION: play_media | CHANNEL: nissaxter\n```',
    'play latest'
  );
  assert(
    mediaEn.length === 1 && mediaEn[0].params.channel === 'nissaxter',
    'CHANNEL inglés → channel'
  );
  const link = parser.parse(
    '```action\nACCIÓN: personal_browser_link | NAVEGADOR: chromium\n```',
    'vincula'
  );
  assert(
    link.length === 1 &&
      link[0].tool === 'personal_browser_link' &&
      link[0].params.browser === 'chromium',
    'vinculación parsea navegador'
  );
  const detect = parser.parse('```action\nACTION: personal_browser_detect\n```', 'detect');
  assert(detect.length === 1 && detect[0].tool === 'personal_browser_detect', 'detección parsea');
}

async function testChallenge() {
  console.log('\n── Anti-bloqueos: detectar, nunca resolver sola ──');
  const detect = BrowserBridge._detectChallengeForTests;
  assert(typeof detect === 'function', 'detector expuesto para tests');
  const captchaPage = {
    locator: () => ({ count: async () => 1 }),
    evaluate: async () => '',
  };
  const found = await detect(captchaPage);
  assert(found.challenge === true, 'iframe recaptcha → desafío');
  const humanPage = {
    locator: () => ({ count: async () => 0 }),
    evaluate: async () => 'Bienvenido a la tienda, elige tu producto favorito',
  };
  const clean = await detect(humanPage);
  assert(clean.challenge === false, 'página normal → sin desafío');
  const textCaptcha = {
    locator: () => ({ count: async () => 0 }),
    evaluate: async () => 'Please verify you are human to continue',
  };
  const byText = await detect(textCaptcha);
  assert(byText.challenge === true, 'texto de verificación → desafío');
  const broken = await detect(null);
  assert(broken.challenge === false, 'página rota → no bloquea (defensivo)');
}

(async () => {
  console.log('\x1b[1m\n════ Personal browser + canal + desafíos ════\x1b[0m');
  await testDetect();
  await testLink();
  await testStatusClose();
  await testChannel();
  await testParser();
  await testChallenge();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
