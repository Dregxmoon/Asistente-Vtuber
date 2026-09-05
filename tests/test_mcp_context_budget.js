// @ts-check
'use strict';
const assert = require('assert/strict');
const { truncateSystemPrompt } = require('../core/core/context.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const { resolveToolset } = require('../core/task/ToolResolver.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const logger = require('../core/observability/Logger.js');

const catalog =
  '# HERRAMIENTAS DISPONIBLES\nServidor: google-calendar\n- get_events\n- start_google_auth\n' +
  't'.repeat(6967);
const memory = '## Lo que sé del usuario\n' + 'm'.repeat(3000);
const episodes = '## Recuerdos episódicos\n' + 'e'.repeat(2000);
const feedback = '# LO APRENDIDO (FEEDBACK)\n' + 'f'.repeat(1000);

function testPriorityAndBoundaries() {
  const prompt =
    ['IDENTIDAD', memory, episodes].join('\n\n---\n\n') + '\n\n' + catalog + '\n\n' + feedback;
  const logs = [];
  const originalInfo = logger.info;
  logger.info = (_scope, message) => {
    logs.push(message);
  };
  try {
    const out = truncateSystemPrompt(prompt, { max: catalog.length + 500 });
    assert(out.includes(catalog));
    assert(!out.includes(memory));
    assert(!out.includes(episodes));
    assert(!out.includes(feedback));
    assert(logs[1].includes('Episodios'));
    assert(logs[0].includes('Memoria'));
    assert(logs[2].includes('Lo aprendido'));
    assert(!logs.some((line) => line.includes('Catálogo de tools')));
    assert(out.length <= catalog.length + 500);
  } finally {
    logger.info = originalInfo;
  }

  const appended =
    'IDENTIDAD\n\n' + feedback + '\n\n' + catalog + '\n\n# REGLAS DE SEGURIDAD\nMantener permisos.';
  const preserved = truncateSystemPrompt(appended, {
    max: appended.length - 500,
    tailSections: [{ name: 'feedback', marker: '# LO APRENDIDO (FEEDBACK)' }],
  });
  assert(preserved.includes(catalog));
  assert(preserved.includes('# REGLAS DE SEGURIDAD\nMantener permisos.'));
}

function testWarningAsLastResort() {
  const events = [];
  const originalWarn = logger.warn;
  const originalInfo = logger.info;
  logger.warn = (_scope, message) => {
    events.push(message);
  };
  logger.info = (_scope, message) => {
    events.push(message);
  };
  try {
    const out = truncateSystemPrompt('IDENTIDAD\n\n' + catalog, { max: 100 });
    assert(out.length <= 100);
    const warning = events.findIndex((line) =>
      line.includes('intentando recortar catálogo de tools')
    );
    const removed = events.findIndex((line) =>
      line.includes('sección "Catálogo de tools" eliminada')
    );
    assert(warning >= 0 && warning < removed);
    assert(events[warning].includes('tool_calls_total=0'));
  } finally {
    logger.warn = originalWarn;
    logger.info = originalInfo;
  }
}

async function testCalendarCallUnderPressure() {
  const originalComplete = LLMProvider.completeWithTools;
  const calls = [];
  const captured = [];
  const mcpManager = {
    listAllTools: () => [
      {
        server: 'google-calendar',
        tool: 'get_events',
        description: 'Consultar eventos',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { content: [{ type: 'text', text: 'No hay eventos mañana.' }] };
    },
  };
  LLMProvider.completeWithTools = async (_messages, systemPrompt, tools) => {
    captured.push(systemPrompt);
    assert(systemPrompt.length <= 30000);
    assert(systemPrompt.includes('google-calendar'));
    assert(systemPrompt.includes('# MODO AGENTE'));
    assert(systemPrompt.includes(catalog));
    if (captured.length === 1) {
      const tool = tools.find((schema) => schema.name.includes('get_events'));
      assert(tool);
      return { content: null, toolCalls: [{ tool: tool.name, params: {} }] };
    }
    return { content: 'No hay eventos mañana.', toolCalls: null };
  };
  try {
    const base = 'IDENTIDAD\n\n---\n\n## Lo que sé del usuario\n' + 'm'.repeat(24500);
    const loop = new AgentLoop({
      llm: async () => {
        throw new Error('No debe usar fallback conversacional');
      },
      mcpManager,
      maxIterations: 3,
    });
    const result = await loop.run(
      'Consulta mis eventos de mañana usando google-calendar...',
      base,
      [],
      {
        mode: 'fast',
        planning: false,
        mcpManager,
        toolResolver: {
          resolveToolset: async (context) => ({
            ...(await resolveToolset(context)),
            promptCatalog: catalog,
          }),
        },
        onApprovalNeeded: async () => true,
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'get_events');
    assert.equal(result.toolResults.length, 1);
    assert(result.toolResults[0].ok);
    assert.equal(captured.length, 2);
    console.log('Regresión simulada: tool_calls_total=1; google-calendar.get_events invocado');
  } finally {
    LLMProvider.completeWithTools = originalComplete;
  }
}
(async () => {
  testPriorityAndBoundaries();
  testWarningAsLastResort();
  await testCalendarCallUnderPressure();
  console.log('Resultado: 3 passed  0 failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
