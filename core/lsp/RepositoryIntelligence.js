// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_FILES = 1800;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.cjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
  '.vue',
]);
const RESOLVE_EXTENSIONS = ['', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json'];
const TASK_STOP_WORDS = new Set([
  'agente',
  'aplica',
  'aplicar',
  'archivo',
  'como',
  'codigo',
  'código',
  'debe',
  'desde',
  'esta',
  'este',
  'hacer',
  'implementar',
  'para',
  'proyecto',
  'tarea',
  'todo',
  'with',
]);
const SENSITIVE_FILE_RE =
  /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db))$/i;

/** @typedef {{path:string,size:number,mtimeMs:number}} FileRecord */
/** @typedef {{from:string,to:string}} DependencyEdge */
/** @typedef {{root:string,generatedAt:number,truncated:boolean,files:FileRecord[],edges:DependencyEdge[],scripts:Record<string,string>,manifests:string[]}} RepositoryIndex */

/** @param {unknown} value */
function _slash(value) {
  return String(value || '')
    .split(path.sep)
    .join('/')
    .replace(/^\.\//, '');
}

/** @param {unknown} value */
function _keywords(value) {
  return [
    ...new Set(
      String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[a-z0-9_][a-z0-9_.-]{2,}/g) || []
    ),
  ]
    .filter((word) => !TASK_STOP_WORDS.has(word))
    .slice(0, 30);
}

/** @param {string} file */
function _isTest(file) {
  return /(^|\/)(?:tests?|__tests__|spec)(\/|$)|(?:^|[._-])(?:test|spec)\.[^/]+$/i.test(file);
}

/** @param {string} file */
function _isManifest(file) {
  return /(^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|requirements[^/]*\.txt)$/i.test(
    file
  );
}

/** @param {string} specifier @param {string} from @param {Set<string>} known */
function _resolveLocalDependency(specifier, from, known) {
  if (!specifier.startsWith('.')) return null;
  const base = _slash(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  for (const extension of RESOLVE_EXTENSIONS) {
    const direct = `${base}${extension}`;
    if (known.has(direct)) return direct;
  }
  for (const extension of RESOLVE_EXTENSIONS.slice(1)) {
    const index = `${base}/index${extension}`;
    if (known.has(index)) return index;
  }
  return null;
}

/** @param {string} content */
function _dependencySpecifiers(content) {
  const found = new Set();
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content))) found.add(match[1]);
  }
  return [...found];
}

/** @param {string} file @param {string[]} keywords */
function _relevance(file, keywords) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  let score = 0;
  for (const keyword of keywords) {
    if (base.includes(keyword)) score += 8;
    else if (lower.includes(keyword)) score += 3;
  }
  if (/^(?:main|index|app|server)\.[^.]+$/i.test(base)) score += 2;
  if (_isTest(file)) score -= 1;
  return score;
}

