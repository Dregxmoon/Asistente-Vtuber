'use strict';

// D1 — aprobación por tarea completa: UN "sí" cubre todos los pasos de una
// tarea desktop/web (task:<tipo>:<destino>) en vez de un card por clic.
// Lo destructivo o fuera del task (exec, escritura, process_stop, uploads)
// sigue pidiendo aprobación por tool.

const {
  taskApprovalPattern,
  isTaskScopeApproved,
  addApproval,
  resetApprovals,
} = require('../core/security/SessionApprovals.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');

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

function createMockLLM(responses) {
  let callCount = 0;
  const fn = async () => {
    if (callCount >= responses.length) return 'Tarea completada.';
    return responses[callCount++];
  };
  fn.callCount = () => callCount;
  return fn;
}

const okBridge = {
  execute: async (tool, params) => ({
    ok: true,
    tool,
    result: {
      kind: 'website',
      url: (params && params.target) || 'https://x.example/',
      ...(params || {}),
    },
    error: null,
    elapsed: 1,
  }),
};

const TASK_RESPONSES = [
  '```action\nACCIÓN: open_website | SITIO: amazon\n```',
  'La tienda quedó abierta.',
  '```action\nACCIÓN: desktop_snapshot | APLICACIÓN: amazon\n```',
  'Ya observé la tienda.',
];

async function main() {
  console.log('\x1b[1m\n════ Aprobación por tarea (D1) ════\x1b[0m');

  console.log('\n── Patrón task:<tipo>:<destino> ──');
  resetApprovals();
  assert(
    taskApprovalPattern('shop-lookup', 'Amazon España') === 'task:shop-lookup:amazon españa',
    'normaliza tipo y destino'
  );
  assert(taskApprovalPattern('', 'amazon') === null, 'sin tipo no hay patrón');
  assert(taskApprovalPattern('shop-lookup', '') === null, 'sin destino no hay patrón');
  assert(
    taskApprovalPattern('shop lookup!!', '  AMAZON  ') === 'task:shop-lookup:amazon',
    'sanea caracteres y espacios'
  );

  console.log('\n── Cobertura del scope ──');
  const scope = taskApprovalPattern('shop-lookup', 'amazon');
  assert(!isTaskScopeApproved({ tool: 'open_website' }, scope), 'sin aprobar no cubre');
  addApproval(scope);
  assert(isTaskScopeApproved({ tool: 'open_website' }, scope), 'cubre open_website aprobado');
  assert(isTaskScopeApproved({ tool: 'desktop_snapshot' }, scope), 'cubre observación aprobada');
  assert(
    isTaskScopeApproved({ tool: 'ui_click', params: { observationId: 'o', ref: 'ui-1' } }, scope),
    'cubre interacción UI aprobada'
  );
  assert(
    isTaskScopeApproved({ tool: 'browser', params: { action: 'get_text' } }, scope),
    'cubre lectura de navegador aprobada'
  );
  assert(!isTaskScopeApproved({ tool: 'exec', params: {} }, scope), 'exec NUNCA queda cubierto');
  assert(
    !isTaskScopeApproved({ tool: 'write', params: {} }, scope),
    'escritura de archivos NUNCA queda cubierta'
  );
  assert(
    !isTaskScopeApproved({ tool: 'process_stop', params: { pid: 42 } }, scope),
    'terminar procesos NUNCA queda cubierto'
  );
  assert(
    !isTaskScopeApproved({ tool: 'browser', params: { action: 'upload' } }, scope),
    'subidas del navegador NUNCA quedan cubiertas'
  );
  assert(
    !isTaskScopeApproved({ tool: 'open_website' }, 'open_website:external:default:x'),
    'un patrón por tool no es un scope de tarea'
  );
  assert(!isTaskScopeApproved({ tool: 'open_website' }, null), 'sin scope no cubre');
  assert(!isTaskScopeApproved(null, scope), 'sin acción no cubre');

  console.log('\n── Integración AgentLoop: un sí, cero cards ──');
  resetApprovals();
  addApproval(scope);
  let cards = 0;
  const loop = new AgentLoop({
    maxIterations: 6,
    llm: createMockLLM(TASK_RESPONSES),
    bridge: okBridge,
  });
  const result = await loop.run('abre amazon y busca el manga', 'Eres un asistente.', [], {
    taskScope: scope,
    onApprovalNeeded: async () => {
      cards++;
      return true;
    },
  });
  assert(cards === 0, 'ningún card por clic con scope aprobado', `cards: ${cards}`);
  assert(
    result.toolResults.filter((item) => item.ok).length >= 2,
    'los pasos se ejecutaron igual',
    JSON.stringify(result.toolResults.map((item) => item.tool))
  );

  console.log('\n── Sin scope aprobado: flujo clásico por clic ──');
  resetApprovals();
  let classicCards = 0;
  const classic = new AgentLoop({
    maxIterations: 6,
    llm: createMockLLM(TASK_RESPONSES),
    bridge: okBridge,
  });
  await classic.run('abre amazon y busca el manga', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => {
      classicCards++;
      return true;
    },
  });
  assert(classicCards >= 2, 'sin scope cada tool pide su card', `cards: ${classicCards}`);

  resetApprovals();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
