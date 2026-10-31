import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transportSourceGuard } from './helpers/submissionSourceGuard';
import { submissionGuard as rawSubmissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

function submissionGuard(db: any, orderId: string, round: number, options: any = {}) {
  return rawSubmissionGuard(db, orderId, round, { answerSourceGuard: transportSourceGuard(), ...options });
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1000); });
afterEach(() => { vi.restoreAllMocks(); });

const base = 'assisted_applications/source_guard_fixture';

function fixture() {
  return createMemoryFirestore({ [base]: { cvUploadedAt: Date.now() }, [`${base}/automation/flow`]: { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1 } },
    'user_cv_profiles/fixture': { answer: 'Yes' } });
}

describe('current answer source fence before irreversible send', () => {
  it.each(['email', 'portal'])('uses the same pre-send transaction for %s and never stamps clicked on a changed source', async channel => {
    const store = fixture();
    const source = store.db.collection('user_cv_profiles').doc('fixture');
    const assertInTransaction = vi.fn(async tx => {
      const record = (await tx.get(source)).data();
      if (record.answer !== 'Yes') throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    });
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1, { answerSourceGuard: { ...transportSourceGuard(), assertInTransaction } });
    await guard.claim(channel, 1);
    store.docs.set(source.path, { answer: 'No' });
    await expect(channel === 'email' ? guard.markEmailSending(2) : guard.markClicked(2)).rejects.toMatchObject({ code: 'evidence_source_changed' });
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
    expect(assertInTransaction).toHaveBeenCalledTimes(1);
    await guard.release('evidence_source_changed', 3);
    expect((await guard.claim(channel, 4, { resumable: true })).status).toBe('claimed');
  });

  it('accepts current private guard through submit and reads every dependency before the clicked write', async () => {
    const store = fixture();
    const runTransaction = store.db.runTransaction;
    const steps: string[] = [];
    store.db.runTransaction = callback => runTransaction(tx => callback({
      ...tx,
      get: async ref => { steps.push(`read:${ref.path}`); return tx.get(ref); },
      set: (...args) => { steps.push('write'); return tx.set(...args); },
    }));
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1);
    await guard.claim('portal', 1);
    steps.length = 0;
    await guard.markClicked(2, { answerSourceGuard: { ...transportSourceGuard(), assertInTransaction: async tx => {
      await tx.get(store.db.collection('user_cv_profiles').doc('fixture'));
    } } });
    expect(steps[0]).toBe(`read:${base}/automation/submission`);
    expect(steps).toContain('read:user_cv_profiles/fixture');
    expect(steps.at(-1)).toBe('write');
    const firstWrite = steps.indexOf('write');
    expect(steps.slice(0, firstWrite).every(step => step.startsWith('read:'))).toBe(true);
    expect(steps.slice(firstWrite)).toEqual(['write', 'write']);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(2);
  });

  it.each(['email', 'portal'])('never overwrites a concurrent SENT receipt or clears it from a stale %s attempt', async channel => {
    const store = fixture();
    const sourceGuard = { assertInTransaction: vi.fn(async () => { throw new Error('must replay SENT before source eligibility'); }) };
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1, { answerSourceGuard: sourceGuard });
    await guard.claim(channel, 1);
    await guard.markSent({ channel, messageId: 'acknowledged-real-send' }, 2);
    await expect(channel === 'email' ? guard.markEmailSending(3) : guard.markClicked(3)).rejects.toMatchObject({ code: 'submission_already_sent' });
    expect(await guard.release('stale attempt cleanup', 4)).toBe(false);
    expect(store.read(`${base}/automation/submission`).r1).toMatchObject({ state: 'sent', messageId: 'acknowledged-real-send', sentAt: 2, clickedAt: null });
    expect(sourceGuard.assertInTransaction).not.toHaveBeenCalled();
  });

  it('rejects an older resumable portal claim when a new attempt owns the ledger', async () => {
    const store = fixture();
    const old = submissionGuard(store.db, 'source_guard_fixture', 1);
    const fresh = submissionGuard(store.db, 'source_guard_fixture', 1);
    await old.claim('portal', 1);
    await fresh.claim('portal', 2, { resumable: true });
    const current = structuredClone(store.read(`${base}/automation/submission`));
    await expect(old.markClicked(3)).rejects.toMatchObject({ code: 'submission_claim_changed' });
    expect(await old.release('stale cleanup', 4)).toBe(false);
    expect(store.read(`${base}/automation/submission`)).toEqual(current);
    await fresh.markClicked(5);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(5);
  });


  it.each(['new_claim', 'sent_receipt'])('never clears a dossier after release when %s acquired the ledger', async mutation => {
    const store = fixture();
    const draftPath = `${base}/ai_drafts/current`;
    store.docs.set(draftPath, { round: 1, sentAttempt: { photo: 'old-dossier' } });
    const old = submissionGuard(store.db, 'source_guard_fixture', 1);
    await old.claim('portal', 1);
    expect(await old.release('certainly unsent', 2)).toBe(true);
    const next = submissionGuard(store.db, 'source_guard_fixture', 1);
    if (mutation === 'new_claim') await next.claim('portal', 3);
    else await next.markSent({ channel: 'portal', messageId: 'actual-ack' }, 3);
    store.docs.set(draftPath, { round: 1, sentAttempt: { photo: 'current-dossier' } });
    expect(await old.clearReleasedAttempt()).toBe(false);
    expect(store.read(draftPath).sentAttempt).toEqual({ photo: 'current-dossier' });
  });


  it('never treats an email handoff as an unclicked resumable portal claim', async () => {
    const store = fixture();
    const email = submissionGuard(store.db, 'source_guard_fixture', 1);
    await email.claim('email', 1);
    await email.markEmailSending(2);
    const original = structuredClone(store.read(`${base}/automation/submission`));
    for (const channel of ['portal', 'owner_extension', 'email']) {
      const next = submissionGuard(store.db, 'source_guard_fixture', 1);
      expect(await next.claim(channel, 3, { resumable: true })).toMatchObject({ status: 'in_flight' });
      expect(store.read(`${base}/automation/submission`)).toEqual(original);
    }
  });


  it('keeps a round-two dossier when an old round-one worker finishes cleanup', async () => {
    const store = fixture();
    const old = submissionGuard(store.db, 'source_guard_fixture', 1);
    await old.claim('portal', 1);
    await old.release('certainly unsent', 2);
    const second = submissionGuard(store.db, 'source_guard_fixture', 2);
    store.docs.set(`${base}/automation/flow`, { state: 'submitting', round: 2, dispatch: { mode: 'submit', round: 2 } });
    await second.claim('portal', 3);
    const sentAttempt = { photo: 'round-two-dossier', submissionAttempt: second.attemptBinding() };
    store.docs.set(`${base}/ai_drafts/current`, { status: 'ready', round: 2, sentAttempt });
    expect(await old.clearReleasedAttempt()).toBe(false);
    expect(store.read(`${base}/ai_drafts/current`).sentAttempt).toEqual(sentAttempt);
  });

  it('clears only its own same-round attempt, and never recreates a purged draft', async () => {
    const store = fixture();
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1);
    await guard.claim('portal', 1);
    store.docs.set(`${base}/ai_drafts/current`, { status: 'ready', round: 1,
      sentAttempt: { photo: 'own-dossier', submissionAttempt: guard.attemptBinding() } });
    await guard.release('certainly unsent', 2);
    expect(await guard.clearReleasedAttempt()).toBe(true);
    expect(store.read(`${base}/ai_drafts/current`).sentAttempt).toBeNull();
    store.docs.delete(`${base}/ai_drafts/current`);
    expect(await guard.clearReleasedAttempt()).toBe(true);
    expect(store.read(`${base}/ai_drafts/current`)).toBeUndefined();
  });

  it.each(['email', 'portal'])('stops hosted %s after a same-round owner takeover', async channel => {
    const store = fixture();
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1);
    await guard.claim(channel, 1);
    store.docs.set(`${base}/automation/flow`, { state: 'owner_takeover', round: 1, dispatch: { mode: 'submit', round: 1 } });
    await expect(channel === 'email' ? guard.markEmailSending(2) : guard.markClicked(2)).rejects.toMatchObject({ code: 'submission_approval_changed' });
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
  });


  it.each(['email', 'portal', 'owner_extension'])('vetoes %s inside the final transaction after retention purge begins, even with no Q/A guard', async channel => {
    const store = fixture();
    if (channel === 'owner_extension') store.docs.set(`${base}/automation/flow`, { state: 'owner_takeover', round: 1 });
    const guard = rawSubmissionGuard(store.db, 'source_guard_fixture', 1);
    await guard.claim(channel, 1);
    store.docs.set(base, { ...store.read(base), retentionPurgingAt: 2 });
    await expect(channel === 'email' ? guard.markEmailSending(3) : guard.markClicked(3)).rejects.toMatchObject({ code: 'submission_retention_changed' });
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
  });

});


