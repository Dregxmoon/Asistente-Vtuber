/**
 * MarchCore.js — Fase 1
 *
 * Fix: init() ahora carga las API keys en LLMProvider para que
 * StateUpdater pueda usarlas al analizar la sesión en background.
 */

const path = require('path');
const fs   = require('fs');
const { getStateGraph }   = require('./state-graph/StateGraph.js');
const { GroundingEngine } = require('./grounding/GroundingEngine.js');
const { SessionManager }  = require('./state-graph/SessionManager.js');
const LLMProvider         = require('./llm/LLMProvider.js');

let _graph     = null;
let _grounding = null;
let _session   = null;
let _app       = null;

/**
 * Inicializa todos los subsistemas de March.
 * Llamar una vez al arrancar Electron, después de ensureLLMConfig().
 */
function init(app) {
  _app = app;

  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);

  // Cargar las API keys en LLMProvider para que StateUpdater las tenga
  // disponibles al analizar la sesión en before-quit (proceso main, no renderer)
  _loadLLMConfig(app);

  console.log('[march-core] inicializado');
  return { graph: _graph, grounding: _grounding, session: _session };
}

/**
 * Carga config.json y configura LLMProvider en el proceso main.
 * Sin esto, StateUpdater no tiene keys y falla al analizar sesiones.
 * @private
 */
function _loadLLMConfig(app) {
  try {
    const configPath = app
      ? path.join(app.getPath('userData'), 'config.json')
      : null;

    if (!configPath || !fs.existsSync(configPath)) {
      console.warn('[march-core] config.json no encontrado, StateUpdater sin keys');
      return;
    }

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg && cfg.llm) {
      LLMProvider.configure(cfg);
      console.log('[march-core] LLMProvider configurado para proceso main');
    }
  } catch(e) {
    console.warn('[march-core] error cargando config para LLMProvider:', e.message);
  }
}

/** Inicia una sesión de chat. Llamar cuando se abre el chat. */
async function startSession() {
  if (!_session) {
    console.warn('[march-core] no inicializado, llamar init() primero');
    return null;
  }
  return _session.start(_app);
}

/** Cierra la sesión activa y espera que el análisis LLM termine. */
async function closeSession() {
  if (_session) await _session.close();
}

/** Registra un turno para el historial de la sesión. */
function addTurn(role, content) {
  _session?.addTurn(role, content);
}

/** Construye el context package para el LLM. */
function buildContext(sessionHistory) {
  if (_grounding) return _grounding.buildContext(sessionHistory);
  const Grounding = require('./llm/GroundingMinimo.js');
  return Grounding.buildContext(sessionHistory);
}

/** Stats para debug. */
function getStats() {
  return _session?.getStats() ?? { error: 'no inicializado' };
}

/** Acceso directo al StateGraph. */
function getGraph() { return _graph; }

module.exports = { init, startSession, closeSession, addTurn, buildContext, getStats, getGraph };