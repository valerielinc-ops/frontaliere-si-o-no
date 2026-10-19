import { byStatus, requeueClosedPromotionCandidate, setStatus } from './candidate-store.mjs';
import { LEDGER_PATH } from './config.mjs';

/**
 * Reconcile in-flight promotion records against their exact GitHub PR.
 * Lookup failures, mismatched PR numbers, and OPEN PRs are deliberately inert.
 *
 * @param {any} store
 * @param {(number: string) => Promise<any>} lookupPullRequest
 * @param {string|null} [ledgerFile]
 * @returns {Promise<{ landed: number, reopened: number }>}
 */
export async function reconcileOpenPromotions(store, lookupPullRequest, ledgerFile = LEDGER_PATH) {
  let landed = 0;
  let reopened = 0;
  for (const candidate of byStatus(store, 'promoting')) {
    const associatedNumber = String(candidate.promotionPr || '').trim();
    if (!/^\d+$/.test(associatedNumber)) continue;

    let pullRequest;
    try {
      pullRequest = await lookupPullRequest(associatedNumber);
    } catch {
      continue;
    }
    if (Number(pullRequest?.number) !== Number(associatedNumber)) continue;

    if (pullRequest.state === 'MERGED') {
      setStatus(store, candidate.key, 'production', {
        promotedAt: pullRequest.mergedAt || new Date().toISOString(),
      }, ledgerFile);
      landed++;
    } else if (pullRequest.state === 'CLOSED'
      && Object.prototype.hasOwnProperty.call(pullRequest, 'mergedAt')
      && pullRequest.mergedAt === null) {
      const reopenedCandidate = requeueClosedPromotionCandidate(
        store,
        candidate.key,
        pullRequest,
        ledgerFile,
      );
      if (reopenedCandidate) reopened++;
    }
  }
  return { landed, reopened };
}
