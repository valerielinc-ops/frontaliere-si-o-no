import { describe, expect, it } from 'vitest';
import { mergeLivePortalQuestions, persistLivePortalRequirements } from '../scripts/assisted-application/lib/portal/merge-live-requirements.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const base = 'assisted_applications/live_contract_fixture';
const old = { id: 'notice', source: 'portal', question: 'Notice period', applicationQuestion: 'Notice period *', context: 'Application', type: 'text', options: [], required: true, validation: { minLength: 30 } };
const live = { ...old, type: 'choice', options: ['1 month', '2 months', '3 months'], applicationOptions: ['1 Monat', '2 Monate', '3 Monate'], optionMap: [{ candidate: '1 month', application: '1 Monat' }, { candidate: '2 months', application: '2 Monate' }, { candidate: '3 months', application: '3 Monate' }], validation: {} };
function fixture() {
  const expected = {
    order: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
    flow: { state: 'submitting', round: 1, answers: { notice: '7 days' }, questionAnswers: { notice_period: '7 days' }, dispatch: { mode: 'submit', round: 1, sourceSha: 'a'.repeat(40) } },
    draft: { status: 'ready', round: 1, questions: [old], approval: { at: 123 }, job: { applyUrl: 'https://jobs.example.test/apply' } },
  };
  const store = createMemoryFirestore({ [base]: expected.order, [`${base}/automation/flow`]: expected.flow, [`${base}/ai_drafts/current`]: expected.draft, [`${base}/automation/submission`]: { r1: { state: 'failed', channel: 'portal', clickedAt: null, releasedAt: 100 } } });
  return { ...store, expected, orderRef: store.db.collection('assisted_applications').doc('live_contract_fixture') };
}

