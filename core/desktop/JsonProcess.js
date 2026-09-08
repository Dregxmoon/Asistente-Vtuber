// @ts-check
'use strict';

const { spawn } = require('child_process');

/**
 * Ejecuta un helper local sin shell y consume exactamente un objeto JSON.
 * Los parámetros se entregan por stdin para que nunca formen parte de una
 * línea de comandos interpretable por el sistema operativo.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, unknown>} payload
 * @param {{timeout?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<Record<string, any>>}
 */
function runJsonProcess(command, args, payload, options = {}) {
  const timeout = Math.min(30_000, Math.max(500, Number(options.timeout) || 10_000));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Helper de automatización agotó ${timeout}ms`));
    }, timeout);

    /** @param {Error|null} error @param {Record<string, any>|undefined} [value] */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value || {});
    };

    child.once('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 64 * 1024) child.kill();
    });
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Helper terminó con código ${String(code)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('respuesta JSON inválida');
        }
        finish(null, parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error(`Helper devolvió una respuesta inválida: ${message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

module.exports = { runJsonProcess };
