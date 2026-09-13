// @ts-check
'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { minimalChildEnv } = require('../utils/childEnv.js');

const PROVIDER_ID = 'codex-cli';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDIO_BYTES = 2 * 1024 * 1024;
const SAFE_COMMAND = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** @returns {string|null} */
function findCodexCommand() {
  const candidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, SAFE_COMMAND));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      swallow('CodexCliProvider.candidates');
    }
  }
  return null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @param {string} systemPrompt
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools
 */
function buildPrompt(messages, systemPrompt, tools = []) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER';
      const content = Array.isArray(message.content)
        ? message.content
            .filter((block) => block?.type === 'text')
            .map((block) => String(block.text || ''))
            .join('\n') + '\n[Imagen omitida: Codex CLI local no admite adjuntos en este puente]'
        : typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
      return `${role}: ${content}`;
    })
    .join('\n\n');
  const toolSection = tools.length
    ? `\n\nHERRAMIENTAS DISPONIBLES EN KAORU:\n${JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        }))
      )}\n\nDevuelve JSON conforme al schema de salida. Puedes responder con content, proponer toolCalls, o ambos. No ejecutes herramientas por tu cuenta. Usa únicamente nombres de la lista. En paramsJson serializa un objeto JSON cuyos argumentos cumplan el inputSchema de la herramienta.`
    : '';
  return `${systemPrompt}\n\nCONVERSACIÓN:\n${transcript}${toolSection}`;
}

const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: ['string', 'null'] },
    toolCalls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          paramsJson: { type: 'string' },
        },
        required: ['tool', 'paramsJson'],
        additionalProperties: false,
      },
    },
  },
  required: ['content', 'toolCalls'],
  additionalProperties: false,
});

/** @returns {Error & {code: string}} */
function abortError() {
  const error = /** @type {Error & {code: string}} */ (new Error('Generación cancelada'));
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

/**
 * @param {import('child_process').ChildProcess} child
 * @param {AbortSignal|null|undefined} signal
 * @param {(error: Error) => void} reject
 */
function attachAbort(child, signal, reject) {
  if (!signal) return () => {};
  const onAbort = () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    timer.unref?.();
    reject(abortError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} prompt
 * @param {string} cwd
 * @param {string} outputPath
 * @param {{signal?: AbortSignal, timeoutMs?: number}} opts
 */
function spawnCodex(command, args, prompt, cwd, outputPath, opts) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const child = spawn(command, args, {
      cwd,
      env: minimalChildEnv(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    /** @param {(value: any) => void} fn @param {any} value */
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupAbort();
      fn(value);
    };
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDIO_BYTES) child.kill('SIGTERM');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_STDIO_BYTES) stderr += chunk.toString();
    });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', async (code, signal) => {
      if (settled) return;
      if (stdoutBytes > MAX_STDIO_BYTES)
        return finish(reject, new Error('Codex CLI excedió el límite de salida'));
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 600);
        return finish(
          reject,
          new Error(
            `Codex CLI terminó con ${signal || `código ${code}`}${detail ? `: ${detail}` : ''}`
          )
        );
      }
      try {
        const output = await fsp.readFile(outputPath, 'utf8');
        finish(resolve, output.trim());
      } catch (_) {
        finish(reject, new Error('Codex CLI no produjo una respuesta final'));
      }
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(
        reject,
        new Error(`Codex CLI excedió el timeout de ${opts.timeoutMs || DEFAULT_TIMEOUT_MS}ms`)
      );
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    const cleanupAbort = attachAbort(child, opts.signal, (error) => finish(reject, error));
    child.stdin?.end(prompt);
  });
}

/**
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @param {string} systemPrompt
 * @param {string} mode
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools
 * @param {{signal?: AbortSignal, onToken?: (token: string) => void, timeoutMs?: number}} opts
 */
async function callCodexCli(messages, systemPrompt, mode, tools = [], opts = {}) {
  if (opts.signal?.aborted) throw abortError();
  const command = findCodexCommand();
  if (!command) throw new Error('Codex CLI no está instalado o no aparece en PATH');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaoru-codex-'));
  const outputPath = path.join(tempDir, 'last-message.txt');
  const schemaPath = path.join(tempDir, 'tool-output.schema.json');
  try {
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
    ];
    if (tools.length) {
      await fsp.writeFile(schemaPath, JSON.stringify(TOOL_OUTPUT_SCHEMA), { mode: 0o600 });
      args.push('--output-schema', schemaPath);
    }
    args.push('-');
    const prompt = buildPrompt(messages, systemPrompt, tools);
    const raw = /** @type {string} */ (
      await spawnCodex(command, args, prompt, tempDir, outputPath, opts)
    );
    if (!tools.length) {
      if (opts.onToken && raw) opts.onToken(raw);
      return raw;
    }
    const parsed = JSON.parse(raw);
    if (!isObject(parsed))
      throw new Error('Codex CLI devolvió una respuesta estructurada inválida');
    const allowed = new Set(tools.map((tool) => tool.name));
    const toolCalls = [];
    if (Array.isArray(parsed.toolCalls)) {
      for (const call of parsed.toolCalls) {
        if (
          !isObject(call) ||
          typeof call.tool !== 'string' ||
          !allowed.has(call.tool) ||
          typeof call.paramsJson !== 'string'
        )
          continue;
        try {
          const params = JSON.parse(call.paramsJson);
          if (isObject(params)) toolCalls.push({ tool: call.tool, params });
        } catch (_) {
          swallow('CodexCliProvider.callCodexCli');
        }
      }
    }
    const content = typeof parsed.content === 'string' ? parsed.content : null;
    if (opts.onToken && content) opts.onToken(content);
    return { content, toolCalls: toolCalls.length ? toolCalls : null };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  PROVIDER_ID,
  findCodexCommand,
  buildPrompt,
  callCodexCli,
  _TOOL_OUTPUT_SCHEMA: TOOL_OUTPUT_SCHEMA,
};
