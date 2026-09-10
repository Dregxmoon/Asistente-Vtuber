'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RepositoryIntelligence,
  _dependencySpecifiers,
  _resolveLocalDependency,
} = require('../core/lsp/RepositoryIntelligence.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-repo-intelligence-'));
  const cachePath = path.join(os.tmpdir(), `kaoru-repo-index-${process.pid}.json`);
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'run-all.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(dir, 'tests', 'service.md'), '# Service test documentation\n');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node tests/test_service.js', lint: 'eslint .' } })
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'service.js'),
      "const { helper } = require('./util.js');\nexports.run = () => helper();\n"
    );
    fs.writeFileSync(path.join(dir, 'src', 'util.js'), "exports.helper = () => 'ok';\n");
    fs.writeFileSync(
      path.join(dir, 'tests', 'test_service.js'),
      "const service = require('../src/service.js');\nservice.run();\n"
    );
    fs.mkdirSync(path.join(dir, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'ignored', 'noise.js'), 'throw 1;');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=never-index-this');

    const specs = _dependencySpecifiers(
      "const a = require('./a'); import b from './b.js'; export { c } from './c.js';"
    );
    assert(specs.length === 3, 'extrae dependencias CommonJS y ESM', JSON.stringify(specs));
    assert(
      _resolveLocalDependency('./util', 'src/service.js', new Set(['src/util.js'])) ===
        'src/util.js',
      'resuelve dependencias relativas contra archivos conocidos'
    );

    const symbolsSeen = [];
    const intelligence = new RepositoryIntelligence({
      workspace: dir,
      cachePath,
      getSymbols: async (file) => {
        symbolsSeen.push(file);
        return file.endsWith('service.js') ? [{ name: 'run', kindName: 'Function', line: 1 }] : [];
      },
    });
    const analysis = await intelligence.analyze('corrige el servicio service');
    assert(
      analysis.files.every((file) => !file.path.includes('node_modules')),
      'excluye dependencias y directorios generados'
    );
    assert(
      analysis.files.every((file) => file.path !== '.env'),
      'no persiste nombres de archivos de credenciales conocidos'
    );
    assert(
      analysis.edges.some((edge) => edge.from === 'src/service.js' && edge.to === 'src/util.js'),
      'construye el grafo de dependencias locales'
    );
    assert(
      analysis.impact.tests.includes('tests/test_service.js'),
      'infiere la prueba relacionada con el archivo candidato',
      JSON.stringify(analysis.impact)
    );
    assert(
      analysis.symbols.some((group) => group.file === 'src/service.js'),
      'enriquece candidatos con símbolos del LSP',
      JSON.stringify({ symbolsSeen, symbols: analysis.symbols })
    );
    const context = await intelligence.buildPlanningContext('service');
    assert(
      context.includes('src/service.js') && context.includes('tests/test_service.js'),
      'produce contexto compacto para planificación'
    );
    assert(fs.existsSync(cachePath), 'persiste metadatos estructurales fuera del workspace');

    const impact = await intelligence.analyzeFiles([path.join(dir, 'src', 'util.js')]);
    assert(
      impact.dependents.includes('src/service.js') &&
        impact.dependents.includes('tests/test_service.js'),
      'recorre dependientes transitivos de archivos mutados',
      JSON.stringify(impact)
    );
    assert(
      impact.commands[0]?.includes('bash tests/run-all.sh') === true &&
        !impact.commands[0].includes('service.md'),
      'genera un comando focal solo para el runner conocido'
    );

    const fromCache = new RepositoryIntelligence({ workspace: dir, cachePath });
    const cached = await fromCache.index();
    assert(
      cached.edges.length === analysis.edges.length,
      'reutiliza el índice persistente vigente'
    );

    fs.writeFileSync(path.join(dir, 'src', 'new_feature.js'), 'exports.ok = true;\n');
    fromCache.invalidate([path.join(dir, 'src', 'new_feature.js')]);
    const refreshed = await fromCache.index();
    assert(
      refreshed.files.some((file) => file.path === 'src/new_feature.js'),
      'invalida y reconstruye después de una mutación'
    );

    const AP = require('../core/planner/ActionParser.js');
    const { AgentLoop } = require('../core/planner/AgentLoop.js');
    AP.setProjectCWD(dir);
    const executed = [];
    const loop = new AgentLoop({
      mode: 'smart',
      repositoryIntelligence: intelligence,
      bridge: {
        async execute(tool, params) {
          executed.push({ tool, command: params.command });
          return {
            ok: true,
            result: { stdout: '', stderr: '', exitCode: 0, signal: null },
            tool,
            elapsed: 1,
          };
        },
      },
    });
    intelligence.invalidate([path.join(dir, 'src', 'util.js')]);
    const verification = await loop._runVerify(
      { enabled: true, command: 'npm run lint', commands: ['npm run lint'] },
      [
        {
          ok: true,
          tool: 'edit',
          _action: { tool: 'edit', params: { path: path.join(dir, 'src', 'util.js') } },
        },
      ]
    );
    assert(
      executed[0]?.command.includes('tests/test_service.js') &&
        executed[1]?.command === 'npm run lint',
      'AgentLoop ejecuta prueba focal y después el sello general',
      JSON.stringify(executed)
    );
    assert(
      verification.impact?.relatedTests.includes('tests/test_service.js'),
      'el resultado conserva evidencia del análisis de impacto'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.unlinkSync(cachePath);
    } catch (_) {}
  }

  console.log(`\nResultado: ${passed} passed · ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
