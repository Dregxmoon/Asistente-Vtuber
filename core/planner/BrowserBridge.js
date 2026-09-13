// @ts-nocheck
/**
 * BrowserBridge.js — navegador aislado del asistente (Playwright)
 *
 * El asistente tiene su propio navegador Chromium, completamente separado
 * del navegador personal del usuario. Ofrece una sesión headless y otra
 * visible administrada, ambas con política de red y pestañas identificadas.
 *
 * Responsabilidades:
 *   - browser: observar, navegar, interactuar, verificar, pestañas y archivos
 *   - web_search: búsqueda real en Google/Bing, extrae resultados del HTML
 *
 * Instalación requerida (una sola vez):
 *   npm install playwright
 *   npx playwright install chromium
 */

'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../observability/Logger.js');
const { isUrlSafe } = require('../security/UrlGuard.js');
const { isImmutablePath } = require('../security/PathGuard.js');
let _urlGuard = isUrlSafe;

// Límite de confianza anti prompt-injection (P3): el texto que el navegador
// extrae de páginas web de terceros NO es confiable — una página maliciosa
// puede incluir instrucciones ocultas para el agente. Todo contenido de
// terceros que entra al contexto del LLM pasa por wrapUntrusted (delimitación
// + neutralización de patrones de inyección).
const { wrapUntrusted, wrapUntrustedItems } = require('../grounding/untrustedContent.js');

let _playwright = null;
let _browser = null;
let _backgroundContext = null;
let _page = null;
let _launching = null; // promesa en curso, evita lanzar 2 navegadores en paralelo
let _managedContext = null;
let _managedPage = null;
let _managedLaunching = null;
// Navegador PERSONAL del usuario (CDP): su binario, su perfil, sus sesiones.
// Kaoru solo observa y actúa con consentimiento; cerrar la conexión NUNCA
// cierra su navegador (disconnect ≠ close).
let _personalBrowser = null;
let _personalContext = null;
let _personalPage = null;
let _personalMeta = null;
let _fallbackProfileDir = '';
const _pageIds = new WeakMap();
const _pendingDialogs = new WeakMap();
const _securedContexts = new WeakSet();
const _hostSafetyCache = new Map();
const _sessionIds = {
  background: crypto.randomUUID(),
  managed: crypto.randomUUID(),
  personal: crypto.randomUUID(),
};

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);

async function _managedProfileDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const profile = path.join(app.getPath('userData'), 'browser-profile');
      await fs.promises.mkdir(profile, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(profile, 0o700).catch(() => {});
      return profile;
    }
  } catch (_) {
    swallow('BrowserBridge._managedProfileDir');
  }
  if (_fallbackProfileDir) return _fallbackProfileDir;
  const fallback = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kaoru-browser-profile-'));
  try {
    await fs.promises.chmod(fallback, 0o700);
  } catch (_) {
    swallow('BrowserBridge._managedProfileDir');
  }
  _fallbackProfileDir = fallback;
  return _fallbackProfileDir;
}

function _pageId(page) {
  if (!_pageIds.has(page)) {
    _pageIds.set(page, `page-${crypto.randomUUID()}`);
    if (page && typeof page.on === 'function') {
      page.on('dialog', (dialog) => _pendingDialogs.set(page, dialog));
    }
  }
  return _pageIds.get(page);
}

async function _workspaceFile(rawPath, mustExist) {
  const candidate = path.resolve(process.cwd(), String(rawPath || ''));
  if (!rawPath || isImmutablePath(candidate)) throw new Error('Ruta de archivo no permitida');
  const root = await fs.promises.realpath(process.cwd());
  let current = mustExist ? candidate : path.dirname(candidate);
  let real;
  try {
    real = await fs.promises.realpath(current);
  } catch (_) {
    throw new Error('El directorio del archivo no existe');
  }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('El archivo debe estar dentro del workspace activo');
  }
  if (mustExist) {
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) throw new Error('La ruta no apunta a un archivo');
    return real;
  }
  return candidate;
}

function _origin(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : 'null';
  } catch (_) {
    return 'null';
  }
}

async function _assertSafeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocolo de navegador bloqueado: ${parsed.protocol}`);
  }
  const cacheKey = `${parsed.protocol}//${parsed.hostname}:${parsed.port || ''}`;
  const cached = _hostSafetyCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < 30_000) {
    if (!cached.safe) throw new Error(`URL bloqueada por seguridad: ${cached.reason}`);
    return;
  }
  const safety = await _urlGuard(parsed.href, { timeout: 3000 });
  _hostSafetyCache.set(cacheKey, { ...safety, checkedAt: Date.now() });
  if (_hostSafetyCache.size > 500) {
    const oldest = _hostSafetyCache.keys().next().value;
    if (oldest) _hostSafetyCache.delete(oldest);
  }
  if (!safety.safe) throw new Error(`URL bloqueada por seguridad: ${safety.reason}`);
}

