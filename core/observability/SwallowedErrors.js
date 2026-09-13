// @ts-check
'use strict';

/**
 * SwallowedErrors.js — contador de `catch` silenciosos.
 *
 * El codebase tiene ~200 `catch (_) {}` vacíos: correctos como defensa (un
 * fallo en telemetría, un sensor o un fallback no debe tumbar el flujo),
 * pero invisibles en producción. Este módulo los hace visibles SIN cambiar
 * semántica: contar nunca lanza, nunca bloquea, no requiere logger (cero
 * dependencias → cero riesgo de ciclos de require).
 *
 * Uso: `catch (_) { swallow('DesktopControl._listLinuxApps'); }`
 * El scope lo pone el codemod (scripts/codemod-swallowed-errors.js) como
 * `archivo.función-o-bloque`; a mano basta un string estable cualquiera.
 * Lectura: `getStats()` en el reporte de telemetría mensual.
 */

/** @type {Record<string, number>} */
let _counts = {};
let _total = 0;
const MAX_SCOPES = 500;

/**
 * @param {unknown} scope etiqueta estable del sitio (p.ej. 'BrowserBridge._ensureBrowser')
 */
function swallow(scope) {
  try {
    const key = typeof scope === 'string' && scope ? scope.slice(0, 120) : 'unknown';
    _counts[key] = (_counts[key] || 0) + 1;
    _total += 1;
    if (Object.keys(_counts).length > MAX_SCOPES) {
      // No crecer sin cota si alguien pasa scopes dinámicos: colapsar la cola.
      let removed = false;
      for (const k of Object.keys(_counts)) {
        if (k.startsWith('__overflow')) {
          _counts[k] += 1;
          removed = true;
          break;
        }
      }
      if (!removed) _counts.__overflow = 1;
    }
  } catch (_) {
    // Contar nunca puede romper al llamador. Literalmente nunca.
  }
}

function getStats() {
  const byScope = Object.entries(_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);
  return { total: _total, scopes: byScope.length, byScope };
}

function reset() {
  _counts = {};
  _total = 0;
}

module.exports = { swallow, getStats, reset };
