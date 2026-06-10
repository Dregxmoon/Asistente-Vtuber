/**
 * StateGraph.js — Fase 1
 *
 * Interfaz pública del grafo de memoria de March.
 * Gestiona nodos con decay automático, relevancia y consolidación.
 *
 * Tipos de nodo:
 *   User     — quién es el usuario (nombre, preferencias globales)
 *   Episode  — evento específico con timestamp (ephémero, decae)
 *   Belief   — algo que March cree sobre el usuario o el mundo
 *   Preference — preferencias observadas (herramienta, horario, estilo)
 *   Project  — proyectos activos del usuario
 *
 * Principio: el decay es obligatorio desde el primer nodo.
 * Un grafo sin decay es un cementerio.
 */

const path = require('path');
const fs   = require('fs');

// ── SQLite con better-sqlite3 ─────────────────────────────────────────────────
// Si better-sqlite3 no está disponible, usar fallback en memoria (dev mode)
let Database;
try {
  Database = require('better-sqlite3');
} catch(e) {
  console.warn('[state-graph] better-sqlite3 no disponible, usando modo memoria');
  Database = null;
}

// ── Constantes ────────────────────────────────────────────────────────────────
const NODE_TYPES = ['User', 'Episode', 'Belief', 'Preference', 'Project'];

// Decay: qué tanto pierde importancia un nodo por día según su tipo
const DECAY_RATES = {
  User:       0.005,  // casi permanente
  Episode:    0.08,   // decae en semanas
  Belief:     0.02,   // decae lento
  Preference: 0.01,   // muy persistente
  Project:    0.03,   // decae en meses si no se toca
};

// Umbral mínimo de importancia antes de archivar un nodo
const ARCHIVE_THRESHOLD = 0.05;

// ── DB en memoria como fallback ───────────────────────────────────────────────
class MemoryDB {
  constructor() {
    this._nodes = new Map();
    this._nextId = 1;
  }
  prepare(sql) {
    const db = this;
    return {
      run:  (...args) => ({ lastInsertRowid: db._nextId++ }),
      get:  (...args) => undefined,
      all:  (...args) => [],
    };
  }
  exec() {}
  transaction(fn) { return fn; }
  pragma() {}
  close() {}
}

// ── StateGraph ────────────────────────────────────────────────────────────────
class StateGraph {
  constructor(dbPath) {
    this._dbPath = dbPath;
    this._db     = null;
    this._ready  = false;
  }

