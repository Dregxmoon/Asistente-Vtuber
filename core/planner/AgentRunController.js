// @ts-check
'use strict';

const MAX_STEERING_QUEUE = 20;
const MAX_STEERING_CHARS = 4000;

const ACTIVE_STATES = new Set(['queued', 'running', 'awaiting_approval']);

/** @typedef {{phase:string|null,tool:string|null,status:string|null,iteration:number|null,at:number}} ProgressSummary */
/** @typedef {{done:number,total:number,steps:string[],kind:string|null,updatedAt:number}} PlanSummary */
/** @typedef {{text:string,at:number}} SteeringUpdate */
/** @typedef {{error:string|null,iterations:number,verification:string|null,resumable:boolean,resumePoint:any,evidence:any}} ResultSummary */

/**
 * Estado efímero y serializable de una ejecución del AgentLoop.
 *
 * La autorización sigue fuera de este objeto: el steering únicamente agrega
 * contexto al siguiente turno del loop. Nunca aprueba herramientas ni cambia
 * reglas de PermissionManager.
 */
class AgentRunController {
  /** @param {{runId:string, abortController?:AbortController, now?:()=>number}} opts */
  constructor({ runId, abortController = new AbortController(), now = Date.now }) {
    if (!runId || typeof runId !== 'string') throw new Error('runId requerido');
    this.runId = runId;
    this.abortController = abortController;
    this.signal = abortController.signal;
    this._now = now;
    this._state = 'queued';
    this._createdAt = now();
    this._startedAt = null;
    this._finishedAt = null;
    /** @type {ProgressSummary|null} */
    this._lastProgress = null;
    /** @type {PlanSummary|null} */
    this._plan = null;
    /** @type {SteeringUpdate[]} */
    this._steering = [];
    this._steeringAccepted = 0;
    this._steeringApplied = 0;
    /** @type {ResultSummary|null} */
    this._resultSummary = null;
  }

  start() {
    if (this._state !== 'queued') return false;
    this._state = 'running';
    this._startedAt = this._now();
    return true;
  }

  /** @param {Record<string, any>|null|undefined} progress */
  noteProgress(progress) {
    if (!progress || typeof progress !== 'object') return;
    const phase = String(progress.phase || '');
    if (phase === 'approval') this._state = 'awaiting_approval';
    else if (ACTIVE_STATES.has(this._state)) this._state = 'running';
    this._lastProgress = {
      phase: phase || null,
      tool: typeof progress.tool === 'string' ? progress.tool : null,
      status: typeof progress.status === 'string' ? progress.status : null,
      iteration: Number.isFinite(Number(progress.iteration)) ? Number(progress.iteration) : null,
      at: this._now(),
    };
  }

  /** @param {Record<string, any>|null|undefined} plan */
  notePlan(plan) {
    if (!plan || typeof plan !== 'object') return;
    /** @type {string[]} */
    const steps = Array.isArray(plan.steps)
      ? plan.steps.map((/** @type {unknown} */ step) => String(step).slice(0, 500)).slice(0, 50)
      : this._plan?.steps || [];
    this._plan = {
      done: Number(plan.done) || 0,
      total: Number(plan.total) || steps.length,
      steps,
      kind: typeof plan.kind === 'string' ? plan.kind : null,
      updatedAt: this._now(),
    };
  }

  /**
   * Encola una corrección del usuario para aplicarla entre iteraciones.
   * @param {unknown} text
   * @returns {{ok:boolean, reason?:string, queued?:number}}
   */
  steer(text) {
    if (!ACTIVE_STATES.has(this._state)) return { ok: false, reason: 'run_not_active' };
    const normalized = String(text || '')
      .trim()
      .slice(0, MAX_STEERING_CHARS);
    if (!normalized) return { ok: false, reason: 'empty_steering' };
    if (this._steering.length >= MAX_STEERING_QUEUE) {
      return { ok: false, reason: 'steering_queue_full' };
    }
    this._steering.push({ text: normalized, at: this._now() });
    this._steeringAccepted++;
    return { ok: true, queued: this._steering.length };
  }

  /** @returns {Array<{text:string,at:number}>} */
  consumeSteering() {
    if (!this._steering.length) return [];
    const updates = this._steering.splice(0, this._steering.length);
    this._steeringApplied += updates.length;
    return updates;
  }

  cancel() {
    if (!ACTIVE_STATES.has(this._state)) return false;
    this._state = 'cancelled';
    this.abortController.abort();
    return true;
  }

  /** @param {Record<string, any>|null|undefined} result */
  finish(result) {
    if (this._state !== 'cancelled') {
      if (result?.cancelled) this._state = 'cancelled';
      else if (result?.error) this._state = 'paused';
      else this._state = 'completed';
    }
    this._finishedAt = this._now();
    this._resultSummary = {
      error: result?.error ? String(result.error).slice(0, 300) : null,
      iterations: Number(result?.iterations) || 0,
      verification: result?.verify?.status ? String(result.verify.status) : null,
      resumable: this._state === 'paused' || this._state === 'cancelled',
      resumePoint: result?.execution?.resumePoint || null,
      evidence: result?.execution?.evidence || null,
    };
    if (result?.plan) this.notePlan(result.plan);
    return this.snapshot();
  }

  /** Estado seguro para IPC: no expone params, resultados ni contenido del steering. */
  snapshot() {
    return {
      runId: this.runId,
      state: this._state,
      active: ACTIVE_STATES.has(this._state),
      createdAt: this._createdAt,
      startedAt: this._startedAt,
      finishedAt: this._finishedAt,
      lastProgress: this._lastProgress ? { ...this._lastProgress } : null,
      plan: this._plan
        ? {
            done: this._plan.done,
            total: this._plan.total,
            kind: this._plan.kind,
            updatedAt: this._plan.updatedAt,
          }
        : null,
      steering: {
        queued: this._steering.length,
        accepted: this._steeringAccepted,
        applied: this._steeringApplied,
      },
      result: this._resultSummary ? { ...this._resultSummary } : null,
    };
  }
}

module.exports = { AgentRunController, ACTIVE_STATES };
