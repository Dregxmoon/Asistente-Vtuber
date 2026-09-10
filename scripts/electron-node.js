#!/usr/bin/env node
// @ts-check
'use strict';

// Ejecuta un script con el Node integrado de Electron en Linux, macOS y
// Windows, sin sintaxis de variables de entorno dependiente del shell.
const { spawn } = require('child_process');
const electron = require('electron');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Uso: node scripts/electron-node.js <script> [...args]');
  process.exitCode = 1;
} else {
  const child = spawn(electron, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    if (signal) console.error(`Electron terminó por señal ${signal}`);
    process.exitCode = code === null ? 1 : code;
  });
}