async function _installNetworkPolicy(context) {
  if (_securedContexts.has(context)) return;
  _securedContexts.add(context);
  if (!context || typeof context.route !== 'function') return;
  await context.route('**/*', async (route) => {
    try {
      const requestUrl = route.request().url();
      const protocol = new URL(requestUrl).protocol;
      if (protocol !== 'data:' && protocol !== 'blob:') await _assertSafeUrl(requestUrl);
      await route.continue();
    } catch (error) {
      logger.warn(
        'BrowserBridge',
        `[browser-security] solicitud bloqueada: ${error instanceof Error ? error.message : String(error)}`
      );
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
}

function _trackContextPages(context, mode) {
  for (const existingPage of context.pages()) _pageId(existingPage);
  if (typeof context.on !== 'function') return;
  context.on('page', (newPage) => {
    _pageId(newPage);
    if (mode === 'managed') _managedPage = newPage;
    else if (mode === 'personal') _personalPage = newPage;
    else _page = newPage;
  });
}

/**
 * Navegador visible y aislado que Kaoru sí puede observar y controlar. No se
 * conecta al perfil personal del usuario; conserva únicamente su propio perfil.
 */
async function _ensureManagedBrowser() {
  if (_managedContext && _managedPage && !_managedPage.isClosed()) return _managedPage;
  if (_managedContext) {
    try {
      _managedPage = await _managedContext.newPage();
      _managedPage.setDefaultTimeout(15_000);
      return _managedPage;
    } catch (_) {
      _managedContext = null;
      _managedPage = null;
    }
  }
  if (_managedLaunching) return _managedLaunching;
  _managedLaunching = (async () => {
    if (!_playwright) {
      try {
        _playwright = require('playwright');
      } catch (_) {
        throw new Error('Playwright no está instalado; no se puede controlar el navegador');
      }
    }
    logger.info(
      'BrowserBridge',
      `[browser-bridge] lanzando navegador visible administrado (locale ${_defaultLocale})...`
    );
    _sessionIds.managed = crypto.randomUUID();
    _managedContext = await _playwright.chromium.launchPersistentContext(
      await _managedProfileDir(),
      {
        headless: false,
        viewport: null,
        // El locale muta según el idioma del usuario (AgentLoop lo fija por
        // run desde responseLanguage). Default español, como Kaoru.
        locale: _defaultLocale,
        serviceWorkers: 'block',
        ignoreDefaultArgs: ['--mute-audio'],
      }
    );
    await _installNetworkPolicy(_managedContext);
    _trackContextPages(_managedContext, 'managed');
    const pages = _managedContext.pages();
    _managedPage = pages[0] || (await _managedContext.newPage());
    _managedPage.setDefaultTimeout(15_000);
    logger.info('BrowserBridge', '[browser-bridge] navegador visible listo');
    return _managedPage;
  })();
  try {
    return await _managedLaunching;
  } finally {
    _managedLaunching = null;
  }
}

/**
 * Adjunta el navegador PERSONAL del usuario por CDP (previamente vinculado
 * con consentimiento: lanzado con --remote-debugging-port sobre su perfil).
 * Reutiliza la conexión entre llamadas. Desconectar NO cierra su navegador.
 * @param {string} endpoint p.ej. http://127.0.0.1:9222
 * @param {{chromium?: {connectOverCDP: (endpoint: string) => Promise<unknown>}}} [deps] conector inyectable (tests)
 */
async function connectPersonalBrowser(endpoint, deps = {}) {
  const clean = String(endpoint || '').trim();
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(clean)) {
    throw new Error('El endpoint personal debe ser local (http://127.0.0.1:PUERTO)');
  }
  if (_personalBrowser && _personalContext && _personalPage && !_personalPage.isClosed()) {
    return _personalPage;
  }
  const connector =
    (deps.chromium && deps.chromium.connectOverCDP) ||
    (await _playwrightChromium()).connectOverCDP.bind(await _playwrightChromium());
  _sessionIds.personal = crypto.randomUUID();
  _personalBrowser = await connector(clean);
  const contexts =
    typeof _personalBrowser.contexts === 'function' ? _personalBrowser.contexts() : [];
  _personalContext = contexts[0] || null;
  if (!_personalContext || typeof _personalContext.newPage !== 'function') {
    _personalBrowser = null;
    _personalContext = null;
    throw new Error('El navegador personal no expone un contexto utilizable');
  }
  await _installNetworkPolicy(_personalContext);
  _trackContextPages(_personalContext, 'personal');
  const pages = typeof _personalContext.pages === 'function' ? _personalContext.pages() : [];
  _personalPage =
    pages.find((candidate) => !candidate.isClosed()) || (await _personalContext.newPage());
  _personalPage.setDefaultTimeout(15_000);
  _personalMeta = { endpoint: clean, connectedAt: Date.now() };
  logger.info('BrowserBridge', '[browser-bridge] navegador personal adjuntado (CDP)');
  return _personalPage;
}

/** Cierra la conexión CDP sin cerrar el navegador del usuario. */
async function disconnectPersonalBrowser() {
  const meta = _personalMeta ? { ..._personalMeta } : null;
  if (_personalBrowser && typeof _personalBrowser.close === 'function') {
    await _personalBrowser.close().catch(() => {});
  }
  _personalBrowser = null;
  _personalContext = null;
  _personalPage = null;
  _personalMeta = null;
  return { disconnected: true, previous: meta };
}

function personalBrowserStatus() {
  if (!_personalBrowser || !_personalContext) return { connected: false };
  return {
    connected: true,
    endpoint: _personalMeta?.endpoint || null,
    sessionId: _sessionIds.personal,
  };
}

async function _playwrightChromium() {
  if (!_playwright) {
    try {
      _playwright = require('playwright');
    } catch (_) {
      throw new Error('Playwright no está instalado; no se puede adjuntar el navegador personal');
    }
  }
  return _playwright.chromium;
}

async function _ensurePersonalBrowser() {
  if (_personalContext && _personalPage && !_personalPage.isClosed()) return _personalPage;
  throw new Error(
    'Navegador personal no vinculado: usa personal_browser_link con tu consentimiento primero'
  );
}

/**
 * Detecta desafíos anti-bot (CAPTCHA/recaptcha/turnstile/press&hold) en la
 * página actual. Kaoru NO los resuelve sola: los reporta para que el humano
 * los pase una vez y ella retome (wait_for_clearance). Defensivo: ante
 * cualquier duda devuelve "sin desafío" en vez de bloquear.
 * @param {{locator?: Function, evaluate?: Function, title?: Function}} page
 */
async function _detectChallenge(page) {
  try {
    if (page && typeof page.locator === 'function') {
      const selectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="challenge"]',
        '[data-sitekey]',
        '#captcha',
        '.g-recaptcha',
        'input[name="captcha"]',
        '#px-captcha',
      ];
      for (const selector of selectors) {
        try {
          const count = await page.locator(selector).count();
          if (count > 0) return { challenge: true, kind: 'captcha' };
        } catch (_) {
          swallow('BrowserBridge._detectChallenge');
        }
      }
    }
    let text = '';
    try {
      if (page && typeof page.evaluate === 'function') {
        text = String(
          await page.evaluate(() => String(document.body?.innerText || '').slice(0, 4000))
        );
      }
    } catch (_) {
      swallow('BrowserBridge._detectChallenge');
    }
    try {
      if (page && typeof page.title === 'function' && !text) text = String(await page.title());
    } catch (_) {
      swallow('BrowserBridge._detectChallenge');
    }
    if (
      /captcha|verify you are (a )?human|verifica que no eres|unusual traffic|tr[aá]fico inusual|press (&|and) hold|are you a robot|just a moment|attention required/i.test(
        text
      )
    ) {
      return { challenge: true, kind: 'challenge' };
    }
  } catch (_) {
    swallow('BrowserBridge._detectChallenge');
  }
  return { challenge: false, kind: 'none' };
}

