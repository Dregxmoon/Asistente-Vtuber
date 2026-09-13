// @ts-check
'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');

/**
 * UserPreferences.js — memoria viva mínima para escritorio/web (T17-lite).
 *
 * "Como la otra vez": cuando una resolución por búsqueda tiene éxito, se
 * recuerda qué host ganó para esos términos. La próxima vez el resolver lo
 * prefiere sin preguntar. También guarda preferencias explícitas (tienda,
 * TLD) que ganan a lo inferido. Archivo local JSON, escritura atómica,
 * fallos silenciosos (nunca rompen una tarea).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function _defaultPath() {
  return path.join(os.homedir(), '.config', 'kaoru', 'user_preferences.json');
}

/** @param {unknown} value */
function _terms(value) {
  return (
    String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) || []
  );
}

class UserPreferences {
  /** @param {{filePath?: string}} [options] */
  constructor(options = {}) {
    this._filePath = options.filePath || _defaultPath();
    /** @type {{resolutions: Record<string, {host: string, count: number, at: number}>, explicit: Record<string, string>}|null} */
    this._cache = null;
  }

  /**
   * @returns {{resolutions: Record<string, {host: string, count: number, at: number}>, explicit: Record<string, string>}}
   */
  _load() {
    if (this._cache) return this._cache;
    /** @type {{resolutions: Record<string, {host: string, count: number, at: number}>, explicit: Record<string, string>}} */
    const data = { resolutions: {}, explicit: {} };
    try {
      if (fs.existsSync(this._filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          if (parsed.resolutions && typeof parsed.resolutions === 'object') {
            Object.assign(data.resolutions, parsed.resolutions);
          }
          if (parsed.explicit && typeof parsed.explicit === 'object') {
            for (const [key, value] of Object.entries(parsed.explicit)) {
              if (typeof value === 'string') data.explicit[String(key)] = value;
            }
          }
        }
      }
    } catch (_) {
      swallow('UserPreferences._load');
    }
    this._cache = data;
    return data;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this._filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._cache), 'utf8');
      fs.renameSync(tmp, this._filePath);
      try {
        fs.chmodSync(this._filePath, 0o600);
      } catch (_) {
        swallow('UserPreferences._save');
      }
    } catch (_) {
      swallow('UserPreferences._save');
    }
  }

  /**
   * Registra que una consulta se resolvió a un host (llamado tras éxito).
   * @param {unknown} query
   * @param {unknown} url
   */
  recordResolution(query, url) {
    try {
      const terms = [...new Set(_terms(query))].slice(0, 6);
      const host = new URL(String(url)).hostname.toLowerCase();
      if (!terms.length || !host) return;
      const data = this._load();
      for (const term of terms) {
        const prev = data.resolutions[term];
        data.resolutions[term] =
          prev && prev.host === host
            ? { host, count: prev.count + 1, at: Date.now() }
            : { host, count: 1, at: Date.now() };
      }
      // Tope anti-crecimiento: conserva las 200 entradas más recientes.
      const entries = Object.entries(data.resolutions).sort((a, b) => b[1].at - a[1].at);
      if (entries.length > 200) {
        data.resolutions =
          /** @type {Record<string, {host: string, count: number, at: number}>} */ (
            Object.fromEntries(entries.slice(0, 200))
          );
      }
      this._save();
    } catch (_) {
      swallow('UserPreferences.recordResolution');
    }
  }

  /**
   * Preferencia explícita del usuario (gana a lo inferido).
   * @param {unknown} key p.ej. 'store', 'tld'
   * @param {unknown} value
   */
  setExplicit(key, value) {
    const cleanKey = String(key || '')
      .trim()
      .toLowerCase()
      .slice(0, 40);
    const cleanValue = String(value || '')
      .trim()
      .slice(0, 120);
    if (!cleanKey || !cleanValue) return;
    const data = this._load();
    data.explicit[cleanKey] = cleanValue;
    this._save();
  }

  /** @param {unknown} key */
  getExplicit(key) {
    const data = this._load();
    return (
      data.explicit[
        String(key || '')
          .trim()
          .toLowerCase()
      ] || null
    );
  }

  /**
   * Host preferido para una consulta (explícito > inferido con count>=2).
   * @param {unknown} query
   * @returns {string|null}
   */
  preferredHost(query) {
    try {
      const data = this._load();
      const explicitStore = data.explicit.store;
      if (explicitStore) {
        try {
          return new URL(
            explicitStore.startsWith('http') ? explicitStore : `https://${explicitStore}`
          ).hostname.toLowerCase();
        } catch (_) {
          swallow('UserPreferences.preferredHost');
        }
      }
      const votes = new Map();
      for (const term of _terms(query)) {
        const entry = data.resolutions[term];
        if (entry && entry.count >= 2)
          votes.set(entry.host, (votes.get(entry.host) || 0) + entry.count);
      }
      let best = null;
      let bestVotes = 0;
      for (const [host, count] of votes) {
        if (count > bestVotes) {
          bestVotes = count;
          best = host;
        }
      }
      return best;
    } catch (_) {
      return null;
    }
  }

  clearCache() {
    this._cache = null;
  }
}

module.exports = { UserPreferences };
