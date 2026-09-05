// @ts-check
'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const server = new Server({ name: 'local-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
server.connect(new StdioServerTransport()).catch(() => {
  process.exitCode = 1;
});
