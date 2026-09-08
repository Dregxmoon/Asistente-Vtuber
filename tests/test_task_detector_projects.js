'use strict';

const { detect } = require('../core/task/TaskDetector.js');

const cases = [
  ['crea una landing sencilla', 'code'],
  ['crea un sitio para mi negocio', 'code'],
  ['haz una página web con un formulario', 'code'],
  ['crea una aplicación pequeña', 'code'],
  ['vacía la carpeta', 'filesystem'],
  ['elimina el contenido del directorio', 'filesystem'],
  ['borra todo lo que hay en esta carpeta', 'filesystem'],
  ['borra todo lo que hay en la carpeta y crea una landing sencilla', 'code'],
  ['ábreme youtube y busca un video de guitarra y reprodúcelo', 'web'],
  ['abre firefox', 'system'],
  ['ábreme steam', 'system'],
];

let failed = 0;
for (const [message, expectedDomain] of cases) {
  const result = detect(message);
  const actual = result.domain?.id || null;
  if (result.isTask && actual === expectedDomain) {
    console.log(`✓ ${message} → ${actual}`);
  } else {
    failed++;
    console.error(`✗ ${message} → ${actual}; esperado ${expectedDomain}`);
  }
}

console.log(`Resultado: ${cases.length - failed} passed  ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
