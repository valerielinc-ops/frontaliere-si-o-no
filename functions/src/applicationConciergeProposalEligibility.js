import { CONCIERGE_ELIGIBILITY_VERSION } from './applicationConciergeEligibility.js';
import { mergeConciergeMatchingRuntime } from './applicationConciergeRuntime.js';

function nonnegativeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function eligibilityFactsRevision(value) {
  const revision = Number(value?.eligibilityFactsRevision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

/** One shared gate for candidate decisions, emails, timers, and proposal capacity. */
export function proposalAcceptability(service, proposal, runtime = null) {
  const currentService = mergeConciergeMatchingRuntime(service || {}, runtime);
  const status = String(proposal?.eligibilityStatus || '');
  const supportedStatus = ['compatible', 'clarification_required'].includes(status);
  const dependency = proposal?.eligibilityFactsDependency;
  const hasDependency = dependency && typeof dependency === 'object'
    && typeof dependency.languages === 'boolean' && typeof dependency.answers === 'boolean';
  let factsCurrent;
  if (hasDependency) {
    const languageRevision = nonnegativeRevision(proposal.eligibilityLanguagesRevision);
    const answerRevision = nonnegativeRevision(proposal.eligibilityAnswersRevision);
    factsCurrent = (!dependency.languages || (languageRevision !== null
        && languageRevision === (nonnegativeRevision(currentService.eligibilityLanguagesRevision) ?? 0)))
      && (!dependency.answers || (answerRevision !== null
        && answerRevision === (nonnegativeRevision(proposal.candidateAnswersRevision) ?? 0)));
  } else {
    // Rows written before per-proposal dependencies keep the scalar contract
    // until the matcher safely annotates them.
    factsCurrent = eligibilityFactsRevision(proposal) === eligibilityFactsRevision(currentService);
  }
  const verified = proposal?.status === 'proposed' && supportedStatus
    && proposal?.eligibilityVersion === CONCIERGE_ELIGIBILITY_VERSION
    && Boolean(currentService.cvStorageKey)
    && proposal?.eligibilityCvStorageKey === currentService.cvStorageKey
    && factsCurrent;
  return {
    verified,
    acceptable: verified && status === 'compatible',
    eligibilityStatus: verified ? status : 'needs_verification',
  };
}

/**
 * Decision-ready proposals and pre-proposal checks use separate capacity.
 * A clarification or an unknown eligibility result is never an offer to accept.
 */
export function countConciergeProposalCapacity(proposals, service, runtime = null) {
  let decisionReady = 0;
  let verificationPending = 0;
  for (const item of proposals || []) {
    const proposal = typeof item?.data === 'function' ? item.data() || {} : item || {};
    if (proposal.status !== 'proposed') continue;
    if (proposalAcceptability(service, proposal, runtime).acceptable) decisionReady += 1;
    else verificationPending += 1;
  }
  return { decisionReady, verificationPending };
}
