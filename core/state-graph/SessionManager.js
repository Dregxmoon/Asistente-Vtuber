/**
 * SessionManager.js — Fase 1
 *
 * Orquesta el ciclo de vida de una sesión de March:
 *   1. Al iniciar: abre sesión en DB, aplica decay diario si corresponde
 *   2. Durante: mantiene historial en memoria RAM
 *   3. Al cerrar: envía el historial al StateUpdater para extracción LLM
 *
 * Es el punto de integración entre chat.html y el StateGraph.
 * Se instancia una vez por proceso Electron.
 */

const { StateUpdater } = require('./StateUpdater.js');

// Cuántas horas mínimo entre ejecuciones de decay
const DECAY_INTERVAL_HOURS = 20;
const DECAY_LAST_RUN_KEY   = 'march_decay_last_run';

class SessionManager {
  constructor(stateGraph, groundingEngine) {
    this._graph    = stateGraph;
    this._grounding = groundingEngine;
    this._updater  = new StateUpdater(stateGraph);
    this._sessionId  = null;
    this._history    = [];
    this._turnCount  = 0;
    this._isClosing  = false;
  }

  /**
   * Inicia una nueva sesión. Llama esto cuando el chat se abre.
   * @param {object} app - Electron app (para userData path)
   */
  async start(app) {
    // Abrir sesión en DB
    this._sessionId = this._graph.startSession();
    this._history   = [];
    this._turnCount = 0;

    console.log(`[session] sesión ${this._sessionId} iniciada`);

    // Decay: correr una vez al día como máximo
    this._maybeRunDecay(app);

    return this._sessionId;
  }

  /**
   * Registra un turno de conversación.
   * @param {'user'|'assistant'} role
   * @param {string} content
   */
  addTurn(role, content) {
    this._history.push({ role, content });
    this._turnCount++;

    // Truncar historial en memoria para no crecer infinito
    // (el StateGraph se ocupa de la memoria a largo plazo)
    if (this._history.length > 40) {
      this._history = this._history.slice(-40);
    }
  }

  /** Retorna el historial actual de la sesión. */
  getHistory() {
    return [...this._history];
  }

  /**
   * Cierra la sesión y dispara el análisis LLM en background.
   * No bloquea — el análisis es async y no crítico.
   */
  async close() {
    if (this._isClosing || !this._sessionId) return;
    this._isClosing = true;

    const sessionId  = this._sessionId;
    const history    = [...this._history];
    const turnCount  = this._turnCount;

    console.log(`[session] cerrando sesión ${sessionId} (${turnCount} turnos)...`);

    // Análisis en background — no esperamos el resultado
    this._updater.processSession(sessionId, history, turnCount)
      .then(result => {
        console.log(`[session] memoria guardada: ${result.saved} nodos`);
      })
      .catch(err => {
        console.error('[session] error guardando memoria:', err.message);
        // Cerrar sesión sin análisis para no perder el registro
        this._graph.endSession(sessionId, { turnCount, summary: null });
      });

    this._sessionId = null;
    this._isClosing = false;
  }

  /** Ejecuta decay si no se ha corrido en las últimas DECAY_INTERVAL_HOURS horas. */
  _maybeRunDecay(app) {
    try {
      const fs     = require('fs');
      const path   = require('path');
      const marker = app
        ? path.join(app.getPath('userData'), 'march_decay_marker.json')
        : null;

      if (!marker) {
        this._updater.runDecay();
        return;
      }

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
    } catch(e) {
      console.warn('[session] error en decay check:', e.message);
    }
  }

  /** Stats del grafo para debug. */
  getStats() {
    return {
      session:   this._sessionId,
      turns:     this._turnCount,
      historyLen: this._history.length,
      graph:     this._graph.getStats(),
    };
  }
}

module.exports = { SessionManager };