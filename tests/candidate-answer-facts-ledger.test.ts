import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { candidateAnswersForQuestions, candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';
import { answerConfirmationSnapshotsFor, answerOriginsForQuestions, answerQuestionCompatibilityHash, answerQuestionSnapshotHash, answerQuestionSnapshotsFor, orderQuestionAnswerContext,
  rememberCandidateAnswerEvidence, rememberOrderQuestionAnswerSnapshots, loadCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { createAnswerSourceGuard } from '../functions/src/assistedApplicationAnswerSourceGuard.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { answerCvFingerprint } from '../functions/src/assistedApplicationAnswerConfirmation.js';
import { ORDER_QUESTION_ANSWER_EVIDENCE_VERSION } from '../functions/src/assistedApplicationCandidateEdits.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

const now = Date.now();
const target = { id: 'target', url: 'https://example.test/jobs/target/' };
const order = { userId: 'synthetic', jobId: 'source', jobUrl: 'https://example.test/jobs/source/',
  cvStorageKey: 'assisted-application-uploads/source/cv.pdf', cvUploadedAt: now };
const birth = `${new Date(now).getUTCFullYear() - 30}-02-20`;
const cases = [
  { question: { id: 'dob', question: 'What is your date of birth?', type: 'date' }, answer: birth, category: 'personal', unit: 'calendar_date', fact: { type: 'birth_date', subject: 'candidate' } },
  { question: { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number' }, answer: '3.5', category: 'experience', unit: 'years', fact: { type: 'experience_duration', subject: 'python' } },
  { question: { id: 'credential', question: 'Possiedi la certificazione PMP?', type: 'yes_no' }, answer: 'Sì', category: 'qualification', unit: 'boolean', fact: { type: 'credential_held', subject: 'pmp' } },
  { question: { id: 'permit', question: 'What is your current Swiss work permit status?', type: 'choice', options: permitOptions('en') }, answer: permitOptions('en')[1], category: 'work_authorization', unit: 'held_status', fact: { type: 'permit_status', jurisdiction: 'CH', status: 'permit_c' } },
];
type AnswerOriginFixture = Record<string, { originSource?: string; source?: string; kind?: string; originCvFingerprint?: string; value: string }>;
function fixture(testCase = cases[0], actor: 'candidate' | 'owner' = 'candidate', answerOrigins: AnswerOriginFixture = {}) {
  const { question, answer } = testCase;
  const key = candidateQuestionAnswerKey(question);
  const draft = { round: 1, cvKey: order.cvStorageKey, questions: [question] };
  const sourceKind = actor === 'candidate' ? 'direct_user' : 'owner_attested';
  const flow = { round: 1, answers: { [question.id]: answer }, answerOrigins,
    orderQuestionAnswersEvidenceVersion: ORDER_QUESTION_ANSWER_EVIDENCE_VERSION };
  const questionSnapshots = answerQuestionSnapshotsFor({ orderId: 'source', questions: [question], draft, nowMs: now });
  const confirmationSnapshots = answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow,
    questions: [question], draft, sourceKind, nowMs: now });
  const local = rememberOrderQuestionAnswerSnapshots({ orderId: 'source', order, flow, questions: [question], draft,
    answers: flow.answers, changed: flow.answers, questionAnswers: { [key]: answer }, confirmed: questionSnapshots,
    sourceKind, nowMs: now });
  Object.assign(flow, { questionAnswers: { [key]: answer }, questionAnswerSnapshots: local.snapshots,
    questionAnswerSnapshotIds: local.questionIds, questionAnswerCompatibility: local.compatibility,
    questionAnswerConfirmationHashes: local.confirmations, questionAnswerSources: local.sources });
  const evidence = rememberCandidateAnswerEvidence({ questions: [question], changed: flow.answers,
    confirmedQuestionSnapshots: confirmationSnapshots,
    orderId: 'source', order, flow, draft, actor, nowMs: now });
  const profileRecord = { applicationQuestionAnswers: { [key]: answer }, applicationQuestionAnswerEvidence: evidence };
  const store = createMemoryFirestore({ 'assisted_applications/source': order, 'assisted_applications/source/automation/flow': flow,
    'assisted_applications/source/ai_drafts/current': draft, 'user_cv_profiles/synthetic': profileRecord });
  const load = () => loadCandidateAnswerEvidence({ db: store.db, profileRecord, userId: order.userId, nowMs: now });
  return { store, evidence, profileRecord, key, load, order, flow, draft };
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
    expect(f.evidence[f.key].confirmationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.evidence[f.key].confirmationId).toMatch(/^[a-f0-9]{64}$/);
    expect(f.evidence[f.key]).toMatchObject({ sourceKind: 'direct_user', originSource: 'unknown' });
    expect(f.evidence[f.key]).not.toHaveProperty('cvFingerprint');
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
  it('binds direct confirmations to candidate, posting, round and question while owner attestations also bind the CV', () => {
    const question = cases[1].question;
    const draft = { ...fixture(cases[1]).draft, questions: [question] };
    const flow = { round: 1 };
    const snapshots = answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow,
      questions: [question], draft, nowMs: now });
    const baseline = snapshots[question.id];
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(answerConfirmationSnapshotsFor({ userId: 'another-candidate', orderId: 'source', order, flow,
      questions: [question], draft, nowMs: now })[question.id]).not.toBe(baseline);
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'another-order', order, flow,
      questions: [question], draft, nowMs: now })[question.id]).not.toBe(baseline);
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order: { ...order, jobUrl: 'https://example.test/jobs/changed/' }, flow,
      questions: [question], draft, nowMs: now })[question.id]).not.toBe(baseline);
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow: { round: 2 },
      questions: [question], draft: { ...draft, round: 2 }, nowMs: now })[question.id]).not.toBe(baseline);
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order: { ...order, cvUploadedAt: now + 1 }, flow,
      questions: [question], draft, nowMs: now })[question.id]).toBe(baseline);
    const ownerBaseline = answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow,
      questions: [question], draft, sourceKind: 'owner_attested', nowMs: now })[question.id];
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order: { ...order, cvUploadedAt: now + 1 }, flow,
      questions: [question], draft, sourceKind: 'owner_attested', nowMs: now })[question.id]).not.toBe(ownerBaseline);
    expect(answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow,
      questions: [{ ...question, question: 'How many years of experience with SQL?' }], draft, nowMs: now })[question.id]).not.toBe(baseline);
  });
  it('does not treat fact.type alone as proof when the exact source question is absent', async () => {
    const f = fixture();
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { ...f.draft, questions: [] });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('rejects a source answer when the same question id is reused for a different prompt', async () => {
    const f = fixture(cases[1]);
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { ...f.draft,
      questions: [{ ...cases[1].question, question: 'How many years of experience do you have with SQL?' }] });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('does not promote old ledger rows without the new typed confirmation proof', async () => {
    const f = fixture(cases[1]);
    delete f.evidence[f.key].confirmationHash;
    delete f.evidence[f.key].confirmationId;
    delete f.evidence[f.key].cvFingerprint;
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
    for (const change of ['unit', 'subject', 'round', 'answer', 'deadline', 'cv_key', 'cv_timestamp', 'draft_cv_key']) {
      const f = fixture(cases[1]);
      if (change === 'unit') f.evidence[f.key].unit = 'months';
      if (change === 'subject') f.evidence[f.key].fact.subject = 'sql';
      if (change === 'round') f.store.docs.set('assisted_applications/source/automation/flow', { round: 2, answers: { experience: '3.5' } });
      if (change === 'answer') f.store.docs.set('assisted_applications/source/automation/flow', { round: 1, answers: { experience: '1' } });
      if (change === 'deadline') f.store.docs.set('assisted_applications/source', { ...order, cvUploadedAt: now - 91 * 86400000 });
      if (change === 'cv_key') f.store.docs.set('assisted_applications/source', { ...order, cvStorageKey: `${order.cvStorageKey}.replacement` });
      if (change === 'cv_timestamp') f.store.docs.set('assisted_applications/source', { ...order, cvUploadedAt: now + 1 });
      if (change === 'draft_cv_key') f.store.docs.set('assisted_applications/source/ai_drafts/current', { ...f.draft, cvKey: `${order.cvStorageKey}.replacement` });
      const loaded = await f.load();
      const shouldSurviveDirectConfirmation = ['cv_key', 'cv_timestamp', 'draft_cv_key'].includes(change);
      expect(loaded(target).answerEvidence).toHaveLength(shouldSurviveDirectConfirmation ? 1 : 0);
    }
  });
  it('keeps a direct user answer after CV replacement but invalidates it after round or question changes', () => {
    const f = fixture(cases[1]);
    expect(orderQuestionAnswerContext({ orderId: 'source', order: f.order, flow: f.flow, draft: f.draft, nowMs: now }).answers)
      .toEqual(f.flow.answers);
    const replacementKey = 'assisted-application-uploads/source/replacement.pdf';
    expect(orderQuestionAnswerContext({ orderId: 'source', order: { ...f.order, cvStorageKey: replacementKey, cvUploadedAt: now + 1 },
      flow: f.flow, draft: { ...f.draft, cvKey: replacementKey }, nowMs: now }).answers).toEqual(f.flow.answers);
    expect(orderQuestionAnswerContext({ orderId: 'source', order: f.order, flow: { ...f.flow, round: 2 },
      draft: { ...f.draft, round: 2 }, nowMs: now }).answers).toEqual({});
    expect(orderQuestionAnswerContext({ orderId: 'source', order: f.order, flow: f.flow,
      draft: { ...f.draft, questions: [{ ...cases[1].question, question: 'How many years of experience do you have with SQL?' }] }, nowMs: now }).answers).toEqual({});
  });
  it('preserves that a CV-suggested value became a direct user statement after the CV is replaced', async () => {
    const question = cases[1].question;
    const cvFingerprint = answerCvFingerprint({ order, draft: { cvKey: order.cvStorageKey } });
    const f = fixture({ ...cases[1], question }, 'candidate', { [question.id]: {
      originSource: 'cv_inferred', originCvFingerprint: cvFingerprint, value: cases[1].answer,
    } });
    expect(f.evidence[f.key]).toMatchObject({ sourceKind: 'direct_user', originSource: 'cv_inferred' });
    expect(f.evidence[f.key].originCvFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const replacementKey = 'assisted-application-uploads/source/replacement.pdf';
    f.store.docs.set('assisted_applications/source', { ...f.order, cvStorageKey: replacementKey, cvUploadedAt: now + 1 });
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { ...f.draft, cvKey: replacementKey });
    expect((await f.load())(target).answerEvidence[0]).toMatchObject({ sourceKind: 'direct_user', originSource: 'cv_inferred' });
  });
  it('keeps an owner-attested local answer and candidate fact dependent on the current CV', async () => {
    const f = fixture(cases[1], 'owner');
    expect((await f.load())(f.order).answerEvidence).toHaveLength(1);
    const nextKey = 'assisted-application-uploads/source/replacement.pdf';
    f.store.docs.set('assisted_applications/source', { ...f.order, cvStorageKey: nextKey, cvUploadedAt: now + 1 });
    f.store.docs.set('assisted_applications/source/ai_drafts/current', { ...f.draft, cvKey: nextKey });
    const context = await f.load();
    expect(context(f.order).answerEvidence).toEqual([]);
    expect(orderQuestionAnswerContext({ orderId: 'source', order: { ...f.order, cvStorageKey: nextKey, cvUploadedAt: now + 1 },
      flow: f.flow, draft: { ...f.draft, cvKey: nextKey }, nowMs: now }).answers).toEqual({});
  });
  it.each(['unknown', "I don't know", 'Non lo so', 'Keine Angabe'])('never stores the explicit unknown value %s as a reusable answer', async value => {
    const f = fixture({ ...cases[1], answer: value });
    expect((await f.load())(target).answerEvidence).toEqual([]);
    expect(orderQuestionAnswerContext({ orderId: 'source', order: f.order, flow: f.flow, draft: f.draft, nowMs: now }).answers).toEqual({});
    expect(candidateAnswersForQuestions([cases[1].question], { [cases[1].question.id]: value }, { [f.key]: '3.5' }))
      .not.toHaveProperty(cases[1].question.id);
  });
  it('keeps direct answers to posting-specific experience tied to that posting', async () => {
    const question = { id: 'consulting', question: 'Have you got experience in consulting?', type: 'yes_no' };
    const f = fixture({ question, answer: 'Yes' });
    expect((await f.load())(target).answerEvidence).toEqual([]);
    expect((await f.load())(f.order).answerEvidence[0]).toMatchObject({ scope: 'job', sourceKind: 'direct_user' });
  });
  it.each([
    { id: 'notice_period', question: 'What is your notice period?', type: 'text', answer: '3 months' },
    { id: 'whatsapp', question: 'Can we contact you via WhatsApp?', type: 'yes_no', answer: 'Yes' },
    { id: 'whatsapp_it', question: 'Accetti la comunicazione tramite WhatsApp?', type: 'yes_no', answer: 'Sì' },
  ])('reuses a confirmed generic candidate preference across postings: $id', async testCase => {
    const f = fixture({ question: { id: testCase.id, question: testCase.question, type: testCase.type }, answer: testCase.answer });
    expect((await f.load())(target).answerEvidence[0]).toMatchObject({ scope: 'candidate', sourceKind: 'direct_user', answer: testCase.answer });
  });
  it.each([
    { id: 'notice_period', question: 'What is your notice period for this position?', type: 'text', answer: '3 months' },
    { id: 'whatsapp', question: 'Do you consent to WhatsApp updates about this application?', type: 'yes_no', answer: 'Yes' },
    { id: 'whatsapp_privacy', question: 'Do you consent to WhatsApp marketing updates?', type: 'yes_no', answer: 'Yes' },
  ])('does not promote posting-specific or privacy/marketing preferences: $id', async testCase => {
    const f = fixture({ question: { id: testCase.id, question: testCase.question, type: testCase.type }, answer: testCase.answer });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('does not reuse a candidate preference when the new question has different options', async () => {
    const question = { id: 'whatsapp', question: 'Can we contact you via WhatsApp?', type: 'choice', options: ['Yes', 'No'] };
    const f = fixture({ question, answer: 'Yes' });
    const targetQuestion = { ...question, id: 'whatsapp_target', options: ['Yes, at any time', 'No'] };
    const targetContext = await loadCandidateAnswerEvidence({ db: f.store.db, profileRecord: f.profileRecord, userId: order.userId,
      nowMs: now, questionKeys: [candidateQuestionAnswerKey(targetQuestion)] });
    expect(targetContext(target, { purpose: 'form' }).answerEvidence).toEqual([]);
    expect(candidateQuestionAnswerKey(question)).not.toBe(candidateQuestionAnswerKey(targetQuestion));
  });
  it('preserves source provenance when a typed answer is localized into another posting option', async () => {
    const sourceAnswer = permitOptions('en')[1];
    const sourceQuestion = cases[3].question;
    const f = fixture({ ...cases[3], answer: sourceAnswer }, 'candidate', { [sourceQuestion.id]: {
      originSource: 'profile_inferred', value: sourceAnswer,
    } });
    const targetQuestion = { id: 'permit_it', question: 'Quale permesso svizzero possiedi attualmente?', type: 'choice', options: permitOptions('it') };
    const targetKey = candidateQuestionAnswerKey(targetQuestion);
    const contextForTarget = await loadCandidateAnswerEvidence({ db: f.store.db, profileRecord: f.profileRecord,
      userId: order.userId, nowMs: now, questionKeys: [targetKey] });
    const candidateEvidence = contextForTarget(target, { purpose: 'form' });
    const projected = candidateAnswersForQuestions([targetQuestion], {}, candidateEvidence.answers);
    expect(projected.permit_it).toBe(permitOptions('it')[1]);
    expect(answerOriginsForQuestions({ questions: [targetQuestion], answers: projected,
      answerEvidence: candidateEvidence.answerEvidence })).toMatchObject({ permit_it: { originSource: 'profile_inferred' } });
  });
  it('keeps a direct user answer usable after the source CV is replaced', async () => {
    const f = fixture(cases[1]);
    const targetOrder = { userId: order.userId, jobId: 'target', jobUrl: target.url,
      cvStorageKey: 'assisted-application-uploads/target/cv.pdf', cvUploadedAt: now };
    const targetFlow = { state: 'submitting', round: 1, answers: {} };
    const targetDraft = { round: 1, cvKey: targetOrder.cvStorageKey,
      questions: [{ ...cases[1].question, id: 'target_experience' }] };
    await f.store.db.collection('assisted_applications').doc('target').set(targetOrder);
    await f.store.db.collection('assisted_applications').doc('target').collection('automation').doc('flow').set(targetFlow);
    await f.store.db.collection('assisted_applications').doc('target').collection('ai_drafts').doc('current').set(targetDraft);
    const answerEvidence = (await f.load())(target, { purpose: 'form' }).answerEvidence;
    const answerSourceGuard = createAnswerSourceGuard({ orderId: 'target', order: targetOrder, flow: targetFlow,
      draft: targetDraft, answerEvidence, nowMs: now });
    const guard = submissionGuard(f.store.db, 'target', 1, { answerSourceGuard });
    expect(await guard.claim('portal', now)).toMatchObject({ status: 'claimed' });

    const replacementKey = 'assisted-application-uploads/source/replacement.pdf';
    await f.store.db.collection('assisted_applications').doc('source').set({ ...f.order, cvStorageKey: replacementKey, cvUploadedAt: now + 1 });
    await f.store.db.collection('assisted_applications').doc('source').collection('ai_drafts').doc('current').set({ ...f.draft, cvKey: replacementKey });
    await guard.markClicked(now + 2);
    expect(await guard.read()).toMatchObject({ state: 'sending', clickedAt: now + 2 });
  });
  it('blocks a pending final click when the source question changes after claim', async () => {
    const f = fixture(cases[1]);
    const targetOrder = { userId: order.userId, jobId: 'target', jobUrl: target.url,
      cvStorageKey: 'assisted-application-uploads/target/cv.pdf', cvUploadedAt: now };
    const targetFlow = { state: 'submitting', round: 1, answers: {} };
    const targetDraft = { round: 1, cvKey: targetOrder.cvStorageKey,
      questions: [{ ...cases[1].question, id: 'target_experience' }] };
    await f.store.db.collection('assisted_applications').doc('target').set(targetOrder);
    await f.store.db.collection('assisted_applications').doc('target').collection('automation').doc('flow').set(targetFlow);
    await f.store.db.collection('assisted_applications').doc('target').collection('ai_drafts').doc('current').set(targetDraft);
    const answerEvidence = (await f.load())(target, { purpose: 'form' }).answerEvidence;
    const answerSourceGuard = createAnswerSourceGuard({ orderId: 'target', order: targetOrder, flow: targetFlow,
      draft: targetDraft, answerEvidence, nowMs: now });
    const guard = submissionGuard(f.store.db, 'target', 1, { answerSourceGuard });
    expect(await guard.claim('portal', now)).toMatchObject({ status: 'claimed' });
    await f.store.db.collection('assisted_applications').doc('target').collection('ai_drafts').doc('current').set({
      ...targetDraft, questions: [{ ...targetDraft.questions[0], question: 'How many years of experience with SQL?' }],
    });
    await expect(guard.markClicked(now + 2)).rejects.toThrow('answer_source_changed');
    expect(await guard.read()).toMatchObject({ state: 'sending', clickedAt: null });
  });
  it('validates options and the full contract before promoting a positive typed subject', () => {
    const question = { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number', validation: { min: 5 } };
    const flow = { round: 1 };
    const draft = { round: 1, cvKey: order.cvStorageKey, questions: [question] };
    const records = rememberCandidateAnswerEvidence({ questions: [question], changed: { experience: '3' },
      confirmedQuestionSnapshots: answerConfirmationSnapshotsFor({ userId: order.userId, orderId: 'source', order, flow, questions: [question], draft, nowMs: now }),
      orderId: 'source', order, flow, draft, actor: 'candidate', nowMs: now });
    expect(records[candidateQuestionAnswerKey(question)]).toMatchObject({ cleared: true });
    expect(records[candidateQuestionAnswerKey(question)]).not.toHaveProperty('fact');
  });
});
