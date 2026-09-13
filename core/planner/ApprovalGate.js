// @ts-check
'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');

/**
 * ApprovalGate.js — decisiones de aprobación por acción, fuera de AgentLoop.
 *
 * Extraído de AgentLoop (god file de 4.5k líneas): todo el flujo
 * permiso → irreversible → diff-preview → propuesta de tarea → scope →
 * card/timeout vive acá, con estado por-run (taskScope, propuesta, tool
 * expirada). AgentLoop solo recibe `{ proceed }` o un bloqueo con el mensaje
 * de historial y el toolResult ya armados.
 *
 * La política (qué es irreversible, qué cubre un scope) sigue en
 * core/security/ (IrreversiblePolicy, SessionApprovals, ToolPolicy): el gate
 * la APLICA, no la define.
 */

const logger = require('../observability/Logger.js');
const AP = require('./ActionParser.js');
const {
  isTaskScopeApproved,
  taskApprovalPattern,
  addApproval,
} = require('../security/SessionApprovals.js');
const { isIrreversible } = require('../security/IrreversiblePolicy.js');
const { MUTATOR_TOOLS } = require('../git/WorkspaceCheckpoint.js');
const { computeDiffPreview } = require('../git/FileDiff.js');

/**
 * @typedef {object} GateAction
 * @property {string} [tool]
 * @property {Record<string, unknown>} [params]
 * @property {unknown} [_diffPreview] vista previa calculada (se adjunta al pedir aprobación)
 */

/**
 * Deriva una propuesta de tarea `task:<tipo>:<destino>` desde tool+params.
 * Intencionalmente SIN parsear texto ni idioma: el destino ya viene
 * estructurado en los params (target/app/query/host). Devuelve null cuando la
 * acción no describe una tarea proponible (y el loop usa cards por clic).
 * @param {GateAction|null|undefined} action
 * @returns {{task: string, target: string, pattern: string}|null}
 */
function proposeTaskScope(action) {
  if (!action || typeof action.tool !== 'string') return null;
  const params = action.params && typeof action.params === 'object' ? action.params : {};
  /** @param {unknown} value @returns {string} */
  const str = (value) => String(value || '').trim();
  /** @type {[string, string]|null} */
  let kind = null;
  if (action.tool === 'launch_app' && str(params.app)) {
    kind = ['app-task', str(params.app)];
  } else if (action.tool === 'open_website' && str(params.target)) {
    kind = ['web-task', str(params.target).slice(0, 80)];
  } else if (action.tool === 'play_media' && str(params.query)) {
    kind = ['media-play', str(params.query).slice(0, 80)];
  } else if (action.tool === 'browser' && str(params.url)) {
    try {
      kind = ['web-task', new URL(str(params.url)).hostname];
    } catch (_) {
      kind = null;
    }
  } else if (['desktop_snapshot', 'window_list', 'desktop_screenshot'].includes(action.tool)) {
    kind = ['desktop-task', str(params.application || params.sourceName) || 'desktop'];
  }
  if (!kind) return null;
  const pattern = taskApprovalPattern(kind[0], kind[1]);
  if (!pattern) return null;
  return { task: kind[0], target: kind[1], pattern };
}

class ApprovalGate {
  /**
   * @param {{ metrics?: { trackApproval?: (approved: boolean) => void }|null }} [deps]
   */
  constructor(deps = {}) {
    this._metrics = deps.metrics || null;
    this.reset();
  }

  /** Estado por-run: se llama al arrancar cada run (incluidos subagentes). */
  reset() {
    this._taskScope = null;
    this._taskScopeProposed = false;
    this._approvalExpiredTool = null;
  }

  /** Tool cuya aprobación expiró en este run (para el aviso de cierre). */
  get approvalExpiredTool() {
    return this._approvalExpiredTool;
  }

  /** @param {boolean} approved */
  _track(approved) {
    try {
      if (this._metrics && typeof this._metrics.trackApproval === 'function') {
        this._metrics.trackApproval(approved);
      }
    } catch (_) {
      swallow('ApprovalGate._track');
    }
  }

