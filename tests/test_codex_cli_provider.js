// @ts-check
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findCodexCommand,
  buildPrompt,
  callCodexCli,
  _TOOL_OUTPUT_SCHEMA,
} = require('../core/llm/CodexCliProvider.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

function testDiscoveryAndCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-codex-path-'));
  const command = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(command, '');
    fs.chmodSync(command, 0o755);
    process.env.PATH = dir;
    assert.equal(findCodexCommand(), command, 'detecta el CLI desde PATH');
    const provider = LLMProvider.getAvailableProviders().find((item) => item.id === 'codex-cli');
    assert(provider);
    assert.equal(provider.hasKey, true);
    assert.equal(provider.type, 'codex-cli');
    assert.deepEqual(provider.catalog, ['local-account']);
    const picker = LLMProvider.getModelPickerData();
    assert(picker.models.some((model) => model.providerId === 'codex-cli' && model.tools));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPromptBoundary() {
  const prompt = buildPrompt(
    [
      { role: 'user', content: 'Revisa mi calendario' },
      { role: 'assistant', content: 'Voy a revisarlo.' },
    ],
    'Eres Kaoru.',
    [
      {
        name: 'calendar_list',
        description: 'Lista eventos',
        inputSchema: { type: 'object', properties: { day: { type: 'string' } } },
      },
    ]
  );
  assert(prompt.includes('Eres Kaoru.'));
  assert(prompt.includes('USER: Revisa mi calendario'));
  assert(prompt.includes('No ejecutes herramientas por tu cuenta'));
  assert(prompt.includes('paramsJson'));
  assert(prompt.includes('calendar_list'));
  assert.equal(_TOOL_OUTPUT_SCHEMA.additionalProperties, false);
}

async function testPreCancelledRun() {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    callCodexCli([{ role: 'user', content: 'No ejecutar' }], 'Sistema', 'fast', [], {
      signal: controller.signal,
    }),
    (error) => error && error.name === 'AbortError' && error.code === 'ABORTED'
  );
}

(async () => {
  testDiscoveryAndCatalog();
  console.log('✓ testDiscoveryAndCatalog');
  testPromptBoundary();
  console.log('✓ testPromptBoundary');
  await testPreCancelledRun();
  console.log('✓ testPreCancelledRun');
  console.log('Resultado: 3 passed  0 failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
