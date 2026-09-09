// @ts-check
'use strict';

const path = require('path');
const crypto = require('crypto');

// ── Aprobaciones "Siempre" de sesión (estilo opencode once/always/reject) ────
// El botón "Siempre" del card de aprobación registra un patrón aquí; mientras
// la sesión viva, cualquier action que matchee el patrón se auto-aprueba sin
// volver a mostrar el card. Se limpia al cerrar la ventana de chat
// (resetApprovals).

const _sessionApprovals = new Set();

/**
 * @typedef {object} ApprovalAction
 * @property {string} tool
 * @property {object} [params]
 * @property {string} [params.command]
 * @property {string} [params.path]
 * @property {string} [params.filePath]
 * @property {string} [params.app]
 * @property {string} [params.target]
 * @property {string} [params.url]
 * @property {string} [params.browser]
 * @property {string} [params.control]
 * @property {string} [params.query]
 * @property {string} [params.service]
 * @property {string} [params.action]
 * @property {string} [params.mode]
 * @property {string} [params.selector]
 * @property {string} [params.role]
 * @property {string} [params.name]
 * @property {string} [params.text]
 * @property {string} [params.label]
 * @property {string} [params.placeholder]
 * @property {string} [params.value]
 * @property {string} [params.key]
 * @property {string} [params.sessionId]
 * @property {string} [params.pageId]
 * @property {string} [params.expectedOrigin]
 * @property {string} [params.observationId]
 * @property {string} [params.ref]
 * @property {string} [params.application]
 * @property {object} [params.expected]
 * @property {string} [params.direction]
 * @property {number} [params.amount]
 * @property {string} [params.dialogAction]
 * @property {string} [params.expectedUrl]
 * @property {string} [params.sourceId]
 * @property {string} [params.sourceName]
 * @property {string} [params.captureId]
 * @property {number} [params.x]
 * @property {number} [params.y]
 * @property {number} [params.pid]
 * @property {object} [params.args]
 * @property {string} [params.args.path]
 * @property {string} [params.server]
 * @property {string} [params.tool]
 */

/**
 * Patrón de sesión para un action. Intenta ser lo más acotado posible:
 *  - mcp  → "mcp:<server>:<tool>" (p.ej. mcp:filesystem:write_file)
 *  - exec → prefijo del comando (2 primeros tokens, p.ej. "exec:git status")
 *  - path → "path:<directorio>" para tools con path (read/write/edit...)
 *  - resto → "tool:<tool>"
 * @param {ApprovalAction|null|undefined} action
 * @returns {string|null}
 */
