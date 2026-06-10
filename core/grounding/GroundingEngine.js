/**
 * GroundingEngine.js — Fase 1
 *
 * Reemplaza GroundingMinimo.js. Construye el Context Package completo
 * que recibe el LLM en cada turno, ahora con memoria persistente.
 *
 * Diferencias con GroundingMinimo (Fase 0):
 *   - Incluye episodios pasados recuperados del StateGraph
 *   - Incluye el World Model (proyectos, preferencias, beliefs)
 *   - Serializa la memoria de forma inteligente dentro del context window
 *
 * En Fase 2 esto se expande con OS Sensor y Context Assembler completo.
 */

const fs   = require('fs');
const path = require('path');

// ── Identity Core ─────────────────────────────────────────────────────────────
const IDENTITY_PATH = path.join(__dirname, '../identity/identity.json');

let _identity = null;

function getIdentity() {
  if (_identity) return _identity;
  try {
    _identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
    console.log('[grounding] identity.json cargado');
  } catch(e) {
    console.error('[grounding] ERROR cargando identity.json:', e.message);
    _identity = { name: 'March 7th', core: 'Soy March 7th.' };
  }
  return _identity;
}

// ── OS Context ────────────────────────────────────────────────────────────────
function getOSContext() {
  const now  = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';

  const days    = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const dayName = days[now.getDay()];

  return {
    time:      now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    date:      now.toLocaleDateString('es-MX',  { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    platform:  process.platform,
    formatted: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} del ${dayName} por la ${timeOfDay}.`,
  };
}

// ── Serializers ───────────────────────────────────────────────────────────────

function serializeIdentity(identity) {
  const lines = [];
  lines.push('# QUIÉN SOY');
  lines.push(identity.core);
  lines.push('');

  if (identity.character) {
    lines.push('# CARÁCTER');
    lines.push(identity.character.summary);
    if (identity.character.traits?.length) {
      identity.character.traits.forEach(t => lines.push(`- ${t}`));
    }
    lines.push('');
  }

  if (identity.voice) {
    lines.push('# VOZ Y ESTILO');
    lines.push(identity.voice.style);
    if (identity.voice.forbidden_phrases?.length) {
      lines.push(`Nunca uso: ${identity.voice.forbidden_phrases.join(' | ')}`);
    }
    lines.push('');
  }

  if (identity.uncertainty_behaviors) {
    lines.push('# CUANDO NO SÉ ALGO');
    const ub = identity.uncertainty_behaviors;
    lines.push(`Sin saber: ${ub.doesnt_know?.description}`);
    lines.push(`Insegura: ${ub.is_unsure?.description}`);
    lines.push(`Equivocada: ${ub.was_wrong?.description}`);
    lines.push('');
  }

  if (identity.limits?.what_i_am_not?.length) {
    lines.push('# LO QUE NO SOY');
    identity.limits.what_i_am_not.forEach(l => lines.push(`- ${l}`));
    lines.push('');
  }

  return lines.join('\n');
}

function serializeWorkingMemory(history, maxTurns = 8) {
  if (!history?.length) return '';
  const recent = history.slice(-maxTurns);
  const lines  = ['# CONVERSACIÓN ACTUAL (esta sesión)'];
  recent.forEach(msg => {
    const role = msg.role === 'user' ? 'Usuario' : 'March';
    lines.push(`${role}: ${msg.content}`);
  });
  return lines.join('\n');
}

/**
 * Serializa la memoria persistente del StateGraph.
 * Límite: ~600 tokens para no saturar el context.
 */
function serializePersistentMemory(episodes, worldModel) {
  const lines = [];

  // World model: User, Projects, Preferences, Beliefs
  const users       = worldModel.filter(n => n.type === 'User');
  const projects    = worldModel.filter(n => n.type === 'Project');
  const preferences = worldModel.filter(n => n.type === 'Preference');
  const beliefs     = worldModel.filter(n => n.type === 'Belief');

  if (users.length) {
    lines.push('# LO QUE SÉ DEL USUARIO');
    users.forEach(n => lines.push(`- ${n.content}`));
    lines.push('');
  }

  if (projects.length) {
    lines.push('# PROYECTOS ACTIVOS');
    projects.slice(0, 5).forEach(n => lines.push(`- ${n.label.replace(/_/g,' ')}: ${n.content}`));
    lines.push('');
  }

  if (preferences.length) {
    lines.push('# PREFERENCIAS OBSERVADAS');
    preferences.slice(0, 5).forEach(n => lines.push(`- ${n.content}`));
    lines.push('');
  }

  if (beliefs.length) {
    lines.push('# LO QUE OBSERVO');
    beliefs.slice(0, 4).forEach(n => lines.push(`- ${n.content}`));
    lines.push('');
  }

  // Episodios pasados (los más recientes y relevantes)
  if (episodes.length) {
    lines.push('# SESIONES ANTERIORES (memoria episódica)');
    episodes.slice(0, 6).forEach(ep => {
      // Limpiar el label del timestamp para mostrarlo legible
      const content = ep.content.slice(0, 200);
      lines.push(`- ${content}`);
    });
    lines.push('');
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

// ── Grounding Engine ──────────────────────────────────────────────────────────

class GroundingEngine {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Construye el system prompt completo para un turno.
   * Es el único punto de entrada para el LLM.
   *
   * @param {Array}  sessionHistory - historial actual (sin el mensaje en curso)
   * @returns {string} system prompt
   */
  buildSystemPrompt(sessionHistory = []) {
    console.log("graph ready:", this._graph?._ready);
    const identity   = getIdentity();
    const os         = getOSContext();
    const sections   = [];

    // 1. Identidad (siempre, ~200 tokens)
    sections.push(serializeIdentity(identity));

    // 2. Contexto temporal
    sections.push('# CONTEXTO ACTUAL');
    sections.push(os.formatted);
    sections.push('');

    // 3. Memoria persistente (si el grafo está disponible)
    if (this._graph?._ready) {
      try {
        const episodes   = this._graph.getRecentEpisodes(20);
        const worldModel = this._graph.getWorldModel();
        const memSection = serializePersistentMemory(episodes, worldModel);
        if (memSection) sections.push(memSection);
      } catch(e) {
        console.warn('[grounding] error leyendo grafo:', e.message);
      }
    }

    // 4. Working memory (conversación actual)
    const wm = serializeWorkingMemory(sessionHistory, 8);
    if (wm) { sections.push(wm); sections.push(''); }

    // 5. Instrucción final
    sections.push('# INSTRUCCIÓN');
    sections.push(
      'Responde como March 7th. Sé concisa cuando el momento lo pide, más extensa cuando el tema lo merece. ' +
      'No uses las frases prohibidas. No te presentes a ti misma en cada mensaje. ' +
      'Si tienes memoria de conversaciones anteriores, úsala de forma natural (no la anuncies). ' +
      'Responde en el idioma en que te hablen.'
    );

    return sections.join('\n');
  }

  /**
   * Construye el Context Package completo para una llamada al LLM.
   * @param {Array} sessionHistory - historial completo incluyendo mensaje actual
   * @returns {{ messages: Array, systemPrompt: string }}
   */
  buildContext(sessionHistory = []) {
    const history      = sessionHistory.slice(0, -1);
    const current      = sessionHistory.slice(-1);
    const systemPrompt = this.buildSystemPrompt(history);
    const messages     = current.length > 0 ? current : [];
    return { messages, systemPrompt };
  }
}

// ── Fallback sin StateGraph (Fase 0 compatible) ───────────────────────────────
// Si se importa sin pasar stateGraph, funciona como GroundingMinimo
function buildContext(sessionHistory = []) {
  const engine = new GroundingEngine(null);
  return engine.buildContext(sessionHistory);
}

function getOSContextPublic() { return getOSContext(); }
function getIdentityPublic()  { return getIdentity();  }

module.exports = {
  GroundingEngine,
  buildContext,
  getOSContext: getOSContextPublic,
  getIdentity:  getIdentityPublic,
};