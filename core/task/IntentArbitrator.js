// @ts-check
'use strict';

/**
 * IntentArbitrator.js — árbitro LLM OPT-IN para la zona gris.
 *
 * Los embeddings deciden rápido y offline (IntentClassifier); el regex queda
 * de fallback. Este árbitro solo entra cuando AMBOS quedan débiles y el
 * usuario lo habilita (`intentArbitration: true`): un LLM (el provider activo,
 * sin modelo nuevo que descargar ni mantener) devuelve JSON estricto con la
 * intención. Cubre lo que el coseno no ve: negación ("abre amazon pero NO
 * compres nada"), multi-intención ("abre X y escríbeme Y") y ambigüedad real.
 *
 * Por qué NO un LLM pequeño local dedicado: el modelo pequeño local YA existe
 * (embeddings multilingües, ms, offline, 0 deps). Un generativo local sumaría
 * ~400MB de descarga, ~1GB de RAM y segundos de CPU por mensaje para un
 * trabajo que el provider activo (Groq, rápido) ya hace mejor y en cualquier
 * idioma. Si algún día Kaoru opera 100% offline, se reconsidera (la interfaz
 * completeFn lo permite sin tocar este módulo).
 */

const ARBITRATOR_SYSTEM = [
  'You classify user intent for a desktop assistant. Reply with EXACTLY one JSON object, no other text.',
  'Schema: {"isTask": boolean, "domain": string|null, "goal": string, "confidence": number}',
  'Domains (use exactly these ids or null): code, filesystem, git, shell, web, system, multimedia, mcp, package, docker, network, data.',
  'isTask=false for greetings, small talk, questions answerable directly, and messages with no actionable request.',
  'confidence is 0.0-1.0. Negations matter: "open X but do NOT buy anything" is a web task constrained to browsing.',
  'Language never changes the domain ids: classify the MEANING, in any language.',
].join('\n');

const VALID_DOMAINS = new Set([
  'code',
  'filesystem',
  'git',
  'shell',
  'web',
  'system',
  'multimedia',
  'mcp',
  'package',
  'docker',
  'network',
  'data',
]);

const ARBITRATOR_TIMEOUT_MS = 8000;

/**
 * @param {unknown} text mensaje del usuario
 * @param {{completeFn?: (messages: Array<{role: string, content: string}>, systemPrompt: string, opts?: object) => Promise<string>, timeoutMs?: number}} [options] completeFn inyectable (tests) o LLMProvider.complete
 * @returns {Promise<{isTask: boolean, domain: {id: string}|null, goal: string, confidence: string, _debug: object}|null>} null = sin veredicto (el pipeline sigue con lo que tenga)
 */
async function arbitrate(text, options = {}) {
  const message = String(text || '')
    .trim()
    .slice(0, 500);
  const completeFn = options.completeFn;
  if (!message || typeof completeFn !== 'function') return null;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 30000)
      : ARBITRATOR_TIMEOUT_MS;

  let raw;
  try {
    raw = await Promise.race([
      completeFn([{ role: 'user', content: message }], ARBITRATOR_SYSTEM, {}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('arbitraje agotó el tiempo')), timeoutMs)
      ),
    ]);
  } catch (_) {
    return null;
  }
  const parsed = _parseVerdict(raw);
  if (!parsed) return null;
  return {
    isTask: parsed.isTask,
    domain: parsed.domain ? { id: parsed.domain } : null,
    goal: message.slice(0, 200),
    confidence: parsed.isTask ? 'medium' : 'none',
    _debug: { arbitratedBy: 'llm', rawConfidence: parsed.confidence },
  };
}

/** @param {unknown} raw @returns {{isTask: boolean, domain: string|null, confidence: number}|null} */
function _parseVerdict(raw) {
  if (typeof raw !== 'string') return null;
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.isTask !== 'boolean') return null;
  const domain =
    typeof parsed.domain === 'string' && VALID_DOMAINS.has(parsed.domain.trim().toLowerCase())
      ? parsed.domain.trim().toLowerCase()
      : null;
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;
  if (parsed.isTask && !domain) return null;
  return { isTask: parsed.isTask, domain, confidence };
}

module.exports = { arbitrate, ARBITRATOR_SYSTEM, VALID_DOMAINS };
