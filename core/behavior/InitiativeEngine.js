/**
 * InitiativeEngine.js — Fase 2
 *
 * Decide cuándo March interrumpe proactivamente al usuario.
 *
 * Fórmula de utilidad: U = Relevance - InterruptionCost
 *   - Relevance: qué tan relevante es el contexto actual para March
 *   - InterruptionCost: coste de interrumpir (tiempo reciente, sesión activa, etc.)
 *
 * Reglas estrictas anti-spam:
 *   - Mínimo 20 minutos entre iniciativas
 *   - Mínimo 5 minutos en la misma app antes de comentar
 *   - Máximo 2 iniciativas por sesión de chat abierta
 *   - No interrumpir si el chat ya está activo (el usuario ya está hablando)
 *
 * Emite al EventBus:
 *   initiative:trigger — { reason, app, suggestion, actionType, canHelp }
 */

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

// Tiempo mínimo en una app antes de que March comente (segundos)
const MIN_APP_TIME_SEC = 5 * 60;      // 5 minutos

// Tiempo mínimo entre iniciativas (ms)
const MIN_INITIATIVE_INTERVAL_MS = 20 * 60 * 1000; // 20 minutos

// Máximo iniciativas por sesión de chat abierta
const MAX_INITIATIVES_PER_SESSION = 2;

// Apps que merecen iniciativa y qué tipo de ayuda puede ofrecer
const INITIATIVE_RULES = [
  {
    category: 'code',
    minTime:  MIN_APP_TIME_SEC,
    score:    0.9,
    messages: [
      (app, title) => `Llevas rato en ${app}. ¿Cómo va el código?`,
      (app, title) => `Veo que estás programando. ¿Necesitas que revise algo?`,
      (app, title) => title?.includes('.') ? `¿Qué estás construyendo en ${title.split(' - ').pop()?.slice(0,40)}?` : `¿En qué proyecto estás trabajando?`,
    ],
    actionType: 'code_help',
    canHelp: true,
  },
  {
    category: 'terminal',
    minTime:  3 * 60, // 3 minutos en terminal ya es sospechoso
    score:    0.85,
    messages: [
      () => 'Llevas un rato en la terminal. ¿Algo que no está saliendo?',
      () => '¿Todo bien con lo que estás corriendo?',
    ],
    actionType: 'terminal_help',
    canHelp: true,
  },
  {
    category: 'docs',
    minTime:  10 * 60,
    score:    0.7,
    messages: [
      (app) => `Llevas tiempo en ${app}. ¿Quieres que te ayude con algo?`,
      (app) => `¿Organizando documentos? Puedo ayudar si necesitas.`,
    ],
    actionType: 'docs_help',
    canHelp: true,
  },
  {
    category: 'design',
    minTime:  10 * 60,
    score:    0.65,
    messages: [
      (app) => `Veo que tienes ${app} abierto. ¿Diseñando algo nuevo?`,
    ],
    actionType: 'design_help',
    canHelp: false,
  },
  {
    category: 'browser',
    minTime:  15 * 60,
    score:    0.5,
    messages: [
      () => 'Mucho tiempo navegando. ¿Buscando algo específico?',
    ],
    actionType: 'browse_help',
    canHelp: false,
  },
];

class InitiativeEngine {
  constructor(stateGraph) {
    this._graph            = stateGraph;
    this._bus              = getEventBus();
    this._lastInitiative   = 0;
    this._initiativeCount  = 0;
    this._chatOpen         = false;
    this._sessionActive    = false;

    this._setupListeners();
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _setupListeners() {
    // Escuchar ticks del OS para evaluar si hay que intervenir
    this._bus.on('os:app-tick', ({ app, friendlyName, category, elapsed, title }) => {
      if (!this._shouldEvaluate()) return;
      this._evaluate({ app, friendlyName, category, elapsed, title });
    });

    // Resetear contador cuando se abre/cierra el chat
    this._bus.on('session:started', () => {
      this._sessionActive   = true;
      this._initiativeCount = 0;
    });
    this._bus.on('session:closed', () => {
      this._sessionActive  = false;
      this._chatOpen       = false;
    });
  }

  /** Notificar que el chat está abierto (no interrumpir si ya está hablando). */
  setChatOpen(open) {
    this._chatOpen = open;
    if (open) this._initiativeCount = 0;
  }

  // ── Evaluación ─────────────────────────────────────────────────────────────

  _shouldEvaluate() {
    // No evaluar si el chat está abierto activamente
    if (this._chatOpen) return false;

    // No evaluar si se superó el límite de iniciativas por sesión
    if (this._initiativeCount >= MAX_INITIATIVES_PER_SESSION) return false;

    // No evaluar si no pasó el tiempo mínimo desde la última iniciativa
    const timeSinceLast = Date.now() - this._lastInitiative;
    if (timeSinceLast < MIN_INITIATIVE_INTERVAL_MS) return false;

    return true;
  }

  _evaluate({ app, friendlyName, category, elapsed, title }) {
    const rule = INITIATIVE_RULES.find(r => r.category === category);
    if (!rule) return;

    // ¿Lleva suficiente tiempo en esta app?
    if (elapsed < rule.minTime) return;

    // Calcular utilidad
    const relevance        = rule.score;
    const interruptionCost = this._calculateInterruptionCost();
    const utility          = relevance - interruptionCost;

    if (utility <= 0.3) return; // umbral mínimo

    // Elegir mensaje
    const msgFn      = rule.messages[Math.floor(Math.random() * rule.messages.length)];
    const suggestion = msgFn(friendlyName || app, title);

    // Disparar iniciativa
    this._lastInitiative = Date.now();
    this._initiativeCount++;

    const payload = {
      reason:     `${elapsed}s en ${category}`,
      app:        friendlyName || app,
      appRaw:     app,
      category,
      title,
      elapsed,
      suggestion,
      actionType: rule.actionType,
      canHelp:    rule.canHelp,
      utility:    Math.round(utility * 100) / 100,
    };

    console.log(`[initiative] disparando: "${suggestion}" (U=${payload.utility})`);
    this._bus.emit('initiative:trigger', payload);
  }

  _calculateInterruptionCost() {
    // Mayor costo si hay iniciativa reciente
    const timeSinceLast = Date.now() - this._lastInitiative;
    const hoursSince    = timeSinceLast / (1000 * 60 * 60);

    if (hoursSince < 0.5)  return 0.8;  // menos de 30 min → muy costoso
    if (hoursSince < 1)    return 0.5;  // 30-60 min → moderado
    if (hoursSince < 2)    return 0.3;  // 1-2 horas → bajo
    return 0.1;                          // más de 2 horas → mínimo
  }

  /** Forzar una iniciativa manualmente (para testing). */
  forceInitiative(suggestion, actionType = 'manual') {
    this._bus.emit('initiative:trigger', {
      reason:     'manual',
      app:        'manual',
      suggestion,
      actionType,
      canHelp:    false,
      utility:    1.0,
    });
  }

  getStats() {
    return {
      lastInitiative:   this._lastInitiative,
      initiativeCount:  this._initiativeCount,
      chatOpen:         this._chatOpen,
      sessionActive:    this._sessionActive,
    };
  }
}

module.exports = { InitiativeEngine };