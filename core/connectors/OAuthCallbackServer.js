// @ts-check
'use strict';

const http = require('http');

/** @typedef {{createdAt: number, processing?: boolean, tokens?: Record<string,string>, error?: string, [key:string]: any}} OAuthState */

class OAuthCallbackServer {
  /**
   * @param {Map<string, OAuthState>} states
   * @param {(state: OAuthState, code: string) => Promise<Record<string,string>>} exchange
   * @param {{port?:number, ttlMs?:number}} [options]
   */
  constructor(states, exchange, options = {}) {
    this.states = states;
    this.exchange = exchange;
    this.port = options.port ?? 18790;
    this.ttlMs = options.ttlMs ?? 600000;
    /** @type {http.Server|null} */
    this.server = null;
    /** @type {Promise<string>|null} */
    this.starting = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.sweep = null;
  }

  /** @returns {Promise<string>} */
  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server = server;
      server.once('error', () => {
        this.starting = null;
        this.server = null;
        reject(new Error('No se pudo abrir el puerto de retorno OAuth'));
      });
      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return;
        server.unref();
        this.sweep = setInterval(() => {
          for (const [key, value] of this.states) {
            if (Date.now() - value.createdAt > this.ttlMs) this.states.delete(key);
          }
          if (!this.states.size) this.close();
        }, 30000);
        this.sweep.unref();
        resolve(`http://127.0.0.1:${address.port}/mcp/oauth/callback`);
      });
    });
    return this.starting;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async handle(req, res) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/mcp/oauth/callback') {
      res.writeHead(404).end('Ruta no disponible');
      return;
    }
    const key = url.searchParams.get('state') || '';
    const data = this.states.get(key);
    if (!data || Date.now() - data.createdAt > this.ttlMs) {
      if (data) this.states.delete(key);
      res.writeHead(400).end('Estado OAuth inválido o expirado');
      return;
    }
    if (data.processing || data.tokens || data.error) {
      res.writeHead(409).end('Este retorno OAuth ya fue procesado');
      return;
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      data.error = 'Autorización cancelada o rechazada por el proveedor';
      res.writeHead(400).end(data.error);
      return;
    }
    data.processing = true;
    try {
      const tokens = await this.exchange(data, code);
      if (this.states.get(key) !== data || Date.now() - data.createdAt > this.ttlMs) {
        res.writeHead(400).end('Estado OAuth expirado');
        return;
      }
      data.tokens = tokens;
      res.end('Autorización completada. Puedes cerrar esta pestaña y volver a Kaoru.');
    } catch (_) {
      data.error = 'No se pudo completar OAuth. Revisa la configuración y vuelve a conectar.';
      res.writeHead(502).end(data.error);
    } finally {
      data.processing = false;
    }
  }

  close() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    this.server?.close();
    this.server = null;
    this.starting = null;
    this.states.clear();
  }
}

module.exports = { OAuthCallbackServer };
