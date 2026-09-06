// @ts-nocheck
// mcp.js — API pública de servidores MCP (listar, añadir, quitar, alternar y
// buscar en el registro).

const state = require('./state.js');

function mcpOnAccountAuthenticated(callback) {
  const { getMCPManager } = require('../mcp/MCPManager.js');
  getMCPManager().setOnAccountAuthenticated(callback);
}

async function mcpListServers() {
  return state.mcp ? state.mcp.listServers() : [];
}

async function mcpStartGoogleAuth(id, service) {
  if (!state.mcp) throw new Error('MCP no inicializado');
  return state.mcp.callTool(id, 'start_google_auth', {
    service_name: service,
    // workspace-mcp reconoce 'default' como selección de cuenta sin login_hint.
    // Una cadena vacía es rechazada por start_google_auth antes de iniciar OAuth.
    user_google_email: 'default',
  });
}

async function mcpAddServer(serverCfg) {
  if (!state.mcp) throw new Error('MCP no inicializado');
  return state.mcp.addServer(serverCfg);
}

async function mcpRemoveServer(id) {
  if (state.mcp) await state.mcp.removeServer(id);
}

async function mcpToggleServer(id, enabled, serverCfg) {
  if (state.mcp) await state.mcp.toggleServer(id, enabled, serverCfg);
}

async function mcpSearchRegistry(query, options = {}) {
  return state.mcp ? state.mcp.searchRegistry(query, options) : [];
}

async function mcpGetFeatured(limit = 24) {
  return state.mcp ? state.mcp.getFeaturedServers(limit) : [];
}

function mcpGetCategories() {
  return state.mcp ? state.mcp.getCategories() : [];
}

module.exports = {
  mcpStartGoogleAuth,
  mcpOnAccountAuthenticated,
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
  mcpGetFeatured,
  mcpGetCategories,
};
