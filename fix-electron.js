const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('ℹ fix-electron: no es Windows, sin cambios.');
  process.exit(0);
}

const electronDir = path.join(__dirname, 'node_modules', 'electron');
const distDir     = path.join(electronDir, 'dist');
const pathFile    = path.join(electronDir, 'path.txt');
const electronExe = path.join(distDir, 'electron.exe');

if (fs.existsSync(electronExe)) {
  writePath();
  console.log('✅ fix-electron: electron.exe encontrado, path.txt listo.');
  process.exit(0);
}

let version;
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
  version = pkg.version;
} catch(e) {
  console.error('❌ fix-electron: no se pudo leer la versión de Electron.');
  process.exit(1);
}

const zipName = `electron-v${version}-win32-x64.zip`;
const zipPath = path.join(distDir, zipName);
const url     = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;

console.log(`📦 fix-electron: descargando Electron v${version}...`);

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

downloadFile(url, zipPath, (err) => {
  if (err) {
    console.error('❌ fix-electron: error al descargar:', err.message);
    process.exit(1);
  }

  console.log('\n📂 fix-electron: extrayendo...');

  // Pequeña pausa para asegurar que el SO libere el handle del archivo
  setTimeout(() => {
    const result = spawnSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force`
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
      console.error('❌ fix-electron: error al extraer ZIP.');
      process.exit(1);
    }

    try { fs.unlinkSync(zipPath); } catch(_) {}

    if (!fs.existsSync(electronExe)) {
      console.error('❌ fix-electron: electron.exe no apareció tras extraer.');
      process.exit(1);
    }

    writePath();
    console.log('✅ fix-electron: Electron instalado correctamente.');
  }, 1000); // espera 1 segundo antes de extraer
});

function writePath() {
  fs.writeFileSync(pathFile, 'electron.exe', { encoding: 'utf8' });
}

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  let received = 0;

  const get = (u, redirects) => {
    if (redirects > 5) return cb(new Error('Demasiadas redirecciones'));
    const mod = u.startsWith('https') ? https : http;
    mod.get(u, { headers: { 'User-Agent': 'nodejs-electron-fix' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location, redirects + 1);
      }
      if (res.statusCode !== 200) {
        return cb(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0');
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.round(received / total * 100);
          process.stdout.write(`\r   Descargando... ${pct}% (${Math.round(received/1024/1024)}MB / ${Math.round(total/1024/1024)}MB)`);
        }
      });
      res.pipe(file);
      // ✅ cb() va DENTRO de file.close() para asegurar que el handle se libera
      file.on('finish', () => file.close(() => cb(null)));
      file.on('error', cb);
    }).on('error', cb);
  };

  get(url, 0);
}