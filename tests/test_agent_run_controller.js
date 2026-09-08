'use strict';

const { AgentRunController } = require('../core/planner/AgentRunController.js');

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

(() => {
  console.log('\nAgentRunController');
  let now = 100;
  const controller = new AgentRunController({ runId: 'run-test', now: () => ++now });
  assert(controller.start(), 'inicia una ejecución en cola');
  assert(controller.steer('prioriza las pruebas').ok, 'acepta steering durante el run');
  assert(controller.snapshot().steering.queued === 1, 'expone cantidad, no contenido sensible');
  assert(
    !JSON.stringify(controller.snapshot()).includes('prioriza'),
    'snapshot no filtra el texto'
  );
  const updates = controller.consumeSteering();
  assert(updates.length === 1, 'consume el steering una sola vez');
  assert(controller.consumeSteering().length === 0, 'la cola queda vacía tras consumir');
  controller.noteProgress({ phase: 'start', tool: 'read', iteration: 2 });
  controller.notePlan({ done: 1, total: 3, steps: ['uno', 'dos', 'tres'] });
  const done = controller.finish({ iterations: 2, error: 'plan_incomplete' });
  assert(done.state === 'paused' && done.result.resumable, 'un fallo queda pausado y reanudable');
  assert(!controller.steer('tarde').ok, 'rechaza steering cuando el run ya terminó');

  const cancellable = new AgentRunController({ runId: 'run-cancel' });
  cancellable.start();
  assert(cancellable.cancel() && cancellable.signal.aborted, 'cancel propaga AbortSignal');
  assert(
    cancellable.finish({ cancelled: true }).state === 'cancelled',
    'conserva estado cancelado'
  );

  console.log(`\nResultado: ${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
