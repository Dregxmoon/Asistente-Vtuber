/**
 * MarchCore.js — Fase 1
 */

const path = require('path');
const fs   = require('fs');
const { getStateGraph }   = require('./state-graph/StateGraph.js');
const { GroundingEngine } = require('./grounding/GroundingEngine.js');
const { SessionManager }  = require('./state-graph/SessionManager.js');
const { StateUpdater }    = require('./state-graph/StateUpdater.js');
const LLMProvider         = require('./llm/LLMProvider.js');

let _graph     = null;
let _grounding = null;
let _session   = null;
let _updater   = null;
let _app       = null;

function init(app) {
  _app = app;

  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  _loadLLMConfig(app);

  console.log('[march-core] inicializado');
  return { graph: _graph, grounding: _grounding, session: _session };
}

function _loadLLMConfig(app) {
  try {
    const configPath = app
      ? path.join(app.getPath('userData'), 'config.json')
      : null;
    if (!configPath || !fs.existsSync(configPath)) {
      console.warn('[march-core] config.json no encontrado');
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg && cfg.llm) {
      LLMProvider.configure(cfg);
      console.log('[march-core] LLMProvider configurado para proceso main');
    }
  } catch(e) {
    console.warn('[march-core] error cargando config:', e.message);
  }
}

async function startSession() {
  if (!_session) { console.warn('[march-core] no inicializado'); return null; }
  return _session.start(_app);
}

async function closeSession() {
  if (_session) await _session.close();
}

function addTurn(role, content) {
  _session?.addTurn(role, content);
}

/**
 * Guardado inmediato por regex — sin LLM, sin tokens.
 * Llamar en cada mensaje del usuario desde main.js.
 */
function detectInstant(userMessage) {
  if (!_updater) return;
  _updater.detectAndSaveInstant(userMessage);
}

function buildContext(sessionHistory) {
  if (_grounding) return _grounding.buildContext(sessionHistory);
  const Grounding = require('./llm/GroundingMinimo.js');
  return Grounding.buildContext(sessionHistory);
}

function getStats() {
  return _session?.getStats() ?? { error: 'no inicializado' };
}

function getGraph() { return _graph; }

module.exports = { init, startSession, closeSession, addTurn, detectInstant, buildContext, getStats, getGraph }