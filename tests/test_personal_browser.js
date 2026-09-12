'use strict';

// PersonalBrowser: detectar cuál usa el usuario, proponer vincularlo y validar
// el vínculo CDP sin matar nada ni tocar perfiles. Todo con dobles inyectados.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  KNOWN_BROWSERS,
  detectDefaultBrowser,
  detectRunningBrowser,
  proposePersonalBrowser,
  resolveProfileDir,
  validatePersonalLink,
  cdpEndpoint,
} = require('../core/planner/PersonalBrowser.js');

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

async function rejects(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'no rechazó');
  } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), label);
  }
}

async function main() {
  console.log('\x1b[1m\n════ PersonalBrowser — detectar, proponer, vincular ════\x1b[0m');

  console.log('\n── Default del sistema ──');
  const chromium = await detectDefaultBrowser({
    platform: 'linux',
    runText: async () => 'chromium.desktop\n',
  });
  assert(chromium && chromium.browser === 'chromium', 'xdg-settings chromium.desktop → chromium');
  const firefox = await detectDefaultBrowser({
    platform: 'linux',
    runText: async () => 'firefox.desktop\n',
  });
  assert(firefox === null, 'firefox no es adjuntable por CDP → null (Ruta 1)');
  const unknown = await detectDefaultBrowser({
    platform: 'linux',
    runText: async () => 'navegador-raro.desktop\n',
  });
  assert(unknown === null, 'desktop id desconocido → null, no inventa');
  const failing = await detectDefaultBrowser({
    platform: 'linux',
    runText: async () => {
      throw new Error('sin xdg-settings');
    },
  });
  assert(failing === null, 'sin comando del SO → null en vez de crash');

  console.log('\n── En ejecución (lo que USA ahora) ──');
  const running = detectRunningBrowser({
    processes: [
      { pid: 100, name: 'code' },
      { pid: 200, name: 'chromium' },
    ],
  });
  assert(
    running && running.browser === 'chromium' && running.pid === 200,
    'encuentra chromium corriendo'
  );
  assert(
    detectRunningBrowser({ processes: [{ pid: 1, name: 'code' }] }) === null,
    'sin navegador corriendo → null'
  );
  // 'chrome' no caza 'chromium' ni al revés (coincidencia exacta).
  const chromeOnly = detectRunningBrowser({ processes: [{ pid: 5, name: 'chrome' }] });
  assert(chromeOnly && chromeOnly.browser === 'chrome', 'chrome exacto → chrome');

  console.log('\n── Propuesta: corriendo gana a default ──');
  const proposal = proposePersonalBrowser(
    { browser: 'brave', pid: 9, source: 'running' },
    { browser: 'chromium', source: 'default' }
  );
  assert(proposal && proposal.browser === 'brave', 'lo que corre ahora gana');
  const fallback = proposePersonalBrowser(null, { browser: 'edge', source: 'default' });
  assert(fallback && fallback.browser === 'edge', 'sin nada corriendo usa el default');
  assert(proposePersonalBrowser(null, null) === null, 'sin datos no propone');
  assert(
    proposePersonalBrowser({ browser: 'firefox', pid: 1, source: 'running' }, null) === null,
    'firefox no proponible para CDP'
  );

  console.log('\n── Perfil real ──');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-profile-'));
  fs.mkdirSync(path.join(home, '.config', 'chromium'), { recursive: true });
  const resolved = resolveProfileDir('chromium', { platform: 'linux', homeDir: home });
  assert(
    resolved.exists && resolved.path.endsWith('.config/chromium'),
    'resuelve y confirma el perfil'
  );
  await rejects(
    () =>
      Promise.resolve().then(() =>
        resolveProfileDir('firefox', { platform: 'linux', homeDir: home })
      ),
    /no soportado/,
    'firefox rechaza resolución de perfil'
  );

  console.log('\n── Validación del vínculo (sin matar nada) ──');
  const ok = await validatePersonalLink({
    browser: 'chromium',
    profileDir: path.join(home, '.config', 'chromium'),
    port: 19222,
    platform: 'linux',
    homeDir: home,
    portFree: async () => true,
  });
  assert(ok.port === 19222 && ok.profileDir.endsWith('.config/chromium'), 'vínculo válido pasa');
  await rejects(
    () =>
      validatePersonalLink({
        browser: 'navegador-maligno',
        profileDir: path.join(home, '.config', 'chromium'),
        port: 19222,
        platform: 'linux',
        homeDir: home,
        portFree: async () => true,
      }),
    /no soportado/,
    'binario fuera de allowlist → rechazado'
  );
  await rejects(
    () =>
      validatePersonalLink({
        browser: 'chromium',
        profileDir: '/tmp/perfil-falso',
        port: 19222,
        platform: 'linux',
        homeDir: home,
        portFree: async () => true,
      }),
    /ubicación esperada/,
    'perfil fuera de raíces esperadas → rechazado'
  );
  await rejects(
    () =>
      validatePersonalLink({
        browser: 'chromium',
        profileDir: path.join(home, '.config', 'chromium'),
        port: 19222,
        platform: 'linux',
        homeDir: home,
        portFree: async () => false,
      }),
    /ocupado/,
    'puerto ocupado → se pide acción humana, nunca se fuerza'
  );
  await rejects(
    () =>
      validatePersonalLink({
        browser: 'chromium',
        profileDir: path.join(home, '.config', 'chromium'),
        port: 80,
        platform: 'linux',
        homeDir: home,
        portFree: async () => true,
      }),
    /inválido/,
    'puerto privilegiado → rechazado'
  );

  assert(cdpEndpoint(19222) === 'http://127.0.0.1:19222', 'endpoint CDP local');
  assert(Object.keys(KNOWN_BROWSERS).length >= 3, 'catálogo multi-navegador, no un if');

  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