it.each(['email', 'portal', 'owner_extension'])('requires a current full source guard for every new %s handoff', async channel => {
  const store = fixture();
  if (channel === 'owner_extension') store.docs.set(`${base}/automation/flow`, { state: 'owner_takeover', round: 1 });
  const guard = rawSubmissionGuard(store.db, 'source_guard_fixture', 1);
  await guard.claim(channel, 1);
  await expect(channel === 'email' ? guard.markEmailSending(2) : guard.markClicked(2)).rejects.toMatchObject({ code: 'evidence_source_changed' });
  expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
  expect([...store.docs.keys()].filter(key => key.includes('/submission_receipts/'))).toHaveLength(0);
});

it.each(['email', 'portal'])('atomically binds an immutable minimal handoff frame for %s', async channel => {
  const store = fixture();
  const guard = submissionGuard(store.db, 'source_guard_fixture', 1);
  await guard.claim(channel, 1);
  if (channel === 'email') await guard.markEmailSending(2); else await guard.markClicked(2);
  const frames = [...store.docs.entries()].filter(([key]) => key.includes('/submission_receipts/'));
  expect(frames).toHaveLength(1);
  const [key, frame] = frames[0];
  expect(key.endsWith(frame.attemptHash)).toBe(true);
  expect(frame).toEqual({ attemptHash: expect.stringMatching(/^[a-f0-9]{64}$/), round: 1, channel, claimArmedAt: 1, handoffAt: 2, sourceFingerprint: 'f'.repeat(64), slotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    draftMaterialHash: expect.stringMatching(/^[a-f0-9]{64}$/), attemptMaterialHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await expect(channel === 'email' ? guard.markEmailSending(3) : guard.markClicked(3)).rejects.toMatchObject({ code: 'submission_claim_changed' });
  expect(store.read(key)).toEqual(frame);
});


it.each(['email', 'portal'])('rechecks retention after the final awaited proof/source read for %s', async channel => {
  for (const phase of ['proof', 'source']) {
    vi.mocked(Date.now).mockReturnValue(100);
    const store = fixture();
    store.docs.set(base, { cvUploadedAt: 1 });
    const dueAt = 1 + 90 * 86400000;
    let entered!: () => void; let resume!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const run = store.db.runTransaction;
    store.db.runTransaction = callback => run(tx => callback({ ...tx, get: async ref => {
      const doc = await tx.get(ref);
      if (phase === 'proof' && ref.path.includes('/submission_receipts/')) { entered(); await release; }
      return doc;
    } }));
    const sourceGuard = { ...transportSourceGuard(), assertInTransaction: async () => { if (phase === 'source') { entered(); await release; } } };
    const guard = rawSubmissionGuard(store.db, 'source_guard_fixture', 1, { answerSourceGuard: sourceGuard });
    await guard.claim(channel, dueAt - 10);
    const pending = channel === 'email' ? guard.markEmailSending(dueAt - 5) : guard.markClicked(dueAt - 5);
    await ready; vi.mocked(Date.now).mockReturnValue(106); resume();
    await expect(pending).rejects.toMatchObject({ code: 'submission_retention_changed' });
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
    expect([...store.docs.keys()].filter(key => key.includes('/submission_receipts/'))).toHaveLength(0);
  }
});
