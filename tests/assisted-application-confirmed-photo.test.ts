import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { confirmSentAttempt } from '../functions/src/assistedApplicationAutomation.js';
import { submissionSlotHash } from '../functions/src/lib/submissionReceiptContract.js';

const NOW = Date.now();
const ID = 'confirmed_photo_fixture';
const ROOT = `assisted_applications/${ID}`;
async function produce(channel: string) {
  const order = { paymentStatus: 'paid', submissionStatus: 'in_progress', cvUploadedAt: NOW - 1000,
    jobId: 'synthetic-job', jobUrl: 'https://employer.invalid/job' };
  const store = createMemoryFirestore({ [ROOT]: order,
    [`${ROOT}/automation/flow`]: { round: 1, state: channel === 'owner_extension' ? 'owner_takeover' : 'submitting',
      dispatch: { round: 1, mode: 'submit', requestedAt: NOW }, heldBy: ['portal:portal_needs_candidate'] },
    [`${ROOT}/ai_drafts/current`]: { round: 1, status: 'ready', coverLetter: 'Synthetic approved letter', questions: [] },
  });
  const guard = submissionGuard(store.db, ID, 1, { receiptClock: () => NOW + 10,
    answerSourceGuard: { fingerprint: 'e'.repeat(64), assertInTransaction: async (tx: any) => { await tx.get(store.db.collection('assisted_applications').doc(ID)); } },
  });
  await guard.claim(channel, NOW);
  const photo = { at: NOW, channel, files: [], submissionAttempt: guard.attemptBinding() };
  await store.db.collection('assisted_applications').doc(ID).collection('ai_drafts').doc('current').set({ sentAttempt: photo }, { merge: true });
  if (channel === 'email') await guard.markEmailSending(NOW + 1, { emailHandoff: {
    messageId: '<synthetic-handoff@sender.invalid>', recipient: 'employer@employer.invalid', slotHash: submissionSlotHash({ orderId: ID, order }),
  } });
  else await guard.markClicked(NOW + 1, { ...(channel === 'owner_extension' ? { ownerIntent: Object.fromEntries(
    ['idHash', 'nativeDigest', 'materialDigest', 'submitterDigest', 'assessmentHash'].map((field, index) => [field, String(index + 1).repeat(64)]),
  ) } : {}) });
  await guard.markSent({ channel, sent: photo }, NOW + 10);
  return { store, photo };
}

describe('confirmed photograph projection', () => {
  for (const channel of ['portal', 'email', 'owner_extension']) {
    it(`projects only the immutable SENT writer photograph for ${channel}`, async () => {
      const { store } = await produce(channel);
      assert.equal(await confirmSentAttempt({ db: store.db, orderId: ID, round: 1, clock: () => NOW + 20 }), true);
      assert.deepEqual(store.read(`${ROOT}/ai_drafts/current`)!.sent, store.read(`${ROOT}/automation/submission`)!.r1.sent);
      assert.equal(store.read(`${ROOT}/ai_drafts/current`)!.sentAttempt, null);
    });
  }

  for (const changed of ['purging', 'new_round', 'slot', 'draft_material', 'attempt_photo', 'legacy_no_frame']) {
    it(`does not project when ${changed} no longer binds the photo`, async () => {
      const { store } = await produce('email');
      if (changed === 'purging') store.read(ROOT)!.retentionPurgingAt = NOW + 11;
      if (changed === 'new_round') store.read(`${ROOT}/ai_drafts/current`)!.round = 2;
      if (changed === 'slot') store.read(ROOT)!.jobId = 'other-job';
      if (changed === 'draft_material') store.read(`${ROOT}/ai_drafts/current`)!.coverLetter = 'changed';
      if (changed === 'attempt_photo') store.read(`${ROOT}/ai_drafts/current`)!.sentAttempt.submissionAttempt.id = 'foreign';
      if (changed === 'legacy_no_frame') store.docs.delete(store.list(`${ROOT}/submission_receipts/`)[0]);
      assert.equal(await confirmSentAttempt({ db: store.db, orderId: ID, round: 1, clock: () => NOW + 20 }), false);
      assert.equal(store.read(`${ROOT}/ai_drafts/current`)!.sent, undefined);
    });
  }

  it('rechecks the real retention clock after the final frame read', async () => {
    const { store } = await produce('email');
    const due = NOW + 30;
    store.read(ROOT)!.cvUploadedAt = due - 90 * 86400000;
    let clock = due - 1;
    const framePath = store.list(`${ROOT}/submission_receipts/`)[0];
    const run = store.db.runTransaction.bind(store.db);
    store.db.runTransaction = fn => run(tx => fn({ ...tx, async get(ref: any) {
      const snapshot = await tx.get(ref);
      if (ref.path === framePath) clock = due + 1;
      return snapshot;
    } }));
    assert.equal(await confirmSentAttempt({ db: store.db, orderId: ID, round: 1, clock: () => clock }), false);
    assert.equal(store.read(`${ROOT}/ai_drafts/current`)!.sent, undefined);
  });

  it('never recreates a purged current draft', async () => {
    const { store } = await produce('email');
    store.docs.delete(`${ROOT}/ai_drafts/current`);
    store.read(ROOT)!.retentionPurgedAt = NOW + 11;
    assert.equal(await confirmSentAttempt({ db: store.db, orderId: ID, round: 1, clock: () => NOW + 20 }), false);
    assert.equal(store.read(`${ROOT}/ai_drafts/current`), undefined);
  });
});
