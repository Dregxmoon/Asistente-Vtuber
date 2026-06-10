/**
 * MarchCore.js — Fase 1
 *
 * Punto de inicialización central de March.
 * Conecta StateGraph + GroundingEngine + SessionManager.
 *
 * Uso en main.js:
 *
 *   const MarchCore = require('./core/MarchCore.js');
 *   MarchCore.init(app);          // al arrancar
 *   MarchCore.startSession();     // al abrir chat
 *   MarchCore.closeSession();     // al cerrar chat
 *   MarchCore.addTurn(role, txt); // después de cada mensaje
 *
 * El GroundingEngine ya viene con el StateGraph integrado.
 * chat.html sigue usando LLMProvider directamente, pero ahora
 * importa el GroundingEngine (Fase 1) en lugar de GroundingMinimo.
 */

const path   = require('path');
const { getStateGraph }   = require('./state-graph/StateGraph.js');
const { GroundingEngine } = require('./grounding/GroundingEngine.js');
const { SessionManager }  = require('./state-graph/SessionManager.js');

let _graph    = null;
let _grounding = null;
let _session   = null;
let _app       = null;

/**
 * Inicializa todos los subsistemas de March.
 * Llamar una vez al arrancar Electron.
 *
 * @param {object} app - Electron app object
 */
function init(app) {
  _app = app;

  // Path de la base de datos en userData (persiste entre reinicios)
  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);

  console.log('[march-core] inicializado');
  return { graph: _graph, grounding: _grounding, session: _session };
}

/** Inicia una sesión de chat. Llamar cuando se abre el chat. */
async function startSession() {
  if (!_session) {
    console.warn('[march-core] no inicializado, llamar init() primero');
    return null;
  }
  return _session.start(_app);
}

/** Cierra la sesión activa y dispara el análisis LLM. */
async function closeSession() {
  if (_session) await _session.close();
}



/** Construye el context package para el LLM. */
function buildContext(sessionHistory) {
  if (_grounding) return _grounding.buildContext(sessionHistory);
  // Fallback a GroundingMinimo si no está inicializado
  const Grounding = require('./llm/GroundingMinimo.js');
  return Grounding.buildContext(sessionHistory);
}

/** Stats para debug / tray menu. */
function getStats() {
  return _session?.getStats() ?? { error: 'no inicializado' };
}

/** Acceso directo al StateGraph (para queries avanzadas). */
function getGraph() { return _graph; }

module.exports = { init, startSession, closeSession, addTurn, buildContext, getStats, getGraph };