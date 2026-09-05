// @ts-check
'use strict';

/** @param {number} value @param {number} fallback */
function _unit(value, fallback = 0.5) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/**
 * Ordena capacidades con señales observables. La selección no autoriza la
 * ejecución: PermissionManager conserva esa responsabilidad.
 */
class CapabilityRouter {
  /** @param {{stats?:Record<string,any>,mcpHealth?:Record<string,any>}} [options] */
  constructor(options = {}) {
    this.stats = options.stats || {};
    this.mcpHealth = options.mcpHealth || {};
  }

  /** @param {any} tool */
  score(tool) {
    const key = `${tool.source || 'local'}:${tool.server ? `${tool.server}/` : ''}${tool.name}`;
    const stats = this.stats[key] || {};
    const health = tool.source === 'mcp' ? this.mcpHealth[tool.server] || {} : {};
    const reliability = _unit(stats.successRate, stats.uses ? 0 : 0.72);
    const healthScore = _unit(health.score, 1);
    const latencyMs = Number(stats.averageLatencyMs ?? health.averageLatencyMs ?? 150);
    const latencyScore = 1 / (1 + Math.max(0, latencyMs) / 1500);
    const costScore = tool.source === 'openclaw' || tool.source === 'git' ? 1 : 0.72;
    const unavailable = health.breaker === 'open' || tool.available === false;
    return {
      key,
      score: unavailable
        ? 0
        : Math.round(
            (healthScore * 0.4 + reliability * 0.35 + latencyScore * 0.15 + costScore * 0.1) * 1000
          ) / 1000,
      health: healthScore,
      reliability,
      latencyMs,
      unavailable,
    };
  }

  /** @param {any[]} tools */
  rank(tools) {
    return tools
      .map((tool, index) => ({ tool, index, route: this.score(tool) }))
      .sort((a, b) => b.route.score - a.route.score || a.index - b.index);
  }
}

module.exports = { CapabilityRouter };
