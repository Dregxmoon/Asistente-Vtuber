#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Codemod idempotente: instrumenta `catch` vacíos con SwallowedErrors.swallow().
 *
 * Cubre:
 *   - `} catch (_) {}` en una línea
 *   - `} catch {}` en una línea
 *   - `catch (e) {}` en una línea (1 sitio conocido)
 *   - bloques `catch (_) {` / `} catch {` cuyo cuerpo está vacío
 *     (solo la línea de cierre, sin nada entre medio)
 *
 * NO toca: tests/, SwallowedErrors.js, líneas que ya llaman a swallow(.
 * El scope es `Archivo.funcion` (mejor esfuerzo:nearest function hacia arriba,
 * tope 60 líneas; si no hay, `Archivo.top`). Re-ejecutar no duplica nada.
 *
 * Uso: node scripts/codemod-swallowed-errors.js [--check]
 *   --check: solo reporta, no escribe.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET_DIRS = ['core', 'ipc', 'infrastructure'];
const TARGET_FILES = ['main.js', 'openclaw-server.js'];
const HELPER = 'SwallowedErrors.js';

function jsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const d of TARGET_DIRS) walk(path.join(ROOT, d));
  for (const f of TARGET_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) out.push(full);
  }
  return out.filter((f) => !f.endsWith(HELPER));
}

/** require relativo desde `file` hasta core/observability/SwallowedErrors.js */
function requirePath(file) {
  const helper = path.join(ROOT, 'core', 'observability', HELPER);
  let rel = path.relative(path.dirname(file), helper);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.replace(/\\/g, '/');
}

function enclosingScope(lines, catchLineIdx, fileBase) {
  for (let i = catchLineIdx; i >= Math.max(0, catchLineIdx - 60); i--) {
    const line = lines[i];
    let m = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) return `${fileBase}.${m[1]}`;
    m =
      /^\s*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/.exec(
        line
      );
    if (m && !/^(if|for|while|switch|catch|try|else|do)$/.test(m[1])) return `${fileBase}.${m[1]}`;
    m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(line);
    if (m) return `${fileBase}.${m[1]}`;
  }
  return `${fileBase}.top`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let totalChanged = 0;
  let totalFiles = 0;
  for (const file of jsFiles()) {
    const before = fs.readFileSync(file, 'utf8');
    // Simulación en memoria para --check y para no escribir dos veces.
    const res = (() => {
      // Reimplementación ligera: procesa sobre copia y compara.
      return processFileContent(file, before);
    })();
    if (res.changed > 0) {
      totalChanged += res.changed;
      totalFiles++;
      console.log(`  ${path.relative(ROOT, file)}: ${res.changed} sitios`);
      if (!checkOnly) fs.writeFileSync(file, res.src);
    }
  }
  console.log(`\n${checkOnly ? '[check] ' : ''}${totalChanged} sitios en ${totalFiles} archivos.`);
}

/** Versión pura (sin E/S) para poder previsualizar con --check. */
function processFileContent(file, src) {
  if (src.includes('SwallowedErrors')) return { changed: 0, src };
  const lines = src.split('\n');
  const fileBase = path.basename(file, '.js');
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const single =
      /^(.*\}\s*catch\s*\(([_\w$]+)\)\s*\{\s*\}\s*(.*))$/.exec(line) ||
      /^(.*\}\s*catch\s*\{\s*\}\s*(.*))$/.exec(line);
    if (single) {
      const prefix = line.slice(0, line.indexOf('{'));
      const suffix = line.slice(line.lastIndexOf('}') + 1);
      lines[i] = `${prefix}{ swallow('${enclosingScope(lines, i, fileBase)}'); }${suffix}`;
      changed++;
      continue;
    }
    const openMatch = /catch\s*(?:\(([_\w$]+)\))?\s*\{\s*$/.exec(line);
    if (openMatch) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && /^\s*\}\s*$/.test(lines[j])) {
        const indent = (lines[j].match(/^\s*/) || [''])[0] + '  ';
        lines.splice(j, 0, `${indent}swallow('${enclosingScope(lines, i, fileBase)}');`);
        changed++;
      }
    }
  }
  if (changed === 0) return { changed: 0, src };
  const reqLine = `const { swallow } = require('${requirePath(file)}');`;
  const strictIdx = lines.findIndex((l) => l.trim() === "'use strict';");
  lines.splice(strictIdx >= 0 ? strictIdx + 1 : 0, 0, reqLine);
  return { changed, src: lines.join('\n') };
}

main();
