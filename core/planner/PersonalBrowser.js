// @ts-check
'use strict';

/**
 * PersonalBrowser.js — el navegador que el usuario SIEMPRE usa, vía CDP.
 *
 * Kaoru detecta cuál es (default del SO + cuál está corriendo), propone
 * vincularlo con consentimiento explícito y lo lanza con
 * --remote-debugging-port sobre SU perfil real para adjuntarse con Playwright
 * (connectOverCDP) — con sus sesiones y logins, pero observable y verificable.
 *
 * Líneas rojas (no negociables):
 *  - JAMÁS mata ni cierra procesos del usuario (ni siquiera el navegador).
 *  - JAMÁS toca un perfil fuera de las raíces esperadas por plataforma.
 *  - Solo binarios de navegadores conocidos (allowlist); nada arbitrario.
 *  - Si el puerto está ocupado o el perfil bloqueado, se informa y se pide
 *    acción humana — nunca se fuerza.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const CDP_DEFAULT_PORT = 9222;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * Navegadores soportados para adjuntar por CDP (familia Chromium: cobertura
 * CDP completa en Playwright; Firefox queda en Ruta 1 — perfil gestionado).
 * Tabla de datos: binarios por plataforma y raíces de perfil esperadas.
 */
const KNOWN_BROWSERS = Object.freeze({
  chromium: Object.freeze({
    label: 'Chromium',
    processNames: ['chromium', 'chromium-browser'],
    linuxBins: ['chromium', 'chromium-browser'],
    win32Bins: ['chrome.exe'],
    darwinApps: ['Chromium'],
    desktopIds: ['chromium.desktop', 'chromium-browser.desktop'],
    profileRoots: {
      linux: ['.config/chromium'],
      win32: ['AppData/Local/Chromium/User Data'],
      darwin: ['Library/Application Support/Chromium'],
    },
  }),
  chrome: Object.freeze({
    label: 'Google Chrome',
    processNames: ['chrome', 'google-chrome', 'google-chrome-stable'],
    linuxBins: ['google-chrome', 'google-chrome-stable'],
    win32Bins: ['chrome.exe'],
    darwinApps: ['Google Chrome'],
    desktopIds: ['google-chrome.desktop'],
    profileRoots: {
      linux: ['.config/google-chrome'],
      win32: ['AppData/Local/Google/Chrome/User Data'],
      darwin: ['Library/Application Support/Google/Chrome'],
    },
  }),
  brave: Object.freeze({
    label: 'Brave',
    processNames: ['brave', 'brave-browser'],
    linuxBins: ['brave-browser', 'brave'],
    win32Bins: ['brave.exe'],
    darwinApps: ['Brave Browser'],
    desktopIds: ['brave-browser.desktop'],
    profileRoots: {
      linux: ['.config/BraveSoftware/Brave-Browser'],
      win32: ['AppData/Local/BraveSoftware/Brave-Browser/User Data'],
      darwin: ['Library/Application Support/BraveSoftware/Brave-Browser'],
    },
  }),
  edge: Object.freeze({
    label: 'Microsoft Edge',
    processNames: ['msedge', 'microsoft-edge'],
    linuxBins: ['microsoft-edge', 'microsoft-edge-stable'],
    win32Bins: ['msedge.exe'],
    darwinApps: ['Microsoft Edge'],
    desktopIds: ['microsoft-edge.desktop'],
    profileRoots: {
      linux: ['.config/microsoft-edge'],
      win32: ['AppData/Local/Microsoft/Edge/User Data'],
      darwin: ['Library/Application Support/Microsoft Edge'],
    },
  }),
});

/**
 * @typedef {object} BrowserInfo
 * @property {string} label
 * @property {string[]} processNames
 * @property {string[]} linuxBins
 * @property {string[]} win32Bins
 * @property {string[]} darwinApps
 * @property {string[]} desktopIds
 * @property {Record<string, string[]>} profileRoots
 */

/** @param {unknown} id @returns {BrowserInfo|null} accesor tipado al catálogo */
function browserInfo(id) {
  if (typeof id !== 'string' || !id) return null;
  const table = /** @type {Record<string, BrowserInfo>} */ (KNOWN_BROWSERS);
  return table[id] || null;
}

/** @param {unknown} value */
function _normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Detecta el navegador predeterminado del SO.
 * @param {{platform?: NodeJS.Platform, runText?: (command: string, args: string[]) => Promise<string>, env?: NodeJS.ProcessEnv}} [options] runText inyectable (tests)
 * @returns {Promise<{browser: string, source: 'default'}|null>}
 */
