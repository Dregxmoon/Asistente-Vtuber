'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const AP = require('../core/planner/ActionParser.js');
const {
  MutationJournal,
  isMutatingAction,
  extractMutationPaths,
} = require('../core/planner/MutationJournal.js');
const { resolveVerifyPlan } = require('../core/commands/verify.js');
const { beginGoal } = require('../core/memory/GoalLifecycle.js');

let passed = 0;
let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function testMutationJournal() {
  const cwd = '/tmp/project';
  const action = { tool: 'exec', params: { command: 'printf x > src/out.js' } };
  assert(isMutatingAction(action), 'exec con redirección cuenta como mutación');
  assert(
    extractMutationPaths(action, cwd)[0] === '/tmp/project/src/out.js',
    'extrae la ruta de una redirección antes de ejecutar'
  );
  assert(
    isMutatingAction({ tool: 'mcp', params: { tool: 'write_file' } }),
    'MCP de escritura cuenta como mutación'
  );
  const journal = new MutationJournal({ cwd });
  journal.record({ ok: true, tool: 'exec' }, action);
  journal.merge({ files: ['/tmp/project/child.js'], entries: [{ tool: 'write' }] });
  assert(journal.toJSON().count === 2, 'fusiona las mutaciones de un subagente');
  assert(journal.files.has('/tmp/project/child.js'), 'conserva archivos del subagente');
}

async function testVerificationMatrix() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-matrix-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'node --test' } })
  );
  const plan = resolveVerifyPlan(null, dir);
  assert(plan.command === 'npm run typecheck', 'mantiene el primer comando compatible');
  assert(plan.commands?.length === 3, 'conserva toda la matriz typecheck/lint/test');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testNaturalContinuation() {
  const active = { id: 7, goal: 'Implementar autenticación completa' };
  const graph = {
    usingFallback: false,
    listActiveIntentions: () => [active],
    ensureGoalGovernance: () => ({}),
    claimGoalExecution: () => ({ claimed: true }),
    recordGoalEvent: () => 1,
    updateProjectCompanion: () => ({}),
  };
  const commitment = beginGoal({
    graph,
    sessionId: 'session-1',
    workspace: '/tmp/project',
    goal: 'continúa y corrige lo que falta',
  });
  assert(commitment?.id === 7 && commitment.resumed, '“continúa” retoma el único objetivo activo');
  assert(commitment?.goal === active.goal, 'la continuación conserva la identidad del objetivo');
}

async function testRepositorySnapshotAndResultTail() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-snapshot-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'module.exports = 1;');
  AP.setProjectCWD(dir);
  const loop = new AgentLoop({ llm: async () => 'ok', bridge: { execute: async () => ({}) } });
  const snapshot = await loop._buildRepositorySnapshot('corrige feature');
  assert(snapshot.includes('src/feature.js'), 'el plan recibe rutas reales del repositorio');
  const long = `inicio-${'x'.repeat(9000)}-final`;
  const summary = loop._summarizeResult({ tool: 'read', result: long });
  assert(
    summary.includes('inicio-') && summary.includes('-final'),
    'lecturas largas conservan inicio y final'
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testVerifyRepairLoop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repair-'));
  AP.setProjectCWD(dir);
  const target = path.join(dir, 'result.txt');
  const responses = [
    `\`\`\`action\nACCIÓN: create_file | ARCHIVO: ${target}\nCONTENIDO: intento uno\n\`\`\``,
    'Terminé.',
    `\`\`\`action\nACCIÓN: create_file | ARCHIVO: ${target}\nCONTENIDO: intento corregido\n\`\`\``,
    'Terminé y verifiqué.',
  ];
  let llmCalls = 0;
  let verifyCalls = 0;
  const bridge = {
    execute: async (tool, params) => {
      if (tool === 'write') {
        fs.writeFileSync(params.path, params.content, 'utf-8');
        return { ok: true, result: 'ok', tool, elapsed: 0 };
      }
      if (tool === 'exec') {
        verifyCalls++;
        const ok = verifyCalls > 1;
        return {
          ok: true,
          result: { stdout: '', stderr: ok ? '' : 'fallo verificable', exitCode: ok ? 0 : 1 },
          tool,
          elapsed: 0,
        };
      }
      return { ok: false, error: 'tool no soportada', result: null, tool, elapsed: 0 };
    },
  };
  const loop = new AgentLoop({
    maxIterations: 8,
    mode: 'smart',
    llm: async () => responses[llmCalls++],
    bridge,
  });
  const result = await loop.run('crea y verifica result.txt', 'Sistema', [], {
    planning: false,
    verifyRepair: true,
    verify: { enabled: true, command: 'npm test' },
  });
  assert(verifyCalls === 2, 'una verificación fallida vuelve al agente y se repite');
  assert(result.verify?.status === 'passed', 'la tarea cierra después de reparar y verificar');
  assert(fs.readFileSync(target, 'utf-8') === 'intento corregido', 'la reparación quedó aplicada');
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await testMutationJournal();
  await testVerificationMatrix();
  await testNaturalContinuation();
  await testRepositorySnapshotAndResultTail();
  await testVerifyRepairLoop();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