/**
 * Lanza el navegador headless si no está corriendo ya.
 * Reutiliza la misma instancia entre llamadas para no pagar el costo
 * de arrancar Chromium en cada acción.
 */
async function _ensureBrowser() {
  if (_browser && _page && !_page.isClosed()) return _page;
  if (_launching) return _launching;

  _launching = (async () => {
    try {
      _playwright = require('playwright');
    } catch (e) {
      throw new Error(
        'Playwright no está instalado. Ejecuta:\n' +
          '  npm install playwright\n' +
          '  npx playwright install chromium'
      );
    }

    logger.info('BrowserBridge', '[browser-bridge] lanzando Chromium headless...');
    _sessionIds.background = crypto.randomUUID();
    _browser = await _playwright.chromium.launch({ headless: true });
    if (typeof _browser.newContext === 'function') {
      _backgroundContext = await _browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        serviceWorkers: 'block',
      });
      await _installNetworkPolicy(_backgroundContext);
      _trackContextPages(_backgroundContext, 'background');
      _page = await _backgroundContext.newPage();
    } else {
      _page = await _browser.newPage({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      });
    }
    logger.info('BrowserBridge', '[browser-bridge] navegador listo');
    return _page;
  })();

  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

/**
 * Cierra el navegador. Llamar al cerrar la app (app.on('before-quit')).
 */
async function closeBrowser() {
  // La conexión personal se suelta SIN cerrar el navegador del usuario.
  await disconnectPersonalBrowser().catch(() => {});
  if (_managedContext) {
    await _managedContext.close().catch(() => {});
    _managedContext = null;
    _managedPage = null;
  }
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _backgroundContext = null;
    _page = null;
    logger.info('BrowserBridge', '[browser-bridge] navegador cerrado');
  }
  if (_fallbackProfileDir) {
    const ownedPrefix = path.join(os.tmpdir(), 'kaoru-browser-profile-');
    if (_fallbackProfileDir.startsWith(ownedPrefix)) {
      await fs.promises.rm(_fallbackProfileDir, { recursive: true, force: true }).catch(() => {});
    }
    _fallbackProfileDir = '';
  }
}

// ── Acciones de browser ────────────────────────────────────────────────────────

/**
 * Ejecuta una acción de navegador.
 *
 * @param {object} input
 * @param {string} input.action
 * @param {string} [input.url]
 * @param {string} [input.selector]
 * @param {string} [input.role]
 * @param {string} [input.name]
 * @param {string} [input.text]
 * @param {string} [input.label]
 * @param {string} [input.placeholder]
 * @param {string} [input.value]
 * @param {string} [input.key]
 * @param {'background'|'managed'} [input.mode]
 */
