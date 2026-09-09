'use strict';

const { DesktopAutomation } = require('../core/desktop/DesktopAutomation.js');

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

async function expectReject(fn, pattern, label) {
  try {
    await fn();
    assert(false, label);
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), label);
  }
}

async function main() {
  let completed = false;
  let now = 1000;
  const adapter = {
    platform: 'linux',
    health: async () => ({ ok: true, backend: 'fake-at-spi2' }),
    snapshot: async () => ({
      ok: true,
      backend: 'fake-at-spi2',
      nodes: [
        {
          path: '0/0',
          processId: 42,
          application: 'Demo',
          window: 'Demo',
          name: 'Ejecutar',
          role: 'button',
          states: ['visible', 'enabled'],
          depth: 0,
        },
        ...(completed
          ? [
              {
                path: '0/1',
                processId: 42,
                application: 'Demo',
                window: 'Demo',
                name: 'Completado',
                role: 'label',
                states: ['visible'],
                depth: 1,
              },
            ]
          : []),
      ],
    }),
    execute: async (action, target, input) => {
      completed = action === 'click';
      return {
        ok: true,
        executed: true,
        evidence: {
          name: target.name,
          role: target.role,
          valueLength: String(input.value || '').length,
        },
      };
    },
  };
  const automation = new DesktopAutomation({
    platform: 'linux',
    adapter,
    now: () => now,
    captureSources: async () => [
      {
        id: 'screen:0',
        name: 'Pantalla principal',
        thumbnail: {
          isEmpty: () => false,
          toJPEG: () => Buffer.from('imagen'),
        },
      },
    ],
  });

  const health = await automation.health();
  assert(health.ok, 'expone salud del backend nativo');
  const screenshot = await automation.screenshot({});
  assert(
    screenshot.dataUrl.startsWith('data:image/jpeg;base64,'),
    'captura pantalla para controles sin accesibilidad'
  );
  const pointer = await automation.pointerClick({ captureId: screenshot.captureId, x: 10, y: 10 });
  assert(
    pointer.executed && !pointer.intentVerified,
    'clic visual exige volver a observar su efecto'
  );
  await expectReject(
    () => automation.pointerClick({ captureId: screenshot.captureId, x: 10, y: 10 }),
    /obsoleta/,
    'una captura no puede reutilizarse después del clic'
  );
  const observed = await automation.snapshot({ application: 'Demo' });
  assert(observed.nodes[0].ref === 'ui-1', 'asigna referencias efímeras a elementos observados');
  const state = automation.getState({ observationId: observed.observationId, ref: 'ui-1' });
  assert(
    state.verified && state.node.name === 'Ejecutar',
    'consulta el estado ligado a una observación vigente'
  );
  const scrolled = await automation.execute('scroll', {
    observationId: observed.observationId,
    ref: 'ui-1',
    direction: 'down',
    amount: 2,
  });
  assert(
    scrolled.executed && !scrolled.intentVerified,
    'desplaza y exige una observación posterior'
  );
  const afterScroll = await automation.snapshot({ application: 'Demo' });
  const clicked = await automation.execute('click', {
    observationId: afterScroll.observationId,
    ref: 'ui-1',
    expected: { name: 'Completado', role: 'label' },
  });
  assert(
    clicked.intentVerified && clicked.status === 'completed',
    'verifica la postcondición tras actuar'
  );
  const waited = await automation.waitFor({
    application: 'Demo',
    expected: { name: 'Completado', role: 'label' },
    timeout: 500,
  });
  assert(waited.verified && waited.status === 'completed', 'espera y verifica una condición UI');
  await expectReject(
    () =>
      automation.execute('click', {
        observationId: afterScroll.observationId,
        ref: 'ui-1',
      }),
    /obsoleta/,
    'impide reutilizar una observación después de cambiar la interfaz'
  );

  completed = false;
  const expiring = await automation.snapshot({ application: 'Demo' });
  now += 61_000;
  await expectReject(
    () =>
      automation.execute('click', {
        observationId: expiring.observationId,
        ref: 'ui-1',
      }),
    /expiró/,
    'las referencias expiran para evitar acciones sobre estado antiguo'
  );

  const windows = await automation.listWindows({ application: 'Demo' });
  assert(
    windows.kind === 'window_list' && windows.nodes.length === 1,
    'lista ventanas observables'
  );

  console.log(`\nResultado: ${passed} passed · ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
