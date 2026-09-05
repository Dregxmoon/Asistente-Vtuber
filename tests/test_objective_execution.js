// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStepProgress } = require('../core/planner/StepExecutionLedger.js');
const { CapabilityRouter } = require('../core/task/CapabilityRouter.js');
const { resolveConnectorScopes } = require('../core/connectors/ConnectorRegistry.js');
const { LearningEngine } = require('../core/learning/LearningEngine.js');
const { StateGraph } = require('../core/state-graph/StateGraph.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function testStepLedger() {
  console.log('\nObjetivos — ledger de evidencia por paso');
  const plan = {
    steps: ['Editar core/widget.js', 'Ejecutar npm test', 'Publicar cambios con git push'],
    criteria: ['archivo modificado', 'suite termina correctamente', 'push confirmado'],
  };
  const results = [
    {
      tool: 'edit',
      ok: true,
      elapsed: 10,
      _action: { tool: 'edit', params: { path: 'core/widget.js' } },
    },
    {
      tool: 'exec',
      ok: true,
      elapsed: 20,
      _action: { tool: 'exec', params: { command: 'npm test' } },
    },
  ];
  const progress = buildStepProgress(plan, results, { status: 'passed', reason: 'checks verdes' });
  assert(progress.done === 2, 'dos evidencias cubren dos pasos concretos, no tres');
  assert(progress.coverageComplete === false, 'no declara cobertura completa sin push');
  assert(results[0].stepOrdinal === 1, 'la edición queda vinculada al paso de edición');
  assert(results[1].stepOrdinal === 2, 'el test queda vinculado al paso de pruebas');

  const complete = buildStepProgress(
    plan,
    [...results, { tool: 'git_push', ok: true, _action: { tool: 'git_push', params: {} } }],
    { status: 'passed' }
  );
  assert(complete.coverageComplete, 'completa el plan cuando cada paso tiene evidencia');
}

function testExactPersistence() {
  console.log('\nObjetivos — persistencia exacta del paso');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-step-ledger-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const id = graph.createIntention({ sessionId: 's1', goal: 'Publicar', workspace: dir });
    graph.createGoalPlan(id, [
      { description: 'Editar', successCriteria: ['diff'] },
      { description: 'Probar', successCriteria: ['test'] },
      { description: 'Publicar', successCriteria: ['push'] },
    ]);
    graph.recordGoalRunProgress(id, {
      stepStates: [
        { ordinal: 1, status: 'completed', evidence: [{ tool: 'edit', ok: true }] },
        { ordinal: 2, status: 'pending', evidence: [] },
        { ordinal: 3, status: 'completed', evidence: [{ tool: 'git_push', ok: true }] },
      ],
    });
    const stored = graph.getGoalPlan(id);
    assert(stored[0].status === 'completed', 'persiste el paso uno completado');
    assert(stored[1].status === 'pending', 'no completa por posición el paso sin evidencia');
    assert(stored[2].status === 'completed', 'persiste evidencia no contigua');
    assert(
      !graph.completeGoalPlan(id, { status: 'verified', stepEvidenceRequired: true }),
      'rechaza cierre global con cobertura incompleta'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testRoutingAndConnectors() {
  console.log('\nCapacidades — salud, coste y permisos de conexión');
  const router = new CapabilityRouter({
    stats: {
      'openclaw:read': { uses: 10, successRate: 0.95, averageLatencyMs: 20 },
      'mcp:files/read_file': { uses: 10, successRate: 0.4, averageLatencyMs: 900 },
    },
    mcpHealth: { files: { score: 0.5, averageLatencyMs: 900 } },
  });
  const ranked = router.rank([
    { source: 'mcp', server: 'files', name: 'read_file' },
    { source: 'openclaw', name: 'read' },
  ]);
  assert(ranked[0].tool.name === 'read', 'prefiere la capacidad local fiable y rápida');
  assert(
    new CapabilityRouter({ mcpHealth: { files: { breaker: 'open', score: 0 } } }).score({
      source: 'mcp',
      server: 'files',
      name: 'read_file',
    }).unavailable,
    'retira una ruta MCP con circuito abierto'
  );
  const calendar = resolveConnectorScopes('google', ['identity', 'calendar_read']);
  assert(
    calendar?.scope.includes('calendar.readonly'),
    'calendario empieza con alcance de lectura'
  );
  assert(calendar?.access === 'read', 'lectura no se eleva silenciosamente a escritura');
  let rejected = false;
  try {
    resolveConnectorScopes('google', ['calendar_admin']);
  } catch (_) {
    rejected = true;
  }
  assert(rejected, 'rechaza capacidades OAuth desconocidas');
}

function testContinuousLearning() {
  console.log('\nAprendizaje — skills y estrategias verificadas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-strategy-'));
  const engine = new LearningEngine({ filePath: path.join(dir, 'learning.json') });
  try {
    for (let index = 0; index < 5; index++) {
      engine.recordTaskOutcome({
        mode: 'smart',
        success: false,
        verificationStatus: 'failed',
        skills: ['skill-inestable'],
        capabilities: ['mcp:slow/tool'],
        goal: `fallo ${index}`,
      });
    }
    assert(engine.skillStats()['skill-inestable'].suspended, 'pone en cuarentena una skill nociva');
    for (let index = 0; index < 2; index++) {
      engine.recordTaskOutcome({
        mode: 'smart',
        success: true,
        verificationStatus: 'verified',
        taskDomain: 'code',
        toolSequence: ['read', 'edit', 'exec'],
        capabilities: ['openclaw:read', 'openclaw:edit', 'openclaw:exec'],
        elapsedMs: 100,
        goal: `éxito ${index}`,
      });
    }
    const strategy = engine.recommendStrategy({ domain: 'code' });
    assert(
      strategy?.sequence.join(',') === 'read,edit,exec',
      'recuerda una ruta verificada repetida'
    );
    assert(
      engine.buildPromptSection({ domain: 'code' })?.includes('Ruta verificada para code'),
      'proyecta la estrategia como orientación, no autorización'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testStepLedger();
testExactPersistence();
testRoutingAndConnectors();
testContinuousLearning();

console.log(`\nResultado: ${passed} passed  ${failed} failed`);
if (failed) process.exitCode = 1;