async function executeBrowserAction(input) {
  const { action, url, selector } = input;
  const mode =
    input.mode === 'managed' ? 'managed' : input.mode === 'personal' ? 'personal' : 'background';
  let page;
  if (mode === 'managed') page = await _ensureManagedBrowser();
  else if (mode === 'personal') page = await _ensurePersonalBrowser();
  else page = await _ensureBrowser();
  const context =
    mode === 'managed'
      ? _managedContext
      : mode === 'personal'
        ? _personalContext
        : _backgroundContext;
  const pages = context && typeof context.pages === 'function' ? context.pages() : [page];
  if (input.sessionId && input.sessionId !== _sessionIds[mode]) {
    throw new Error('La sesión del navegador cambió; ejecuta browser snapshot nuevamente');
  }
  if (input.pageId) {
    const selected = pages.find((candidate) => _pageId(candidate) === input.pageId);
    if (!selected || selected.isClosed()) {
      throw new Error('La pestaña cambió o se cerró; ejecuta browser tabs nuevamente');
    }
    page = selected;
  }

  const pageMeta = () => ({
    sessionId: _sessionIds[mode],
    pageId: _pageId(page),
    url: String(page.url()),
    origin: _origin(page.url()),
    mode,
  });
  const scopedActions = new Set([
    'click',
    'type',
    'press',
    'back',
    'forward',
    'select',
    'check',
    'uncheck',
    'hover',
    'scroll',
    'close_tab',
    'select_tab',
    'get_text',
    'wait_for',
    'screenshot',
    'upload',
    'download',
    'dialog',
    'wait_for_clearance',
  ]);
  if (scopedActions.has(action)) {
    if (!input.sessionId || !input.pageId || !input.expectedOrigin) {
      throw new Error(
        'La acción requiere sessionId, pageId y expectedOrigin de una observación reciente'
      );
    }
    if (_origin(page.url()) !== String(input.expectedOrigin)) {
      throw new Error('El origen de la página cambió; observa nuevamente antes de interactuar');
    }
  }

  const locatorForInput = () => {
    if (selector) return page.locator(selector).first();
    if (input.role) {
      const role = String(input.role).trim();
      if (!/^[a-z][a-z0-9_-]{0,30}$/i.test(role)) throw new Error('Rol no permitido');
      return page.getByRole(role, input.name ? { name: String(input.name) } : {}).first();
    }
    if (input.label) return page.getByLabel(String(input.label)).first();
    if (input.placeholder) return page.getByPlaceholder(String(input.placeholder)).first();
    if (input.text) return page.getByText(String(input.text), { exact: false }).first();
    throw new Error(`${action} requiere selector, role, label, placeholder o text`);
  };

  const ensureFinalUrlSafe = async () => {
    const current = String(page.url());
    if (_origin(current) !== 'null') await _assertSafeUrl(current);
  };

  // Desafío anti-bot tras navegar/actuar: Kaoru NO resuelve CAPTCHAs sola
  // (evasión de bots: poco fiable y contra ToS). Lo detecta, lo reporta con
  // requiresUserAction y el humano lo pasa una vez; wait_for_clearance retoma.
  const withChallengeCheck = async (result) => {
    const found = await _detectChallenge(page);
    if (found.challenge) {
      return {
        ...result,
        humanChallenge: { kind: found.kind, requiresUserAction: true },
        intentVerified: false,
        status: 'executed_unverified',
      };
    }
    return result;
  };

  switch (action) {
    case 'navigate': {
      if (!url) throw new Error('navigate requiere "url"');
      await _assertSafeUrl(url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await ensureFinalUrlSafe();
      const title = await page.title();
      return {
        result: await withChallengeCheck({
          ...pageMeta(),
          title,
          status: 'completed',
          verified: true,
        }),
      };
    }

    case 'wait_for_clearance': {
      const timeout = Math.min(120_000, Math.max(1000, Number(input.timeout) || 60_000));
      const deadline = Date.now() + timeout;
      let cleared = false;
      do {
        const found = await _detectChallenge(page);
        cleared = !found.challenge;
        if (!cleared && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } while (!cleared && Date.now() < deadline);
      return {
        result: {
          ...pageMeta(),
          status: cleared ? 'completed' : 'timeout',
          verified: cleared,
          requiresUserAction: !cleared,
        },
      };
    }

    case 'tabs': {
      const tabs = await Promise.all(
        pages
          .filter((candidate) => !candidate.isClosed())
          .map(async (candidate) => ({
            pageId: _pageId(candidate),
            url: String(candidate.url()),
            origin: _origin(candidate.url()),
            title: await candidate.title().catch(() => ''),
            active: candidate === page,
          }))
      );
      return { result: { sessionId: _sessionIds[mode], mode, tabs } };
    }

    case 'new_tab': {
      if (!context || typeof context.newPage !== 'function') {
        throw new Error('La sesión actual no admite pestañas');
      }
      page = await context.newPage();
      if (mode === 'managed') _managedPage = page;
      else if (mode === 'personal') _personalPage = page;
      else _page = page;
      if (url) {
        await _assertSafeUrl(url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await ensureFinalUrlSafe();
      }
      return { result: { ...pageMeta(), status: 'completed', verified: true } };
    }

    case 'select_tab':
      await page.bringToFront();
      if (mode === 'managed') _managedPage = page;
      else if (mode === 'personal') _personalPage = page;
      else _page = page;
      return { result: { ...pageMeta(), status: 'completed', verified: true } };

    case 'close_tab': {
      const closedPageId = _pageId(page);
      await page.close();
      const remaining = pages.filter((candidate) => !candidate.isClosed());
      if (remaining.length) {
        if (mode === 'managed') _managedPage = remaining[0];
        else if (mode === 'personal') _personalPage = remaining[0];
        else _page = remaining[0];
      }
      return {
        result: {
          sessionId: _sessionIds[mode],
          pageId: closedPageId,
          status: 'completed',
          verified: page.isClosed(),
        },
      };
    }

    case 'snapshot': {
      let accessibility = '';
      const body = page.locator('body').first();
      if (typeof body.ariaSnapshot === 'function') {
        accessibility = await body.ariaSnapshot({ timeout: 15_000 }).catch(() => '');
      }
      if (!accessibility) {
        accessibility = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('button,a,input,textarea,select,[role]')];
          return nodes
            .slice(0, 300)
            .map((element, index) => {
              const role = element.getAttribute('role') || element.tagName.toLowerCase();
              const label =
                element.getAttribute('aria-label') ||
                element.getAttribute('placeholder') ||
                element.textContent ||
                '';
              return `${index + 1}. ${role}: ${String(label).trim().slice(0, 160)}`;
            })
            .join('\n');
        });
      }
      return {
        result: {
          ...pageMeta(),
          title: await page.title(),
          accessibility: wrapUntrusted(String(accessibility).slice(0, 20_000)),
        },
      };
    }

    case 'click': {
      const beforeUrl = String(page.url());
      await locatorForInput().click({ timeout: 15_000 });
      await page.waitForTimeout?.(150);
      await ensureFinalUrlSafe();
      return {
        result: await withChallengeCheck({
          ...pageMeta(),
          executed: true,
          actionVerified: true,
          intentVerified: Boolean(
            input.expectedUrl && String(page.url()).includes(input.expectedUrl)
          ),
          status:
            input.expectedUrl && String(page.url()).includes(input.expectedUrl)
              ? 'completed'
              : 'executed_unverified',
          previousUrl: beforeUrl,
        }),
      };
    }

    case 'type': {
      const value = String(input.value ?? '');
      if (value.length > 4000) throw new Error('Texto demasiado largo');
      const locator = locatorForInput();
      await locator.fill(value, { timeout: 15_000 });
      const actual = typeof locator.inputValue === 'function' ? await locator.inputValue() : value;
      return {
        result: await withChallengeCheck({
          ...pageMeta(),
          executed: true,
          actionVerified: actual === value,
          intentVerified: actual === value,
          status: actual === value ? 'completed' : 'verification_failed',
          valueLength: value.length,
        }),
      };
    }

    case 'press': {
      const key = String(input.key || '').trim();
      if (!/^[A-Za-z0-9+_{}()-]{1,40}$/.test(key)) throw new Error('Tecla no permitida');
      const hasTarget = selector || input.role || input.label || input.placeholder || input.text;
      if (hasTarget) await locatorForInput().press(key, { timeout: 15_000 });
      else await page.keyboard.press(key);
      await page.waitForTimeout?.(150);
      await ensureFinalUrlSafe();
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: true,
          intentVerified: false,
          status: 'executed_unverified',
        },
      };
    }

    case 'select': {
      const option = String(input.option ?? input.value ?? '');
      if (!option || option.length > 500) throw new Error('select requiere una opción válida');
      const locator = locatorForInput();
      const selected = await locator
        .selectOption({ label: option })
        .catch(() => locator.selectOption(option));
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: Array.isArray(selected) && selected.length > 0,
          intentVerified: Array.isArray(selected) && selected.length > 0,
          status:
            Array.isArray(selected) && selected.length > 0 ? 'completed' : 'verification_failed',
        },
      };
    }

    case 'check':
    case 'uncheck': {
      const locator = locatorForInput();
      if (action === 'check') await locator.check({ timeout: 15_000 });
      else await locator.uncheck({ timeout: 15_000 });
      const checked = await locator.isChecked();
      const verified = action === 'check' ? checked : !checked;
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: verified,
          intentVerified: verified,
          status: verified ? 'completed' : 'verification_failed',
        },
      };
    }

    case 'hover':
      await locatorForInput().hover({ timeout: 15_000 });
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: true,
          intentVerified: false,
          status: 'executed_unverified',
        },
      };

    case 'upload': {
      const filePath = await _workspaceFile(input.path, true);
      await locatorForInput().setInputFiles(filePath, { timeout: 15_000 });
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: true,
          intentVerified: true,
          status: 'completed',
          file: path.basename(filePath),
        },
      };
    }

    case 'download': {
      const destination = await _workspaceFile(input.path, false);
      const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
      await locatorForInput().click({ timeout: 15_000 });
      const download = await downloadPromise;
      await download.saveAs(destination);
      const stat = await fs.promises.stat(destination);
      const verified = stat.isFile() && stat.size >= 0;
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: verified,
          intentVerified: verified,
          status: verified ? 'completed' : 'verification_failed',
          path: destination,
          bytes: stat.size,
        },
      };
    }

    case 'dialog': {
      const dialog = _pendingDialogs.get(page);
      if (!dialog) throw new Error('No hay un diálogo pendiente en esta pestaña');
      const dialogAction = input.dialogAction === 'dismiss' ? 'dismiss' : 'accept';
      if (dialogAction === 'dismiss') await dialog.dismiss();
      else await dialog.accept(String(input.value || '').slice(0, 1000));
      _pendingDialogs.delete(page);
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: true,
          intentVerified: true,
          status: 'completed',
          dialogAction,
        },
      };
    }

    case 'scroll': {
      const direction = ['up', 'down', 'left', 'right'].includes(input.direction)
        ? input.direction
        : 'down';
      const before = await page.evaluate(() => ({ x: globalThis.scrollX, y: globalThis.scrollY }));
      const delta = { up: [0, -600], down: [0, 600], left: [-600, 0], right: [600, 0] }[direction];
      await page.mouse.wheel(delta[0], delta[1]);
      const after = await page.evaluate(() => ({ x: globalThis.scrollX, y: globalThis.scrollY }));
      const changed = before.x !== after.x || before.y !== after.y;
      return {
        result: {
          ...pageMeta(),
          executed: true,
          actionVerified: changed,
          intentVerified: changed,
          status: changed ? 'completed' : 'verification_failed',
        },
      };
    }

    case 'wait_for': {
      const timeout = Math.min(20_000, Math.max(250, Number(input.timeout) || 10_000));
      await locatorForInput().waitFor({ state: 'visible', timeout });
      return { result: { ...pageMeta(), status: 'completed', verified: true } };
    }

    case 'get_text': {
      if (selector || input.role || input.label || input.placeholder || input.text) {
        const text = await locatorForInput()
          .textContent({ timeout: 15_000 })
          .catch(() => null);
        if (text === null) throw new Error(`No se encontró el elemento: ${selector}`);
        return { result: { ...pageMeta(), text: wrapUntrusted(text.trim()) } };
      }
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      return { result: { ...pageMeta(), text: wrapUntrusted(bodyText.slice(0, 5000)) } };
    }

    case 'screenshot': {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 60,
        animations: 'disabled',
        scale: 'css',
      });
      return {
        result: {
          ...pageMeta(),
          mimeType: 'image/jpeg',
          byteLength: buffer.length,
          dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
        },
      };
    }

    case 'get_url':
      return { result: pageMeta() };

    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await ensureFinalUrlSafe();
      return { result: { ...pageMeta(), status: 'completed', verified: true } };

    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await ensureFinalUrlSafe();
      return { result: { ...pageMeta(), status: 'completed', verified: true } };

    default:
      throw new Error(`Acción de navegador desconocida: ${action}`);
  }
}

