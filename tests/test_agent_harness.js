'use strict';

const { AgentLoop } = require('../core/planner/AgentLoop.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function testLifecycleHooks() {
  const events = [];
  const pluginManager = {
    async runHook(name) {
      events.push(name);
    },
  };
  const loop = new AgentLoop({ llm: async () => 'Respuesta final verificada.' });
  const result = await loop.run('responde', 'sistema', [], { reportMode: true, pluginManager });
  assert(result.response.includes('Respuesta final'), 'el run conserva su resultado');
  assert(events[0] === 'beforeAgentRun', 'hook beforeAgentRun');
  assert(events.includes('afterAgentRun'), 'hook afterAgentRun');
  assert(events.at(-1) === 'agentStop', 'hook agentStop incluso al cerrar');

  events.length = 0;
  await loop.run('responde', 'sistema', [], {
    reportMode: true,
    pluginManager,
    beforeAgentRunHandled: true,
  });
  assert(
    !events.includes('beforeAgentRun'),
    'la fachada puede evitar ejecutar beforeAgentRun doble'
  );
  assert(
    events.includes('afterAgentRun') && events.at(-1) === 'agentStop',
    'los hooks de cierre siguen'
  );
}

async function testParallelReadOnlySubagents() {
  const loop = new AgentLoop({ llm: async () => 'ok' });
  let active = 0;
  let peak = 0;
  loop._executeSubagent = async (action) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
    return { ok: true, result: { response: action.params.task }, error: null, tool: 'subagent' };
  };
  const result = await loop._executeSubagentBatch({
    tool: 'subagent_batch',
    params: {
      tasks: [
        { task: 'investiga A', agent: 'explorador' },
        { task: 'investiga B', agent: 'investigador' },
      ],
    },
  });
  assert(result.ok && result.result.reports.length === 2, 'batch devuelve todos los reportes');
  assert(peak === 2, 'subagentes read_only se ejecutan realmente en paralelo');

  const denied = await loop._executeSubagentBatch({
    tool: 'subagent_batch',
    params: {
      tasks: [
        { task: 'A', agent: 'general' },
        { task: 'B', agent: 'explorador' },
      ],
    },
  });
  assert(!denied.ok, 'batch paralelo rechaza perfiles con capacidad de escritura');
}

async function testToolBudgetAndHooks() {
  const original = LLMProvider.completeWithTools;
  const events = [];
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    return {
      content: '',
      toolCalls: [{ tool: 'read', params: { path: 'package.json' } }],
    };
  };
  try {
    const loop = new AgentLoop({
      bridge: { execute: async () => ({ ok: true, result: '{}', error: null, tool: 'read' }) },
    });
    const result = await loop.run('lee', 'sistema', [], {
      reportMode: true,
      maxToolCalls: 1,
      tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      pluginManager: {
        async runHook(name) {
          events.push(name);
        },
      },
    });
    assert(result.error === 'budget_exhausted', 'presupuesto de tools detiene el loop');
    assert(result.toolResults.length === 1 && calls === 1, 'no excede el máximo de tool calls');
    assert(events.includes('afterTool'), 'hook afterTool recibe ejecuciones exitosas');
  } finally {
    LLMProvider.completeWithTools = original;
  }
}

(async () => {
  console.log('\nAgent harness avanzado');
  await testLifecycleHooks();
  await testParallelReadOnlySubagents();
  await testToolBudgetAndHooks();
  console.log(`\nResultado: ${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
