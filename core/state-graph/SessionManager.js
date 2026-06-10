/**
 * SessionManager.js — Fase 1 (fix: close() es awaitable)
 *
 * Bug anterior: close() disparaba el análisis LLM en background sin await.
 * Cuando la app se cerraba con before-quit, Node.js terminaba antes de que
 * el LLM respondiera y la DB nunca se escribía.
 *
 * Fix: close() retorna la Promise real. main.js hace await en before-quit,
 * dando tiempo al análisis LLM antes de salir.
 */

const { StateUpdater } = require('./StateUpdater.js');

const DECAY_INTERVAL_HOURS = 20;

class SessionManager {
  constructor(stateGraph, groundingEngine) {
    this._graph        = stateGraph;
    this._grounding    = groundingEngine;
    this._updater      = new StateUpdater(stateGraph);
    this._sessionId    = null;
    this._history      = [];
    this._turnCount    = 0;
    this._isClosing    = false;
    this._closePromise = null;
  }

  async start(app) {
    if (this._closePromise) {
      await this._closePromise.catch(() => {});
      this._closePromise = null;
    }
    this._sessionId = this._graph.startSession();
    this._history   = [];
    this._turnCount = 0;
    console.log(`[session] sesión ${this._sessionId} iniciada`);
    this._maybeRunDecay(app);
    return this._sessionId;
  }

  addTurn(role, content) {
    this._history.push({ role, content });
    this._turnCount++;
    if (this._history.length > 40) this._history = this._history.slice(-40);
  }

  getHistory() { return [...this._history]; }

  async close() {
    if (this._isClosing || !this._sessionId) return;
    this._isClosing = true;

    const sessionId = this._sessionId;
    const history   = [...this._history];
    const turnCount = this._turnCount;
    this._sessionId = null;

    console.log(`[session] cerrando sesión ${sessionId} (${turnCount} turnos)...`);

    this._closePromise = this._updater.processSession(sessionId, history, turnCount)
      .then(result => {
        console.log(`[session] memoria guardada: ${result.saved} nodos`);
      })
      .catch(err => {
        console.error('[session] error guardando memoria:', err.message);
        try { this._graph.endSession(sessionId, { turnCount, summary: null }); } catch(_) {}
      })
      .finally(() => { this._isClosing = false; });

    return this._closePromise;
  }

  _maybeRunDecay(app) {
    try {
      const fs   = require('fs');
      const path = require('path');
      const marker = app
        ? path.join(app.getPath('userData'), 'march_decay_marker.json')
        : null;
      if (!marker) { this._updater.runDecay(); return; }
      let lastRun = 0;
      if (fs.existsSync(marker)) {
        try { lastRun = JSON.parse(fs.readFileSync(marker, 'utf-8')).ts || 0; } catch(_) {}
      }
      const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
      if (hoursSince >= DECAY_INTERVAL_HOURS) {
        console.log('[session] corriendo decay diario...');
        this._updater.runDecay();
        fs.writeFileSync(marker, JSON.stringify({ ts: Date.now() }), 'utf-8');
      }
    } catch(e) { console.warn('[session] error en decay check:', e.message); }
  }

  getStats() {
    return {
      session:    this._sessionId,
      turns:      this._turnCount,
      historyLen: this._history.length,
      graph:      this._graph.getStats(),
    };
  }
}

module.exports = { SessionManager };