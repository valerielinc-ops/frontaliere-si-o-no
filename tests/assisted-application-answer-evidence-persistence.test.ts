import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';
import { loadCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
vi.mock('../functions/src/assistedApplicationAutomation.js', () => ({
  flowRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('automation').doc('flow'),
  draftRefFor: (db: any, id: string) => db.collection('assisted_applications').doc(id).collection('ai_drafts').doc('current'),
}));
vi.mock('../functions/src/assistedApplicationTailoredCvPdf.js', () => ({
  tailoredCvChanges: () => false, rebuildTailoredCvPdf: vi.fn(), supersededPhotoPdf: () => null,
}));
const { saveAnswersWithCv } = await import('../functions/src/assistedApplicationCvCommit.js');
const now = Date.now();
const question = { id: 'english', question: 'What is your English proficiency level?', type: 'text' };
const key = candidateQuestionAnswerKey(question);
const order = { userId: 'candidate', jobId: 'job', jobUrl: 'https://example.test/jobs/original/', cvUploadedAt: now };
const flow = { state: 'candidate_review', round: 1, answers: {}, questionAnswers: {} };
const draft = { round: 1, questions: [question] };
function fixture() {
  const store = createMemoryFirestore({
    'assisted_applications/source': order,
    'assisted_applications/source/automation/flow': flow,
    'assisted_applications/source/ai_drafts/current': draft,
    'user_cv_profiles/candidate': { status: 'ready', profile: { languages: [{ language: 'English', level: 'B2' }] } },
  });
  const save = (answers: any, extra = {}) => saveAnswersWithCv({ db: store.db, bucket: null, orderId: 'source', order,
    flow: store.read('assisted_applications/source/automation/flow'), draft, answers, nowMs: now, answerActor: 'candidate', ...extra });
  return { store, save };
}

describe('shared evidence producer uses the explicit answer writer', () => {
  it.each(['candidate', 'owner'])('persists an attested %s answer without changing the extracted CV profile', async answerActor => {
    const f = fixture();
    await f.save({ english: 'C1' }, { answerActor });
    const record = f.store.read('user_cv_profiles/candidate');
    expect(record).toMatchObject({ status: 'ready', profile: { languages: [{ language: 'English', level: 'B2' }] },
      applicationQuestionAnswers: { [key]: 'C1' }, applicationQuestionAnswerEvidence: { [key]: {
        answer: 'C1', question: expect.objectContaining(question), provenance: expect.objectContaining({ actor: answerActor, round: 1, orderId: 'source' }),
      } } });
    const context = await loadCandidateAnswerEvidence({ db: f.store.db, userId: 'candidate', profileRecord: record });
    expect(context({ id: 'other', url: 'https://example.test/jobs/other/' }).answers[key]).toBe('C1');
  });
  it('removes cleared evidence from Firestore maps, preserving all unrelated profile fields', async () => {
    const f = fixture();
    await f.save({ english: 'C1' });
    await f.save({ english: '' });
    const record = f.store.read('user_cv_profiles/candidate');
    expect(record.applicationQuestionAnswers[key]).toBe('');
    expect(record.applicationQuestionAnswerEvidence[key]).toMatchObject({ cleared: true });
    expect(record.applicationQuestionAnswerEvidence[key]).not.toHaveProperty('question');
    expect(record.applicationQuestionAnswerEvidence[key]).not.toHaveProperty('answer');
    expect(record.profile.languages[0].level).toBe('B2');
    expect(record.status).toBe('ready');
  });
  it('does not overwrite a newer shared fact from unchanged memory on another order', async () => {
    const f = fixture();
    await f.save({ english: 'C1' });
    const salary = { id: 'salary', question: 'What is your requested salary in CHF per year?', type: 'number' };
    await f.save({ salary: '80000' }, { orderId: 'second', draft: { round: 1, questions: [salary] },
      flow: { state: 'candidate_review', round: 1, answers: {}, questionAnswers: { [key]: 'A1' } } });
    expect(f.store.read('user_cv_profiles/candidate').applicationQuestionAnswers[key]).toBe('C1');
    expect(f.store.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence[key].answer).toBe('C1');
  });
  it('does not attest an unknown writer or publish a stale round to the shared profile', async () => {
    const f = fixture();
    await f.save({ english: 'C1' }, { answerActor: null });
    expect(f.store.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence).toBeUndefined();
    const before = structuredClone(f.store.read('user_cv_profiles/candidate'));
    await f.save({ english: 'A1' }, { flow: { ...flow, round: 2 } });
    expect(f.store.read('user_cv_profiles/candidate')).toEqual(before);
  });
});

describe('shared confirmations are monotonic across orders', () => {
  it.each(['C1', ''])('an older changed answer (%s) cannot overwrite a newer source', async older => {
    const f = fixture();
    const secondOrder = { ...order, jobId: 'second-job', jobUrl: 'https://example.test/jobs/second/' };
    f.store.docs.set('assisted_applications/newer', secondOrder);
    f.store.docs.set('assisted_applications/newer/automation/flow', flow);
    f.store.docs.set('assisted_applications/newer/ai_drafts/current', draft);
    await f.save({ english: 'A1' }, { orderId: 'newer', order: secondOrder, flow, nowMs: now + 2 });
    await f.save({ english: older }, { nowMs: now + 1 });
    const record = f.store.read('user_cv_profiles/candidate');
    expect(record.applicationQuestionAnswers[key]).toBe('A1');
    expect(record.applicationQuestionAnswerEvidence[key].provenance.orderId).toBe('newer');
    expect(record.applicationQuestionAnswerEvidence[key].answer).toBe('A1');
  });
  it('keeps a metadata-only clear clock so an older positive cannot resurrect the fact', async () => {
    const f = fixture();
    await f.save({ english: 'C1' }, { nowMs: now + 1 });
    await f.save({ english: '' }, { nowMs: now + 3 });
    await f.save({ english: 'C1' }, { nowMs: now + 2 });
    const record = f.store.read('user_cv_profiles/candidate');
    expect(record.applicationQuestionAnswers[key]).toBe('');
    expect(record.applicationQuestionAnswerEvidence[key]).toMatchObject({ cleared: true, provenance: { confirmedAt: now + 3 } });
    expect(record.applicationQuestionAnswerEvidence[key]).not.toHaveProperty('answer');
    expect(record.applicationQuestionAnswerEvidence[key]).not.toHaveProperty('question');
  });
  it('does not choose between contradictory values with the same timestamp', async () => {
    const f = fixture();
    await f.save({ english: 'C1' });
    await f.save({ english: 'A1' });
    const record = f.store.read('user_cv_profiles/candidate');
    expect(record.applicationQuestionAnswers[key]).toBe('');
    expect(record.applicationQuestionAnswerEvidence[key]).toMatchObject({ cleared: true });
  });
});

describe('shared evidence never recreates deleted private profiles', () => {
  it('keeps the order-local answer while skipping a missing or deleted profile', async () => {
    const f = fixture();
    f.store.docs.delete('user_cv_profiles/candidate');
    await f.save({ english: 'C1' });
    expect(f.store.read('user_cv_profiles/candidate')).toBeUndefined();
    expect(f.store.read('assisted_applications/source/automation/flow').answers.english).toBe('C1');
  });
});
