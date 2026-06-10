/**
 * StateUpdater.js — Fase 1
 *
 * Analiza el historial de sesión con una llamada LLM y extrae
 * lo que vale la pena recordar entre sesiones.
 *
 * March decide qué es memorable — no un algoritmo ciego.
 *
 * Flujo:
 *   1. Al cerrar sesión, se envía el historial completo al LLM
 *   2. El LLM responde con JSON estructurado: nodos a crear/actualizar
 *   3. StateUpdater escribe esos nodos al StateGraph
 *   4. Se crea un nodo Episode que resume la sesión
 */

const LLMProvider = require('../llm/LLMProvider.js');

// ── Prompt de extracción ──────────────────────────────────────────────────────
const EXTRACTION_SYSTEM = `Eres el sistema de memoria de March 7th, una entidad digital persistente.
Tu tarea es analizar una conversación y extraer lo que VALE LA PENA RECORDAR a largo plazo.

Sé selectivo. No todo merece ser recordado. Prioriza:
- Información sobre el usuario (nombre, trabajo, proyectos, preferencias)
- Eventos significativos mencionados
- Cosas que el usuario dijo explícitamente que son importantes
- Cambios de estado (proyecto terminado, problema resuelto, decisión tomada)

IGNORA:
- Saludos y despedidas genéricas
- Preguntas triviales
- Cosas que el usuario probablemente ya no recordará tampoco

Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin backticks, sin explicaciones:

{
  "episode_summary": "Resumen breve de la sesión en 1-2 oraciones. Si fue trivial, escribe null.",
  "episode_importance": 0.0 a 1.0,
  "nodes": [
    {
      "type": "User|Episode|Belief|Preference|Project",
      "label": "etiqueta corta única (ej: 'nombre_usuario', 'proyecto_march7th')",
      "content": "contenido detallado de lo que hay que recordar",
      "importance": 0.0 a 1.0,
      "tags": ["tag1", "tag2"]
    }
  ]
}

Tipos de nodo:
- User: información sobre quién es el usuario
- Episode: algo que ocurrió en esta sesión específica  
- Belief: algo que March observa/concluye sobre el usuario
- Preference: preferencias observadas (herramientas, horarios, estilos)
- Project: proyectos activos mencionados

Si la conversación no tiene nada memorable, devuelve nodes: [] y episode_summary: null.`;

// ── StateUpdater ──────────────────────────────────────────────────────────────
class StateUpdater {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Procesa una sesión terminada y escribe la memoria al grafo.
   *
   * @param {number} sessionId - ID de la sesión en DB
   * @param {Array}  history   - [{role, content}] historial completo
   * @param {number} turnCount - número de turnos de la sesión
   * @returns {Promise<object>} resultado del procesamiento
   */
  async processSession(sessionId, history, turnCount) {
    if (!history || history.length < 2) {
      console.log('[state-updater] sesión muy corta, nada que guardar');
      this._graph.endSession(sessionId, { turnCount, summary: null });
      return { saved: 0, skipped: true };
    }

    console.log(`[state-updater] analizando sesión (${history.length} mensajes)...`);

    let extracted;
    try {
      extracted = await this._extractMemories(history);
    } catch(e) {
      console.error('[state-updater] error en extracción LLM:', e.message);
      // Fallback: guardar resumen básico sin LLM
      this._graph.endSession(sessionId, {
        turnCount,
        summary: `Sesión de ${turnCount} turnos (sin análisis)`,
      });
      return { saved: 0, error: e.message };
    }

    // Escribir nodos al grafo
    let saved = 0;
    const nodeIds = [];

    for (const node of (extracted.nodes || [])) {
      try {
        if (!node.type || !node.label || !node.content) continue;

        const id = this._graph.upsertNode({
          type:       node.type,
          label:      node.label.toLowerCase().replace(/\s+/g, '_').slice(0, 80),
          content:    node.content,
          importance: Math.min(1.0, Math.max(0.1, node.importance ?? 0.6)),
          tags:       Array.isArray(node.tags) ? node.tags : [],
        });

        nodeIds.push(id);
        saved++;
      } catch(e) {
        console.warn('[state-updater] error guardando nodo:', e.message);
      }
    }

    // Crear nodo Episode para esta sesión si tiene resumen
    let episodeId = null;
    if (extracted.episode_summary) {
      const epImportance = Math.min(1.0, Math.max(0.1, extracted.episode_importance ?? 0.5));
      const dateStr      = new Date().toLocaleDateString('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long'
      });

      episodeId = this._graph.createNode({
        type:       'Episode',
        label:      `sesion_${Date.now()}`,
        content:    `[${dateStr}] ${extracted.episode_summary}`,
        importance: epImportance,
        tags:       ['sesion', 'auto'],
      });
    }

    // Cerrar la sesión en DB
    this._graph.endSession(sessionId, {
      turnCount,
      summary:   extracted.episode_summary,
      episodeId,
    });

    console.log(`[state-updater] guardados: ${saved} nodos, episodio: ${episodeId ? 'sí' : 'no'}`);
    return { saved, episodeId, nodeIds };
  }

  /**
   * Llama al LLM para extraer memorias del historial.
   * @private
   */
  async _extractMemories(history) {
    // Serializar el historial de forma compacta
    const conversation = history.map(m => {
      const role = m.role === 'user' ? 'Usuario' : 'March';
      return `${role}: ${m.content}`;
    }).join('\n');

    const userMessage = `Analiza esta conversación y extrae lo que vale la pena recordar:\n\n${conversation}`;

    const rawResponse = await LLMProvider.complete(
      [{ role: 'user', content: userMessage }],
      EXTRACTION_SYSTEM
    );

    // Parsear JSON de forma robusta
    return this._parseJSON(rawResponse);
  }

  /**
   * Parsea JSON de la respuesta del LLM de forma tolerante.
   * @private
   */
  _parseJSON(raw) {
    // Intentar parsear directo
    try {
      return JSON.parse(raw.trim());
    } catch(_) {}

    // Buscar JSON dentro del texto (por si el LLM añadió texto extra)
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch(_) {}
    }

    // Fallback seguro
    console.warn('[state-updater] no se pudo parsear respuesta LLM, usando fallback');
    return { episode_summary: null, episode_importance: 0, nodes: [] };
  }

  /**
   * Aplica decay diario al grafo.
   * Llamar una vez al día o al iniciar la app.
   */
  runDecay() {
    this._graph.applyDecay();
  }
}

module.exports = { StateUpdater };