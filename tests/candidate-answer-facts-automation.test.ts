import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => 'true'), bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}) }));
const tailoredCvMocks = vi.hoisted(() => ({
  tailoredCvChanges: vi.fn(() => false),
  rebuildTailoredCvPdf: vi.fn(),
  supersededPhotoPdf: vi.fn(() => null),
}));
vi.mock('../functions/src/assistedApplicationTailoredCvPdf.js', () => ({
  tailoredCvChanges: tailoredCvMocks.tailoredCvChanges,
  rebuildTailoredCvPdf: tailoredCvMocks.rebuildTailoredCvPdf,
  supersededPhotoPdf: tailoredCvMocks.supersededPhotoPdf,
}));
const { saveAnswersWithCv } = await import('../functions/src/assistedApplicationCvCommit.js');
const { startAutomation, applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
const { answerOriginsForQuestions, loadCandidateAnswerEvidence, loadRunnerAnswerContext } = await import('../functions/src/assistedApplicationAnswerEvidence.js');
const { answerConfirmationSnapshotsFor } = await import('../functions/src/assistedApplicationAnswerEvidence.js');
const { answerCvFingerprint } = await import('../functions/src/assistedApplicationAnswerConfirmation.js');
const { candidateAnswersForQuestions, candidateQuestionAnswerKey } = await import('../functions/src/assistedApplicationCandidateEdits.js');

type CvOrderFixture = Record<string, unknown> & { cvStorageKey?: string; cvUploadedAt?: number; userId?: string };
type CvDraftFixture = Record<string, unknown> & { cvKey?: string };
type ConfirmationSnapshotInput = { orderId: string; order: CvOrderFixture; flow: Record<string, unknown>;
  questions: Array<Record<string, unknown>>; draft: CvDraftFixture; nowMs: number };
const orderWithCv = (orderId: string, order: CvOrderFixture) => ({
  ...order,
  cvStorageKey: order.cvStorageKey || `assisted-application-uploads/${orderId}/test-cv.pdf`,
  cvUploadedAt: order.cvUploadedAt || Date.now(),
});
const draftWithCv = (order: CvOrderFixture, draft: CvDraftFixture) => ({ ...draft, cvKey: order.cvStorageKey });
const confirmationSnapshots = ({ orderId, order, flow, questions, draft, nowMs }: ConfirmationSnapshotInput) => answerConfirmationSnapshotsFor({
  userId: order.userId, orderId, order, flow, questions, draft, nowMs,
});

function bufferedDb(store, { failPath = '' } = {}) {
  const transactions = [];
  const db = {
    collection: store.db.collection,
    async runTransaction(callback: (transaction: any) => Promise<any>) {
      const writes: Array<{ ref: any; data?: any; options?: any; delete?: boolean }> = [];
      const result = await callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => {
          if (ref.path === failPath) throw new Error('synthetic_transaction_write_failure');
          writes.push({ ref, data, options });
        },
        delete: (ref: any) => writes.push({ ref, delete: true }),
      });
      for (const write of writes) {
        if (write.delete) await write.ref.delete();
        else await write.ref.set(write.data, write.options);
      }
      transactions.push(writes);
      return result;
    },
  };
  return { db: db as any, transactions };
}

