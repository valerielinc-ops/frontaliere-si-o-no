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
    await expect(guard.markClicked(2)).rejects.toMatchObject({ code: 'evidence_source_changed' });
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
    expect(steps[0]).toBe('read:user_cv_profiles/fixture');
    expect(steps.at(-1)).toBe('write');
    expect(steps.slice(0, -1).every(step => step.startsWith('read:'))).toBe(true);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(2);
  });
});
