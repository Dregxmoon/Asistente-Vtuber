// @ts-check
'use strict';

const path = require('path');
const { runJsonProcess } = require('../JsonProcess.js');

class WindowsUIAutomationAdapter {
  /** @param {{powerShellBin?: string, runner?: typeof runJsonProcess}} [options] */
  constructor(options = {}) {
    this.platform = 'win32';
    this._powerShellBin = options.powerShellBin || 'powershell.exe';
    this._runner = options.runner || runJsonProcess;
    this._helper = path.join(__dirname, '..', 'helpers', 'windows_uiautomation.ps1');
  }

  async health() {
    return this._run({ operation: 'health' }, 5000);
  }

  /** @param {Record<string, unknown>} input */
  async snapshot(input = {}) {
    return this._run({ operation: 'snapshot', ...input }, 15_000);
  }

  /** @param {string} action @param {Record<string, unknown>} target @param {Record<string, unknown>} input */
  async execute(action, target, input = {}) {
    return this._run({ operation: 'execute', action, target, input }, 20_000);
  }

  /** @param {Record<string, unknown>} payload @param {number} timeout */
  _run(payload, timeout) {
    return this._runner(
      this._powerShellBin,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this._helper],
      payload,
      { timeout }
    );
  }
}

module.exports = { WindowsUIAutomationAdapter };
