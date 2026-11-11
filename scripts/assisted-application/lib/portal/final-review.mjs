import { SUBMIT_RE, VALIDATION_RE } from './fill.mjs';
import { applicationStage, finalReviewStageChecks } from './stages.mjs';

/**
 * The click moved this posting's application to a final review page whose own
 * words say that a later Submit/Apply is still required. Keep this predicate
 * pure so the runner and evidence reconciliation use the same stage contract.
 */
export function advancedToFinalReviewChecks(snapshot, { url, submissionUrl, applyUrl, sourceProtocol = null, job = {} } = {}) {
  const snapshotAvailable = Boolean(snapshot);
  const pageMoved = Boolean(url && submissionUrl && url !== submissionUrl);
  const validationClear = snapshotAvailable && !(snapshot.errors || []).length
    && !(snapshot.fields || []).some(field => field?.invalid === true)
    && !VALIDATION_RE.test(String(snapshot.text || ''));
  const finalControlPresent = Boolean(snapshotAvailable && (snapshot.buttons || []).some(button => !button?.chrome
    && SUBMIT_RE.test(String(button?.text || ''))));
  const stageChecks = finalReviewStageChecks(snapshot, { url, applyUrl, sourceProtocol });
  const observedStage = snapshotAvailable ? applicationStage(snapshot, { url, applyUrl, sourceProtocol, job }).kind : '';
  const finalReviewStage = observedStage === 'final_review';
  return { snapshotAvailable, pageMoved, validationClear, finalControlPresent,
    finalReviewRouteBound: stageChecks.routeBound, reviewInstructions: stageChecks.reviewInstructions,
    finalReviewStage, observedStage };
}

export function advancedToFinalReview(snapshot, options = {}) {
  return Object.values(advancedToFinalReviewChecks(snapshot, options)).every(Boolean);
}