function approvalPattern(action) {
  if (!action) return null;
  const tool = action.tool;
  const params = action.params || {};
  if (tool === 'mcp' && params.server && params.tool) {
    return `mcp:${params.server}:${params.tool}`;
  }
  if (tool === 'exec' && typeof params.command === 'string' && params.command.trim()) {
    return `exec:${params.command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  if (tool === 'launch_app' && typeof params.app === 'string' && params.app.trim()) {
    return `launch_app:${params.app.trim().toLowerCase()}`;
  }
  if (tool === 'open_website' && typeof params.target === 'string' && params.target.trim()) {
    const target = params.target.trim().toLowerCase();
    const control = params.control === 'managed' && !params.browser ? 'managed' : 'external';
    const browser = String(
      params.browser || (control === 'managed' ? 'kaoru' : 'default')
    ).toLowerCase();
    try {
      return `open_website:${control}:${browser}:${new URL(target).hostname}`;
    } catch (_) {
      return `open_website:${control}:${browser}:${target}`;
    }
  }
  if (tool === 'play_media' && typeof params.query === 'string' && params.query.trim()) {
    const service = String(params.service || 'youtube')
      .trim()
      .toLowerCase();
    const query = params.query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    const control = params.control === 'external' ? 'external' : 'managed';
    const browser = String(params.browser || 'kaoru').toLowerCase();
    return `play_media:${control}:${browser}:${service}:${query}`;
  }
  if (tool === 'ui_wait') {
    const application = String(params.application || 'all')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
    const expectedFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(params.expected || {}))
      .digest('hex')
      .slice(0, 16);
    return `ui_wait:${application}:${expectedFingerprint}`;
  }
  if (tool === 'desktop_snapshot' || tool === 'desktop_screenshot' || tool === 'window_list') {
    const application = String(params.application || params.sourceId || params.sourceName || 'all')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
    return `${tool}:${application}`;
  }
  if (tool === 'pointer_click') {
    if (!params.captureId) return null;
    return `pointer_click:${params.captureId}:${Number(params.x) || 0}:${Number(params.y) || 0}`;
  }
  if (tool === 'process_stop') {
    const pid = Number(params.pid);
    return Number.isInteger(pid) && pid > 1 ? `process_stop:${pid}` : null;
  }
  if (tool === 'process_list') {
    const query = String(params.query || '')
      .trim()
      .toLowerCase()
      .slice(0, 80);
    return `process_list:${query || 'all'}`;
  }
  if (tool === 'desktop_capabilities' || tool === 'camera_status' || tool === 'open_camera') {
    return tool;
  }
  if (
    [
      'window_focus',
      'ui_get_state',
      'ui_click',
      'ui_type',
      'ui_press',
      'ui_select',
      'ui_scroll',
      'window_close',
    ].includes(tool)
  ) {
    if (!params.observationId || !params.ref) return null;
    const valueFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          value: params.value || '',
          key: params.key || '',
          direction: params.direction || '',
          amount: Number(params.amount) || 0,
        })
      )
      .digest('hex')
      .slice(0, 16);
    return `${tool}:${params.observationId}:${params.ref}:${valueFingerprint}`;
  }
  if (tool === 'browser') {
    const action = String(params.action || 'navigate').toLowerCase();
    const mode = params.mode === 'managed' ? 'managed' : 'background';
    if (action === 'navigate' && typeof params.url === 'string') {
      try {
        return `browser:${mode}:navigate:${new URL(params.url).hostname}`;
      } catch (_) {}
    }
    if (action === 'new_tab' && typeof params.url === 'string') {
      try {
        return `browser:${mode}:new_tab:${new URL(params.url).hostname}`;
      } catch (_) {}
    }
    const scopedActions = new Set([
      'click',
      'type',
      'press',
      'back',
      'forward',
      'select',
      'check',
      'uncheck',
      'hover',
      'scroll',
      'close_tab',
      'select_tab',
      'get_text',
      'wait_for',
      'screenshot',
      'upload',
      'download',
      'dialog',
    ]);
    if (
      scopedActions.has(action) &&
      (!params.sessionId || !params.pageId || !params.expectedOrigin)
    ) {
      return null;
    }
    const target =
      [params.selector, params.role, params.name, params.text, params.label, params.placeholder]
        .filter((value) => typeof value === 'string' && value.trim())
        .join('|') || 'page';
    const normalizedTarget = String(target).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    const valueFingerprint = crypto
      .createHash('sha256')
      .update(
        [params.value, params.key, params.path, params.dialogAction, params.expectedUrl]
          .filter((value) => value !== undefined)
          .join('|')
      )
      .digest('hex')
      .slice(0, 16);
    const scope = [params.sessionId, params.pageId, params.expectedOrigin]
      .filter(Boolean)
      .join(':');
    return `browser:${mode}:${scope}:${action}:${normalizedTarget}:${valueFingerprint}`;
  }
  const p = params.path || params.filePath || (params.args && params.args.path);
  if (typeof p === 'string' && p.trim()) {
    try {
      return `path:${path.dirname(p)}`;
    } catch (_) {
      return `tool:${tool}`;
    }
  }
  return `tool:${tool}`;
}

/** @param {string|null} pattern */
function isApproved(pattern) {
  return Boolean(pattern) && _sessionApprovals.has(pattern);
}

/** @param {string|null} pattern */
function addApproval(pattern) {
  if (pattern) _sessionApprovals.add(pattern);
}

function resetApprovals() {
  _sessionApprovals.clear();
}

module.exports = { approvalPattern, isApproved, addApproval, resetApprovals };
