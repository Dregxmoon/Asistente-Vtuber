/**
 * LLMProvider.js — Fase 0
 * Interfaz unificada para Groq / Gemini / OpenAI con fallback automático.
 * El modelo es un detalle de implementación. March es March.
 */

const https = require('https');
const http  = require('http');

// ── Configuración por defecto (se sobreescribe con config.json) ───────────────
let _config = {
  primary:  'groq',
  apiKeys:  { groq: '', gemini: '', openai: '' },
  fallback: ['gemini', 'openai'],
};

function configure(cfg) {
  if (cfg && cfg.llm) {
    _config = { ..._config, ...cfg.llm };
    if (cfg.llm.apiKeys) _config.apiKeys = { ..._config.apiKeys, ...cfg.llm.apiKeys };
  }
}

// ── Helper HTTP ───────────────────────────────────────────────────────────────
function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Proveedores ───────────────────────────────────────────────────────────────

async function callGroq(messages, systemPrompt) {
  const key = _config.apiKeys.groq;
  if (!key) throw new Error('No Groq API key');

  const msgs = [{ role: 'system', content: systemPrompt }, ...messages];
  const res  = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model: 'llama-3.3-70b-versatile', messages: msgs, max_tokens: 512, temperature: 0.85 }
  );
  if (res.status !== 200) throw new Error(`Groq ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content.trim();
}

async function callGemini(messages, systemPrompt) {
  const key = _config.apiKeys.gemini;
  if (!key) throw new Error('No Gemini API key');

  // Gemini usa un formato diferente — convertimos
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {},
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 512, temperature: 0.85 },
    }
  );
  if (res.status !== 200) throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.candidates[0].content.parts[0].text.trim();
}

async function callOpenAI(messages, systemPrompt) {
  const key = _config.apiKeys.openai;
  if (!key) throw new Error('No OpenAI API key');

  const msgs = [{ role: 'system', content: systemPrompt }, ...messages];
  const res  = await post(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model: 'gpt-4o-mini', messages: msgs, max_tokens: 512, temperature: 0.85 }
  );
  if (res.status !== 200) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content.trim();
}

const PROVIDERS = { groq: callGroq, gemini: callGemini, openai: callOpenAI };

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Envía mensajes al LLM con fallback automático.
 * @param {Array}  messages     — historial [{role, content}]
 * @param {string} systemPrompt — contexto completo de March para este turno
 * @returns {Promise<string>}   — respuesta de texto
 */
async function complete(messages, systemPrompt) {
  const order = [_config.primary, ...(_config.fallback || [])];
  const tried = [];

  for (const providerName of order) {
    const fn = PROVIDERS[providerName];
    if (!fn) continue;
    const key = _config.apiKeys[providerName];
    if (!key || key.trim() === '') continue;

    try {
      console.log(`[llm] intentando ${providerName}...`);
      const result = await fn(messages, systemPrompt);
      console.log(`[llm] respuesta de ${providerName} (${result.length} chars)`);
      return result;
    } catch(e) {
      console.log(`[llm] ${providerName} falló: ${e.message}`);
      tried.push(providerName);
    }
  }

  throw new Error(`Todos los providers fallaron: ${tried.join(', ')}`);
}

/**
 * Retorna el nombre del provider que se usará (para logs/debug).
 */
function getActiveProvider() {
  const order = [_config.primary, ...(_config.fallback || [])];
  for (const name of order) {
    const key = _config.apiKeys[name];
    if (key && key.trim() !== '') return name;
  }
  return null;
}

module.exports = { configure, complete, getActiveProvider };