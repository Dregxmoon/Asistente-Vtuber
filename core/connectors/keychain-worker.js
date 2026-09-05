// @ts-check
'use strict';
const { parentPort, workerData } = require('worker_threads');
const keychain = require('../../infrastructure/keychain/KeychainManager.js');
try {
  const { operation, key, value } = workerData;
  let result;
  if (operation === 'get') result = keychain.getKey(key);
  else if (operation === 'set') result = keychain.setKey(key, value);
  else if (operation === 'delete') result = keychain.deleteKey(key);
  else throw new Error('Operación no permitida');
  parentPort?.postMessage({ ok: true, result });
} catch (_) {
  parentPort?.postMessage({ ok: false });
}
