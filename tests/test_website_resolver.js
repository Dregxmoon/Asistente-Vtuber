'use strict';

// Fase A1 — resolver universal de destinos web: ya no existe un callejón sin
// salida cuando el destino no es una URL completa ni uno de los 8
// SITE_ALIASES fijos. Estos tests cubren los 3 caminos (URL directa, alias
// como atajo, fallback de búsqueda) sin depender de red real: webSearch y
// urlGuard se inyectan como mocks deterministas.

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

async function rejects(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'no rechazó');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), label, message);
  }
}

function makeBridge({ webSearch, urlGuard, desktopControl } = {}) {
  return new OpenClawBridge({
    webSearch,
    urlGuard,
    desktopControl: desktopControl || {
      execute: async (tool, params) =>
        tool === 'open_website'
          ? { kind: 'website', url: params.target, browser: params.browser || 'default' }
          : { tool, params },
    },
  });
}

async function testUrlDirecta() {
  console.log('\n── Camino 1: URL https completa ───────────────────────');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('no debería llamarse: ya era una URL válida');
    },
  });
  const result = await bridge.execute('open_website', { target: 'https://example.org/ruta' });
  assert(result.ok, 'una URL https completa se abre sin tocar el resolver de búsqueda');
  assert(result.result.resolvedBy === 'url', 'se marca resolvedBy=url');
}

async function testAliasComoAtajo() {
  console.log('\n── Camino 2: alias conocido (atajo, no lista blanca) ──');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('no debería llamarse: youtube es un alias conocido');
    },
  });
  const result = await bridge.execute('open_website', { target: 'youtube' });
  assert(result.ok && result.result.url === 'https://www.youtube.com/', 'alias resuelve directo');
  assert(result.result.resolvedBy === 'alias', 'se marca resolvedBy=alias');
}

async function testFallbackBusqueda() {
  console.log('\n── Camino 3: destino desconocido → fallback de búsqueda ─');
  let searchedQuery = null;
  const bridge = makeBridge({
    webSearch: async ({ query }) => {
      searchedQuery = query;
      return {
        result: [
          { title: 'Sitio bloqueado', url: 'https://blocked.example/' },
          { title: 'Amazon España', url: 'https://www.amazon.es/' },
          { title: 'Otra opción', url: 'https://otra.example/' },
        ],
      };
    },
    urlGuard: async (url) => ({ safe: !url.includes('blocked.example') }),
  });
  const result = await bridge.execute('open_website', { target: 'amazon' });
  assert(
    result.ok && result.result.url === 'https://www.amazon.es/',
    'destino no predefinido se resuelve por búsqueda + UrlGuard, saltando el primer resultado bloqueado',
    JSON.stringify(result)
  );
  assert(result.result.resolvedBy === 'search', 'se marca resolvedBy=search');
  assert(
    result.result.resolvedFromQuery === 'amazon',
    'se conserva la consulta usada como evidencia'
  );
  assert(searchedQuery === 'amazon', 'la búsqueda usa el texto tal como lo pidió el usuario');
}

async function testFallbackSinResultadosSeguros() {
  console.log('\n── Sin resultados seguros → error honesto, no crash ───');
  const bridge = makeBridge({
    webSearch: async () => ({
      result: [
        { title: 'x', url: 'https://blocked.example/' },
        { title: 'y', url: 'http://inseguro.example/' },
      ],
    }),
    urlGuard: async () => ({ safe: false }),
  });
  await rejects(
    () =>
      bridge.execute('open_website', { target: 'un sitio inexistente' }).then((r) => {
        if (!r.ok) throw new Error(r.error);
        return r;
      }),
    /No encontré un destino seguro/,
    'informa honestamente cuando ningún resultado pasa el candado de seguridad'
  );
}

async function testBusquedaFalla() {
  console.log('\n── La búsqueda misma falla → error claro ──────────────');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('captcha de Google');
    },
  });
  const result = await bridge.execute('open_website', { target: 'un sitio raro' });
  assert(!result.ok, 'no declara éxito si la búsqueda de respaldo falla');
  assert(/captcha de Google/.test(result.error), 'propaga el motivo real del fallo', result.error);
}

(async () => {
  console.log('\x1b[1m\n════ Resolver universal de open_website (Fase A1) ════\x1b[0m');
  await testUrlDirecta();
  await testAliasComoAtajo();
  await testFallbackBusqueda();
  await testFallbackSinResultadosSeguros();
  await testBusquedaFalla();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
