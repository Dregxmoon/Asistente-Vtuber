'use strict';

const { getToolSchemas } = require('../core/llm/ToolSchemas.js');
const { ToolRegistry } = require('../core/task/ToolRegistry.js');

const registry = new ToolRegistry();
const native = new Map(getToolSchemas().map((tool) => [tool.name, tool]));
const catalog = [
  ...registry._getDesktopTools(),
  ...registry._getOpenClawTools().filter((tool) => tool.name === 'browser'),
];
let failed = 0;

for (const tool of catalog) {
  const schema = native.get(tool.name);
  if (!schema) {
    console.error(`✗ ${tool.name}: ausente del schema nativo`);
    failed++;
    continue;
  }
  const nativeParams = new Set(Object.keys(schema.inputSchema?.properties || {}));
  const catalogParams = new Set((tool.params || []).map((param) => param.name));
  const missing = [...nativeParams].filter((name) => !catalogParams.has(name));
  const extra = [...catalogParams].filter((name) => !nativeParams.has(name));
  if (missing.length || extra.length) {
    console.error(`✗ ${tool.name}: drift missing=${missing.join(',')} extra=${extra.join(',')}`);
    failed++;
  } else {
    console.log(`✓ ${tool.name}: catálogo y schema coinciden`);
  }
}

if (failed) process.exit(1);
