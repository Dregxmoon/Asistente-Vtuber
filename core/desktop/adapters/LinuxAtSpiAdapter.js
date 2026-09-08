// @ts-check
'use strict';

const path = require('path');
const { runJsonProcess } = require('../JsonProcess.js');

class LinuxAtSpiAdapter {
  /** @param {{pythonBin?: string, runner?: typeof runJsonProcess}} [options] */
  constructor(options = {}) {
    this.platform = 'linux';
    this._pythonBin = options.pythonBin || process.env.KAORU_PYTHON_BIN || '/usr/bin/python3';
    this._runner = options.runner || runJsonProcess;
    this._helper = path.join(__dirname, '..', 'helpers', 'linux_atspi.py');
  }

  async health() {
    return this._runner(
      this._pythonBin,
      [this._helper],
      { operation: 'health' },
      { timeout: 3000 }
    );
  }

  /** @param {Record<string, unknown>} input */
  async snapshot(input = {}) {
    return this._runner(
      this._pythonBin,
      [this._helper],
      { operation: 'snapshot', ...input },
      { timeout: 15_000 }
    );
  }

  /** @param {string} action @param {Record<string, unknown>} target @param {Record<string, unknown>} input */
  async execute(action, target, input = {}) {
    return this._runner(
      this._pythonBin,
      [this._helper],
      { operation: 'execute', action, target, input },
      { timeout: 20_000 }
    );
  }
}

module.exports = { LinuxAtSpiAdapter };