// ── web_search real ───────────────────────────────────────────────────────────

/**
 * Búsqueda real usando el navegador propio del asistente.
 * Navega a Google, extrae título + URL + snippet de los resultados orgánicos.
 *
 * @param {object} input
 * @param {string} input.query
 * @param {number} [input.max_results]
 */
async function executeWebSearch(input) {
  const { query, max_results = 5 } = input;
  if (!query) throw new Error('web_search requiere "query"');

  const page = await _ensureBrowser();
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=es`;

  logger.info('BrowserBridge', `[browser-bridge] web_search: "${query}"`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Extraer resultados orgánicos del DOM de Google.
  // Los selectores de Google cambian con frecuencia; este es robusto
  // a varias variantes comunes del HTML de resultados.
  const results = await page.evaluate((max) => {
    const items = [];
    const blocks = document.querySelectorAll('div.g, div[data-sokoban-container]');

    for (const block of blocks) {
      if (items.length >= max) break;

      const titleEl = block.querySelector('h3');
      const linkEl = block.querySelector('a');
      const snippetEl = block.querySelector('div[data-sncf], div.VwiC3b, span.aCOpRe');

      if (titleEl && linkEl?.href) {
        items.push({
          title: titleEl.innerText.trim(),
          url: linkEl.href,
          snippet: snippetEl ? snippetEl.innerText.trim() : '',
        });
      }
    }
    return items;
  }, max_results);

  if (!results.length && _rssFallback) {
    // Fallback sin DOM ni captchas: Bing RSS por HTTPS plano (verificado en
    // vivo: Google/DuckDuckGo bloquean scraping desde ciertas redes mientras
    // Bing RSS responde 200 con resultados). Mantiene vivo el resolver
    // universal cuando el buscador primario falla.
    try {
      const fallback = await _rssFallback(query, max_results);
      if (Array.isArray(fallback) && fallback.length) {
        logger.info(
          'BrowserBridge',
          `[browser-bridge] web_search: ${fallback.length} resultados (Bing RSS)`
        );
        return { result: wrapUntrustedItems(fallback) };
      }
    } catch (e) {
      logger.warn('BrowserBridge', `[browser-bridge] fallback RSS falló: ${e.message}`);
    }
  }

  if (!results.length) {
    return {
      result: [],
      error:
        'No se encontraron resultados (Google pudo haber cambiado su HTML, o hay un captcha bloqueando)',
    };
  }

  // P3: los snippets de resultados son contenido de terceros → límite de
  // confianza (delimitación + neutralización de patrones de inyección).
  logger.info('BrowserBridge', `[browser-bridge] web_search: ${results.length} resultados`);
  return { result: wrapUntrustedItems(results) };
}

/**
 * Busca vía Bing RSS (HTTPS plano, sin JS ni DOM): `format=rss` devuelve
 * <item> con title/link/description. Probado en vivo contra bloqueos que
 * tumban Google y DuckDuckGo. La URL pasa por el mismo candado que el resto.
 * @param {string} rawQuery
 * @param {number} maxResults
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
function _fetchBingRss(rawQuery, maxResults) {
  const https = require('https');
  const feedUrl = `https://www.bing.com/search?q=${encodeURIComponent(rawQuery)}&format=rss`;
  return _assertSafeUrl(feedUrl).then(
    () =>
      new Promise((resolve, reject) => {
        const req = https.get(
          feedUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
              Accept: 'application/rss+xml',
            },
            timeout: 15000,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`Bing RSS respondió HTTP ${res.statusCode}`));
              return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
              if (body.length > 512 * 1024) {
                res.destroy();
                reject(new Error('Bing RSS excedió el tamaño máximo'));
              }
            });
            res.on('end', () => {
              try {
                resolve(_parseRssItems(body, maxResults));
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('timeout', () => {
          req.destroy(new Error('Bing RSS agotó el tiempo'));
        });
        req.on('error', reject);
      })
  );
}

