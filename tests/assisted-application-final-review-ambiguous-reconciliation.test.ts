import { describe, expect, it, vi } from 'vitest';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { PORTAL_AUTO_RETRY_DELAYS_MS, PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION,
  portalFinalReviewAmbiguousRecoveryPending, portalRetryDueAt } from '../functions/src/assistedApplicationPortalRetryPolicy.js';
import { reconcileFinalReviewAmbiguous } from '../scripts/assisted-application/reconcile-final-review-ambiguous.mjs';
import { decideFinalReviewAmbiguousReconciliation } from '../scripts/assisted-application/lib/final-review-ambiguous-reconciliation.mjs';
import { advancedToFinalReview } from '../scripts/assisted-application/lib/portal/final-review.mjs';
import { encryptJson } from '../scripts/assisted-application/lib/secure-run.mjs';

const applyUrl = 'https://careers.example/Careers/ApplicationMethods?jobId=42';
const submissionUrl = 'https://careers.example/Careers/ApplicationConfirmation?jobId=42';
const finalUrl = 'https://careers.example/Careers/ApplicationReview?jobId=42';
const reviewText = 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.';
const reviewSnapshot = { url: finalUrl, text: reviewText, errors: [], fields: [],
  buttons: [{ text: 'Submit', disabled: false, chrome: false }] };

function eligibleInput(overrides = {}) {
  return {
    order: { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: 1,
      talentPoolConsent: true, submissionStatus: 'draft' },
    flow: { state: 'owner_takeover', heldBy: ['portal_ambiguous'], round: 1,
      dispatch: { mode: 'submit', round: 1 } },
    draft: { status: 'ready', round: 1, sent: false, channel: { applyUrl }, job: { title: 'Example role' } },
    submission: { r1: { state: 'sending', channel: 'portal', clickedAt: 200 } },
    inbox: [],
    source: { applyUrl, event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: {
      finalOutcomes: ['ambiguous'], finalUrl, submissionUrl,
    } },
    sourcePathBound: true,
    postClickSnapshot: reviewSnapshot,
    submissionUrl,
    laterVerificationClear: true,
    nowMs: 1_000,
    ...overrides,
  };
}

describe('shared final-review predicate', () => {
  it('accepts a bound review page that asks for another active final submit', () => {
    expect(advancedToFinalReview(reviewSnapshot, { url: finalUrl, submissionUrl, applyUrl, job: { title: 'Example role' } })).toBe(true);
  });

  it('rejects a confirmation page and a validation error page', () => {
    const confirmation = { ...reviewSnapshot, url: 'https://careers.example/Careers/ThankYou?jobId=42',
      text: 'Thank you for your application.', buttons: [] };
    const validation = { ...reviewSnapshot, errors: ['required field'] };
    expect(advancedToFinalReview(confirmation, { url: confirmation.url, submissionUrl, applyUrl })).toBe(false);
    expect(advancedToFinalReview(validation, { url: finalUrl, submissionUrl, applyUrl })).toBe(false);
  });

  it('requires a final control in the observed page evidence', () => {
    const noControl = { ...reviewSnapshot, buttons: [{ text: 'Cancel', disabled: false, chrome: false }] };
    expect(advancedToFinalReview(noControl, { url: finalUrl, submissionUrl, applyUrl })).toBe(false);
  });

  it('recognizes a bound Avature final review when the saved page has no live portal metadata', () => {
    const sourceProtocol = {
      vendor: 'avature', portalId: '87', namespace: '/Careers', page: 'JobDetail',
      origin: 'https://careers.example', path: '/Careers/JobDetail/Example-Role/42',
      quoted: { portalId: '87', urlPath: 'Careers', page: 'JobDetail',
        applicationName: 'customPortal', applicationCode: 'customPortal_87' },
    };
    const avatureApplyUrl = 'https://careers.example/Careers/JobDetail/Example-Role/42';
    const avatureReviewUrl = 'https://careers.example/Careers/ApplicationReview?jobId=42';
    const avatureSubmissionUrl = 'https://careers.example/Careers/ApplicationConfirmation?jobId=42';
    const savedSnapshot = { ...reviewSnapshot, url: avatureReviewUrl, protocol: null };
    expect(advancedToFinalReview(savedSnapshot, { url: avatureReviewUrl, submissionUrl: avatureSubmissionUrl,
      applyUrl: avatureApplyUrl, sourceProtocol, job: { title: 'Example role' } })).toBe(true);
  });
});

