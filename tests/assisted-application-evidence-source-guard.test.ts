import { describe, expect, it, vi } from 'vitest';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const base = 'assisted_applications/source_guard_fixture';

function fixture() {
  return createMemoryFirestore({ [base]: {}, [`${base}/automation/flow`]: { state: 'submitting' },
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
    const guard = submissionGuard(store.db, 'source_guard_fixture', 1, { answerSourceGuard: { assertInTransaction } });
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
    await guard.markClicked(2, { answerSourceGuard: { assertInTransaction: async tx => {
      await tx.get(store.db.collection('user_cv_profiles').doc('fixture'));
    } } });
    expect(steps[0]).toBe(`read:${base}/automation/submission`);
    expect(steps).toContain('read:user_cv_profiles/fixture');
    expect(steps.at(-1)).toBe('write');
    expect(steps.slice(0, -1).every(step => step.startsWith('read:'))).toBe(true);
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
    store.docs.set(draftPath, { sentAttempt: { photo: 'old-dossier' } });
    const old = submissionGuard(store.db, 'source_guard_fixture', 1);
    await old.claim('portal', 1);
    expect(await old.release('certainly unsent', 2)).toBe(true);
    const next = submissionGuard(store.db, 'source_guard_fixture', 1);
    if (mutation === 'new_claim') await next.claim('portal', 3);
    else await next.markSent({ channel: 'portal', messageId: 'actual-ack' }, 3);
    store.docs.set(draftPath, { sentAttempt: { photo: 'current-dossier' } });
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

});
