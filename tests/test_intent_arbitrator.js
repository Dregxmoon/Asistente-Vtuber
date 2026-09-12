'use strict';

// IntentArbitrator: árbitro LLM OPT-IN para la zona gris (negación,
// multi-intención). JSON estricto o nada; timeout y fallback a null.
// completeFn inyectado: estos tests nunca tocan red ni keys.

const { arbitrate, VALID_DOMAINS } = require('../core/task/IntentArbitrator.js');

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

async function main() {
  console.log('\x1b[1m\n════ IntentArbitrator LLM (opt-in) ════\x1b[0m');

  console.log('\n── Veredicto válido ──');
  let seenPrompt = null;
  const ok = await arbitrate('abre amazon pero NO compres nada', {
    completeFn: async (messages, systemPrompt) => {
      seenPrompt = systemPrompt;
      assert(
        Array.isArray(messages) && messages[0].content.includes('NO compres'),
        'recibe el mensaje íntegro (negación incluida)'
      );
      return '{"isTask": true, "domain": "web", "goal": "abrir amazon sin comprar", "confidence": 0.8}';
    },
  });
  assert(ok && ok.isTask && ok.domain.id === 'web', 'negación → tarea web acotada');
  assert(ok && ok.confidence === 'medium', 'confianza del árbitro no infla a high');
  assert(
    seenPrompt && /null/.test(seenPrompt) && /multimedia/.test(seenPrompt),
    'el prompt lista dominios'
  );

  console.log('\n── Rechazos ──');
  assert(
    (
      await arbitrate('hola', {
        completeFn: async () => '{"isTask": false, "domain": null, "goal": "", "confidence": 0.9}',
      })
    ).isTask === false,
    'conversación → isTask false'
  );
  assert(
    (await arbitrate('x', { completeFn: async () => 'no es json' })) === null,
    'basura no-JSON → null'
  );
  assert(
    (await arbitrate('x', { completeFn: async () => '{"isTask": true}' })) === null,
    'tarea sin dominio → null'
  );
  assert(
    (await arbitrate('x', {
      completeFn: async () => '{"isTask": true, "domain": "teletransportar", "confidence": 1}',
    })) === null,
    'dominio inventado → null'
  );
  assert(
    (await arbitrate('x', { completeFn: async () => '{"isTask": "quizás"}' })) === null,
    'isTask no booleano → null'
  );
  assert((await arbitrate('', { completeFn: async () => '{}' })) === null, 'vacío → null');
  assert((await arbitrate('hola')) === null, 'sin completeFn → null');

  console.log('\n── Timeout y errores ──');
  const slow = await arbitrate('abre algo', {
    completeFn: () => new Promise(() => {}),
    timeoutMs: 50,
  });
  assert(slow === null, 'LLM colgado → null por timeout');
  const failing = await arbitrate('abre algo', {
    completeFn: async () => {
      throw new Error('sin red');
    },
  });
  assert(failing === null, 'error de red → null (sigue el pipeline con lo que tenga)');

  console.log('\n── Catálogo ──');
  assert(VALID_DOMAINS.has('web') && VALID_DOMAINS.has('system'), 'dominios desktop presentes');
  assert(!VALID_DOMAINS.has('teletransportar'), 'sin dominios inventados');

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
