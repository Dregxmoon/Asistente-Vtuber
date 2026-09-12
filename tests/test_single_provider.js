'use strict';

/**
 * test_single_provider.js — UN solo proveedor activo, sin pila ni rotación.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_single_provider.js
 *
 * Verifica:
 *   1. configure({provider}) selecciona; legacy primary migra; fallback se ignora.
 *   2. Sin rotación: si el elegido falla, NO se llama a otro aunque tenga key.
 *   3. Reintentos con backoff dentro del mismo proveedor y éxito posterior.
 *   4. Rate-limit → error accionable (esperar o /model), sin saltar solo.
 *   5. Sin key / provider desconocido → errores accionables, no silencio.
 *   6. completeWithTools usa el mismo proveedor único.
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

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

const LLMProvider = require('../core/llm/LLMProvider.js');

function setProvider(id, key = 'FAKE-KEY') {
  LLMProvider.configure({ llm: { provider: id, providers: { [id]: { apiKey: key } } } });
}

function clearInjected() {
  for (const id of ['groq', 'gemini', 'openai']) {
    LLMProvider._debug_setCaller(id, null);
    LLMProvider._debug_setToolCaller(id, null);
  }
}

// ── Test 1: selección y migración ────────────────────────────────────────────

async function testSelection() {
  console.log(C.bold('\n── Test 1: selección + migración legacy ───────────────────'));

  setProvider('openai');
  assert(LLMProvider.getActiveProvider() === 'openai', 'configure({provider}) selecciona');

  LLMProvider.configure({ llm: { primary: 'gemini' } });
  assert(LLMProvider.getActiveProvider() === 'gemini', 'legacy primary migra a provider');

  LLMProvider.configure({ llm: { provider: 'groq', fallback: ['gemini', 'openai'] } });
  assert(LLMProvider.getActiveProvider() === 'groq', 'fallback legacy se ignora');

  // hasActiveKey es consistente con lo que muestra el picker (vale en
  // cualquier entorno, tenga o no keys reales configuradas).
  const listed = (LLMProvider.getAvailableProviders() || []).find((p) => p.id === 'groq');
  assert(
    LLMProvider.hasActiveKey() === !!(listed && listed.hasKey),
    'hasActiveKey coincide con el picker'
  );

  LLMProvider.configure({ llm: { provider: 'no-existe' } });
  assert(LLMProvider.getActiveProvider() === null, 'id desconocido → active null');
  setProvider('groq');
}

// ── Test 2: sin rotación ─────────────────────────────────────────────────────

async function testNoRotation() {
  console.log(C.bold('\n── Test 2: el fallo NO rota a otro proveedor ──────────────'));

  setProvider('groq');
  LLMProvider.configure({
    llm: { providers: { gemini: { apiKey: 'FAKE-KEY' } } },
  });
  let geminiCalls = 0;
  LLMProvider._debug_setCaller('groq', async () => {
    throw new Error('groq 500: error interno');
  });
  LLMProvider._debug_setCaller('gemini', async () => {
    geminiCalls++;
    return 'respuesta gemini';
  });

  let message = '';
  try {
    await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'sys');
  } catch (e) {
    message = e.message;
  }
  assert(/groq falló/.test(message), 'el error nombra al proveedor elegido', message);
  assert(/\/model/.test(message), 'el error dice cómo cambiar (/model)', message);
  assert(
    geminiCalls === 0,
    'gemini JAMÁS fue llamado aunque tenga key',
    `llamadas: ${geminiCalls}`
  );
  clearInjected();
}

// ── Test 3: reintento dentro del mismo proveedor ─────────────────────────────

async function testRetrySameProvider() {
  console.log(C.bold('\n── Test 3: reintento con backoff, mismo proveedor ────────'));

  setProvider('groq');
  let calls = 0;
  LLMProvider._debug_setCaller('groq', async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return 'ok tras reintento';
  });
  const result = await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'sys');
  assert(result === 'ok tras reintento', 'el reintento recupera dentro del proveedor');
  assert(calls === 2, 'exactamente 2 intentos, sin terceros', `intentos: ${calls}`);
  clearInjected();
}

// ── Test 4: rate-limit → mensaje accionable, sin espera eterna ───────────────

async function testRateLimit() {
  console.log(C.bold('\n── Test 4: rate-limit con Retry-After largo ───────────────'));

  setProvider('groq');
  let calls = 0;
  LLMProvider._debug_setCaller('groq', async () => {
    calls++;
    throw new Error('groq 429: Please try again in 50m14.5s');
  });
  const t0 = Date.now();
  let message = '';
  try {
    await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'sys');
  } catch (e) {
    message = e.message;
  }
  const elapsed = Date.now() - t0;
  assert(/rate-limit/.test(message), 'menciona rate-limit', message);
  assert(/\/model/.test(message), 'sugiere cambiar de proveedor', message);
  assert(calls === 1, 'no martilla: 1 intento ante espera larga', `intentos: ${calls}`);
  assert(elapsed < 15000, 'no espera 50 minutos', `${elapsed}ms`);
  clearInjected();
}

// ── Test 5: sin key / desconocido ────────────────────────────────────────────

async function testMissingKey() {
  console.log(C.bold('\n── Test 5: errores accionables ────────────────────────────'));

  LLMProvider.configure({ llm: { provider: 'openai', providers: { openai: { apiKey: '' } } } });
  let message = '';
  try {
    await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'sys');
  } catch (e) {
    message = e.message;
  }
  assert(/Sin API key para openai/.test(message), 'sin key → error claro', message);
  assert(/\/model/.test(message), 'sin key → dice dónde configurarla');

  LLMProvider.configure({ llm: { provider: 'inexistente' } });
  message = '';
  try {
    await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'sys');
  } catch (e) {
    message = e.message;
  }
  assert(/desconocido/.test(message), 'provider desconocido → error claro', message);
  setProvider('groq');
}

// ── Test 6: tool-calling también es proveedor único ──────────────────────────

async function testToolsSingleProvider() {
  console.log(C.bold('\n── Test 6: completeWithTools sin rotación ─────────────────'));

  setProvider('groq');
  LLMProvider.configure({ llm: { providers: { gemini: { apiKey: 'FAKE-KEY' } } } });
  let geminiCalls = 0;
  LLMProvider._debug_setToolCaller('groq', async () => {
    throw new Error('groq 500: tools caídos');
  });
  // El fallback a texto también falla: determinista con o sin keys reales.
  LLMProvider._debug_setCaller('groq', async () => {
    throw new Error('groq 500: texto caído');
  });
  LLMProvider._debug_setToolCaller('gemini', async () => {
    geminiCalls++;
    return { content: 'gemini tools', toolCalls: [] };
  });
  let message = '';
  try {
    await LLMProvider.completeWithTools([{ role: 'user', content: 'hola' }], 'sys', [
      { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ]);
  } catch (e) {
    message = e.message;
  }
  assert(/groq/.test(message), 'el error es del proveedor elegido', message);
  assert(geminiCalls === 0, 'tool-calling tampoco rota', `llamadas: ${geminiCalls}`);
  clearInjected();
}

async function main() {
  console.log(C.bold(C.cyan('\n════════ Proveedor único (sin pila) ════════')));
  await testSelection();
  await testNoRotation();
  await testRetrySameProvider();
  await testRateLimit();
  await testMissingKey();
  await testToolsSingleProvider();
  setProvider('groq');
  clearInjected();
  console.log(C.bold('\n══════════════════════════════════════════'));
  console.log(
    `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${failed ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${passed + failed} total`
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
