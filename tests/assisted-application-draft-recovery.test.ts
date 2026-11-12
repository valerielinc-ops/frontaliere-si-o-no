import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import {
  DRAFT_CANDIDATE_EMAIL_MISSING_CODE,
  DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
  DRAFT_AUTO_RETRY_DELAY_MS,
  draftRetryDueAt,
} from '../functions/src/assistedApplicationDraftRetryPolicy.js';
import { reconcileDraftFailures } from '../scripts/assisted-application/reconcile-draft-failures.mjs';

const now = Date.now();
const base = 'assisted_applications/draft_recovery_test';

function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'owner_takeover' },
    [`${base}/automation/flow`]: {
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, sent: null, sentAttempt: null },
    [`${base}/automation/submission`]: {
      r1: { state: 'failed', channel: 'portal', clickedAt: null, confirmedNotSent: true, releasedAt: now - 1_000 },
    },
  });
}

describe('automatic recovery after a failed draft run', () => {
  it('queues one delayed regeneration without granting send authority', async () => {
    const store = fixture();
    const context = { db: store.db, nowMs: now, isEnabled: async () => true };

    expect(await reconcileDraftFailures(context)).toMatchObject({ eligible: 1, queued: 0 });
    expect(store.read(`${base}/automation/flow`).draftAutoRetryAt).toBeUndefined();

    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({
      state: 'owner_takeover', heldBy: ['draft_failed'], draftAutoRetryCount: 0,
      draftAutoRetryAt: now + DRAFT_AUTO_RETRY_DELAY_MS,
    });
    expect(store.read(base).automationDueAt).toBe(now + DRAFT_AUTO_RETRY_DELAY_MS);
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
  });

  it('grants one versioned retry for a prior candidate-email failure after the ordinary retry was used', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, {
      ...store.read(`${base}/automation/flow`), draftAutoRetryCount: 1,
      draftRecoveryVersion: 'draft-recovery-v1',
    });
    store.docs.set(`${base}/automation_events/email-failure`, {
      type: 'draft_failed', round: 2, error: DRAFT_CANDIDATE_EMAIL_MISSING_CODE,
    });
    const context = { db: store.db, nowMs: now, isEnabled: async () => true };

    expect(await reconcileDraftFailures(context)).toMatchObject({ eligible: 1, queued: 0 });
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({
      state: 'owner_takeover', heldBy: ['draft_failed'], draftAutoRetryCount: 0,
      draftAutoRetryAt: now + DRAFT_AUTO_RETRY_DELAY_MS,
      draftCandidateEmailRecoveryVersion: DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION,
    });
    const scheduledEvents = store.list(`${base}/events/`).length;
    expect(await reconcileDraftFailures({ ...context, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(scheduledEvents);
  });

  it('does not replenish an exhausted draft retry for an unrelated failure code', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, {
      ...store.read(`${base}/automation/flow`), draftAutoRetryCount: 1,
      draftRecoveryVersion: 'draft-recovery-v1',
    });
    store.docs.set(`${base}/automation_events/other-failure`, {
      type: 'draft_failed', round: 2, error: 'documents_empty',
    });

    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
  });

  it('regenerates only the missing round through the normal clock event', () => {
    const result = transition({
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      draftAutoRetryCount: 0, draftAutoRetryAt: now,
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    }, { type: 'draft_auto_retry' }, {
      draft: { status: 'ready', round: 1 }, nowMs: now,
    });

    expect(result.flow).toMatchObject({
      state: 'regenerating', round: 2, heldBy: [], draftAutoRetryCount: 1,
      draftAutoRetryAt: null,
    });
    expect(result.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'draft_auto_retry' }]);
    expect(draftRetryDueAt(result.flow)).toBeNull();
  });

  it('does not dispatch a queued retry after the posting expired', () => {
    const result = transition({
      state: 'owner_takeover', round: 2, heldBy: ['draft_failed'],
      draftAutoRetryCount: 0, draftAutoRetryAt: now,
      postingExpiredAt: now - 1,
      dispatch: { mode: 'draft', round: 2, attempts: 1 },
    }, { type: 'draft_auto_retry' }, {
      draft: { status: 'ready', round: 1 }, nowMs: now,
    });

    expect(result.ignored).toBe('posting_expired');
    expect(result.effects).toEqual([]);
  });

  it.each(['sent', 'sending', 'clicked'])('does not queue when the application may have left: %s', async state => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, {
      r1: { state, channel: 'portal', clickedAt: state === 'clicked' ? now : null, releasedAt: now },
    });
    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
  });

  it.each([
    ['confirmed release', { state: 'failed', channel: 'portal', clickedAt: now - 10, confirmedNotSent: true, releasedAt: now - 1 }],
    ['legacy confirmed release', { state: 'failed', channel: 'portal', clickedAt: now - 10, releasedAt: now - 1 }],
  ])('allows draft recovery after a %s with retained click evidence', async (_label, record) => {
    const store = fixture();
    store.docs.set(`${base}/automation/submission`, { r1: record });

    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 1, queued: 1 });
  });

  it('fails closed on a malformed persisted retry count', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), draftAutoRetryCount: ' ' });
    expect(await reconcileDraftFailures({ db: store.db, nowMs: now, apply: true, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeUndefined();
  });
});
