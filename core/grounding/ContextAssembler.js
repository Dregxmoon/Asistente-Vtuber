/**
 * ContextAssembler.js — Fase 2
 *
 * Orquesta la construcción del Context Package completo.
 * Reemplaza la serialización inline que estaba en GroundingEngine.
 *
 * Pipeline:
 *   1. Recibe: identity, osContext, retrievalResult, sessionHistory, currentMessage
 *   2. Ensambla el contextPackage normalizado
 *   3. Selecciona el serializer correcto según el provider activo
 *   4. Devuelve { systemPrompt, messages }
 *
 * CAMBIO: osContext ahora incluye `openWindowsSummary`, un string con
 * TODAS las ventanas/apps visibles abiertas (no solo la que tiene el foco),
 * generado por OSSensor.getOpenWindowsSummary(). Ej:
 *   "Visual Studio Code (OSSensor.js), Microsoft Edge (GitHub - Dregxmoon),
 *    Explorador de archivos, Discord"
 * Los serializers deben incluir esta línea en el system prompt para que
 * March pueda responder con precisión qué tiene abierto el usuario.
 */

const fs   = require('fs');
const path = require('path');

const { GroqSerializer }                     = require('./serializers/GroqSerializer.js');
const { GeminiSerializer, OpenAISerializer } = require('./serializers/GeminiOpenAISerializer.js');

// Mapa de serializers por provider
const SERIALIZERS = {
  groq:   new GroqSerializer(),
  gemini: new GeminiSerializer(),
  openai: new OpenAISerializer(),
};

// ── Cargar Identity ────────────────────────────────────────────────────────────
const IDENTITY_PATH = path.join(__dirname, '../identity/identity.json');
let _identity = null;

function getIdentity() {
  if (_identity) return _identity;
  try {
    _identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
  } catch(e) {
    _identity = { name: 'March 7th', core: 'Soy March 7th.' };
  }
  return _identity;
}

// ── OS Context formatter ───────────────────────────────────────────────────────
function buildOSContext(osSensor) {
  if (!osSensor) return _buildMinimalOSContext();

  const ctx = osSensor.getCurrentContext();
  const now = new Date();
  const hour = now.getHours();

  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';

  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

  return {
    time:             now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' }),
    date:             now.toLocaleDateString('es-MX',  { weekday:'long', day:'numeric', month:'long' }),
    timeOfDay,
    dayName:          days[now.getDay()],
    timeFormatted:    `Son las ${now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })} del ${days[now.getDay()]} por la ${timeOfDay}.`,
    platform:         process.platform,
    app:              ctx.app,
    friendlyName:     ctx.friendlyName,
    title:            ctx.title,
    category:         ctx.category,
    elapsed:          ctx.elapsed,
    elapsedFormatted: ctx.elapsedFormatted,
    // NUEVO: resumen de todas las ventanas/apps abiertas (OSSensor mejorado)
    openWindowsSummary: ctx.openWindowsSummary ?? null,
    todaySummary:     osSensor.getTodaySummary(),
  };
}

function _buildMinimalOSContext() {
  const now  = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';
  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  return {
    timeFormatted: `Son las ${now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })} del ${days[now.getDay()]} por la ${timeOfDay}.`,
    app: null, friendlyName: null, title: null, category: null,
    elapsed: 0, elapsedFormatted: '0s', openWindowsSummary: null, todaySummary: null,
  };
}

// ── ContextAssembler ──────────────────────────────────────────────────────────

class ContextAssembler {
  constructor() {
    this._osSensor = null;
  }

  /** Inyectar el OSSensor cuando esté disponible. */
  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  }

  /**
   * Construye y serializa el Context Package completo.
   *
   * @param {object} opts
   * @param {Array}  opts.sessionHistory  — historial de la sesión actual
   * @param {object} opts.retrievalResult — resultado de RetrievalPlanner.plan()
   * @param {string} opts.activeProvider  — 'groq' | 'gemini' | 'openai'
   * @returns {{ systemPrompt: string, messages: Array }}
   */
  build({ sessionHistory = [], retrievalResult = null, activeProvider = 'groq' }) {
    const identity = getIdentity();
    const osCtx    = buildOSContext(this._osSensor);

    // Separar mensaje actual del historial
    const history      = sessionHistory.slice(0, -1);
    const currentMsg   = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null;

    // Construir el context package normalizado
    const contextPackage = {
      identity,
      osContext: osCtx,
      persistentMemory: retrievalResult
        ? { nodes: retrievalResult.nodes, episodes: retrievalResult.episodeNodes }
        : { nodes: [], episodes: [] },
      sessionHistory: history,
      currentMessage: currentMsg,
    };

    // Seleccionar serializer
    const serializer = SERIALIZERS[activeProvider] || SERIALIZERS.groq;

    const result = serializer.serialize(contextPackage);

    console.log(`[context-assembler] provider=${activeProvider} systemPrompt=${result.systemPrompt.length}chars nodes=${retrievalResult?.nodes?.length ?? 0}`);

    return result;
  }

  /**
   * Versión simplificada para el handler IPC (sin sessionHistory completo).
   * Compatible con la firma de GroundingEngine.buildContext()
   */
  buildFromSession(sessionHistory = [], activeProvider = 'groq', retrievalResult = null) {
    return this.build({ sessionHistory, retrievalResult, activeProvider });
  }
}

module.exports = { ContextAssembler, buildOSContext };