'use strict';

// Multilenguaje por inferencia, no en código: el idioma vive en el texto del
// usuario y la respuesta final; tools, protocolo y decisiones usan la
// interlingua canónica en inglés. Cero ramas por idioma en el código.

const { fuseTaskIntent } = require('../core/core/context.js');
const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
const { detectLanguage, localeFor } = require('../core/grounding/LanguageProfile.js');
const { WebsiteResolver } = require('../core/desktop/WebsiteResolver.js');
const { SITE_ALIASES } = require('../core/desktop/DesktopControl.js');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const {
  taskApprovalPattern,
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
    webSearch: async () => ({ result: [{ title: 'x', url: 'https://www.amazon.es/' }] }),
    urlGuard: async () => ({ safe: true }),
    managedNavigator: async (input) => ({
      result: { url: input.url, title: 'mock', status: 'completed', verified: true },
    }),
    ...overrides,
  });
}

async function testFusion() {
  console.log('\n── Fusión intent→task (EN sin regex inglés) ──');
  // "open amazon": TaskDetector (regex ES) no ve tarea; embeddings sí.
  const fused = fuseTaskIntent(
    { isTask: false, confidence: 'none', domain: null },
    {
      detected: true,
      action: 'open_website',
      tool: 'open_website',
      confidence: 0.9,
      level: 'high',
    },
    'open amazon and check the manga'
  );
  assert(fused && fused.isTask && fused.domain.id === 'web', 'EN se fusiona a tarea web');
  assert(
    fused && fused.confidence === 'medium',
    'alta embedding → media fusionada (señal más débil)'
  );

  const existing = { isTask: true, confidence: 'high', domain: { id: 'system' } };
  assert(
    fuseTaskIntent(existing, { detected: true, action: 'x', tool: 'launch_app', level: 'high' }) ===
      null,
    'tarea existente no se toca'
  );
  assert(
    fuseTaskIntent(null, { detected: false, level: 'none' }, 'hola') === null,
    'sin intent no hay fusión'
  );
  assert(
    fuseTaskIntent(
      null,
      { detected: true, action: 'answer_question', tool: null, level: 'high' },
      'hola'
    ) === null,
    'conversación no se fusiona (tool null)'
  );
  assert(
    fuseTaskIntent(
      null,
      { detected: true, action: 'x', tool: 'herramienta_rara', level: 'high' },
      'x'
    ) === null,
    'tool desconocida no se fusiona'
  );
}

