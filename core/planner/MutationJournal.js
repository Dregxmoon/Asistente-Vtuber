// @ts-check
'use strict';

const path = require('path');
const AP = require('./ActionParser.js');

const DIRECT_MUTATORS = new Set([
  'write',
  'edit',
  'apply_patch',
  'create_file',
  'edit_file',
  'code_execution',
  'rename',
  'git_add',
  'git_commit',
  'git_stash',
  'git_merge',
  'git_rebase',
  'git_push',
  'github_issue_create',
  'github_issue_comment',
  'github_issue_close',
  'github_pr_create',
  'github_pr_review',
]);

const DIRECTLY_VERIFIABLE_MUTATORS = new Set([
  'git_commit',
  'git_push',
  'github_issue_create',
  'github_issue_comment',
  'github_issue_close',
  'github_pr_create',
  'github_pr_review',
]);

const EXEC_MUTATION_RE =
  /(?:^|\s)(?:rm|mv|cp|mkdir|touch|truncate|install)\b|(?:^|\s)sed\s+-i\b|(?:^|\s)(?:npm|pnpm|yarn)\s+(?:i|install|add|remove)\b|(?:>|>>)/i;

/** @param {any} action */
function isMutatingAction(action) {
  const tool = String(action?.tool || '');
  const params = action?.params || {};
  if (DIRECT_MUTATORS.has(tool)) return true;
  if (tool === 'exec') return EXEC_MUTATION_RE.test(String(params.command || ''));
  if (tool === 'mcp') return !AP.isMCPToolReadOnly(String(params.tool || ''));
  // Los plugins son código externo. Pueden declarar explícitamente readOnly;
  // ante ausencia de metadata se tratan como mutadores para no dar por
  // verificada una acción externa sin evidencia.
  if (tool === 'plugin') return params.readOnly !== true && params.read_only !== true;
  return false;
}

/** @param {unknown} value @param {string} cwd @returns {string|null} */
function absolutePath(value, cwd) {
  if (!value || typeof value !== 'string') return null;
  const clean = value.trim().replace(/^['"]|['"]$/g, '');
  if (!clean || clean === '/dev/null') return null;
  return path.resolve(cwd, clean);
}

/** Extrae rutas que pueden capturarse antes de ejecutar una mutación.
 * @param {any} action @param {string} [cwd] @returns {string[]}
 */
function extractMutationPaths(action, cwd = AP.PROJECT_CWD || process.cwd()) {
  const params = action?.params || {};
  const values = [params.path, params.filePath, params.newPath, params.destination];
  if (action?.tool === 'mcp' && params.args && typeof params.args === 'object') {
    values.push(params.args.path, params.args.filePath, params.args.destination);
  }
  const patch = String(params.patch || params.instructions || '');
  for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) values.push(match[1]);
  if (action?.tool === 'exec') {
    const command = String(params.command || '');
    for (const match of command.matchAll(/(?:>|>>)\s*(?:['"]([^'"]+)['"]|([^\s;&|]+))/g)) {
      values.push(match[1] || match[2]);
    }
  }
  /** @type {string[]} */
  const paths = [];
  for (const value of values) {
    const resolved = absolutePath(value, cwd);
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

/** @param {any} result */
function isSuccessfulMutationResult(result) {
  if (!result?.ok) return false;
  return isMutatingAction(result._action || { tool: result.tool, params: result.params || {} });
}

class MutationJournal {
  /** @param {{cwd?:string}} [opts] */
  constructor(opts = {}) {
    this.cwd = opts.cwd || AP.PROJECT_CWD || process.cwd();
    /** @type {Array<any>} */
    this.entries = [];
    /** @type {Set<string>} */
    this.files = new Set();
  }

  /** @param {any} result @param {any} action */
  record(result, action) {
    if (!result?.ok || !isMutatingAction(action)) return null;
    const files = extractMutationPaths(action, this.cwd);
    for (const file of files) this.files.add(file);
    const entry = {
      tool: String(action.tool || result.tool || ''),
      files,
      at: Date.now(),
      reversible: files.length > 0,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Incorpora efectos confirmados por un ejecutor anidado.
   * @param {any} serialized @param {string} [source]
   */
  merge(serialized, source = 'subagent') {
    if (!serialized || typeof serialized !== 'object') return;
    for (const file of serialized.files || []) {
      const absolute = absolutePath(file, this.cwd);
      if (absolute) this.files.add(absolute);
    }
    for (const entry of serialized.entries || []) {
      this.entries.push({ ...entry, source });
    }
  }

  toJSON() {
    return {
      count: this.entries.length,
      files: [...this.files],
      entries: this.entries.slice(),
    };
  }
}

module.exports = {
  MutationJournal,
  DIRECT_MUTATORS,
  DIRECTLY_VERIFIABLE_MUTATORS,
  isMutatingAction,
  isSuccessfulMutationResult,
  extractMutationPaths,
};
