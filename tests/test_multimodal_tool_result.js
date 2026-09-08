'use strict';

const { AgentLoop } = require('../core/planner/AgentLoop.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

let failed = 0;
function assert(condition, label) {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failed++;
}

const loop = new AgentLoop({ bridge: { execute: async () => ({ ok: true }) } });
const dataUrl = `data:image/jpeg;base64,${Buffer.from('image').toString('base64')}`;
const message = loop._buildToolResultMessage({
  ok: true,
  tool: 'desktop_screenshot',
  result: { mimeType: 'image/jpeg', byteLength: 5, dataUrl },
});
assert(Array.isArray(message) && message[1].type === 'image_url', 'AgentLoop conserva la imagen');

const anthropic = LLMProvider._debug_providerMessageContent(message, 'anthropic');
assert(
  anthropic[1].type === 'image' && anthropic[1].source.media_type === 'image/jpeg',
  'convierte imagen al contrato Anthropic'
);
const gemini = LLMProvider._debug_providerMessageContent(message, 'gemini');
assert(gemini[1].inline_data.mime_type === 'image/jpeg', 'convierte imagen al contrato Gemini');
const openai = LLMProvider._debug_providerMessageContent(message, 'openai');
assert(openai[1].image_url.url === dataUrl, 'conserva contrato OpenAI compatible');

if (failed) process.exit(1);