/** @param {unknown} error */
function _errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} value */
function _shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class RepositoryIntelligence {
  /**
   * @param {{workspace?:string|(()=>string|null|undefined),getSymbols?:(file:string)=>Promise<any[]>,cachePath?:string|null,maxFiles?:number,maxFileBytes?:number,cacheTtlMs?:number,now?:()=>number}} [options]
   */
  constructor(options = {}) {
    this._workspace = options.workspace || process.cwd();
    this._getSymbols = options.getSymbols || (async () => []);
    this._cachePath = options.cachePath || null;
    this._maxFiles = Math.max(100, Number(options.maxFiles) || DEFAULT_MAX_FILES);
    this._maxFileBytes = Math.max(4096, Number(options.maxFileBytes) || DEFAULT_MAX_BYTES);
    this._cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    this._now = options.now || Date.now;
    /** @type {RepositoryIndex|null} */
    this._index = null;
    this._dirty = false;
  }

  _root() {
    const value = typeof this._workspace === 'function' ? this._workspace() : this._workspace;
    return path.resolve(String(value || process.cwd()));
  }

  /** @param {string[]} [files] */
  invalidate(files = []) {
    this._dirty = true;
    if (!files.length) this._index = null;
  }

  /** @returns {Promise<RepositoryIndex>} */
  async index() {
    const root = this._root();
    const current = this._index;
    if (
      !this._dirty &&
      current &&
      current.root === root &&
      this._now() - current.generatedAt < this._cacheTtlMs
    ) {
      return current;
    }
    const persisted = await this._readCache(root);
    if (!this._dirty && persisted) {
      this._index = persisted;
      return persisted;
    }
    const index = await this._scan(root);
    this._index = index;
    this._dirty = false;
    await this._writeCache(index);
    return index;
  }

  /** @param {string} task */
  async analyze(task) {
    const index = await this.index();
    const keywords = _keywords(task);
    const known = new Set(index.files.map((file) => file.path));
    const seeds = index.files
      .map((file) => ({ path: file.path, score: _relevance(file.path, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 16);
    const seedPaths = seeds.map((item) => item.path);
    const dependencies = new Set();
    const dependents = new Set();
    for (const edge of index.edges) {
      if (seedPaths.includes(edge.from)) dependencies.add(edge.to);
      if (seedPaths.includes(edge.to)) dependents.add(edge.from);
    }
    const relatedNames = new Set(
      [...seedPaths, ...dependencies, ...dependents].map((file) =>
        path.posix.basename(file, path.posix.extname(file)).replace(/^(?:test|spec)[._-]?/i, '')
      )
    );
    const tests = index.files
      .map((file) => file.path)
      .filter(_isTest)
      .filter((file) => {
        if (!seedPaths.length) return false;
        const lower = file.toLowerCase();
        return [...relatedNames].some(
          (name) => name.length > 2 && lower.includes(name.toLowerCase())
        );
      })
      .slice(0, 20);
    const symbolFiles = seedPaths
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
      .slice(0, 6);
    const symbols = [];
    for (const file of symbolFiles) {
      try {
        const found = await this._getSymbols(path.join(index.root, file));
        if (Array.isArray(found) && found.length) {
          symbols.push({
            file,
            items: found.slice(0, 12).map((item) => ({
              name: String(item?.name || '').slice(0, 120),
              kind: String(item?.kindName || item?.kind || '').slice(0, 40),
              line: Math.max(0, Number(item?.line) || 0),
            })),
          });
        }
      } catch (_) {}
    }
    return {
      ...index,
      keywords,
      candidates: seeds,
      impact: {
        seeds: seedPaths,
        dependencies: [...dependencies].slice(0, 30),
        dependents: [...dependents].slice(0, 30),
        tests,
      },
      symbols,
      knownFiles: known.size,
    };
  }

  /**
   * Calcula el radio de impacto de archivos realmente mutados. Los comandos
   * focales solo se producen cuando el repositorio ofrece el runner explícito
   * `tests/run-all.sh`; no se inventan flags para runners desconocidos.
   * @param {string[]} changedFiles
   */
  async analyzeFiles(changedFiles) {
    const index = await this.index();
    const rootPrefix = `${index.root}${path.sep}`;
    const seeds = [
      ...new Set(
        changedFiles
          .map((file) => path.resolve(index.root, file))
          .filter((file) => file === index.root || file.startsWith(rootPrefix))
          .map((file) => _slash(path.relative(index.root, file)))
          .filter((file) => index.files.some((known) => known.path === file))
      ),
    ];
    const dependencies = new Set();
    const dependents = new Set();
    let frontier = seeds.slice();
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next = [];
      for (const edge of index.edges) {
        if (frontier.includes(edge.from) && !dependencies.has(edge.to)) {
          dependencies.add(edge.to);
        }
        if (frontier.includes(edge.to) && !dependents.has(edge.from)) {
          dependents.add(edge.from);
          next.push(edge.from);
        }
      }
      frontier = next;
    }
    const baseNames = new Set(
      [...seeds, ...dependencies, ...dependents].map((file) =>
        path.posix.basename(file, path.posix.extname(file)).replace(/^(?:test|spec)[._-]?/i, '')
      )
    );
    const tests = index.files
      .map((file) => file.path)
      .filter(_isTest)
      .filter(
        (file) =>
          seeds.includes(file) ||
          dependents.has(file) ||
          [...baseNames].some(
            (name) => name.length > 2 && file.toLowerCase().includes(name.toLowerCase())
          )
      )
      .slice(0, 30);
    const commands = [];
    const runnableTests = tests.filter((file) => /(^|\/)test_[^/]+\.js$/.test(file));
    if (runnableTests.length && index.files.some((file) => file.path === 'tests/run-all.sh')) {
      commands.push(`bash tests/run-all.sh ${runnableTests.map(_shellQuote).join(' ')}`);
    }
    const touchedRuntime = seeds.some((file) => !(_isTest(file) || /README|docs\//i.test(file)));
    const fanOut = dependents.size;
    const risk = !touchedRuntime ? 'low' : fanOut >= 12 ? 'high' : fanOut >= 4 ? 'medium' : 'low';
    return {
      seeds,
      dependencies: [...dependencies].slice(0, 50),
      dependents: [...dependents].slice(0, 50),
      tests,
      commands,
      risk,
      rationale: tests.length
        ? `${tests.length} prueba(s) vinculadas por dependencias o nombre`
        : 'No se pudo inferir una prueba focal; conservar verificación general',
    };
  }

  /** @param {string} task @param {{maxChars?:number}} [options] */
  async buildPlanningContext(task, options = {}) {
    const analysis = await this.analyze(task);
    const lines = [
      '# INTELIGENCIA DEL REPOSITORIO',
      `Raíz: ${analysis.root}`,
      `Índice: ${analysis.knownFiles} archivos, ${analysis.edges.length} dependencias locales${analysis.truncated ? ' (truncado)' : ''}.`,
      `Términos: ${analysis.keywords.join(', ') || '(sin coincidencias específicas)'}`,
      `Scripts: ${Object.keys(analysis.scripts).join(', ') || '(no detectados)'}`,
      `Manifiestos: ${analysis.manifests.join(', ') || '(no detectados)'}`,
      'Archivos candidatos:',
      ...(analysis.candidates.length
        ? analysis.candidates.map((item) => `- ${item.path} (relevancia ${item.score})`)
        : ['- Sin candidatos fiables; inspeccionar antes de editar.']),
      'Impacto estructural inicial:',
      `- Dependencias: ${analysis.impact.dependencies.join(', ') || '(ninguna detectada)'}`,
      `- Dependientes: ${analysis.impact.dependents.join(', ') || '(ninguno detectado)'}`,
      `- Pruebas relacionadas: ${analysis.impact.tests.join(', ') || '(ninguna inferida)'}`,
    ];
    for (const group of analysis.symbols) {
      lines.push(
        `Símbolos ${group.file}: ${group.items.map((item) => `${item.kind} ${item.name}:${item.line + 1}`).join(', ')}`
      );
    }
    lines.push(
      'Este mapa es evidencia de reconocimiento, no autorización. Confirma contenido y referencias con read/LSP antes de mutar.'
    );
    return lines.join('\n').slice(0, Math.max(2000, Number(options.maxChars) || 9000));
  }

  /** @param {string} root @returns {Promise<RepositoryIndex>} */
  async _scan(root) {
    /** @type {FileRecord[]} */
    const files = [];
    let truncated = false;
    /** @param {string} directory */
    const visit = async (directory) => {
      if (files.length >= this._maxFiles) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (_) {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= this._maxFiles) {
          truncated = true;
          break;
        }
        if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
          continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = _slash(path.relative(root, absolute));
        if (SENSITIVE_FILE_RE.test(relative)) continue;
        try {
          const stat = await fs.promises.stat(absolute);
          files.push({
            path: relative,
            size: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
          });
        } catch (_) {}
      }
    };
    await visit(root);
    const known = new Set(files.map((file) => file.path));
    /** @type {DependencyEdge[]} */
    const edges = [];
    for (const file of files) {
      if (!SOURCE_EXTENSIONS.has(path.extname(file.path)) || file.size > this._maxFileBytes)
        continue;
      let content;
      try {
        content = await fs.promises.readFile(path.join(root, file.path), 'utf8');
      } catch (_) {
        continue;
      }
      for (const specifier of _dependencySpecifiers(content)) {
        const target = _resolveLocalDependency(specifier, file.path, known);
        if (target) edges.push({ from: file.path, to: target });
      }
    }
    /** @type {Record<string,string>} */
    let scripts = {};
    const packageFile = files.find((file) => file.path === 'package.json');
    if (packageFile && packageFile.size <= this._maxFileBytes) {
      try {
        const parsed = JSON.parse(
          await fs.promises.readFile(path.join(root, 'package.json'), 'utf8')
        );
        if (parsed?.scripts && typeof parsed.scripts === 'object') {
          scripts = Object.fromEntries(
            Object.entries(parsed.scripts)
              .filter((entry) => typeof entry[1] === 'string')
              .slice(0, 40)
          );
        }
      } catch (_) {}
    }
    return {
      root,
      generatedAt: this._now(),
      truncated,
      files,
      edges,
      scripts,
      manifests: files
        .map((file) => file.path)
        .filter(_isManifest)
        .slice(0, 30),
    };
  }

  /** @param {string} root @returns {Promise<RepositoryIndex|null>} */
  async _readCache(root) {
    if (!this._cachePath || this._dirty) return null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this._cachePath, 'utf8'));
      if (
        parsed?.root === root &&
        Array.isArray(parsed.files) &&
        Array.isArray(parsed.edges) &&
        this._now() - Number(parsed.generatedAt) < this._cacheTtlMs
      ) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  /** @param {RepositoryIndex} index */
  async _writeCache(index) {
    if (!this._cachePath) return;
    const temporary = `${this._cachePath}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
      await fs.promises.rename(temporary, this._cachePath);
    } catch (error) {
      try {
        await fs.promises.unlink(temporary);
      } catch (_) {}
      if (process.env.DEBUG) console.warn('[repository-intelligence] cache:', _errorText(error));
    }
  }
}

module.exports = {
  RepositoryIntelligence,
  DEFAULT_MAX_FILES,
  _dependencySpecifiers,
  _resolveLocalDependency,
};
