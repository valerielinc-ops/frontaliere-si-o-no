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
    await saveAnswersWithCv({ db: store.db, bucket: null, orderId: 'source', order: source, flow, draft, answers, answerActor: 'candidate', nowMs: now });
    const profile = store.read('user_cv_profiles/synthetic');
    expect(Object.values(profile.applicationQuestionAnswerEvidence)).toHaveLength(4);
    expect(profile.profile).toEqual({ languages: [] });
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
    const context = await loadRunnerAnswerContext({ db: store.db, order, flow: rawFlow, draft: { round: 1, questions: translated } });
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
});
