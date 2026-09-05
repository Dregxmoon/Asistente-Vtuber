// @ts-check
'use strict';
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const storage = require('../../infrastructure/config/SafeStorageCrypto.js');
const PREFIX = 'keychain:';

/** @param {'get'|'set'|'delete'} operation @param {string} key @param {string} [value] @returns {Promise<any>} */
function keychainRequest(operation, key, value) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'keychain-worker.js'), {
      workerData: { operation, key, value },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, 12000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message.ok ? message.result : null);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** @param {string} id @param {string} secret @param {typeof keychainRequest} [request] */
async function storeGoogleSecret(id, secret, request = keychainRequest) {
  const key = 'mcp_google_' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 40);
  if (await request('set', key, secret)) return { value: PREFIX + key, storage: 'keychain' };
  // Deuda técnica: sin llavero ni safeStorage se conserva el fallback legacy
  // en texto plano. El wizard informa credentialStorage=plaintext explícitamente.
  const encrypted = storage.encrypt(secret);
  return {
    value: encrypted,
    storage: encrypted.startsWith(storage.ENC_PREFIX) ? 'encrypted' : 'plaintext',
  };
}

/** @param {Record<string,string>} env @param {typeof keychainRequest} [request] @returns {Promise<Record<string,string>>} */
async function resolveMCPEnv(env, request = keychainRequest) {
  const resolved = storage.decryptAllKeys(env || {});
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.startsWith(PREFIX)) {
      const key = value.slice(PREFIX.length);
      if (!/^mcp_google_[a-f0-9]{40}$/.test(key))
        throw new Error('Referencia de credencial MCP inválida');
      const secret = await request('get', key);
      if (typeof secret !== 'string' || !secret)
        throw new Error('No se pudo recuperar la credencial MCP del llavero');
      resolved[name] = secret;
    }
  }
  return resolved;
}
module.exports = { storeGoogleSecret, resolveMCPEnv };
