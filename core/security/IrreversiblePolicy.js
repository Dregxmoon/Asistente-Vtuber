// @ts-check
'use strict';

/**
 * IrreversiblePolicy.js — acciones que NUNCA fluyen solas, ni con aprobación
 * por tarea ni con autoApprove global. Comprar, pagar, suscribirse con cargo,
 * borrar datos o publicar exigen un "sí" explícito del humano, siempre.
 *
 * Es determinista (regex sobre tool+params, sin LLM) y conservadora: ante la
 * duda NO marca (el flujo normal ya pide aprobación para alto impacto). Lo que
 * sí hace es IMPEDIR que un scope de tarea o un autoApprove global silencien
 * estas acciones.
 */

// Texto visible de botones/enlaces/inputs que implica dinero o compromiso.
const MONEY_TEXT_RE =
  /\b(comprar|comprar ahora|buy now|place (your )?order|realizar pedido|confirmar (compra|pedido|pago)|pagar|pagar ahora|pay (now)?|checkout|suscribir|subscribe|pago|payment|donar|donate)\b/i;

// Rutas que implican transacción, borrado o publicación.
const MONEY_URL_RE =
  /\/(checkout|buy|pay|payment|order|subscription|subscribe|billing|delete-account|publish)\b/i;

// Comandos destructivos que ni el autoApprove puede tragar.
const DESTRUCTIVE_COMMAND_RE =
  /\brm\s+-rf?\b|\bdel\s+\/[sqf]|\bformat\b|\bshutdown\b|\breboot\b|\bmkfs\b|:\(\)\s*{\s*:\|:\s*&\s*}\s*;/i;

/** @param {unknown} value @returns {string} */
function _str(value) {
  return String(value || '');
}

/**
 * @param {{tool?: string, params?: Record<string, unknown>}|null|undefined} [action]
 * @returns {boolean} true = exige confirmación humana explícita siempre
 */
function isIrreversible(action) {
  if (!action || typeof action.tool !== 'string') return false;
  const params = action.params && typeof action.params === 'object' ? action.params : {};
  const str = _str;

  if (action.tool === 'browser') {
    const haystack = [
      params.text,
      params.name,
      params.label,
      params.selector,
      params.url,
      params.expectedUrl,
    ]
      .map(str)
      .join(' ');
    if (MONEY_TEXT_RE.test(haystack) || MONEY_URL_RE.test(str(params.url))) return true;
    return false;
  }
  if (action.tool === 'open_website') {
    // Abrir no compra; pero abrir DIRECTO una URL de checkout merece aviso.
    return MONEY_URL_RE.test(str(params.target));
  }
  if (action.tool === 'exec') {
    return DESTRUCTIVE_COMMAND_RE.test(str(params.command));
  }
  if (action.tool === 'process_stop') return true;
  if (
    action.tool === 'mcp' ||
    (typeof action.tool === 'string' && action.tool.startsWith('plugin.'))
  ) {
    const blob = JSON.stringify(params.args || params || {});
    return MONEY_TEXT_RE.test(blob);
  }
  return false;
}

module.exports = { isIrreversible };