describe('typed facts use the complete producer and automation path', () => {
  it('reuses the four attested fact types through source reads and equivalent native values without another candidate request', async () => {
    const now = Date.now(), orderId = 'order_ABC123', path = `assisted_applications/${orderId}`;
    const cvStorageKey = `assisted-application-uploads/${orderId}/1-cv.pdf`;
    const order = orderWithCv(orderId, { userId: 'synthetic', paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', cvUploadedAt: now,
      cvStorageKey, cvFileCheck: { key: cvStorageKey, verdict: 'ok', detectedType: 'pdf' }, jobId: 'target', jobUrl: 'https://example.test/jobs/target/' });
    const source = orderWithCv('source', { ...order, cvStorageKey: undefined, jobId: 'source', jobUrl: 'https://example.test/jobs/source/' });
    const questions = [
      { id: 'dob', question: 'What is your date of birth?', type: 'date' },
      { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number' },
      { id: 'credential', question: 'Possiedi la certificazione PMP?', type: 'yes_no' },
      { id: 'permit', question: 'What is your current Swiss work permit status?', type: 'choice', options: permitOptions('en') },
    ];
    const answers = { dob: `${new Date(now).getUTCFullYear() - 30}-02-20`, experience: '3.5', credential: 'Sì', permit: permitOptions('en')[1] };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} }, draft = draftWithCv(source, { round: 1, questions });
    const store = createMemoryFirestore({ [path]: order, 'assisted_applications/source': source,
      'assisted_applications/source/automation/flow': flow, 'assisted_applications/source/ai_drafts/current': draft,
      'user_cv_profiles/synthetic': { status: 'ready', profile: { languages: [] } } });
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: 'source', order: source, flow, draft, answers,
      answerQuestionSnapshots: confirmationSnapshots({ orderId: 'source', order: source, flow, questions, draft, nowMs: now }), answerActor: 'candidate', nowMs: now });
    const profile = store.read('user_cv_profiles/synthetic');
    expect(Object.values(profile.applicationQuestionAnswerEvidence)).toHaveLength(4);
    for (const question of questions) {
      const key = candidateQuestionAnswerKey(question);
      const evidence = profile.applicationQuestionAnswerEvidence[key];
      expect(profile.applicationQuestionAnswers[key]).toBe(answers[question.id]);
      expect(evidence).toMatchObject({ answer: answers[question.id], question: expect.objectContaining({
        id: question.id, question: question.question,
      }), scope: 'candidate', provenance: { actor: 'candidate', userId: 'synthetic', orderId: 'source', round: 1, confirmedAt: now } });
      expect(evidence.questionSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.questionCompatibilityHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(profile.profile).toEqual({ languages: [] });
    const sourceContext = await loadRunnerAnswerContext({ db: store.db, orderId: 'source', order: source,
      flow: store.read('assisted_applications/source/automation/flow'), draft, nowMs: now });
    expect(sourceContext.answerEvidence).toHaveLength(4);
    expect(candidateAnswersForQuestions(questions, {}, sourceContext.flow.questionAnswers)).toEqual(answers);
    const purgeStarted = await loadRunnerAnswerContext({ db: store.db, orderId: 'source', order: { ...source, retentionPurgingAt: now },
      flow: store.read('assisted_applications/source/automation/flow'), draft, nowMs: now });
    expect(purgeStarted.answerEvidence).toEqual([]);
    expect(purgeStarted.flow.answers).toEqual({});
    expect(purgeStarted.flow.questionAnswers).toEqual({});
    const runEffect = vi.fn(async (_input: any) => ({ ok: true }));
    await startAutomation({ db: store.db, orderId, runEffect, nowMs: now });
    expect(store.read(`${path}/automation/flow`).questionAnswers).toEqual({});
    const translated = [
      { id: 'it_dob', question: 'Qual è la tua data di nascita?', type: 'date' },
      { id: 'it_experience', question: 'Quanti anni di esperienza hai con Python?', type: 'number' },
      { id: 'en_credential', question: 'Do you hold the PMP certification?', type: 'yes_no', options: ['Yes', 'No'] },
      { id: 'fr_permit', question: 'Quel permis suisse possédez-vous actuellement?', type: 'choice', options: permitOptions('fr') },
    ];
    const rawFlow = { round: 1, state: 'submitting', answers: {}, questionAnswers: { legacy_consent: 'Yes' }, heldBy: [], dispatch: { mode: 'submit', round: 1, attempts: 2 } };
    const original = structuredClone(rawFlow);
    const context = await loadRunnerAnswerContext({ db: store.db, orderId, order, flow: rawFlow, draft: { round: 1, questions: translated } });
    expect(context.answerEvidence).toHaveLength(4);
    expect(rawFlow).toEqual(original);
    expect(context.flow.questionAnswers).not.toHaveProperty('legacy_consent');
    expect(candidateAnswersForQuestions(translated, {}, context.flow.questionAnswers)).toEqual({ it_dob: answers.dob,
      it_experience: answers.experience, en_credential: 'Yes', fr_permit: permitOptions('fr')[1] });
    const purgingTarget = await loadRunnerAnswerContext({ db: store.db, orderId, order: { ...order, retentionPurgingAt: now },
      flow: rawFlow, draft: { round: 1, questions: translated }, nowMs: now });
    expect(purgingTarget.answerEvidence).toEqual([]);
    expect(purgingTarget.flow.answers).toEqual({});
    expect(purgingTarget.flow.questionAnswers).toEqual({});
    store.docs.set(`${path}/automation/flow`, rawFlow);
    store.docs.set(`${path}/ai_drafts/current`, { round: 1, status: 'ready', questions: translated, factCheck: { ok: true, unsupported: [] }, verdict: 'good' });
    runEffect.mockClear();
    const result = await applyAutomationEvent({ db: store.db, orderId, event: { type: 'submit_needs_candidate', questions: translated.map(q => q.id), questionDetails: translated }, runEffect, nowMs: now });
    expect(result.flow.state).toBe('owner_takeover');
    expect(runEffect.mock.calls.some(([input]) => input.effect.kind === 'candidate_action_needed')).toBe(false);
    expect(store.read(`${path}/automation/flow`).questionAnswers).toEqual({});
  });

  it('preserves a server-attested answer origin only when the candidate confirms the exact value', async () => {
    const now = Date.now(), userId = 'synthetic', sourceId = 'source_attested_origin', targetId = 'target_attested_origin';
    const source = orderWithCv(sourceId, { userId, paymentStatus: 'paid', jobId: sourceId, jobUrl: `https://example.test/jobs/${sourceId}/` });
    const target = orderWithCv(targetId, { userId, paymentStatus: 'paid', jobId: targetId, jobUrl: `https://example.test/jobs/${targetId}/` });
    const value = '3.5';
    const sourceQuestion = { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number' };
    const targetQuestion = { ...sourceQuestion, id: 'target_experience' };
    const sourceOrigin = { originSource: 'cv_inferred', value,
      originCvFingerprint: answerCvFingerprint({ order: source, draft: { cvKey: source.cvStorageKey } }) };
    const sourceFlow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {}, answerOrigins: { [sourceQuestion.id]: sourceOrigin } };
    const sourceDraft = draftWithCv(source, { round: 1, questions: [sourceQuestion] });
    const targetFlow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const targetDraft = draftWithCv(target, { round: 1, questions: [targetQuestion] });
    const store = createMemoryFirestore({ [`assisted_applications/${sourceId}`]: source,
      [`assisted_applications/${sourceId}/automation/flow`]: sourceFlow,
      [`assisted_applications/${sourceId}/ai_drafts/current`]: sourceDraft,
      [`assisted_applications/${targetId}`]: target,
      [`assisted_applications/${targetId}/automation/flow`]: targetFlow,
      [`assisted_applications/${targetId}/ai_drafts/current`]: targetDraft,
      [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } } });

    const sourceOrigins = answerOriginsForQuestions({ questions: [sourceQuestion], answers: { [sourceQuestion.id]: value }, flow: sourceFlow });
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: sourceId, order: source, flow: sourceFlow, draft: sourceDraft,
      answers: { experience: value }, answerQuestionSnapshots: confirmationSnapshots({ orderId: sourceId, order: source, flow: sourceFlow,
        questions: [sourceQuestion], draft: sourceDraft, nowMs: now }), confirmedAnswerOrigins: sourceOrigins, answerActor: 'candidate', nowMs: now });

    const targetNow = now + 2000;
    const runner = await loadRunnerAnswerContext({ db: store.db, orderId: targetId, order: target,
      flow: targetFlow, draft: targetDraft, nowMs: targetNow });
    const answers = candidateAnswersForQuestions([targetQuestion], {}, runner.flow.questionAnswers);
    const origins = answerOriginsForQuestions({ questions: [targetQuestion], answers, answerEvidence: runner.answerEvidence });
    expect(origins.target_experience).toMatchObject({ originSource: 'cv_inferred',
      originCvFingerprint: sourceOrigin.originCvFingerprint });
    expect(answerOriginsForQuestions({ questions: [targetQuestion], answers: { target_experience: '4' }, answerEvidence: runner.answerEvidence }))
      .toEqual({});
    const reviewFlow = { ...targetFlow, answerOrigins: origins };
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: targetId, order: target, flow: reviewFlow, draft: targetDraft,
      answers, answerQuestionSnapshots: confirmationSnapshots({ orderId: targetId, order: target, flow: reviewFlow,
        questions: [targetQuestion], draft: targetDraft, nowMs: targetNow }), confirmedAnswerOrigins: origins,
      answerActor: 'candidate', nowMs: targetNow });

    const key = candidateQuestionAnswerKey(targetQuestion);
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence[key]).toMatchObject({
      answer: value, sourceKind: 'direct_user', originSource: 'cv_inferred',
      originCvFingerprint: sourceOrigin.originCvFingerprint,
      provenance: { actor: 'candidate', orderId: targetId },
    });

    const savedFlow = store.read(`assisted_applications/${targetId}/automation/flow`);
    const afterSave = await loadRunnerAnswerContext({ db: store.db, orderId: targetId, order: target,
      flow: savedFlow, draft: targetDraft, nowMs: targetNow + 2000 });
    const displayedAnswers = candidateAnswersForQuestions([targetQuestion], {}, afterSave.flow.questionAnswers);
    const displayedOrigins = answerOriginsForQuestions({ questions: [targetQuestion], answers: displayedAnswers,
      answerEvidence: afterSave.answerEvidence, flow: afterSave.flow });
    const changedAnswer = { target_experience: '4' };
    const changedFlow = { ...afterSave.flow, answerOrigins: displayedOrigins };
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: targetId, order: target, flow: changedFlow, draft: targetDraft,
      answers: changedAnswer, answerQuestionSnapshots: confirmationSnapshots({ orderId: targetId, order: target, flow: changedFlow,
        questions: [targetQuestion], draft: targetDraft, nowMs: targetNow + 2000 }), confirmedAnswerOrigins: {},
      answerActor: 'candidate', nowMs: targetNow + 2000 });
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence[key]).toMatchObject({
      answer: '4', sourceKind: 'direct_user', originSource: 'unknown',
    });
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence[key]).not.toHaveProperty('originCvFingerprint');
  });

  it('commits typed evidence with the confirmed source answer in the same transaction, including a CV rebuild', async () => {
    const now = Date.now(), orderId = 'atomic_answer_order', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = orderWithCv(orderId, { userId, paymentStatus: 'paid', cvUploadedAt: now, jobId: 'source', jobUrl: 'https://example.test/jobs/source/' });
    const question = { id: 'birth_date', question: 'What is your date of birth?', type: 'date' };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = draftWithCv(order, { round: 1, questions: [question] });
    const store = createMemoryFirestore({ [path]: order, [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft, [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } } });
    const { db, transactions } = bufferedDb(store);
    tailoredCvMocks.tailoredCvChanges.mockReturnValueOnce(true);
    tailoredCvMocks.rebuildTailoredCvPdf.mockResolvedValueOnce({ pdfKey: 'synthetic-tailored.pdf', renderer: 'test', photo: null });

    await saveAnswersWithCv({ db, bucket: {}, orderId, order, flow, draft, answers: { birth_date: '1996-02-20' },
      answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions: [question], draft, nowMs: now }), answerActor: 'candidate', nowMs: now });

    expect(transactions).toHaveLength(1);
    const committedPaths = new Set(transactions[0].map(write => write.ref.path));
    expect(committedPaths).toEqual(new Set([`${path}/automation/flow`, `${path}/ai_drafts/current`, `user_cv_profiles/${userId}`]));
    const key = candidateQuestionAnswerKey(question);
    const profile = store.read(`user_cv_profiles/${userId}`);
    expect(profile.applicationQuestionAnswers[key]).toBe('1996-02-20');
    expect(profile.applicationQuestionAnswerEvidence[key]).toMatchObject({
      answer: '1996-02-20', scope: 'candidate', question: expect.objectContaining({ id: question.id }),
      provenance: { actor: 'candidate', userId, orderId, round: 1, confirmedAt: now },
    });
    expect(store.read(`${path}/automation/flow`).answers.birth_date).toBe('1996-02-20');
    expect(store.read(`${path}/ai_drafts/current`).tailoredCv.pdfKey).toBe('synthetic-tailored.pdf');
  });

  it('does not commit an order answer if its shared evidence write fails', async () => {
    const now = Date.now(), orderId = 'failed_ledger_order', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = orderWithCv(orderId, { userId, paymentStatus: 'paid', cvUploadedAt: now, jobId: 'source', jobUrl: 'https://example.test/jobs/source/' });
    const question = { id: 'birth_date', question: 'What is your date of birth?', type: 'date' };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = draftWithCv(order, { round: 1, questions: [question] });
    const store = createMemoryFirestore({ [path]: order, [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft, [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } } });
    const { db, transactions } = bufferedDb(store, { failPath: `user_cv_profiles/${userId}` });

    await expect(saveAnswersWithCv({ db, bucket: null, orderId, order, flow, draft, answers: { birth_date: '1996-02-20' },
      answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions: [question], draft, nowMs: now }), answerActor: 'candidate', nowMs: now }))
      .rejects.toThrow('synthetic_transaction_write_failure');

    expect(transactions).toHaveLength(0);
    expect(store.read(`${path}/automation/flow`).answers).toEqual({});
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence).toBeUndefined();
  });

  it('reuses generic candidate facts across jobs and keeps unrecognized answers unverified', async () => {
    const now = Date.now(), orderId = 'scoped_answer_order', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = orderWithCv(orderId, { userId, paymentStatus: 'paid', cvUploadedAt: now, jobId: 'source', jobUrl: 'https://example.test/jobs/source/' });
    const questions = [
      { id: 'notice_period', question: 'What is your notice period?', type: 'text' },
      { id: 'origin_region', question: 'Which region is your place of origin?', type: 'text' },
    ];
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = draftWithCv(order, { round: 1, questions });
    const store = createMemoryFirestore({ [path]: order, [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft, [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } } });
    const { db, transactions } = bufferedDb(store);
    const answers = { notice_period: '3 months', origin_region: 'Ticino' };

    await saveAnswersWithCv({ db, bucket: null, orderId, order, flow, draft, answers,
      answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions, draft, nowMs: now }), answerActor: 'candidate', nowMs: now });

    const profile = store.read(`user_cv_profiles/${userId}`);
    const noticeKey = candidateQuestionAnswerKey(questions[0]);
    const regionKey = candidateQuestionAnswerKey(questions[1]);
    expect(transactions).toHaveLength(1);
    expect(profile.applicationQuestionAnswerEvidence[noticeKey]).toMatchObject({
      answer: '3 months', scope: 'candidate', question: expect.objectContaining({ id: 'notice_period' }),
      provenance: { actor: 'candidate', orderId, round: 1, jobUrl: order.jobUrl },
    });
    expect(profile.applicationQuestionAnswerEvidence[regionKey]).toMatchObject({ cleared: true,
      provenance: { actor: 'candidate', orderId, round: 1 } });
    expect(profile.applicationQuestionAnswerEvidence[regionKey]).not.toHaveProperty('answer');
    expect(profile.applicationQuestionAnswers[noticeKey]).toBe('3 months');
    expect(profile.applicationQuestionAnswers[regionKey]).toBe('');

    const contextFor = await loadCandidateAnswerEvidence({ db: store.db, profileRecord: profile, userId, nowMs: now });
    expect(contextFor({ id: 'other', url: 'https://example.test/jobs/other/' }, { purpose: 'form' }).answerEvidence).toMatchObject([
      { answer: '3 months', scope: 'candidate', provenance: { jobUrl: order.jobUrl } },
    ]);
    expect(contextFor(order, { purpose: 'form' }).answerEvidence).toMatchObject([
      { answer: '3 months', scope: 'candidate', provenance: { jobUrl: order.jobUrl } },
    ]);
  });

  it('does not recreate local answers or profile evidence when retention purge wins during a save', async () => {
    const now = Date.now(), orderId = 'purge_race_order', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = orderWithCv(orderId, { userId, paymentStatus: 'paid', cvUploadedAt: now, jobId: 'target', jobUrl: 'https://example.test/jobs/target/' });
    const question = { id: 'notice_period', question: 'What is your notice period?', type: 'text', required: true };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = draftWithCv(order, { round: 1, questions: [question] });
    const store = createMemoryFirestore({
      [path]: order,
      [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft,
      [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } },
    });
    const profileRef = store.db.collection('user_cv_profiles').doc(userId);
    const orderRef = store.db.collection('assisted_applications').doc(orderId);
    const flowRef = orderRef.collection('automation').doc('flow');
    const commitTransaction = store.db.runTransaction.bind(store.db);
    let purgeWon = false;
    let attemptedLedgerWrite = false;
    const db = {
      collection: store.db.collection,
      async runTransaction(callback: (transaction: any) => Promise<any>) {
        if (purgeWon) return commitTransaction(callback);
        let readProfile = false;
        const writes: Array<{ ref: any; data: any; options: any }> = [];
        const result = await callback({
          get: async (ref: any) => {
            if (ref.path === `user_cv_profiles/${userId}`) readProfile = true;
            return ref.get();
          },
          set: (ref: any, data: any, options?: any) => {
            if (ref.path === `user_cv_profiles/${userId}`) attemptedLedgerWrite = true;
            writes.push({ ref, data, options });
          },
          delete: (ref: any) => writes.push({ ref, delete: true, options: undefined }),
        });
        if (readProfile) {
          // Model Firestore retrying the transaction after the purge atomically
          // writes its order marker and removes this order's profile evidence.
          purgeWon = true;
          await orderRef.set({ retentionPurgingAt: now + 1 }, { merge: true });
          await flowRef.delete();
          await profileRef.set({ applicationQuestionAnswers: {}, applicationQuestionAnswerEvidence: {} }, { merge: true });
          return commitTransaction(callback);
        }
        for (const write of writes) {
          if (write.delete) await write.ref.delete();
          else await write.ref.set(write.data, write.options);
        }
        return result;
      },
    };

    await expect(saveAnswersWithCv({ db: db as any, bucket: null, orderId, order, flow, draft, answers: { notice_period: '3 months' },
      answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions: [question], draft, nowMs: now }),
      answerActor: 'candidate', nowMs: now })).rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });

    expect(purgeWon).toBe(true);
    expect(attemptedLedgerWrite).toBe(true);
    expect(store.read(`${path}/automation/flow`)).toBeUndefined();
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence).toEqual({});
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswers).toEqual({});
    await expect(saveAnswersWithCv({ db: store.db, bucket: null, orderId, order, flow, draft,
      answers: { notice_period: '6 months' }, answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions: [question], draft, nowMs: now }),
      answerActor: 'candidate', nowMs: now })).rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });
    expect(store.read(`${path}/automation/flow`)).toBeUndefined();
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence).toEqual({});
  });

  it('retries the local answer transaction against a purge marker committed before its write', async () => {
    const now = Date.now(), orderId = 'purge_local_race', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = orderWithCv(orderId, { userId, paymentStatus: 'paid', cvUploadedAt: now,
      jobId: 'target', jobUrl: 'https://example.test/jobs/target/' });
    const question = { id: 'notice_period', question: 'What is your notice period?', type: 'text', required: true };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = draftWithCv(order, { round: 1, questions: [question] });
    const store = createMemoryFirestore({
      [path]: order,
      [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft,
      [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } },
    });
    const orderRef = store.db.collection('assisted_applications').doc(orderId);
    const flowRef = orderRef.collection('automation').doc('flow');
    const commitTransaction = store.db.runTransaction.bind(store.db);
    let purgeWon = false;
    const db = {
      collection: store.db.collection,
      async runTransaction(callback: (transaction: any) => Promise<any>) {
        if (purgeWon) return commitTransaction(callback);
        let flowRead = false;
        const writes: Array<{ ref: any; data: any; options: any }> = [];
        const result = await callback({
          get: async (ref: any) => {
            if (ref.path === `${path}/automation/flow`) flowRead = true;
            return ref.get();
          },
          set: (ref: any, data: any, options?: any) => writes.push({ ref, data, options }),
        });
        if (flowRead) {
          // Firestore retries after an order write conflicts with this read set.
          purgeWon = true;
          await orderRef.set({ retentionPurgingAt: now + 1 }, { merge: true });
          await flowRef.delete();
          return commitTransaction(callback);
        }
        for (const write of writes) await write.ref.set(write.data, write.options);
        return result;
      },
    };

    await expect(saveAnswersWithCv({ db: db as any, bucket: null, orderId, order, flow, draft, answers: { notice_period: '3 months' },
      answerQuestionSnapshots: confirmationSnapshots({ orderId, order, flow, questions: [question], draft, nowMs: now }),
      answerActor: 'candidate', nowMs: now })).rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });

    expect(purgeWon).toBe(true);
    expect(store.read(`${path}/automation/flow`)).toBeUndefined();
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence).toBeUndefined();
  });
});
