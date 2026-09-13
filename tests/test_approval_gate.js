'use strict';

// ApprovalGate: decisiones de aprobación extraídas de AgentLoop.
// Cubre allow/ask/deny, timeout, scope de tarea, irreversibles y métricas.

const { ApprovalGate, proposeTaskScope } = require('../core/planner/ApprovalGate.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const { addApproval, resetApprovals } = require('../core/security/SessionApprovals.js');

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

function makeGate() {
  const approvals = [];
  const metrics = {
    trackApproval: (approved) => approvals.push(approved),
    get calls() {
      return approvals;
    },
  };
  return { gate: new ApprovalGate({ metrics }), metrics };
}

async function main() {
  console.log('\n── Propuesta de scope desde tool+params ──');
  const proposal = proposeTaskScope({
    tool: 'open_website',
    params: { target: 'https://example.com/' },
  });
  assert(proposal && proposal.task === 'web-task', 'open_website propone web-task');
  assert(
    proposeTaskScope({ tool: 'exec', params: { command: 'ls' } }) === null,
    'exec no propone scope'
  );
  assert(proposeTaskScope(null) === null, 'acción nula no propone');
  assert(
    proposeTaskScope({ tool: 'browser', params: { url: 'no-es-url' } }) === null,
    'URL inválida no propone'
  );

  console.log('\n── allow directo sin aprobación ──');
  {
    const { gate } = makeGate();
    const decision = await gate.decide({
      action: { tool: 'read', params: {} },
      requiresApproval: false,
      permissionAction: 'allow',
      opts: {},
    });
    assert(decision.proceed === true, 'low impact procede sin handler');
  }

  console.log('\n── ask + approve / deny / timeout ──');
  {
    const { gate, metrics } = makeGate();
    const action = { tool: 'exec', params: { command: 'rm -rf /' } };
    const ok = await gate.decide({
      action,
      requiresApproval: true,
      permissionAction: 'ask',
      opts: { onApprovalNeeded: async () => true },
    });
    assert(ok.proceed === true, 'aprobado procede');
    assert(metrics.calls.length === 1 && metrics.calls[0] === true, 'métrica granted');

    const denied = await gate.decide({
      action,
      requiresApproval: true,
      permissionAction: 'ask',
      opts: { onApprovalNeeded: async () => false },
    });
    assert(denied.proceed === false, 'denegado no procede');
    assert(
      denied.toolResult && denied.toolResult.error === 'cancelada_por_usuario',
      'error cancelada_por_usuario'
    );
    assert(/cancelada por el usuario/.test(denied.historyMessage), 'mensaje para el historial');

    const expired = await gate.decide({
      action,
      requiresApproval: true,
      permissionAction: 'ask',
      opts: { onApprovalNeeded: async () => ({ approved: false, reason: 'timeout' }) },
    });
    assert(expired.proceed === false, 'timeout no procede');
    assert(expired.toolResult.error === 'aprobacion_expirada', 'error aprobacion_expirada');
    assert(gate.approvalExpiredTool === 'exec', 'tool expirada registrada en el gate');
  }

  console.log('\n── Sin handler → fail closed ──');
  {
    const { gate } = makeGate();
    const decision = await gate.decide({
      action: { tool: 'exec', params: { command: 'rm -rf /' } },
      requiresApproval: true,
      permissionAction: 'ask',
      opts: {},
    });
    assert(decision.proceed === false, 'sin handler se bloquea');
    assert(decision.toolResult.error === 'sin_handler_aprobacion', 'error sin_handler_aprobacion');
  }

  console.log('\n── Scope de tarea: una aprobación cubre el resto ──');
  {
    resetApprovals();
    const { gate } = makeGate();
    let taskCards = 0;
    let clickCards = 0;
    const action = { tool: 'open_website', params: { target: 'https://example.com/' } };
    const first = await gate.decide({
      action,
      requiresApproval: true,
      permissionAction: 'ask',
      opts: {
        onTaskApprovalNeeded: async () => {
          taskCards++;
          return true;
        },
        onApprovalNeeded: async () => {
          clickCards++;
          return true;
        },
      },
    });
    assert(first.proceed === true, 'primera acción procede tras aprobar tarea');
    assert(taskCards === 1, 'propuesta pedida una sola vez');
    const second = await gate.decide({
      action: { tool: 'desktop_snapshot', params: {} },
      requiresApproval: true,
      permissionAction: 'ask',
      opts: {
        onTaskApprovalNeeded: async () => {
          taskCards++;
          return true;
        },
        onApprovalNeeded: async () => {
          clickCards++;
          return true;
        },
      },
    });
    assert(second.proceed === true, 'segunda acción cubierta por scope');
    assert(
      taskCards === 1 && clickCards === 0,
      'cero cards por clic con scope',
      `task:${taskCards} click:${clickCards}`
    );
    resetApprovals();
  }

  console.log('\n── Scope rechazado → cards clásicas ──');
  {
    resetApprovals();
    const { gate } = makeGate();
    let cards = 0;
    const decision = await gate.decide({
      action: { tool: 'open_website', params: { target: 'https://example.com/' } },
      requiresApproval: true,
      permissionAction: 'ask',
      opts: {
        onTaskApprovalNeeded: async () => false,
        onApprovalNeeded: async () => {
          cards++;
          return true;
        },
      },
    });
    assert(decision.proceed === true, 'rechazado el scope, la card clásica decide');
    assert(cards === 1, 'se pidió card por clic');
    resetApprovals();
  }

  console.log('\n── Irreversible: ni scope ni autoApprove lo silencian ──');
  {
    resetApprovals();
    addApproval('task:web-task:https://tienda.example/checkout');
    const { gate } = makeGate();
    let cards = 0;
    const decision = await gate.decide({
      action: { tool: 'browser', params: { action: 'click', text: 'Comprar ahora' } },
      requiresApproval: true,
      permissionAction: 'ask',
      opts: {
        taskScope: 'task:web-task:https://tienda.example/checkout',
        onTaskApprovalNeeded: async () => {
          throw new Error('no debería proponerse scope para irreversible');
        },
        onApprovalNeeded: async () => {
          cards++;
          return true;
        },
      },
    });
    assert(decision.proceed === true, 'con aprobación explícita procede');
    assert(cards === 1, 'irreversible siempre muestra card');
    resetApprovals();
  }

  console.log('\n── Integración AgentLoop: aviso de expiración al cierre ──');
  {
    const { AgentLoop: Loop } = { AgentLoop };
    const loop = new Loop({
      maxIterations: 3,
      llm: async () => 'Voy a ejecutar.\n```action\nACCIÓN: run_command | COMANDO: rm -rf /\n```',
      bridge: {
        execute: async () => {
          throw new Error('no debería ejecutarse');
        },
      },
    });
    const result = await loop.run('haz algo', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => ({ approved: false, reason: 'timeout' }),
    });
    assert(
      /DENEGADA/.test(result.response),
      'el cierre avisa la acción no ejecutada',
      result.response.slice(-160)
    );
  }

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