  /**
   * Decide si una acción puede ejecutarse.
   * @param {{ action: GateAction, requiresApproval: boolean, permissionAction: string, opts?: { onApprovalNeeded?: Function, onTaskApprovalNeeded?: Function, taskScope?: string|null } }} input
   * @returns {Promise<{proceed: boolean, historyMessage?: string, toolResult?: {ok: boolean, error: string, tool?: string}}>}
   */
  async decide({ action, requiresApproval, permissionAction, opts = {} }) {
    // T13/T16: lo irreversible exige "sí" explícito SIEMPRE.
    let irreversible = false;
    try {
      irreversible = isIrreversible(action);
    } catch (_) {
      irreversible = false;
    }
    if (irreversible && permissionAction !== 'deny') permissionAction = 'ask';

    // Vista previa de diff ANTES de pedir aprobación (informada, no bloqueante).
    const toolName = typeof action.tool === 'string' ? action.tool : '';
    if (toolName && MUTATOR_TOOLS.has(toolName) && action._diffPreview === undefined) {
      try {
        action._diffPreview = computeDiffPreview({
          tool: toolName,
          params: action.params || {},
          cwd: AP.PROJECT_CWD,
        });
      } catch (e) {
        logger.warn(
          'ApprovalGate',
          `[approval-gate] falló el cálculo para ${action.tool}: ${e instanceof Error ? e.message : String(e)}`
        );
        action._diffPreview = null;
      }
    }

    // Propuesta de tarea completa, UNA vez por run.
    if (
      permissionAction === 'ask' &&
      requiresApproval &&
      !irreversible &&
      !this._taskScope &&
      !this._taskScopeProposed &&
      typeof opts.onTaskApprovalNeeded === 'function'
    ) {
      const proposal = proposeTaskScope(action);
      if (proposal) {
        this._taskScopeProposed = true;
        try {
          const scopeDecision = await opts.onTaskApprovalNeeded({
            ...proposal,
            firstAction: { tool: action.tool },
          });
          const scopeObj =
            scopeDecision !== null && typeof scopeDecision === 'object' ? scopeDecision : null;
          const scopeApproved = scopeObj ? Boolean(scopeObj.approved) : Boolean(scopeDecision);
          if (scopeApproved) {
            addApproval(proposal.pattern);
            this._taskScope = proposal.pattern;
            logger.info(
              'ApprovalGate',
              `[approval-gate] tarea aprobada de una vez: ${proposal.pattern}`
            );
          }
        } catch (e) {
          logger.warn(
            'ApprovalGate',
            `[approval-gate] propuesta de tarea falló: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }
    const effectiveTaskScope = this._taskScope || opts.taskScope || null;

    // Scope de tarea ya aprobado que cubre la acción → sin card.
    const taskScopeCovered =
      permissionAction === 'ask' &&
      requiresApproval &&
      isTaskScopeApproved(action, effectiveTaskScope);
    if (taskScopeCovered) {
      logger.info(
        'ApprovalGate',
        `[approval-gate] tool "${action.tool}" cubierta por scope de tarea ${effectiveTaskScope}`
      );
      this._track(true);
      return { proceed: true };
    }

    if (permissionAction === 'ask' && requiresApproval && opts.onApprovalNeeded) {
      const decision = await opts.onApprovalNeeded(action);
      const isObject = decision !== null && typeof decision === 'object';
      const isTimeout = isObject && decision.reason === 'timeout';
      const approved = isObject ? Boolean(decision.approved) : Boolean(decision);
      this._track(approved);
      if (!approved) {
        if (isTimeout) this._approvalExpiredTool = action.tool;
        return {
          proceed: false,
          historyMessage: isTimeout
            ? `[La herramienta "${action.tool}" NO se ejecutó: el tiempo de aprobación expiró sin tu respuesta — continúa sin ella o busca otra estrategia]`
            : `[Herramienta "${action.tool}" cancelada por el usuario — continúa sin ella o busca otra estrategia]`,
          toolResult: {
            ok: false,
            error: isTimeout ? 'aprobacion_expirada' : 'cancelada_por_usuario',
            tool: action.tool,
          },
        };
      }
      return { proceed: true };
    }

    if (requiresApproval && !opts.onApprovalNeeded && permissionAction !== 'allow') {
      return {
        proceed: false,
        historyMessage: `[Herramienta "${action.tool}" requiere aprobación pero no hay handler — BLOQUEADA. Continúa sin ella o informa que no puedes ejecutarla.]`,
        toolResult: { ok: false, error: 'sin_handler_aprobacion', tool: action.tool },
      };
    }

    return { proceed: true };
  }
}

module.exports = { ApprovalGate, proposeTaskScope };