/** @param {string} xml @param {number} maxResults */
function _parseRssItems(xml, maxResults) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const unescape = (s) =>
    String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  let match;
  while ((match = itemRe.exec(xml)) !== null && items.length < maxResults) {
    const block = match[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block);
    const link = /<link>([\s\S]*?)<\/link>/.exec(block);
    const description = /<description>([\s\S]*?)<\/description>/.exec(block);
    const url = unescape(link && link[1]).trim();
    if (!/^https:\/\//.test(url)) continue;
    items.push({
      title:
        unescape(title && title[1])
          .trim()
          .slice(0, 200) || url,
      url,
      snippet: unescape(description && description[1])
        .trim()
        .slice(0, 300),
    });
  }
  return items;
}

let _rssFallback = _fetchBingRss;

function _normalizeMediaQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query || query.length > 200) throw new Error('Consulta de video inválida');
  if ([...query].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('Consulta de video contiene caracteres no permitidos');
  }
  return query;
}

function _youtubeWatchUrl(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let resolved;
  try {
    resolved = new URL(candidate, 'https://www.youtube.com/');
  } catch (_) {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(resolved.hostname)) return null;
  const shortId = resolved.hostname === 'youtu.be' ? resolved.pathname.slice(1) : '';
  if (resolved.hostname !== 'youtu.be' && resolved.pathname !== '/watch') return null;
  const videoId = shortId || resolved.searchParams.get('v') || '';
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
  resolved.protocol = 'https:';
  resolved.hostname = 'www.youtube.com';
  resolved.pathname = '/watch';
  resolved.search = '';
  resolved.searchParams.set('v', videoId);
  resolved.searchParams.set('autoplay', '1');
  return resolved.href;
}

