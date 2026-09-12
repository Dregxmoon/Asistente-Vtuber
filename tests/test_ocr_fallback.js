'use strict';

// OcrFallback: ojos de respaldo sin accesibilidad (Wayland/canvas/juegos).
// TSV parseado con dobles; el binario real solo se toca en el caso vivo.

const { EventEmitter } = require('events');
const { readWords, locateQuery } = require('../core/desktop/OcrFallback.js');
const { DesktopAutomation } = require('../core/desktop/DesktopAutomation.js');

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

const TSV =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
  '1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t\n' +
  '5\t1\t1\t1\t1\t1\t100\t200\t90\t30\t96\tBuscar\n' +
  '5\t1\t1\t1\t1\t2\t200\t200\t120\t30\t12\tBorowso\n' +
  '5\t1\t1\t1\t1\t3\t330\t200\t80\t30\t-1\t\n';

function fakeSpawnFactory({ stdout = TSV, code = 0, stderr = '' } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = { write: () => {}, end: () => queueMicrotask(() => child.emit('close', code)) };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    });
    fakeSpawnFactory.last = { command, args, options };
    return child;
  };
}

const GEOMETRY = {
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  imageSize: { width: 800, height: 600 },
};

async function main() {
  console.log('\x1b[1m\n════ OcrFallback — ojos sin accesibilidad ════\x1b[0m');

  console.log('\n── TSV → palabras con confianza ──');
  const words = await readWords(Buffer.from('fake'), 'eng', fakeSpawnFactory({}));
  assert(words.length === 2, 'solo palabras con texto y conf válida', JSON.stringify(words));
  assert(words[0].text === 'Buscar' && words[0].confidence === 96, 'conserva texto y confianza');
  assert(
    fakeSpawnFactory.last.command === 'tesseract' && fakeSpawnFactory.last.options.shell === false,
    'tesseract sin shell, por stdin/stdout'
  );

  console.log('\n── Localización → puntos de pantalla ──');
  const matches = locateQuery(words, 'buscar', GEOMETRY);
  assert(matches.length === 1, 'encuentra "Buscar" insensible a mayúsculas');
  assert(
    matches[0].screenPoint.x === 145 && matches[0].screenPoint.y === 215,
    'centro de caja mapeado a pantalla',
    JSON.stringify(matches[0])
  );
  assert(
    locateQuery(words, 'inexistente', GEOMETRY).length === 0,
    'sin match → lista vacía honesta'
  );

  console.log('\n── Errores honestos ──');
  try {
    await readWords(Buffer.alloc(0), 'eng', fakeSpawnFactory({}));
    assert(false, 'imagen vacía se rechaza');
  } catch (e) {
    assert(/inválida/.test(e.message), 'imagen vacía se rechaza');
  }
  try {
    await readWords(
      Buffer.from('x'),
      'eng',
      fakeSpawnFactory({ code: 1, stderr: 'Error opening data file ./spa.traineddata' })
    );
    assert(false, 'fallo tesseract se rechaza');
  } catch (e) {
    assert(/código 1/.test(e.message) && /spa/.test(e.message), 'idioma ausente se explica');
  }
  try {
    locateQuery(words, '', GEOMETRY);
    assert(false, 'query vacía se rechaza');
  } catch (e) {
    assert(/localizar/.test(e.message), 'query vacía se rechaza');
  }

  console.log('\n── Integración DesktopAutomation ──');
  let now = 1000;
  const automation = new DesktopAutomation({
    platform: 'linux',
    adapter: {
      health: async () => ({ ok: true }),
      snapshot: async () => ({ ok: true, nodes: [] }),
      execute: async () => ({ ok: true }),
    },
    now: () => now,
    captureSources: async () => [
      {
        id: 'screen:0',
        name: 'Pantalla',
        thumbnail: {
          isEmpty: () => false,
          toJPEG: () => Buffer.from('fakejpeg'),
          getSize: () => ({ width: 800, height: 600 }),
        },
      },
    ],
  });
  const shot = await automation.screenshot({});
  const ocr = await automation.ocrQuery({ captureId: 'mala', query: 'x' }).catch((e) => e);
  assert(ocr instanceof Error && /obsoleta/.test(ocr.message), 'captura ajena se rechaza');
  // TTL: avanza el reloj más allá de 30s.
  now += 31_000;
  const expired = await automation
    .ocrQuery({ captureId: shot.captureId, query: 'x' })
    .catch((e) => e);
  assert(expired instanceof Error && /expiró/.test(expired.message), 'captura expirada se rechaza');

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
