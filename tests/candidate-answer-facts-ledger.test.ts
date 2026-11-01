import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';
import { answerQuestionCompatibilityHash, answerQuestionSnapshotHash, answerQuestionSnapshotsFor, rememberCandidateAnswerEvidence, loadCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { ORDER_QUESTION_ANSWER_EVIDENCE_VERSION } from '../functions/src/assistedApplicationCandidateEdits.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

const now = Date.now();
const target = { id: 'target', url: 'https://example.test/jobs/target/' };
const order = { userId: 'synthetic', jobId: 'source', jobUrl: 'https://example.test/jobs/source/', cvUploadedAt: now };
const birth = `${new Date(now).getUTCFullYear() - 30}-02-20`;
const cases = [
  { question: { id: 'dob', question: 'What is your date of birth?', type: 'date' }, answer: birth, category: 'personal', unit: 'calendar_date', fact: { type: 'birth_date', subject: 'candidate' } },
  { question: { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number' }, answer: '3.5', category: 'experience', unit: 'years', fact: { type: 'experience_duration', subject: 'python' } },
  { question: { id: 'credential', question: 'Possiedi la certificazione PMP?', type: 'yes_no' }, answer: 'Sì', category: 'qualification', unit: 'boolean', fact: { type: 'credential_held', subject: 'pmp' } },
  { question: { id: 'permit', question: 'What is your current Swiss work permit status?', type: 'choice', options: permitOptions('en') }, answer: permitOptions('en')[1], category: 'work_authorization', unit: 'held_status', fact: { type: 'permit_status', jurisdiction: 'CH', status: 'permit_c' } },
];
function fixture(testCase = cases[0]) {
  const { question, answer } = testCase;
  const key = candidateQuestionAnswerKey(question);
  const draft = { round: 1, questions: [question] };
  const questionAnswerSnapshots = { [key]: answerQuestionSnapshotHash({ orderId: 'source', question, draft, nowMs: now }) };
  const flow = { round: 1, answers: { [question.id]: answer }, questionAnswerSnapshots,
    questionAnswerSnapshotIds: { [key]: [question.id] },
    questionAnswerCompatibility: { [key]: answerQuestionCompatibilityHash({ orderId: 'source', question, draft, nowMs: now }) },
    orderQuestionAnswersEvidenceVersion: ORDER_QUESTION_ANSWER_EVIDENCE_VERSION };
  const evidence = rememberCandidateAnswerEvidence({ questions: [question], changed: flow.answers,
    confirmedQuestionSnapshots: answerQuestionSnapshotsFor({ orderId: 'source', questions: [question], draft, nowMs: now }),
    orderId: 'source', order, flow, draft, actor: 'candidate', nowMs: now });
  const profileRecord = { applicationQuestionAnswers: { [key]: answer }, applicationQuestionAnswerEvidence: evidence };
  const store = createMemoryFirestore({ 'assisted_applications/source': order, 'assisted_applications/source/automation/flow': flow, 'assisted_applications/source/ai_drafts/current': draft });
  const load = () => loadCandidateAnswerEvidence({ db: store.db, profileRecord, userId: order.userId, nowMs: now });
  return { store, evidence, profileRecord, key, load };
}

describe('typed facts use the attested answer source contract', () => {
  it.each(cases)('retains full question, typed $category unit and candidate provenance for cross-job use', async testCase => {
    const f = fixture(testCase);
    expect((await f.load())(target).answerEvidence[0]).toMatchObject({ question: testCase.question, answer: testCase.answer,
      category: testCase.category, unit: testCase.unit, scope: 'candidate', fact: testCase.fact, provenance: { actor: 'candidate', orderId: 'source', round: 1, confirmedAt: now } });
  });
  it('returns an opaque digest rather than answer values as the cache fingerprint', async () => {
    const f = fixture();
    const result = (await f.load())(target);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprint).not.toContain(cases[0].answer);
    expect(result.fingerprint).not.toContain(f.key);
    expect(f.evidence[f.key].id).toMatch(/^answer-[a-f0-9]{24}$/);
    expect((await f.load())(target).fingerprint).toBe(result.fingerprint);
  });
  it('binds confirmation to the shown question text and excludes answer-shaped payload fields', () => {
    const question = { id: 'experience', question: 'How many years of Python experience?', type: 'number', required: true,
      answer: '3.5', suggested: '5', value: '3.5' };
    const sameQuestion = { ...question, answer: '8', suggested: '10', value: '8' };
    const changedQuestion = { ...sameQuestion, question: 'How many years of SQL experience?' };
    const originalHash = answerQuestionSnapshotHash({ orderId: 'source', question });
    const originalCompatibility = answerQuestionCompatibilityHash({ orderId: 'source', question });
    expect(answerQuestionSnapshotHash({ orderId: 'source', question: sameQuestion })).toBe(originalHash);
    expect(answerQuestionCompatibilityHash({ orderId: 'source', question: sameQuestion })).toBe(originalCompatibility);
    expect(answerQuestionSnapshotHash({ orderId: 'source', question: changedQuestion })).not.toBe(originalHash);
    expect(originalHash).not.toContain(question.answer);
    expect(originalCompatibility).not.toContain(question.answer);
  });
  it('does not treat fact.type alone as proof when the exact source question is absent', async () => {
    const f = fixture();
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { round: 1, questions: [] });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('rejects a source answer when the same question id is reused for a different prompt', async () => {
    const f = fixture(cases[1]);
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { round: 1,
      questions: [{ ...cases[1].question, question: 'How many years of experience do you have with SQL?' }] });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('keeps G attached to the source employment rather than granting general work rights', async () => {
    const f = fixture({ ...cases[3], answer: permitOptions('en')[4] });
    const context = await f.load();
    expect(context(target).answerEvidence).toEqual([]);
    expect(context(order).answerEvidence[0]).toMatchObject({ scope: 'job', fact: { status: 'permit_g', relation: 'reported_possession_not_work_right' } });
  });
  it.each(['B (will be sponsored by employer)', 'B (only if the employer sponsors me)', 'C (role-specific condition)'])('does not promote a conditional permit answer to a portable fact: %s', answer => {
    const f = fixture({ ...cases[3], answer, question: { ...cases[3].question, options: [answer] } });
    expect(f.evidence[f.key]).not.toHaveProperty('fact');
    expect(f.evidence[f.key]?.scope).not.toBe('candidate');
  });
  it('does not reuse a fact whose unit, subject, round, source answer or retention changed', async () => {
    for (const change of ['unit', 'subject', 'round', 'answer', 'deadline']) {
      const f = fixture(cases[1]);
      if (change === 'unit') f.evidence[f.key].unit = 'months';
      if (change === 'subject') f.evidence[f.key].fact.subject = 'sql';
      if (change === 'round') f.store.docs.set('assisted_applications/source/automation/flow', { round: 2, answers: { experience: '3.5' } });
      if (change === 'answer') f.store.docs.set('assisted_applications/source/automation/flow', { round: 1, answers: { experience: '1' } });
      if (change === 'deadline') f.store.docs.set('assisted_applications/source', { ...order, cvUploadedAt: now - 91 * 86400000 });
      expect((await f.load())(target).answerEvidence).toEqual([]);
    }
  });
  it('validates options and the full contract before promoting a positive typed subject', () => {
    const question = { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number', validation: { min: 5 } };
    const records = rememberCandidateAnswerEvidence({ questions: [question], changed: { experience: '3' },
      confirmedQuestionSnapshots: answerQuestionSnapshotsFor({ orderId: 'source', questions: [question], draft: { round: 1, questions: [question] }, nowMs: now }),
      orderId: 'source', order, flow: { round: 1 }, draft: { round: 1 }, actor: 'candidate', nowMs: now });
    expect(records[candidateQuestionAnswerKey(question)]).toMatchObject({ cleared: true });
    expect(records[candidateQuestionAnswerKey(question)]).not.toHaveProperty('fact');
  });
});
