// @ts-check
'use strict';
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const SERVICES = Object.freeze({
  calendar: 'Calendar',
  gmail: 'Gmail',
  drive: 'Drive',
  docs: 'Docs',
  sheets: 'Sheets',
  tasks: 'Tasks',
  contacts: 'Contacts',
});

/** @param {unknown} input */
function validateGoogleWorkspace(input) {
  const data =
    /** @type {{clientId?:unknown,clientSecret?:unknown,services?:unknown,readOnly?:unknown,uvxPath?:unknown}} */ (
      input || {}
    );
  if (
    typeof data.clientId !== 'string' ||
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(data.clientId.trim())
  )
    throw new Error('Client ID inválido: debe terminar en .apps.googleusercontent.com');
  if (
    typeof data.clientSecret !== 'string' ||
    !/^[\x21-\x7e]{8,512}$/.test(data.clientSecret.trim())
  )
    throw new Error('Introduce un Client Secret válido, sin espacios');
  if (
    !Array.isArray(data.services) ||
    !data.services.length ||
    data.services.some(
      (service) => typeof service !== 'string' || !Object.hasOwn(SERVICES, service)
    )
  )
    throw new Error('Selecciona al menos un servicio Google válido');
  if (typeof data.readOnly !== 'boolean') throw new Error('Modo de lectura inválido');
  return {
    clientId: data.clientId.trim(),
    clientSecret: data.clientSecret.trim(),
    services: [...new Set(/** @type {string[]} */ (data.services))],
    readOnly: data.readOnly,
    uvxPath: typeof data.uvxPath === 'string' ? data.uvxPath.trim() : '',
  };
}

/** @param {string} [configured] @returns {Promise<string>} */
async function findUvx(configured = '') {
  const binary = process.platform === 'win32' ? 'uvx.exe' : 'uvx';
  const candidates = configured
    ? [configured]
    : [
        ...(process.env.PATH || '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, binary)),
        path.join(os.homedir(), '.local', 'bin', binary),
        path.join(os.homedir(), '.cargo', 'bin', binary),
      ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch (_) {}
  }
  throw new Error(
    'No se encontró uvx. Instala uv o selecciona la ruta de uvx en Opciones avanzadas.'
  );
}

/** @param {unknown} input */
async function buildGoogleWorkspaceConfig(input) {
  const data = validateGoogleWorkspace(input);
  const command = await findUvx(data.uvxPath);
  return {
    name: 'google-workspace',
    connector: 'google-workspace',
    command,
    args: ['workspace-mcp', '--tools', ...data.services, ...(data.readOnly ? ['--read-only'] : [])],
    env: { GOOGLE_OAUTH_CLIENT_ID: data.clientId, GOOGLE_OAUTH_CLIENT_SECRET: data.clientSecret },
  };
}

/** @param {string} line @returns {string|null} */
function authenticatedGoogleEmail(line) {
  // Eliminar los colores ANSI emitidos por el proceso hijo.
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  const match =
    clean.match(/Authenticated via stdio_single_session:\s*([^\s<>]+@[^\s<>]+)\s*$/) ||
    clean.match(/OAuth callback: Successfully authenticated user:\s*([^\s<>]+@[^\s<>]+)\.\s*$/);
  return match && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(match[1])
    ? match[1]
    : null;
}
module.exports = {
  SERVICES,
  validateGoogleWorkspace,
  findUvx,
  buildGoogleWorkspaceConfig,
  authenticatedGoogleEmail,
};