async function detectDefaultBrowser(options = {}) {
  const platform = options.platform || process.platform;
  const runText = options.runText || null;
  if (platform === 'linux') {
    if (!runText) return null;
    try {
      const desktopId = _normalize(await runText('xdg-settings', ['get', 'default-web-browser']));
      for (const [id, info] of Object.entries(KNOWN_BROWSERS)) {
        if (info.desktopIds.some((candidate) => _normalize(candidate) === desktopId)) {
          return { browser: id, source: 'default' };
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }
  if (platform === 'win32') {
    if (!runText) return null;
    try {
      const output = String(
        await runText('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction Stop).ProgId",
        ])
      ).toLowerCase();
      if (output.includes('chrome')) {
        return {
          browser: output.includes('brave') ? 'brave' : output.includes('edge') ? 'edge' : 'chrome',
          source: 'default',
        };
      }
      if (output.includes('chromium')) return { browser: 'chromium', source: 'default' };
    } catch (_) {
      return null;
    }
    return null;
  }
  return null;
}

/**
 * Detecta qué navegador conocido está corriendo ahora (lo que el usuario USA).
 * @param {{processes?: Array<{pid: number, name: string}>}} [options]
 * @returns {{browser: string, pid: number, source: 'running'}|null}
 */
function detectRunningBrowser(options = {}) {
  const processes = Array.isArray(options.processes) ? options.processes : [];
  /** @type {{browser: string, pid: number}|null} */
  let best = null;
  for (const proc of processes) {
    const name = _normalize(proc.name);
    if (!name) continue;
    for (const [id, info] of Object.entries(KNOWN_BROWSERS)) {
      // Coincidencia exacta contra nombres de proceso conocidos (no
      // subcadenas: 'chrome' no debe cazar 'chromium' ni viceversa).
      if (
        info.processNames.some((candidate) => name === candidate || name === `${candidate}.exe`)
      ) {
        best = { browser: id, pid: Number(proc.pid) || 0 };
        break;
      }
    }
    if (best) break;
  }
  return best ? { ...best, source: 'running' } : null;
}

/**
 * Elige qué navegador proponer: el que está corriendo (lo que USA ahora)
 * gana sobre el predeterminado. Sin idioma ni listas mágicas: datos.
 * @param {{browser: string, pid?: number, source: string}|null} running
 * @param {{browser: string, source: string}|null} defaultBrowser
 * @returns {{browser: string, source: string, reason: string}|null}
 */
function proposePersonalBrowser(running, defaultBrowser) {
  if (running && browserInfo(running.browser)) {
    return {
      browser: running.browser,
      source: 'running',
      reason: `está corriendo ahora (pid ${running.pid || '?'})`,
    };
  }
  if (defaultBrowser && browserInfo(defaultBrowser.browser)) {
    return {
      browser: defaultBrowser.browser,
      source: 'default',
      reason: 'es el predeterminado del sistema',
    };
  }
  return null;
}

/**
 * Resuelve el directorio del perfil real del navegador.
 * @param {string} browserId id de KNOWN_BROWSERS
 * @param {{platform?: NodeJS.Platform, homeDir?: string}} [options]
 * @returns {{path: string, exists: boolean}}
 */
function resolveProfileDir(browserId, options = {}) {
  const info = browserInfo(browserId);
  if (!info) throw new Error(`Navegador no soportado para vínculo personal: ${browserId}`);
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();
  const roots =
    (platform === 'win32'
      ? info.profileRoots.win32
      : platform === 'darwin'
        ? info.profileRoots.darwin
        : info.profileRoots.linux) || [];
  const root = roots[0] || '';
  // Las raíces están expresadas relativas al home en las tres plataformas
  // (AppData vive bajo el home en Windows); path.join resuelve el separador.
  const full = root ? path.join(home, ...root.split('/')) : '';
  let exists = false;
  try {
    exists = Boolean(full) && fs.existsSync(full);
  } catch (_) {
    exists = false;
  }
  return { path: full, exists };
}

/**
 * Comprueba si un puerto TCP local está libre.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true = libre
 */
function isPortFree(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(true));
  });
}

/**
 * Valida un vínculo personal antes de lanzar: binario conocido, perfil dentro
 * de raíces esperadas, puerto válido y libre. No mata nada, no toca nada.
 * @param {{browser?: unknown, profileDir?: unknown, port?: unknown, platform?: NodeJS.Platform, homeDir?: string, portFree?: (port: number) => Promise<boolean>}} options
 */
async function validatePersonalLink(options = {}) {
  const browser = String(options.browser || '')
    .trim()
    .toLowerCase();
  const info = browserInfo(browser);
  if (!info)
    throw new Error(
      `Navegador no soportado para vínculo personal: ${browser || '(vacío)'}. Soportados: ${Object.keys(KNOWN_BROWSERS).join(', ')}`
    );
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();
  const profileDir = String(options.profileDir || '');
  if (!profileDir) throw new Error('Falta el directorio del perfil real del usuario');
  const resolved = path.resolve(profileDir);
  const allowedRoots = (info.profileRoots[platform] || info.profileRoots.linux || []).map((root) =>
    path.join(home, ...root.split('/'))
  );
  const insideAllowed = allowedRoots.some((root) =>
    resolved.toLowerCase().startsWith(root.toLowerCase())
  );
  if (!insideAllowed) {
    throw new Error(
      'El perfil no está en una ubicación esperada para ese navegador; vínculo rechazado'
    );
  }
  let exists = false;
  try {
    exists = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  } catch (_) {
    exists = false;
  }
  if (!exists) throw new Error(`El perfil no existe: ${resolved}`);
  const port = Number(options.port || CDP_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Puerto CDP inválido: ${String(options.port)}. Usa ${MIN_PORT}-${MAX_PORT}`);
  }
  const portFree = options.portFree || isPortFree;
  if (!(await portFree(port))) {
    throw new Error(
      `El puerto ${port} está ocupado (quizá otra instancia depurable). Cierra esa instancia o elige otro puerto — Kaoru nunca cierra procesos ajenos`
    );
  }
  return { browser, label: info.label, profileDir: resolved, port };
}

/** @param {unknown} port @returns {string} endpoint CDP para adjuntar Playwright */
function cdpEndpoint(port) {
  return `http://127.0.0.1:${Number(port) || CDP_DEFAULT_PORT}`;
}

module.exports = {
  KNOWN_BROWSERS,
  CDP_DEFAULT_PORT,
  browserInfo,
  detectDefaultBrowser,
  detectRunningBrowser,
  proposePersonalBrowser,
  resolveProfileDir,
  isPortFree,
  validatePersonalLink,
  cdpEndpoint,
};