/** @param {unknown} value */
function _mediaTerms(value) {
  return (
    String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}

/**
 * Selecciona localmente el resultado cuyo título mejor cubre artista/tema.
 * El texto de la página solo influye en el ranking; el URL todavía pasa por
 * `_youtubeWatchUrl`, que restringe host, ruta e id.
 * @param {string} query
 * @param {Array<{title?:unknown,href?:unknown,url?:unknown}>} candidates
 */
function _rankYouTubeCandidates(query, candidates) {
  const queryTerms = [...new Set(_mediaTerms(query))];
  const normalizedQuery = queryTerms.join(' ');
  return (
    candidates
      .map((candidate, index) => {
        const url = _youtubeWatchUrl(candidate.href || candidate.url);
        if (!url) return null;
        const titleTerms = _mediaTerms(candidate.title);
        const title = titleTerms.join(' ');
        const coverage = queryTerms.filter((term) => titleTerms.includes(term)).length;
        const exactBonus =
          normalizedQuery && title.includes(normalizedQuery) ? queryTerms.length + 2 : 0;
        return { url, score: coverage * 10 + exactBonus - index * 0.01 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]?.url || null
  );
}

async function _dismissYouTubeConsent(page) {
  if (!page || typeof page.getByRole !== 'function') return;
  const accept = page
    .getByRole('button', {
      name: /^(accept all|aceptar todo|i agree|acepto|agree|同意する)$/i,
    })
    .first();
  if ((await accept.count().catch(() => 0)) > 0) {
    await accept.click({ timeout: 3000 }).catch(() => {});
  }
}

/**
 * Espera el renderer dinámico y usa tres contratos independientes: locator,
 * ytInitialData y HTML serializado. Solo sale un URL /watch validado.
 */
async function _locateYouTubeWatchUrl(page, query) {
  const candidates = await page
    .evaluate(() =>
      [...document.querySelectorAll('ytd-video-renderer a#video-title[href*="watch?v="]')]
        .slice(0, 20)
        .map((element) => ({
          title: element.getAttribute('title') || element.textContent || '',
          href: element.getAttribute('href') || '',
        }))
    )
    .catch(() => []);
  if (Array.isArray(candidates)) {
    const ranked = _rankYouTubeCandidates(query, candidates);
    if (ranked) return ranked;
  }
  if (page && typeof page.locator === 'function') {
    const videoLink = page
      .locator(
        'ytd-video-renderer a#video-title[href*="watch?v="], a#video-title[href*="watch?v="]'
      )
      .first();
    try {
      await videoLink.waitFor({ state: 'attached', timeout: 12_000 });
      const located = _youtubeWatchUrl(await videoLink.getAttribute('href'));
      if (located) return located;
    } catch (_) {
      swallow('BrowserBridge._locateYouTubeWatchUrl');
    }
  }

  const fromPage = await page
    .evaluate(() => {
      const direct = document.querySelector(
        'ytd-video-renderer a#video-title[href*="watch?v="], a#video-title[href*="watch?v="]'
      );
      const href = direct?.getAttribute('href');
      if (href) return href;
      const queue = [globalThis.ytInitialData];
      let visited = 0;
      while (queue.length && visited++ < 20_000) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        if (value.videoRenderer && typeof value.videoRenderer.videoId === 'string') {
          return `/watch?v=${value.videoRenderer.videoId}`;
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') queue.push(child);
        }
      }
      return null;
    })
    .catch(() => null);
  const structured = _youtubeWatchUrl(fromPage);
  if (structured) return structured;

  if (page && typeof page.content === 'function') {
    const html = await page.content().catch(() => '');
    const match = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{6,20})"/);
    const serialized = _youtubeWatchUrl(match ? `/watch?v=${match[1]}` : null);
    if (serialized) return serialized;
  }
  return null;
}

async function _searchYouTube(page, query) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
  await _assertSafeUrl(searchUrl);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await _dismissYouTubeConsent(page);
  const watchUrl = await _locateYouTubeWatchUrl(page, query);
  if (watchUrl) return watchUrl;

  // Segundo contrato independiente. Si el renderer de YouTube cambia o queda
  // bloqueado por consentimiento, una búsqueda web todavía puede entregar un
  // enlace /watch validable. Nunca se confía en el texto del resultado.
  const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `site:youtube.com/watch ${query}`
  )}&hl=es`;
  await _assertSafeUrl(fallbackUrl);
  await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  const googleCandidate = await page
    .locator('a[href*="youtube.com/watch?v="], a[href*="youtu.be/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);
  const fallbackWatchUrl = _youtubeWatchUrl(googleCandidate);
  if (fallbackWatchUrl) return fallbackWatchUrl;

  const pageText = await page
    .evaluate(() => String(document.body?.innerText || '').slice(0, 2000))
    .catch(() => '');
  if (
    /captcha|unusual traffic|tráfico inusual|verify you are human|verifica que eres humano/i.test(
      pageText
    )
  ) {
    throw new Error(
      'La búsqueda requiere verificación humana (CAPTCHA); el navegador quedó abierto para continuar manualmente'
    );
  }
  throw new Error(
    'No se encontró un video verificable mediante YouTube ni el buscador alternativo; la interfaz pudo cambiar'
  );
}

/**
 * Resuelve el primer video orgánico de YouTube sin confiar en texto de la web.
 * @param {string} rawQuery
 * @returns {Promise<string>}
 */
async function findFirstYouTubeVideo(rawQuery) {
  const query = _normalizeMediaQuery(rawQuery);
  return _searchYouTube(await _ensureBrowser(), query);
}

/**
 * Verifica que un <video> realmente avanza (no basta con "play pulsado").
 * Contrato compartido por búsqueda, URL directa y último video de un canal.
 * @param {{evaluate: Function, locator: Function, waitForFunction?: Function}} page
 */
async function _awaitPlayback(page) {
  const playButton = page.locator('.ytp-large-play-button, button.ytp-play-button').first();
  let playing = await page
    .evaluate(() => {
      const media = document.querySelector('video');
      return Boolean(media && !media.paused && media.readyState >= 2);
    })
    .catch(() => false);
  if (!playing) {
    await playButton.click({ timeout: 10_000 }).catch(() => {});
    playing = await page
      .waitForFunction(
        () => {
          const media = document.querySelector('video');
          return Boolean(media && !media.paused && media.readyState >= 2);
        },
        null,
        { timeout: 10_000 }
      )
      .then(() => true)
      .catch(() => false);
  }
  if (playing) {
    playing = await page
      .waitForFunction(
        () => {
          const media = document.querySelector('video');
          if (!media || media.paused || media.readyState < 2) return false;
          const marker = '__kaoruPlaybackStart';
          const previous = Number(globalThis[marker]);
          if (!Number.isFinite(previous)) {
            globalThis[marker] = media.currentTime;
            return false;
          }
          return media.currentTime > previous + 0.25;
        },
        null,
        { timeout: 5000, polling: 250 }
      )
      .then(() => true)
      .catch(() => false);
  }
  return playing;
}

/** @param {unknown} rawHandle @returns {string} handle normalizado sin @ ni URL */
function _normalizeChannelHandle(rawHandle) {
  let handle = String(rawHandle || '').trim();
  const atMatch = /@([A-Za-z0-9._-]{1,60})/.exec(handle);
  if (atMatch) return atMatch[1];
  const pathMatch = /\byoutube\.com\/(?:c|user|channel)\/([A-Za-z0-9._-]{1,60})/i.exec(handle);
  if (pathMatch) return pathMatch[1];
  handle = handle.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) throw new Error('Canal de YouTube inválido');
  return handle;
}

/**
 * Ojos para "ponme lo más reciente de <canal>": abre la pestaña de videos del
 * canal en orden de subida y devuelve el PRIMER /watch válido (el más
 * reciente). Solo sale una URL validada por _youtubeWatchUrl.
 * @param {string} rawHandle @nissaxter, nissaxter, URL del canal...
 */
async function findLatestChannelVideo(rawHandle) {
  const handle = _normalizeChannelHandle(rawHandle);
  const page = await _ensureBrowser();
  const candidates = [
    `https://www.youtube.com/@${handle}/videos`,
    `https://www.youtube.com/c/${handle}/videos`,
    `https://www.youtube.com/user/${handle}/videos`,
  ];
  for (const channelUrl of candidates) {
    await _assertSafeUrl(channelUrl);
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await _dismissYouTubeConsent(page);
    // El renderer de YouTube hidrata DESPUÉS de domcontentloaded: esperar el
    // primer enlace antes de leer, si no el DOM sale vacío (falso negativo).
    // Las páginas de canal usan ytd-rich-item-renderer con anchors SIN id
    // (a#video-title solo aparece en búsquedas): se cubren ambas formas.
    const CHANNEL_LINK_SELECTOR =
      'ytd-rich-item-renderer a[href*="watch?v="], a#video-title[href*="watch?v="]';
    if (page && typeof page.locator === 'function') {
      await page
        .locator(CHANNEL_LINK_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 12_000 })
        .catch(() => {});
    }
    const first = await page
      .evaluate(
        (selector) =>
          [...document.querySelectorAll(selector)]
            .slice(0, 5)
            .map((element) => element.getAttribute('href') || ''),
        CHANNEL_LINK_SELECTOR
      )
      .catch(() => []);
    for (const href of Array.isArray(first) ? first : []) {
      const watchUrl = _youtubeWatchUrl(href);
      if (watchUrl) return watchUrl;
    }
  }
  throw new Error(
    `No encontré videos recientes del canal "${handle}"; verifica el nombre del canal`
  );
}

