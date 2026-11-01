import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => 'true'), bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}) }));
vi.mock('../functions/src/assistedApplicationTailoredCvPdf.js', () => ({
  tailoredCvChanges: () => false, rebuildTailoredCvPdf: vi.fn(), supersededPhotoPdf: () => null,
}));
const { saveAnswersWithCv } = await import('../functions/src/assistedApplicationCvCommit.js');
const { startAutomation, applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
const { loadRunnerAnswerContext } = await import('../functions/src/assistedApplicationAnswerEvidence.js');
const { answerQuestionSnapshotsFor } = await import('../functions/src/assistedApplicationAnswerEvidence.js');
const { candidateAnswersForQuestions } = await import('../functions/src/assistedApplicationCandidateEdits.js');

describe('typed facts use the complete producer and automation path', () => {
  it('reuses the four attested fact types through source reads and equivalent native values without another candidate request', async () => {
    const now = Date.now(), orderId = 'order_ABC123', path = `assisted_applications/${orderId}`;
    const cvStorageKey = `assisted-application-uploads/${orderId}/1-cv.pdf`;
    const order = { userId: 'synthetic', paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', cvUploadedAt: now,
      cvStorageKey, cvFileCheck: { key: cvStorageKey, verdict: 'ok', detectedType: 'pdf' }, jobId: 'target', jobUrl: 'https://example.test/jobs/target/' };
    const source = { ...order, jobId: 'source', jobUrl: 'https://example.test/jobs/source/' };
    const questions = [
      { id: 'dob', question: 'What is your date of birth?', type: 'date' },
      { id: 'experience', question: 'How many years of experience do you have with Python?', type: 'number' },
      { id: 'credential', question: 'Possiedi la certificazione PMP?', type: 'yes_no' },
      { id: 'permit', question: 'What is your current Swiss work permit status?', type: 'choice', options: permitOptions('en') },
    ];
    const answers = { dob: `${new Date(now).getUTCFullYear() - 30}-02-20`, experience: '3.5', credential: 'Sì', permit: permitOptions('en')[1] };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} }, draft = { round: 1, questions };
    const store = createMemoryFirestore({ [path]: order, 'assisted_applications/source': source,
      'assisted_applications/source/automation/flow': flow, 'assisted_applications/source/ai_drafts/current': draft,
      'user_cv_profiles/synthetic': { status: 'ready', profile: { languages: [] } } });
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: 'source', order: source, flow, draft, answers,
      answerQuestionSnapshots: answerQuestionSnapshotsFor({ orderId: 'source', questions, draft, nowMs: now }), answerActor: 'candidate', nowMs: now });
    const profile = store.read('user_cv_profiles/synthetic');
    expect(Object.values(profile.applicationQuestionAnswerEvidence)).toHaveLength(4);
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
    store.docs.set(`${path}/automation/flow`, rawFlow);
    store.docs.set(`${path}/ai_drafts/current`, { round: 1, status: 'ready', questions: translated, factCheck: { ok: true, unsupported: [] }, verdict: 'good' });
    runEffect.mockClear();
    const result = await applyAutomationEvent({ db: store.db, orderId, event: { type: 'submit_needs_candidate', questions: translated.map(q => q.id), questionDetails: translated }, runEffect, nowMs: now });
    expect(result.flow.state).toBe('owner_takeover');
    expect(runEffect.mock.calls.some(([input]) => input.effect.kind === 'candidate_action_needed')).toBe(false);
    expect(store.read(`${path}/automation/flow`).questionAnswers).toEqual({});
  });

  it('does not recreate answer evidence when retention purge wins after the ledger transaction read', async () => {
    const now = Date.now(), orderId = 'purge_race_order', userId = 'synthetic', path = `assisted_applications/${orderId}`;
    const order = { userId, paymentStatus: 'paid', cvUploadedAt: now, jobId: 'target', jobUrl: 'https://example.test/jobs/target/' };
    const question = { id: 'notice_period', question: 'What is your notice period?', type: 'text', required: true };
    const flow = { round: 1, state: 'candidate_review', answers: {}, questionAnswers: {} };
    const draft = { round: 1, questions: [question] };
    const store = createMemoryFirestore({
      [path]: order,
      [`${path}/automation/flow`]: flow,
      [`${path}/ai_drafts/current`]: draft,
      [`user_cv_profiles/${userId}`]: { status: 'ready', profile: { languages: [] } },
    });
    const profileRef = store.db.collection('user_cv_profiles').doc(userId);
    const orderRef = store.db.collection('assisted_applications').doc(orderId);
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

    await saveAnswersWithCv({ db: db as any, bucket: null, orderId, order, flow, draft, answers: { notice_period: '3 months' },
      answerQuestionSnapshots: answerQuestionSnapshotsFor({ orderId, questions: [question], draft, nowMs: now }),
      answerActor: 'candidate', nowMs: now });

    expect(purgeWon).toBe(true);
    expect(attemptedLedgerWrite).toBe(true);
    expect(store.read(`${path}/automation/flow`).answers).toEqual({ notice_period: '3 months' });
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswerEvidence).toEqual({});
    expect(store.read(`user_cv_profiles/${userId}`).applicationQuestionAnswers).toEqual({});
  });
});
