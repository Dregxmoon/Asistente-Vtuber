'use strict';

// Fase A4 — TaskDetector debe reconocer tareas de escritorio/apps aunque el
// destino NO esté en la lista fija de aliases, y no debe confundir "lanza/
// inicia/arranca una app" con "ejecuta un comando de shell" solo por
// compartir el verbo (bug real: antes SHELL tenía un catch-all de esos
// verbos sin exigir objeto, con peso 8 > SYSTEM peso 7).

const TaskDetector = require('../core/task/TaskDetector.js');

let passed = 0;
let failed = 0;

function assertDomain(text, expectedDomainId, label) {
  const result = TaskDetector.detect(text);
  const actual = result.domain && result.domain.id;
  const ok = actual === expectedDomainId;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${label || text}`);
    passed++;
  } else {
    console.log(
      `  \x1b[31m✗\x1b[0m ${label || text} — esperado "${expectedDomainId}", obtuvo "${actual}" (isTask=${result.isTask})`
    );
    failed++;
  }
}

function assertIsTask(text, label) {
  const result = TaskDetector.detect(text);
  const ok = result.isTask === true;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${label || text}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label || text} — isTask=${result.isTask}`);
    failed++;
  }
}

console.log('\x1b[1m\n════ TaskDetector — dominio desktop genérico (Fase A4) ════\x1b[0m');

console.log('\n── Caso guía: apps NO predefinidas se reconocen como system ──');
assertDomain(
  'abre mi libreoffice writer y escribe un ensayo sobre la conquista de américa',
  'system',
  'caso guía completo del plan de autonomía'
);
assertDomain('abre libreoffice writer', 'system');
assertDomain('lanza el juego de ajedrez', 'system');
assertDomain('inicia blender', 'system');

console.log('\n── Bug corregido: "lanza/inicia/arranca" ya no se confunde con shell ──');
assertDomain(
  'abre steam y lanza el juego de ajedrez',
  'system',
  'antes se clasificaba como shell (peso 8 > 7) por el catch-all genérico'
);

console.log('\n── Los alias fijos existentes siguen funcionando (no regresión) ──');
assertDomain('abre firefox', 'system');
assertDomain('ábreme steam', 'system');

console.log('\n── El shell real sigue detectándose bien ──');
assertDomain('ejecuta un comando en la terminal', 'shell');
assertDomain('corre este script de python', 'shell');
assertDomain('npm install express', 'shell');

console.log('\n── Dominios más específicos con más peso siguen ganando ──');
assertDomain(
  'abre el archivo de configuración',
  'filesystem',
  'archivo sigue siendo filesystem, no system'
);
assertDomain(
  'ábreme youtube',
  'web',
  'sitio conocido sigue siendo web, no system (empate resuelto a favor de web)'
);

console.log('\n── Sigue siendo una tarea real (no cae a chat) ──');
assertIsTask('abre mi libreoffice writer y escribe un ensayo sobre la conquista de américa');

console.log(`\nResultado: ${passed} passed  ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