  /**
   * Inicializa la base de datos y crea las tablas si no existen.
   * Debe llamarse antes de cualquier operación.
   */
  init() {
    if (this._ready) return this;

    try {
      if (Database) {
        const dir = path.dirname(this._dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this._db = new Database(this._dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('foreign_keys = ON');
      } else {
        this._db = new MemoryDB();
      }

      this._createSchema();
      this._ready = true;
      console.log('[state-graph] inicializado:', this._dbPath);
    } catch(e) {
      console.error('[state-graph] error init:', e.message);
      this._db = new MemoryDB();
      this._createSchema();
      this._ready = true;
    }

    return this;
  }

  _createSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL CHECK(type IN ('User','Episode','Belief','Preference','Project')),
        label       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        importance  REAL    NOT NULL DEFAULT 1.0,
        decay_rate  REAL    NOT NULL DEFAULT 0.05,
        access_count INTEGER NOT NULL DEFAULT 0,
        tags        TEXT    DEFAULT '[]',
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type       ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_importance ON nodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_archived   ON nodes(archived);
      CREATE INDEX IF NOT EXISTS idx_nodes_created    ON nodes(created_at DESC);

      CREATE TABLE IF NOT EXISTS node_relations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        to_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        rel_type  TEXT    NOT NULL,
        weight    REAL    NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        UNIQUE(from_id, to_id, rel_type)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_from ON node_relations(from_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to   ON node_relations(to_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        summary    TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        episode_id INTEGER REFERENCES nodes(id)
      );
    `);
  }

  // ── CRUD de nodos ───────────────────────────────────────────────────────────

  /**
   * Crea un nuevo nodo en el grafo.
   * @param {object} opts - { type, label, content, importance?, tags? }
   * @returns {number} id del nodo creado
   */
  createNode({ type, label, content, importance = 1.0, tags = [] }) {
    if (!NODE_TYPES.includes(type)) throw new Error(`Tipo inválido: ${type}`);
    const now = Date.now();
    const stmt = this._db.prepare(`
      INSERT INTO nodes (type, label, content, importance, decay_rate, tags, created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      type, label, content, importance,
      DECAY_RATES[type],
      JSON.stringify(tags),
      now, now, now
    );
    return result.lastInsertRowid;
  }

  /**
   * Actualiza el contenido o importancia de un nodo.
   * También resetea la importancia hacia arriba (el acceso refuerza el nodo).
   */
  updateNode(id, { content, label, importance, tags } = {}) {
    const now  = Date.now();
    const node = this.getNode(id);
    if (!node) return false;

    const newImportance = importance ?? Math.min(1.0, node.importance + 0.2);
    const newContent    = content  ?? node.content;
    const newLabel      = label    ?? node.label;
    const newTags       = tags     ?? JSON.parse(node.tags || '[]');

    this._db.prepare(`
      UPDATE nodes SET content=?, label=?, importance=?, tags=?, updated_at=?, last_accessed_at=?, access_count=access_count+1
      WHERE id=?
    `).run(newContent, newLabel, newImportance, JSON.stringify(newTags), now, now, id);

    return true;
  }

  /** Obtiene un nodo por ID. */
  getNode(id) {
    return this._db.prepare('SELECT * FROM nodes WHERE id=?').get(id) || null;
  }

  /**
   * Busca nodos por tipo y/o texto en label/content.
   * Ordena por importancia decreciente.
   */
  queryNodes({ type, search, limit = 20, includeArchived = false } = {}) {
    let sql    = 'SELECT * FROM nodes WHERE 1=1';
    const args = [];

    if (!includeArchived) { sql += ' AND archived=0'; }
    if (type)   { sql += ' AND type=?';                          args.push(type); }
    if (search) { sql += ' AND (label LIKE ? OR content LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }

    sql += ' ORDER BY importance DESC LIMIT ?';
    args.push(limit);

    return this._db.prepare(sql).all(...args);
  }

  /**
   * Recupera los N episodios más recientes y relevantes.
   * Este es el método principal que usa el Grounding Engine.
   */
  getRecentEpisodes(limit = 20) {
    return this._db.prepare(`
      SELECT * FROM nodes
      WHERE type='Episode' AND archived=0
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Recupera todos los nodos persistentes (User, Project, Preference, Belief)
   * que forman el "estado del mundo" de March.
   */
  getWorldModel() {
    return this._db.prepare(`
      SELECT * FROM nodes
      WHERE type IN ('User','Project','Preference','Belief')
        AND archived=0
      ORDER BY importance DESC
      LIMIT 30
    `).all();
  }

  /**
   * Upsert inteligente: si existe un nodo con el mismo label y tipo,
   * actualiza su contenido y refuerza su importancia.
   * Si no existe, lo crea.
   */
  upsertNode({ type, label, content, importance, tags = [] }) {
    const existing = this._db.prepare(
      'SELECT id FROM nodes WHERE type=? AND label=? AND archived=0 LIMIT 1'
    ).get(type, label);

    if (existing) {
      this.updateNode(existing.id, { content, importance, tags });
      return existing.id;
    }
    return this.createNode({ type, label, content, importance, tags });
  }

  // ── Relaciones ──────────────────────────────────────────────────────────────

  createRelation(fromId, toId, relType, weight = 1.0) {
    try {
      this._db.prepare(`
          INSERT OR REPLACE INTO node_relations (from_id, to_id, rel_type, weight, created_at)

        VALUES (?, ?, ?, ?, ?)
      `).run(fromId, toId, relType, weight, Date.now());
    } catch(_) {}
  }

  // ── Sesiones ────────────────────────────────────────────────────────────────

  startSession() {
    const result = this._db.prepare(
      'INSERT INTO sessions (started_at) VALUES (?)'
    ).run(Date.now());
    return result.lastInsertRowid;
  }

  endSession(sessionId, { summary, turnCount, episodeId } = {}) {
    this._db.prepare(`
      UPDATE sessions SET ended_at=?, summary=?, turn_count=?, episode_id=?
      WHERE id=?
    `).run(Date.now(), summary || null, turnCount || 0, episodeId || null, sessionId);
  }

  getLastSessions(limit = 5) {
    return this._db.prepare(`
      SELECT * FROM sessions WHERE ended_at IS NOT NULL
      ORDER BY started_at DESC LIMIT ?
    `).all(limit);
  }

  // ── Decay ───────────────────────────────────────────────────────────────────

  /**
   * Aplica decay a todos los nodos activos.
   * Fórmula: importance *= (1 - decay_rate) ^ días_desde_último_acceso
   *
   * Los nodos que caen bajo ARCHIVE_THRESHOLD se archivan automáticamente.
   * NUNCA se borran — solo se archivan para mantener historial.
   */
  applyDecay() {
    const now   = Date.now();
    const nodes = this._db.prepare(
      'SELECT id, importance, decay_rate, last_accessed_at FROM nodes WHERE archived=0'
    ).all();

    const update   = this._db.prepare(
      'UPDATE nodes SET importance=?, updated_at=? WHERE id=?'
    );
    const archive  = this._db.prepare(
      'UPDATE nodes SET archived=1, updated_at=? WHERE id=?'
    );

    const runDecay = this._db.transaction(() => {
      let decayed = 0, archived = 0;

      for (const node of nodes) {
        const daysSince = (now - node.last_accessed_at) / (1000 * 60 * 60 * 24);
        if (daysSince < 1) continue; // no decaer nodos recientes

        const newImportance = node.importance * Math.pow(1 - node.decay_rate, daysSince);

        if (newImportance < ARCHIVE_THRESHOLD) {
          archive.run(now, node.id);
          archived++;
        } else {
          update.run(Math.round(newImportance * 10000) / 10000, now, node.id);
          decayed++;
        }
      }

      console.log(`[state-graph] decay: ${decayed} actualizados, ${archived} archivados`);
    });

    runDecay();
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    try {
      const total    = this._db.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0;
      const active   = this._db.prepare('SELECT COUNT(*) as c FROM nodes WHERE archived=0').get()?.c ?? 0;
      const byType   = this._db.prepare(
        'SELECT type, COUNT(*) as c FROM nodes WHERE archived=0 GROUP BY type'
      ).all();
      return { total, active, byType };
    } catch {
      return { total: 0, active: 0, byType: [] };
    }
  }

  close() {
    try { this._db?.close(); } catch(_) {}
  }
}

// ── Singleton por proceso ─────────────────────────────────────────────────────
let _instance = null;

function getStateGraph(dbPath) {
  if (!_instance) {
    _instance = new StateGraph(dbPath).init();
  }
  return _instance;
}

module.exports = { StateGraph, getStateGraph, NODE_TYPES, DECAY_RATES };