/**
 * RetrievalPlanner.js — Fase 2
 *
 * Decide qué nodos del StateGraph son relevantes para el mensaje actual
 * ANTES de construir el context package.
 *
 * En lugar de pasar todo el World Model siempre (Fase 1),
 * el planner elige los nodos más relevantes para ESTE mensaje específico.
 *
 * Estrategia (sin embeddings, keyword-based):
 *   1. Extraer términos clave del mensaje
 *   2. Buscar nodos que coincidan en label o content
 *   3. Siempre incluir nodos User de alta importancia (nombre, trabajo, etc.)
 *   4. Incluir proyectos activos si el contexto OS lo sugiere
 *   5. Límite: ~8 nodos para no saturar el contexto
 */

// Keywords que mapean a tipos de búsqueda
const INTENT_PATTERNS = [
  { pattern: /\b(proyecto|project|trabajando en|working on|construyendo|building)\b/i, types: ['Project'] },
  { pattern: /\b(recuerdas|recuerda|dijiste|mencionaste|remember)\b/i,                types: ['Episode', 'Belief'] },
  { pattern: /\b(preferencia|gusta|favorito|like|prefer|odio|hate)\b/i,               types: ['Preference'] },
  { pattern: /\b(quién soy|mi nombre|cómo me llamo|who am i)\b/i,                     types: ['User'] },
  { pattern: /\b(código|programar|bug|error|función|función|debug|código)\b/i,         types: ['Project', 'Belief'] },
  { pattern: /\b(ayer|antes|última vez|last time|semana pasada|hace días)\b/i,         types: ['Episode'] },
];

class RetrievalPlanner {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Punto de entrada principal.
   * Dado el mensaje del usuario y el contexto OS, devuelve los nodos relevantes.
   *
   * @param {string} userMessage
   * @param {object} osContext — { app, category, elapsed, title }
   * @returns {{ nodes: Array, episodeNodes: Array, strategy: string }}
   */
  plan(userMessage = '', osContext = null) {
    if (!this._graph?._ready) {
      return { nodes: [], episodeNodes: [], strategy: 'fallback' };
    }

    const nodes        = [];
    const nodeIds      = new Set();
    const addNode      = (n) => { if (n && !nodeIds.has(n.id)) { nodeIds.add(n.id); nodes.push(n); } };
    const addAll       = (arr) => arr.forEach(addNode);

    // 1. Siempre incluir nodos User de alta importancia (nombre, trabajo, etc.)
    const coreUser = this._graph.queryNodes({ type: 'User', limit: 5 });
    addAll(coreUser);

    // 2. Detectar intención del mensaje y buscar nodos específicos
    const intents = this._detectIntents(userMessage);
    for (const type of intents) {
      const found = this._graph.queryNodes({ type, limit: 3 });
      addAll(found);
    }

    // 3. Búsqueda por keywords en el mensaje
    const keywords = this._extractKeywords(userMessage);
    for (const kw of keywords.slice(0, 4)) {
      const found = this._graph.queryNodes({ search: kw, limit: 2 });
      addAll(found);
    }

    // 4. Si el OS muestra código/terminal → priorizar proyectos activos
    if (osContext && ['code', 'terminal', 'api'].includes(osContext.category)) {
      const projects = this._graph.queryNodes({ type: 'Project', limit: 3 });
      addAll(projects);
    }

    // 5. Episodios recientes (siempre útiles para continuidad)
    const episodes = this._graph.getRecentEpisodes(4);

    // 6. Preferencias si el mensaje es conversacional
    if (!intents.length && userMessage.length < 80) {
      const prefs = this._graph.queryNodes({ type: 'Preference', limit: 2 });
      addAll(prefs);
    }

    // Ordenar por importancia y limitar
    const sortedNodes = nodes
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    const strategy = intents.length > 0
      ? `intent:${intents.join(',')}`
      : keywords.length > 0 ? `keywords:${keywords.slice(0,2).join(',')}` : 'default';

    console.log(`[retrieval] strategy=${strategy} nodes=${sortedNodes.length} episodes=${episodes.length}`);

    return {
      nodes:        sortedNodes,
      episodeNodes: episodes,
      strategy,
      keywords,
      intents,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _detectIntents(message) {
    const types = new Set();
    for (const { pattern, types: t } of INTENT_PATTERNS) {
      if (pattern.test(message)) t.forEach(type => types.add(type));
    }
    return [...types];
  }

  _extractKeywords(message) {
    if (!message) return [];

    // Limpiar y tokenizar
    const words = message
      .toLowerCase()
      .replace(/[¿?¡!.,;:()]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // Stopwords en español e inglés
    const stopwords = new Set([
      'para', 'como', 'que', 'esto', 'este', 'una', 'uno', 'con', 'por', 'pero',
      'más', 'muy', 'bien', 'todo', 'algo', 'hace', 'cuando', 'donde', 'quiero',
      'puedes', 'puedo', 'tengo', 'tienes', 'estar', 'tener', 'hacer', 'decir',
      'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when',
      'where', 'there', 'their', 'about', 'would', 'could', 'should',
    ]);

    return words.filter(w => !stopwords.has(w)).slice(0, 6);
  }
}

module.exports = { RetrievalPlanner };