/**
 * Reproduce una URL /watch ya validada en el navegador visible y verifica
 * reproducción real. Misma evidencia que la búsqueda (playing + verified).
 * @param {string} watchUrl URL https de youtube.com/watch validada
 * @param {string} [label] etiqueta para el reporte (canal o consulta)
 */
async function playYouTubeUrl(watchUrl, label = '') {
  const validated = _youtubeWatchUrl(watchUrl);
  if (!validated) throw new Error('URL de video inválida para reproducción');
  const page = await _ensureManagedBrowser();
  await page.goto(validated, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await _dismissYouTubeConsent(page);
  const playing = await _awaitPlayback(page);
  await page.bringToFront();
  return {
    kind: 'media',
    service: 'youtube',
    query: label,
    url: validated,
    browser: 'kaoru-managed-chromium',
    playing,
    verified: playing,
    requiresUserAction: !playing,
  };
}

/**
 * Abre un navegador visible administrado por Kaoru, navega al video y verifica
 * si el elemento multimedia realmente comenzó a reproducirse.
 * @param {string} rawQuery
 */
async function playYouTubeMedia(rawQuery) {
  const query = _normalizeMediaQuery(rawQuery);
  const page = await _ensureManagedBrowser();
  const watchUrl = await _searchYouTube(page, query);
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await _dismissYouTubeConsent(page);

  const playing = await _awaitPlayback(page);
  await page.bringToFront();
  return {
    kind: 'media',
    service: 'youtube',
    query,
    url: watchUrl,
    browser: 'kaoru-managed-chromium',
    playing,
    verified: playing,
    requiresUserAction: !playing,
  };
}

let _defaultLocale = 'es-MX';
/**
 * Fija el locale del navegador managed para el próximo lanzamiento. Lo llama
 * AgentLoop al arrancar cada run desde responseLanguage (idioma inferido del
 * usuario). Valida formato BCP-47 simple; cualquier valor raro cae al default.
 * @param {unknown} locale
 */
function setDefaultLocale(locale) {
  const clean = String(locale || '').trim();
  if (/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(clean)) {
    _defaultLocale = clean;
  }
}

module.exports = {
  executeBrowserAction,
  executeWebSearch,
  findFirstYouTubeVideo,
  findLatestChannelVideo,
  playYouTubeMedia,
  playYouTubeUrl,
  connectPersonalBrowser,
  disconnectPersonalBrowser,
  personalBrowserStatus,
  closeBrowser,
  setDefaultLocale,
  _youtubeWatchUrl,
  _rankYouTubeCandidates,
  _installNetworkPolicy,
  _assertSafeUrl,
  _setUrlGuardForTests: (guard) => {
    _urlGuard = typeof guard === 'function' ? guard : isUrlSafe;
    _hostSafetyCache.clear();
  },
  _setRssFallbackForTests: (fallback) => {
    // null explícito = sin fallback (tests deterministas sin red).
    _rssFallback =
      fallback === null ? null : typeof fallback === 'function' ? fallback : _fetchBingRss;
  },
  _detectChallengeForTests: _detectChallenge,
};