async function testSerializerNeutral() {
  console.log('\n── Serializer: protocolo canónico + línea de idioma ──');
  const serializer = new GroqSerializer();
  const base = {
    identity: null,
    osContext: null,
    persistentMemory: null,
    inferredModel: null,
    metamemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'open amazon please' },
    toolIntent: null,
    commStyleHint: null,
    language: detectLanguage('open amazon please'),
  };
  const withLang = serializer.serialize(base, {}).systemPrompt;
  assert(/TOOL PROTOCOL \(canonical/.test(withLang), 'nota canónica presente');
  assert(/ACTION:.*TARGET:/.test(withLang), 'ejemplo canónico en inglés');
  assert(/Respond to the user in inglés/.test(withLang), 'línea de respuesta en inglés');
  const withoutLang = serializer.serialize({ ...base, language: null }, {}).systemPrompt;
  assert(/TOOL PROTOCOL \(canonical/.test(withoutLang), 'canónico sin idioma también');
  assert(!/IDIOMA DE RESPUESTA/.test(withoutLang), 'sin idioma no hay línea de respuesta');
}

async function testResolverLocale() {
  console.log('\n── Resolver: locale del usuario en el scoring ──');
  const resolver = new WebsiteResolver({
    aliases: SITE_ALIASES,
    webSearch: async () => ({
      result: [
        { title: 'Amazon US', url: 'https://www.amazon.com/' },
        { title: 'Amazon México', url: 'https://www.amazon.com.mx/' },
      ],
    }),
    urlGuard: async () => ({ safe: true }),
  });
  const sinLocale = await resolver.resolve('amazon');
  assert(sinLocale.url === 'https://www.amazon.com/', 'sin locale gana el primero empatado');
  resolver.setLocaleHints(localeFor('es').tldHints);
  const conLocale = await resolver.resolve('amazon');
  assert(
    conLocale.url === 'https://www.amazon.com.mx/',
    'con hints es-MX gana .com.mx aunque llegue segundo',
    conLocale.url
  );
}

async function testClarification() {
  console.log('\n── Resolver: clarificación con candidatos ──');
  const resolver = new WebsiteResolver({
    aliases: SITE_ALIASES,
    webSearch: async () => ({
      result: [
        { title: 'Tienda A', url: 'https://tienda-a.example/' },
        { title: 'Tienda B', url: 'https://tienda-b.example/' },
      ],
    }),
    urlGuard: async () => ({ safe: false }),
  });
  let mensaje = '';
  try {
    await resolver.resolve('una tienda rarísima');
  } catch (error) {
    mensaje = error instanceof Error ? error.message : String(error);
  }
  assert(
    /tienda-a\.example/.test(mensaje) &&
      /tienda-b\.example/.test(mensaje) &&
      /Cuál querías/.test(mensaje),
    'el error lista opciones para preguntar UNA cosa concreta',
    mensaje
  );
}

async function testNeedsVerification() {
  console.log('\n── Guard verificar ⇒ managed ──');
  const bridge = makeBridge();
  const forced = await bridge.execute('open_website', {
    target: 'https://tienda.example/',
    control: 'external',
    needsVerification: true,
  });
  assert(
    forced.ok && forced.result.forcedManaged === true,
    'needsVerification fuerza managed aunque pidan external'
  );
  assert(
    forced.result.browser === 'kaoru-managed-chromium',
    'navega con el Chromium verificable, no el personal'
  );
  const plain = await bridge.execute('open_website', { target: 'https://tienda.example/' });
  assert(
    plain.ok && plain.result.browser === 'default' && !plain.result.forcedManaged,
    'sin flag se conserva el default external (sin regresión)'
  );
}

async function testTaskProposal() {
  console.log('\n── Propuesta de tarea: un sí, cero cards ──');
  resetApprovals();
  const responses = [
    '```action\nACTION: open_website | TARGET: amazon\n```',
    'Abierta.',
    '```action\nACTION: desktop_snapshot | APPLICATION: amazon\n```',
    'Observada.',
  ];
  let calls = 0;
  const llm = async () => (calls < responses.length ? responses[calls++] : 'Listo.');
  const bridge = makeBridge();
  let proposals = 0;
  let cards = 0;
  const loop = new AgentLoop({ maxIterations: 6, llm, bridge });
  const result = await loop.run('open amazon and check the manga', 'You are an assistant.', [], {
    onTaskApprovalNeeded: async (proposal) => {
      proposals++;
      assert(
        proposal.task === 'web-task' &&
          proposal.pattern === taskApprovalPattern('web-task', 'amazon'),
        'la propuesta sale de tool+params, sin parsear idioma',
        JSON.stringify(proposal)
      );
      addApproval(proposal.pattern);
      return true;
    },
    onApprovalNeeded: async () => {
      cards++;
      return true;
    },
  });
  assert(proposals === 1, 'la propuesta se pide UNA vez por run', `proposals: ${proposals}`);
  assert(cards === 0, 'tras aprobar la tarea no hay cards por clic', `cards: ${cards}`);
  assert(result.toolResults.filter((item) => item.ok).length >= 2, 'los pasos se ejecutaron igual');

  resetApprovals();
  let proposals2 = 0;
  let cards2 = 0;
  const loop2 = new AgentLoop({
    maxIterations: 6,
    llm: async () =>
      proposals2 + cards2 < 4 ? responses[(proposals2 + cards2) % responses.length] : 'Listo.',
    bridge: makeBridge(),
  });
  await loop2.run('open amazon and check the manga', 'You are an assistant.', [], {
    onTaskApprovalNeeded: async () => {
      proposals2++;
      return false;
    },
    onApprovalNeeded: async () => {
      cards2++;
      return true;
    },
  });
  assert(proposals2 === 1, 'rechazada tampoco se re-pregunta');
  assert(cards2 >= 1, 'rechazada degrada a cards clásicas', `cards: ${cards2}`);
  resetApprovals();
}

(async () => {
  console.log('\x1b[1m\n════ Multilenguaje por inferencia ════\x1b[0m');
  await testFusion();
  await testSerializerNeutral();
  await testResolverLocale();
  await testClarification();
  await testNeedsVerification();
  await testTaskProposal();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
