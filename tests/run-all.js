#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Runner portable para todas las suites. Cada archivo corre con el Node de
 * Electron porque better-sqlite3/sqlite-vec están reconstruidos para su ABI.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const electron = require('electron');
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[mK]`, 'g');

/** @param {string} directory @returns {string[]} */
function suitesIn(directory) {
  const absolute = path.join(root, directory);
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test_.*\.js$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

/** @param {string} value @returns {string} */
function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, '');
}

/** @param {string} suite @returns {Promise<{ code: number, output: string }>} */
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(electron, [suite], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
    child.once('close', (code) => resolve({ code: code === null ? 1 : code, output }));
  });
}

async function main() {
  if (typeof electron !== 'string' || !fs.existsSync(electron)) {
    throw new Error(`no se encontró el binario de Electron en: ${electron}`);
  }

  if (!fs.existsSync(path.join(root, 'data', 'core.db'))) {
    console.warn('⚠ No existe data/core.db; ejecuta npm run init-db antes de la regresión.');
  }

  const requested = process.argv.slice(2);
  const suites = requested.length
    ? requested
    : [...suitesIn('tests'), ...suitesIn(path.join('tests', 'e2e'))].sort();
  let totalPassed = 0;
  let totalFailed = 0;
  const failedSuites = [];

  for (const suite of suites) {
    const absolute = path.resolve(root, suite);
    if (!fs.existsSync(absolute)) {
      console.log(`── ${suite} (no existe, omitida)`);
      continue;
    }

    console.log(`\n────────────────── ${suite} ──────────────────`);
    const result = await runSuite(suite);
    const clean = stripAnsi(result.output);
    const summary = clean
      .split(/\r?\n/)
      .filter((line) => line.includes('Resultado'))
      .pop();
    const passed = Number(summary?.match(/(\d+) passed/)?.[1] || 0);
    const reportedFailed = Number(summary?.match(/(\d+) failed/)?.[1] || 0);
    totalPassed += passed;

    if (result.code === 0) {
      totalFailed += reportedFailed;
      console.log(`  ✔  ${summary || 'suite completada'}`);
    } else {
      totalFailed += reportedFailed || 1;
      failedSuites.push(suite);
      console.log(`  ✘  ${summary || 'sin resumen'}   (exit ${result.code})`);
      // El detalle completo permite diagnosticar fallos que solo se reproducen
      // en un runner de otro sistema operativo, especialmente Windows.
      console.log(clean.trimEnd());
    }
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  RESULTADO GLOBAL:  ${totalPassed} passed · ${totalFailed} failed`);
  if (failedSuites.length) {
    console.log(`  Fallaron: ${failedSuites.join(' ')}`);
    process.exitCode = 1;
  } else {
    console.log('  TODAS LAS SUITES EN VERDE');
  }
  console.log('══════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