describe('final-review ambiguous reconciliation decision', () => {
  it('keeps a case unknown when post-click page proof is missing and does not write', async () => {
    const orderData = { automationState: 'owner_takeover', paymentStatus: 'paid', consentVersion: 'assisted-application-v2',
      consentedAt: 1, talentPoolConsent: true, submissionStatus: 'draft' };
    const childData = {
      'automation/flow': { state: 'owner_takeover', heldBy: ['portal_ambiguous'], round: 1, dispatch: { mode: 'submit', round: 1 } },
      'automation/submission': { r1: { state: 'sending', channel: 'portal', startedAt: 123, clickedAt: 200 } },
      'ai_drafts/current': { status: 'ready', round: 1, sent: false, channel: { applyUrl }, job: { title: 'Example role' } },
    };
    const snap = data => ({ data: () => data });
    const orderRef: any = { id: 'fixture-order-1234', get: async () => snap(orderData) };
    orderRef.collection = (name: string) => ({
      doc: (id: string) => ({ get: async () => snap(childData[`${name}/${id}`]) }),
      get: async () => ({ docs: [] }),
    });
    const query: any = { where: () => query, orderBy: () => query, limit: () => query,
      get: async () => ({ docs: [{ id: orderRef.id, ref: orderRef }] }) };
    const db = { collection: () => query, runTransaction: vi.fn() } as any;
    const results = await reconcileFinalReviewAmbiguous({ db, bucket: { file: () => ({ download: async () => { throw new Error('missing'); } }) } as any,
      key: 'synthetic-test-key', apply: true, isEnabled: async () => true, nowMs: 1_000 });
    expect(results[0]?.decision).toBe('unknown');
    expect(db.runTransaction).not.toHaveBeenCalled();
    expect(orderData.automationState).toBe('owner_takeover');
  });

  it('returns a no-op for an already reconciled version', () => {
    const result = decideFinalReviewAmbiguousReconciliation(eligibleInput({
      flow: { ...eligibleInput().flow, portalFinalReviewAmbiguousRecoveryVersion: PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION },
    }));
    expect(result).toEqual({ decision: 'already_reconciled', criteria: { versionMarker: true } });
  });

  it('accepts only the exact evidence set shared with the runner predicate', () => {
    const result = decideFinalReviewAmbiguousReconciliation(eligibleInput());
    expect(result.decision).toBe('reconcile');
    expect(Object.values(result.criteria).every(Boolean)).toBe(true);
  });

  it('releases a proved no-send claim, queues one retry, and is idempotent', async () => {
    const orderId = 'fixture-order-1234';
    const key = Buffer.alloc(32, 7);
    const startedAt = 123;
    const orderPath = `assisted_applications/${orderId}`;
    const docs = new Map<string, any>([
      [orderPath, { automationState: 'owner_takeover', paymentStatus: 'paid', consentVersion: 'assisted-application-v2',
        consentedAt: 1, talentPoolConsent: true, submissionStatus: 'draft' }],
      [`${orderPath}/automation/flow`, { state: 'owner_takeover', heldBy: ['portal_ambiguous'], round: 1,
        dispatch: { mode: 'submit', round: 1 }, portalAutoRetryCount: PORTAL_AUTO_RETRY_DELAYS_MS.length }],
      [`${orderPath}/automation/submission`, { r1: { state: 'sending', channel: 'portal', startedAt, clickedAt: 200, attemptId: 'fixture-attempt' } }],
      [`${orderPath}/ai_drafts/current`, { status: 'ready', round: 1, sent: false, sentAttempt: { state: 'started' },
        channel: { applyUrl }, job: { title: 'Example role' } }],
    ]);
    const source = { applyUrl, event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: {
      finalOutcomes: ['ambiguous'], finalUrl, steps: [{ url: submissionUrl }], afterSubmitSnapshot: reviewSnapshot,
    } };
    const envelope = Buffer.from(JSON.stringify(encryptJson(source, key)));
    const document = (path: string): any => ({
      id: path.split('/').at(-1), path,
      get: async () => ({ id: path.split('/').at(-1), ref: document(path), data: () => docs.get(path) }),
      collection: (name: string) => collection(`${path}/${name}`),
    });
    const collection = (path: string): any => ({
      doc: (id: string) => document(`${path}/${id}`),
      where: () => collection(path), orderBy: () => collection(path), limit: () => collection(path), startAfter: () => collection(path),
      get: async () => ({ docs: [...docs.entries()].filter(([key]) => key.startsWith(`${path}/`)
        && !key.slice(path.length + 1).includes('/')).map(([key]) => ({ id: key.split('/').at(-1), ref: document(key), data: () => docs.get(key) })) }),
    });
    const db: any = { collection, runTransaction: vi.fn(async callback => {
      const writes: Array<{ path: string; data: any; merge: boolean }> = [];
      const result = await callback({
        get: async ref => ref.get(),
        set: (ref, data, options = {}) => writes.push({ path: ref.path, data, merge: Boolean(options.merge) }),
      });
      for (const write of writes) docs.set(write.path, write.merge ? { ...(docs.get(write.path) || {}), ...write.data } : write.data);
      return result;
    }) };
    const bucket: any = { file: () => ({ download: async () => [envelope] }) };
    const result = await reconcileFinalReviewAmbiguous({ db, bucket, key, apply: true, isEnabled: async () => true, nowMs: 1_000 });

    expect(result[0]?.decision).toBe('reconciled');
    expect(docs.get(`${orderPath}/automation/submission`)?.r1).toMatchObject({
      state: 'failed', reason: 'portal_review_pending', releasedAt: 1_000, confirmedNotSent: true,
      clickedAt: 200, attemptId: 'fixture-attempt',
    });
    expect(docs.get(`${orderPath}/ai_drafts/current`)?.sentAttempt).toBeNull();
    expect(docs.get(`${orderPath}/automation/flow`)).toMatchObject({
      portalAutoRetryCount: PORTAL_AUTO_RETRY_DELAYS_MS.length,
      portalAutoRetryAt: 1_000 + PORTAL_AUTO_RETRY_DELAYS_MS[0],
      portalFinalReviewAmbiguousRecoveryVersion: PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION,
    });
    expect(docs.get(orderPath)?.automationDueAt).toBe(1_000 + PORTAL_AUTO_RETRY_DELAYS_MS[0]);
    expect([...docs].some(([path, event]) => path.startsWith(`${orderPath}/events/`)
      && event.actor === 'reconcile:final-review-ambiguous'
      && event.recoveryVersion === PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION)).toBe(true);

    const repeated = await reconcileFinalReviewAmbiguous({ db, bucket, key, apply: true, isEnabled: async () => true, nowMs: 2_000 });
    expect(repeated[0]?.decision).toBe('already_reconciled');
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('bounded recovery after reconciliation', () => {
  it('queues one extra portal attempt and rejects another after it is spent', () => {
    const now = 5_000;
    const pending = { state: 'owner_takeover', heldBy: ['portal_ambiguous'], round: 1,
      dispatch: { mode: 'submit', round: 1 }, portalAutoRetryCount: PORTAL_AUTO_RETRY_DELAYS_MS.length,
      portalAutoRetryAt: now, portalFinalReviewAmbiguousRecoveryVersion: PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION };
    expect(portalFinalReviewAmbiguousRecoveryPending(pending)).toBe(true);
    expect(portalRetryDueAt(pending)).toBe(now);
    const retry = transition(pending, { type: 'portal_auto_retry' }, { draft: { status: 'ready', round: 1 }, nowMs: now });
    expect(retry.flow).toMatchObject({ state: 'submitting', portalAutoRetryCount: PORTAL_AUTO_RETRY_DELAYS_MS.length + 1,
      portalAutoRetryAt: null });
    expect(portalFinalReviewAmbiguousRecoveryPending(retry.flow)).toBe(false);
    expect(transition({ ...retry.flow, state: 'owner_takeover', heldBy: ['portal_ambiguous'], portalAutoRetryAt: now },
      { type: 'portal_auto_retry' }, { draft: { status: 'ready', round: 1 }, nowMs: now }).ignored).toBe('not_auto_retryable');
  });
});
