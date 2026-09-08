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

async function testPlanIsNeverOptionalInProductionMode() {
  let calls = 0;
  const loop = new AgentLoop({
    maxIterations: 3,
    llm: async () => {
      calls++;
      return calls === 1 ? 'respuesta sin formato de plan' : 'No pude completar todavía.';
    },
  });
  const result = await loop.run('corrige el archivo de configuración del proyecto', 'sistema', [], {
    planning: false,
    requirePlan: true,
    strictCompletion: true,
  });
  assert(result.plan && result.plan.total >= 3, 'modo producción conserva un plan fallback');
  assert(result.error === 'plan_incomplete', 'no declara éxito si quedan pasos sin evidencia');
  assert(
    String(result.response).includes('INCOMPLETA') && String(result.response).includes('reanudará'),
    'el cierre informa estado incompleto y reanudación'
  );
}

async function testSteeringIsAppliedBetweenIterations() {
  let promptMessages = [];
  const loop = new AgentLoop({
    llm: async (messages) => {
      promptMessages = messages;
      return 'Resultado ajustado.';
    },
  });
  let consumed = false;
  const result = await loop.run('analiza el proyecto', 'sistema', [], {
    reportMode: true,
    consumeSteering: () => {
      if (consumed) return [];
      consumed = true;
      return [{ text: 'prioriza los fallos de cancelación' }];
    },
  });
  assert(result.steering?.applied === 1, 'el resultado informa steering aplicado');
  assert(
    promptMessages.some((message) =>
      String(message.content || '').includes('prioriza los fallos de cancelación')
    ),
    'la actualización entra al contexto de la siguiente decisión'
  );
  assert(
    promptMessages.some((message) => String(message.content || '').includes('No la interpretes')),
    'el steering no se presenta como autorización'
  );
}

async function testExecutionContractAndOptInRollback() {
  let finalized = 0;
  let reverted = 0;
  const checkpoint = {
    async finalize() {
      finalized++;
      return this.metadata();
    },
    metadata() {
      return { canRevert: true, files: ['fallo.js'] };
    },
    async revert() {
      reverted++;
      return { ok: true, reverted: ['fallo.js'] };
    },
  };
  const loop = new AgentLoop({ checkpoint, llm: async () => 'sin usar' });
  loop._runInternal = async () => ({
    response: 'La verificación falló.',
    iterations: 2,
    toolResults: [{ ok: true, tool: 'write', result: 'ok' }],
    error: 'verification_failed',
    verify: { status: 'failed' },
  });
  const result = await loop.run('corrige el archivo', 'sistema', [], {
    rollbackOnVerificationFailure: true,
  });
  assert(reverted === 1 && finalized >= 1, 'rollback opt-in revierte un checkpoint verificable');
  assert(result.rollback?.ok === true, 'el resultado expone evidencia del rollback');
  assert(
    result.execution?.state === 'paused' && result.execution?.resumable === true,
    'el contrato terminal conserva la tarea para reanudar'
  );

  reverted = 0;
  const conservative = new AgentLoop({ checkpoint, llm: async () => 'sin usar' });
  conservative._runInternal = loop._runInternal;
  const noRollback = await conservative.run('corrige el archivo', 'sistema', [], {});
  assert(reverted === 0 && !noRollback.rollback, 'sin opt-in nunca revierte automáticamente');
}

(async () => {
  console.log('\nAgent harness avanzado');
  await testLifecycleHooks();
  await testParallelReadOnlySubagents();
  await testToolBudgetAndHooks();
  await testPlanIsNeverOptionalInProductionMode();
  await testSteeringIsAppliedBetweenIterations();
  await testExecutionContractAndOptInRollback();
  console.log(`\nResultado: ${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
