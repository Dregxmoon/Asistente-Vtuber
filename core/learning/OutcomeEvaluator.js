// @ts-check
'use strict';

const {
  isSuccessfulMutationResult,
  DIRECT_MUTATORS,
  DIRECTLY_VERIFIABLE_MUTATORS,
} = require('../planner/MutationJournal.js');

/**
 * Clasifica el resultado observable de una corrida sin confiar en el texto del
 * modelo. Mantiene separadas cuatro ideas que antes se mezclaban:
 * terminación, mutación, verificación y éxito apto para aprendizaje.
 */

const MUTATING_TOOLS = DIRECT_MUTATORS;

const DIRECTLY_VERIFIABLE_TOOLS = DIRECTLY_VERIFIABLE_MUTATORS;

/**
 * @typedef {{tool?:string, ok?:boolean, _action?:{tool?:string}}} OutcomeToolResult
 * @typedef {{toolResults?:OutcomeToolResult[], error?:string|null, truncated?:boolean, cancelled?:boolean, unverifiedEdits?:string, verify?:{status?:string, reason?:string}, mutationJournal?:{count?:number}}} AgentResult
 */

/** @param {AgentResult} result */
function evaluateTaskOutcome(result = {}) {
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const successfulTools = toolResults
    .filter((item) => item && item.ok)
    .map((item) => String(item.tool || item._action?.tool || ''))
    .filter(Boolean);
  const journalCount = Number(result.mutationJournal?.count);
  const mutationCount = Number.isFinite(journalCount)
    ? journalCount
    : toolResults.filter(isSuccessfulMutationResult).length;
  const terminalSuccess = !result.error && !result.truncated && !result.cancelled;
  const verify = result.verify && typeof result.verify === 'object' ? result.verify : null;

  let verificationStatus = 'not_applicable';
  let verificationReason = 'no_mutations';
  if (!terminalSuccess || result.unverifiedEdits) {
    verificationStatus = 'failed';
    verificationReason = result.unverifiedEdits
      ? 'unverified_edit_claim'
      : result.error || 'incomplete';
  } else if (mutationCount > 0) {
    if (verify?.status === 'passed') {
      verificationStatus = 'verified';
      verificationReason = 'verification_passed';
    } else if (verify?.status === 'failed') {
      verificationStatus = 'failed';
      verificationReason = 'verification_failed';
    } else if (successfulTools.some((tool) => DIRECTLY_VERIFIABLE_TOOLS.has(tool))) {
      verificationStatus = 'verified';
      verificationReason = 'tool_confirmed';
    } else {
      verificationStatus = 'unverified';
      verificationReason = String(verify?.reason || 'verification_missing');
    }
  }

  return {
    terminalSuccess,
    success:
      terminalSuccess &&
      (verificationStatus === 'verified' || verificationStatus === 'not_applicable'),
    verificationStatus,
    verificationReason,
    mutationCount,
    successfulTools: successfulTools.slice(0, 20),
  };
}

module.exports = { evaluateTaskOutcome, MUTATING_TOOLS, DIRECTLY_VERIFIABLE_TOOLS };