describe('current runner updates a previously stored portal question contract', () => {
  it.each(['text', 'choice'])('upgrades stale %s with the same id without losing options or answers', async type => {
    const store = fixture();
    store.expected.draft.questions[0].type = type;
    await store.orderRef.collection('ai_drafts').doc('current').set(store.expected.draft);
    const event = { type: 'submit_needs_candidate', questions: [live], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(true);
    const actual = store.read(`${base}/ai_drafts/current`);
    expect(actual.questions).toEqual([live]);
    expect(actual.approval).toEqual(store.expected.draft.approval);
    expect(store.read(`${base}/automation/flow`)).toEqual(store.expected.flow);
    expect(event.questions).toEqual(['notice']);
  });

  it('keeps the original id for a uniquely identical field and rejects ambiguous identity evidence', () => {
    const renamed = mergeLivePortalQuestions([old], [{ ...live, id: 'regenerated' }]);
    expect(renamed.questions).toEqual([{ ...live, id: old.id }]);
    expect(renamed.ids.get('regenerated')).toBe(old.id);
    expect(mergeLivePortalQuestions([old], [{ ...live, context: 'Newsletter' }]).questions).toEqual([old]);
    expect(mergeLivePortalQuestions([old], [{ ...live, applicationQuestion: 'Other notice period' }]).questions).toEqual([old]);
    expect(mergeLivePortalQuestions([{ ...old, source: 'cv_match' }], [live]).questions).toEqual([{ ...old, source: 'cv_match' }]);
  });

  it('keeps bounded preflight descriptors as references without replacing the native catalogue', async () => {
    const store = fixture();
    store.expected.draft.questions = [live];
    await store.orderRef.collection('ai_drafts').doc('current').set(store.expected.draft);
    const event: any = { type: 'submit_needs_candidate', questions: [{ id: 'notice' }], questionDetails: [{ id: 'notice', question: old.question, type: 'text', options: [] }], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(true);
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([live]);
    expect(event.questions).toEqual(['notice']);
  });

  it('never chooses the first of two incoming fields for an old context-free answer', () => {
    const contextFree = { ...old, context: '' };
    const a = { ...live, id: 'section-a', context: 'Section A' };
    const b = { ...live, id: 'section-b', context: 'Section B' };
    for (const incoming of [[a, b], [b, a]]) {
      const merged = mergeLivePortalQuestions([contextFree], incoming);
      expect(merged.ambiguous).toBe(true);
      expect(merged.questions).toEqual([contextFree]);
    }
  });

  it('rejects duplicate identities in a wholly new catalogue in either order', () => {
    const a = { ...live, id: 'same', question: 'Choose department', applicationQuestion: '' };
    const b = { ...live, id: 'same', question: 'Choose country', applicationQuestion: '' };
    for (const incoming of [[a, b], [b, a]]) expect(mergeLivePortalQuestions([], incoming)).toMatchObject({ questions: [], ambiguous: true });
  });

  it('rejects new-only semantic collisions without reporting a ghost id', async () => {
    for (const reversed of [false, true]) {
      const store = fixture();
      store.expected.draft.questions = [];
      await store.orderRef.collection('ai_drafts').doc('current').set(store.expected.draft);
      const incoming = [{ ...live, id: 'section-a', context: 'Section A' }, { ...live, id: 'section-b', context: 'Section B' }];
      if (reversed) incoming.reverse();
      const event = { type: 'submit_needs_candidate', questions: incoming, documents: [] };
      expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(false);
      expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([]);
      expect(event.questions).toEqual(incoming);
    }
  });

  it('requires the current remote actor to attest its own counters inside the write transaction', async () => {
    const store = fixture();
    await store.orderRef.collection('automation').doc('flow').set({ executionId: 'execution-a' }, { merge: true });
    store.expected.flow = store.read(`${base}/automation/flow`);
    await store.orderRef.collection('automation').doc('flow').set({ remoteExecutionRound: 1, remoteExecutionAttempts: 1 }, { merge: true });
    const event = () => ({ type: 'submit_needs_candidate', questions: [live], documents: [] });
    expect(await persistLivePortalRequirements({ ...store, round: 1, event: event() })).toBe(false);
    expect(await persistLivePortalRequirements({ ...store, round: 1, event: event(), validateExecutionInTransaction: async () => undefined })).toBe(false);
    expect(await persistLivePortalRequirements({ ...store, round: 1, event: event(), validateExecutionInTransaction: async (tx: any) => ({ flow: (await tx.get(store.orderRef.collection('automation').doc('flow'))).data(), execution: { id: 'execution-stale' } }) })).toBe(false);
    expect(await persistLivePortalRequirements({ ...store, round: 1, event: event(), validateExecutionInTransaction: async (tx: any) => ({ flow: (await tx.get(store.orderRef.collection('automation').doc('flow'))).data(), execution: { id: 'execution-a' } }) })).toBe(true);
  });

  it('keeps more than forty real candidate/native choices and their mapping on the draft', async () => {
    const store = fixture();
    const options = Array.from({ length: 55 }, (_, index) => `Candidate choice ${index}`);
    const applicationOptions = options.map((_, index) => `Native choice ${index}`);
    const incoming = { ...live, options, applicationOptions, optionMap: options.map((candidate, index) => ({ candidate, application: applicationOptions[index] })) };
    const event = { type: 'submit_needs_candidate', questions: [incoming], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(true);
    expect(store.read(`${base}/ai_drafts/current`).questions[0]).toEqual(incoming);
  });

  it('reports only the original id after an exact field regenerates its id', async () => {
    const store = fixture();
    const generic = { ...old, id: 'department', question: 'Choose department', applicationQuestion: 'Choose department *', options: ['Engineering', 'Sales'] };
    store.expected.draft.questions = [generic];
    await store.orderRef.collection('ai_drafts').doc('current').set(store.expected.draft);
    const event: any = { type: 'submit_needs_candidate', questions: [{ ...generic, id: 'regenerated', type: 'choice' }], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(true);
    expect(event.questions).toEqual(['department']);
    expect(event.questionDetails.map((question: any) => question.id)).toEqual(['department']);
    const result = transition(store.expected.flow, event, { draft: store.read(`${base}/ai_drafts/current`) });
    expect(result.flow.heldBy).toEqual(['question:department']);
  });

  it('does not carry acceptance across a Firestore transaction retry', async () => {
    const store = fixture();
    let attempts = 0;
    const db = { runTransaction: async (callback: any) => {
      await callback({ get: (ref: any) => ref.get(), set: () => { attempts++; } });
      await store.orderRef.collection('automation').doc('flow').set({ round: 2 }, { merge: true });
      return callback({ get: (ref: any) => ref.get(), set: () => { throw new Error('stale write'); } });
    } };
    const event = { type: 'submit_needs_candidate', questions: [live], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, db, round: 1, event })).toBe(false);
    expect(attempts).toBe(1);
    expect(event.questions).toEqual([live]);
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([old]);
  });

  it.each(['round', 'source', 'answers', 'draft', 'order', 'clicked', 'sent', 'withdrawn', 'attempt'])('refuses the metadata write after %s changed', async kind => {
    const store = fixture();
    if (kind === 'round') await store.orderRef.collection('automation').doc('flow').set({ round: 2 }, { merge: true });
    if (kind === 'source') await store.orderRef.collection('automation').doc('flow').set({ dispatch: { sourceSha: 'b'.repeat(40) } }, { merge: true });
    if (kind === 'answers') await store.orderRef.collection('automation').doc('flow').set({ answers: { notice: '2 months' } }, { merge: true });
    if (kind === 'draft') await store.orderRef.collection('ai_drafts').doc('current').set({ approval: { at: 456 } }, { merge: true });
    if (kind === 'order') await store.orderRef.set({ paymentStatus: 'refunded' }, { merge: true });
    if (kind === 'clicked' || kind === 'sent') await store.orderRef.collection('automation').doc('submission').set({ r1: { state: kind === 'sent' ? 'sent' : 'sending', clickedAt: 200 } });
    if (kind === 'withdrawn') await store.orderRef.collection('automation').doc('submission').set({ withdrawnAt: 200 }, { merge: true });
    if (kind === 'attempt') await store.orderRef.collection('ai_drafts').doc('current').set({ sentAttempt: { at: 200 } }, { merge: true });
    const before = store.read(`${base}/ai_drafts/current`);
    const event = { type: 'submit_needs_candidate', questions: [live], documents: [] };
    expect(await persistLivePortalRequirements({ ...store, round: 1, event })).toBe(false);
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    expect(event.questions).toEqual([live]);
  });
});
