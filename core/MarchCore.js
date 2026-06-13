/**
 * MarchCore.js — Fase 2
 *
 * Inicializa y conecta todos los subsistemas:
 *   StateGraph → GroundingEngine → SessionManager → StateUpdater
 *   OSSensor → EventBus → InitiativeEngine
 *
 * Nuevas responsabilidades vs Fase 1:
 *   - Arrancar OSSensor y conectarlo al GroundingEngine
 *   - Arrancar InitiativeEngine y conectarlo al EventBus
 *   - Exponer callback para cuando Initiative dispara (main.js lo escucha)
 */

const path = require('path');
const fs   = require('fs');

const { getStateGraph }   = require('./state-graph/StateGraph.js');
const { GroundingEngine } = require('./grounding/GroundingEngine.js');
const { SessionManager }  = require('./state-graph/SessionManager.js');
const { StateUpdater }    = require('./state-graph/StateUpdater.js');
const { OSSensor }        = require('../infrastructure/sensors/OSSensor.js');
const { getEventBus }     = require('../infrastructure/event-bus/EventBus.js');
const { InitiativeEngine }= require('./behavior/InitiativeEngine.js');
const LLMProvider         = require('./llm/LLMProvider.js');

let _graph      = null;
let _grounding  = null;
let _session    = null;
let _updater    = null;
let _osSensor   = null;
let _initiative = null;
let _bus        = null;
let _app        = null;

// Callback para enviar iniciativas al renderer (se registra desde main.js)
let _onInitiative = null;

function init(app) {
  _app = app;
  _bus = getEventBus();

  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  // Subsistemas base (Fase 1)
  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  // Subsistemas nuevos (Fase 2)
  _osSensor   = new OSSensor(_graph);
  _initiative = new InitiativeEngine(_graph);

  // Conectar OSSensor al GroundingEngine
  _grounding.setOSSensor(_osSensor);

  // Arrancar OSSensor solo en Windows (en otros OS es no-op)
  if (process.platform === 'win32') {
    _osSensor.start();
  } else {
    console.log('[march-core] OSSensor no disponible (no es Windows)');
  }

  // Escuchar iniciativas del InitiativeEngine
  _bus.on('initiative:trigger', (payload) => {
    console.log(`[march-core] initiative: "${payload.suggestion}"`);
    if (_onInitiative) _onInitiative(payload);
  });

  _loadLLMConfig(app);

  console.log('[march-core] inicializado (Fase 2)');
  return { graph: _graph, grounding: _grounding, session: _session };
}

/**
 * Registrar callback para iniciativas proactivas.
 * Lo llama main.js para recibir los mensajes y enviarlos al chat.
 *
 * @param {Function} cb — (payload) => void
 */
function onInitiative(cb) {
  _onInitiative = cb;
}

/**
 * Notificar al InitiativeEngine que el chat está abierto/cerrado.
 * Cuando el chat está abierto, no se disparan iniciativas.
 */
function setChatOpen(open) {
  _initiative?.setChatOpen(open);
}

function _loadLLMConfig(app) {
  try {
    const configPath = app
      ? path.join(app.getPath('userData'), 'config.json')
      : null;
    if (!configPath || !fs.existsSync(configPath)) return;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg?.llm) {
      LLMProvider.configure(cfg);
      console.log('[march-core] LLMProvider configurado');
    }
  } catch(e) {
    console.warn('[march-core] error cargando config:', e.message);
  }
}

async function startSession() {
  if (!_session) { console.warn('[march-core] no inicializado'); return null; }
  const id = await _session.start(_app);
  _bus.emit('session:started', { sessionId: id });
  return id;
}

async function closeSession() {
  if (_session) {
    await _session.close();
    _bus.emit('session:closed', { sessionId: null });
  }
}

function addTurn(role, content) {
  _session?.addTurn(role, content);
  _bus.emit('memory:turn-added', { role, content });
}

function detectInstant(userMessage) {
  if (!_updater) return;
  _updater.detectAndSaveInstant(userMessage);
}

/**
 * Construye el Context Package completo.
 * Ahora pasa el provider activo al GroundingEngine para elegir el serializer.
 */
function buildContext(sessionHistory) {
  const activeProvider = LLMProvider.getActiveProvider() || 'groq';

  if (_grounding) {
    return _grounding.buildContext(sessionHistory, activeProvider);
  }
  const Fallback = require('./llm/GroundingMinimo.js');
  return Fallback.buildContext(sessionHistory);
}

function getStats() {
  return {
    session:    _session?.getStats() ?? { error: 'no inicializado' },
    osSensor:   _osSensor?.getCurrentContext() ?? null,
    initiative: _initiative?.getStats() ?? null,
    eventBus:   _bus?.getActiveEvents() ?? {},
  };
}

function getGraph()     { return _graph;     }
function getOSSensor()  { return _osSensor;  }
function getEventBus_() { return _bus;       }

module.exports = {
  init,
  startSession,
  closeSession,
  addTurn,
  detectInstant,
  buildContext,
  getStats,
  getGraph,
  getOSSensor,
  getEventBus: getEventBus_,
  onInitiative,
  setChatOpen,
};