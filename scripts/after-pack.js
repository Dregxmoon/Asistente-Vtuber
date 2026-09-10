// @ts-check
'use strict';

// electron-builder hook: compila el launcher AppContainer en el runner nativo
// de Windows y lo coloca junto a app.asar. Así el primer arranque instalado no
// necesita invocar Add-Type; los clones mantienen la compilación como fallback.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** @param {string} executable @param {string[]} args @returns {Promise<void>} */
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`compilador AppContainer terminó con código ${code}`));
    });
  });
}

/** @param {{ electronPlatformName: string, appOutDir: string }} context */
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' || process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot no está definido en el build de Windows');
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  if (!fs.existsSync(powershell)) throw new Error(`PowerShell 5.1 no encontrado: ${powershell}`);

  const script = path.join(__dirname, '..', 'core', 'sandbox', 'compile-windows-sandbox.ps1');
  const output = path.join(context.appOutDir, 'resources', 'Kaoru.WindowsSandbox.exe');
  await run(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-OutputPath',
    output,
  ]);
  if (!fs.existsSync(output)) throw new Error('PowerShell no produjo Kaoru.WindowsSandbox.exe');
}

module.exports = afterPack;
module.exports.run = run;
