import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { operationalDefaultAnswer, operationalQuestionTopic, withOperationalQuestionAnswers, operationalEmailBody } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { evaluateRedFlags, transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { candidateAnswerForField, guardPlan, addressQuestionTopic, isAddressLikeQuestion } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { autoAnswersForPortalQuestions, candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
import { reconcileOperationalAnswers } from '../scripts/assisted-application/reconcile-operational-answers.mjs';
import { openRequiredQuestions } from '../scripts/assisted-application/lib/submit.mjs';
import { provenOptionalOperationalPortalQuestion } from '../functions/src/lib/portalNativeContract.js';

const questions = [
  { id: 'notice', question: 'Qual è il tuo attuale periodo di preavviso?', applicationQuestion: 'Attuale periodo di preavviso *', type: 'choice', options: [], required: true, source: 'portal' },
  { id: 'whatsapp', question: 'Accetti la comunicazione tramite WhatsApp?', applicationQuestion: 'Comunicazione via WhatsApp *', type: 'yes_no', options: [], required: true, source: 'portal' },
  { id: 'workload', question: 'Qual è il grado di occupazione desiderato?', type: 'choice', options: [], required: true, source: 'portal' },
];
const draft = { status: 'ready', round: 1, job: { source: 'job_detail' }, channel: { type: 'portal' }, questions };
const approved = { state: 'needs_candidate_action', round: 1, heldBy: questions.map(q => `question:${q.id}`), dispatch: { mode: 'submit', round: 1, attempts: 1 } };
const REAL_ENGLISH_PRIVACY_ACK = 'Please check this box to acknowledge that you have read the Applicant Privacy Notice.';

describe('operational preferences at every required-answer gate', () => {
  it('projects defaults without recording candidate facts', () => {
    const result = withOperationalQuestionAnswers(questions, {});
    expect(result.answers).toEqual({ notice: '3 mesi', whatsapp: 'Sì', workload: '100%' });
    expect(Object.values(result.defaults).every(item => item.source === 'policy_default')).toBe(true);
    expect(evaluateRedFlags(draft).candidate).toEqual([]);
    expect(openRequiredQuestions(draft)).toEqual([]);
    const actual = candidateWithEdits({ order: {}, draft, flow: {} });
    expect(actual.answers).toEqual({});
    expect(actual.profile.availability || '').toBe('');
  });

  it('preserves explicit answers and keeps genuinely hard questions open', () => {
    expect(withOperationalQuestionAnswers(questions, { notice: '1 mese', whatsapp: false, workload: 80 }).answers)
      .toEqual({ notice: '1 mese', whatsapp: false, workload: 80 });
    const mixed = { ...draft, questions: [...questions, { id: 'license', question: 'Hai la certificazione richiesta?', type: 'yes_no', required: true }] };
    expect(evaluateRedFlags(mixed).candidate).toEqual(['license']);
    expect(openRequiredQuestions(mixed).map(q => q.id)).toEqual(['license']);
    expect(transition(approved, { type: 'tick' }, { draft: mixed }).flow.state).toBe('needs_candidate_action');
  });

  it('resumes only an approved round with completely resolved, identified holds', () => {
    expect(transition(approved, { type: 'tick' }, { draft }).effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }]);
    for (const blocked of [
      { ...approved, dispatch: { mode: 'draft', round: 1 } },
      { ...approved, heldBy: ['question:unknown'] },
      { ...approved, heldBy: ['document:degree'] },
      { ...approved, postingExpiredAt: Date.now() },
    ]) expect(transition(blocked, { type: 'tick' }, { draft }).flow.state).toBe('needs_candidate_action');
    expect(transition(approved, { type: 'tick' }, { draft: { ...draft, factCheck: { unsupported: [{ field: 'letter', kind: 'skill', token: 'unknown' }] } } }).flow.state).toBe('needs_candidate_action');
  });

  it('keeps only unanswered questions in a portal wait', () => {
    const hard = { id: 'hard', question: 'Hai un permesso di lavoro?', type: 'text', required: true };
    const result = transition({ ...approved, state: 'submitting' }, { type: 'submit_needs_candidate', questions: [...questions, hard] }, { draft: { ...draft, questions: [...questions, hard] } });
    expect(result.flow.heldBy).toEqual(['question:hard']);
  });
});

describe('scope, languages and actual field options', () => {
  it.each([
    ['Notice period', '3 months'], ['Kündigungsfrist', '3 Monate'], ['Délai de préavis', '3 mois'], ['Periodo di preavviso', '3 mesi'],
  ])('uses the language of %s', (label, value) => expect(operationalDefaultAnswer({ label })?.value).toBe(value));

  it.each([
    'Can you start within 1 month?', 'Can you confirm a notice period of 1 month?',
    'Earliest start date', 'Notice period maximum 1 month', 'Do you have WhatsApp?',
    'Your WhatsApp number', 'Accetti marketing tramite WhatsApp?', 'WhatsApp privacy conditions',
    'Hai esperienza nella comunicazione via WhatsApp?', 'Can you work 100% shifts?',
    'Hai un diploma?', 'Confermi disponibilità al 100% richiesta?',
    'What is your notice period and earliest possible start date?',
    'Qual è il preavviso e la data di inizio?', 'Kündigungsfrist und frühester Eintrittstermin',
    'Délai de préavis et date de début', 'Your notice period and desired workload',
    'What is your notice period and salary expectation?',
    'Do you consent to be contacted via WhatsApp?', 'Consenso al contatto via WhatsApp',
    'Einwilligung zur Kommunikation per WhatsApp', 'Consentement au contact par WhatsApp',
    'WhatsApp contact and data processing',
  ])('does not invent facts or consent: %s', label => expect(operationalDefaultAnswer({ label, type: 'yes_no' })).toBeNull());

  it.each([
    ['it', 'Seleziona questa casella per confermare di aver letto l’Informativa sulla privacy per i candidati.'],
    ['de', 'Aktivieren Sie dieses Kontrollkästchen, um zu bestätigen, dass Sie die Datenschutzerklärung für Bewerber gelesen haben.'],
    ['en', 'Select this checkbox to confirm that you have read the Privacy Notice for Candidates.'],
    ['fr', 'Veuillez cocher cette case pour confirmer que vous avez pris connaissance de l’avis de confidentialité destiné aux candidats.'],
    ['real-en', REAL_ENGLISH_PRIVACY_ACK],
  ])('defaults only the sole privacy-reading checkbox in %s', (_locale, label) => {
    const question = { id: 'privacy', label, type: 'checkbox', required: true };
    expect(operationalQuestionTopic(question)).toBe('privacy_review_ack');
    expect(operationalDefaultAnswer(question)).toMatchObject({ value: 'true', topic: 'privacy_review_ack' });
    expect(candidateAnswerForField({ identity: {}, profile: {}, answers: {} }, { ...question, kind: 'checkbox' }))
      .toMatchObject({ value: 'true', source: 'policy_default' });
  });

  it('defaults the legacy text descriptor without an original native contract', () => {
    const question = {
      id: 'portal_privacy_ack', question: 'Seleziona questa casella per confermare di aver letto l\'Informativa sulla privacy per i candidati.',
      applicationQuestion: REAL_ENGLISH_PRIVACY_ACK, type: 'text', options: [], required: true, source: 'portal',
    };
    expect(question.originalNativeContract).toBeUndefined();
    expect(operationalQuestionTopic(question)).toBe('privacy_review_ack');
    expect(operationalDefaultAnswer(question)).toMatchObject({ value: 'Yes', topic: 'privacy_review_ack' });
  });

  it.each([['default', {}, true], ['false', { answer: false }, false], ['No', { answer: 'No' }, false]])
    ('projects a privacy checkbox through guardPlan and applyActions without a model action: %s', async (_name, answerPatch, expected) => {
      const field = { id: 'privacy_ack', kind: 'checkbox', inputType: 'checkbox', type: 'text', label: REAL_ENGLISH_PRIVACY_ACK, required: true, checked: false, options: [] };
      const candidate = {
        identity: {}, profile: {}, answers: {},
        portalQuestionsAnswered: answerPatch.answer === undefined ? [] : [{ question: REAL_ENGLISH_PRIVACY_ACK, answer: answerPatch.answer, source: 'answers' }],
      };
      const guarded = guardPlan({ actions: [], missingRequired: [] }, [field], candidate);
      expect(guarded.actions).toContainEqual(expect.objectContaining({ fieldId: field.id, action: expected ? 'check' : 'uncheck' }));
      const dom = new JSDOM('<!doctype html><input data-aa-id="privacy_ack" type="checkbox">', { url: 'https://jobs.example.test/apply' });
      const element = dom.window.document.querySelector('input');
      const locator = {
        first: () => locator,
        elementHandle: async () => ({ dispose: async () => {} }),
        evaluate: async (fn: any, arg?: any) => fn(element, arg),
        setChecked: async (checked: boolean) => { element.checked = checked; },
        isChecked: async () => element.checked,
      };
      const frame = { locator: () => locator };
      const result = await applyActions({ frames: () => [frame], mainFrame: () => frame } as any, [field], guarded.actions, {}, { pause: async () => {} });
      expect(result).toEqual([expect.objectContaining({ fieldId: field.id, ok: true })]);
      expect(element.checked).toBe(expected);
      dom.window.close();
    });

  it('keeps an existing native tick answered, while an explicit refusal can remove it', () => {
    const field = { id: 'privacy_ack', kind: 'checkbox', inputType: 'checkbox', type: 'text', label: REAL_ENGLISH_PRIVACY_ACK, required: true, checked: true, options: [] };
    const defaultPlan = guardPlan({ actions: [], missingRequired: [] }, [field], { identity: {}, profile: {}, answers: {} });
    expect(defaultPlan).toEqual({ actions: [], missingRequired: [] });
    const refusalPlan = guardPlan({ actions: [], missingRequired: [] }, [field], {
      identity: {}, profile: {}, answers: {},
      portalQuestionsAnswered: [{ question: REAL_ENGLISH_PRIVACY_ACK, answer: 'No', source: 'answers' }],
    });
    expect(refusalPlan.actions).toContainEqual(expect.objectContaining({ fieldId: field.id, action: 'uncheck' }));
    expect(refusalPlan.missingRequired).toContainEqual(expect.objectContaining({ fieldId: field.id }));
  });

  it('lets explicit false win over the privacy soft default and rejects contradictions', () => {
    const label = 'Select this checkbox to confirm that you have read the Privacy Notice for Candidates.';
    const question = { id: 'privacy', label, type: 'checkbox', required: true };
    expect(withOperationalQuestionAnswers([question], { privacy: false }).answers).toEqual({ privacy: false });
    for (const answer of [false, 'No']) {
      const formCandidate = candidateForForm({
        identity: { name: 'Test Candidate', email: 'candidate@example.test', phone: '' }, profile: {},
        answers: { privacy: answer }, draft: { questions: [{ ...question, applicationQuestion: label }] },
        portalQuestions: [{ ...question, applicationQuestion: label }],
      });
      expect(formCandidate.portalQuestionsAnswered).toContainEqual(expect.objectContaining({ answer: String(answer) }));
    }
    for (const answer of [false, 'No']) {
      expect(candidateAnswerForField({ identity: {}, profile: {}, answers: {}, portalQuestionsAnswered: [{ question: label, answer, source: 'candidate' }] }, { ...question, kind: 'checkbox' }))
        .toMatchObject({ value: String(answer), source: 'answers' });
    }
    for (const variant of [
      `${label} and agree to the terms`,
      `${label} and have 5 years of experience`,
      `${label} for marketing`,
      `${label} for the talent pool`,
      `${label} and share data with third parties`,
      `${label} and agree to the subscription`,
      { label, name: 'country' },
      { label, id: 'experienceYears' },
    ]) {
      const candidateQuestion = typeof variant === 'string' ? { label: variant, type: 'checkbox' } : { ...variant, type: 'checkbox' };
      expect(operationalDefaultAnswer(candidateQuestion)).toBeNull();
    }
  });

  it('keeps the native optional contract on the same privacy-review topic', () => {
    const label = 'Select this checkbox to confirm that you have read the Privacy Notice for Candidates.';
    const question = {
      source: 'portal', required: false, applicationQuestion: label,
      portalNativeContract: {
        version: 'native-contract-v1', round: 1, url: 'https://join.com/apply', observedAt: 1,
        required: false, requiredEvidence: 'aria-required:false', topic: 'privacy_review_ack',
        frame: 0, form: 0, fieldId: 'privacy', label,
      },
    };
    expect(provenOptionalOperationalPortalQuestion(question, {
      round: 1, channel: { applyUrl: 'https://join.com/apply' },
    })).toBe(true);
  });

  it('rejects compound text prompts independently of their input type', () => {
    for (const question of [
      'What is your notice period and earliest possible start date?',
      'Qual è il preavviso e la data di inizio?',
      'What is your notice period and salary expectation?',
      'Your notice period and desired workload',
    ]) expect(operationalDefaultAnswer({ question, type: 'text' })).toBeNull();
    expect(operationalDefaultAnswer({ question: 'Do you consent to be contacted via WhatsApp?', type: 'yes_no' })).toBeNull();
  });

  it('requires an available preference and respects validation bounds', () => {
    expect(operationalDefaultAnswer({ label: 'Notice period', options: [{ label: '3 months', value: 'notice_3' }] })?.value).toBe('3 months');
    expect(operationalDefaultAnswer({ label: 'Notice period', options: ['1 month', '6 months'] })).toBeNull();
    expect(operationalDefaultAnswer({ label: 'Notice period (months)', type: 'number', validation: { max: 2 } })).toBeNull();
    expect(operationalDefaultAnswer({ label: 'Notice period', type: 'date' })).toBeNull();
  });

  it('fills the portal without promoting defaults into confirmed CV facts', () => {
    const candidate = { identity: {}, profile: { availability: 'Immediately' }, answers: {} };
    const field = { id: 'notice', label: 'Notice period', kind: 'text', required: true, options: [] };
    expect(candidateAnswerForField(candidate, field)).toMatchObject({ value: '3 months', source: 'policy_default' });
    const guarded = guardPlan({ actions: [{ fieldId: 'notice', action: 'fill', value: '1 month', source: 'rule' }], missingRequired: [] }, [field], candidate);
    expect(guarded.actions).toEqual([expect.objectContaining({ value: '3 months', source: 'policy_default' })]);
    expect(guarded.missingRequired).toEqual([]);
    expect(autoAnswersForPortalQuestions({ questions, candidate })).toEqual({});
    expect(candidate.answers).toEqual({});
  });

  it.each([
    ['Comunicazione via WhatsApp', 'Sì'], ['Contatto via WhatsApp', 'Sì'], ['Communication via WhatsApp', 'Yes'],
    ['Kommunikation per WhatsApp', 'Ja'], ['Communication par WhatsApp', 'Oui'], ['Communication sur WhatsApp', 'Oui'],
  ])('recognizes an unconditional contact preference even when the ATS reports text: %s', (label, value) => {
    const field = { id: 'contact', label, kind: 'text', type: 'text', required: true, options: [] };
    expect(addressQuestionTopic(label)).toBe('');
    expect(isAddressLikeQuestion(label)).toBe(false);
    const candidate = { identity: { address: { street: 'Example Street 12' } }, profile: {}, answers: {} };
    expect(candidateAnswerForField(candidate, field)).toMatchObject({ value, source: 'policy_default' });
    const question = { ...field, question: label };
    const result = transition({ ...approved, state: 'submitting', dispatch: { ...approved.dispatch, attempts: 2 } }, {
      type: 'submit_needs_candidate', questions: ['contact'], questionDetails: [question],
    }, { draft: { ...draft, questions: [question] } });
    expect(result.flow.state).toBe('owner_takeover');
    expect(result.flow.heldBy).toEqual(['portal:portal_needs_candidate']);
    expect(result.effects).not.toContainEqual(expect.objectContaining({ kind: 'candidate_action_needed' }));
  });

  it('uses the explicit locale when a contact label is shared by French and English', () => {
    expect(operationalDefaultAnswer({ label: 'Communication via WhatsApp', type: 'text' }, { locale: 'fr' })?.value).toBe('Oui');
  });

  it.each(['Via', 'Via / Piazza', 'Nome della via', 'Qual è la tua via e il numero civico?', 'Via e numero'])('retains real street fields: %s', label => {
    expect(addressQuestionTopic(label)).toMatch(/^address/);
    expect(isAddressLikeQuestion(label)).toBe(true);
  });

  it.each(['Comunicazione via WhatsApp e consenso privacy', 'Explain communication via WhatsApp', 'Your WhatsApp number', 'Communication via WhatsApp for marketing'])('keeps other text questions unresolved: %s', question => {
    expect(operationalDefaultAnswer({ question, type: 'text' })).toBeNull();
    expect(addressQuestionTopic(question)).toBe('');
  });

  it('includes required defaults in an email without editing its stored draft', () => {
    const emailDraft = { ...draft, language: 'it', applicationEmail: { body: 'Buongiorno' } };
    expect(operationalEmailBody(emailDraft)).toContain('3 mesi');
    expect(operationalEmailBody(emailDraft)).toContain('100%');
    expect(emailDraft.applicationEmail.body).toBe('Buongiorno');
  });
});


describe('operational wait recovery after deployment', () => {
  it('runs the real MemoryFirestore sweep and dispatches only after the privacy default resolves the question hold', async () => {
    const base = 'assisted_applications/privacy_ack_sweep';
    const question = {
      id: 'portal_privacy_ack',
      question: 'Seleziona questa casella per confermare di aver letto l\'Informativa sulla privacy per i candidati.',
      applicationQuestion: REAL_ENGLISH_PRIVACY_ACK,
      type: 'text', options: [], required: true, source: 'portal',
    };
    const now = 1793449764000;
    const store = createMemoryFirestore({
      [base]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'needs_candidate_action', automationDueAt: now },
      [`${base}/automation/flow`]: {
        state: 'needs_candidate_action', round: 1, heldBy: [`question:${question.id}`],
        dispatch: { mode: 'submit', round: 1, attempts: 1 }, heldSince: now - 1000,
      },
      [`${base}/ai_drafts/current`]: {
        status: 'ready', round: 1, questions: [question], factCheck: { ok: true, unsupported: [] },
        job: { source: 'job_detail' }, channel: { type: 'portal', applyUrl: 'https://jobs.example.test/apply' },
      },
    });
    const effects: any[] = [];
    const result = await runAutomationSweep({
      db: store.db,
      nowMs: now,
      runEffect: async ({ effect }: any) => { effects.push(effect); return { ok: true }; },
    });
    expect(result).toMatchObject({ ticks: 1, failed: 0 });
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'submitting', heldBy: [], dispatch: { reason: 'resolved_candidate_answers' } });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }]);
  });

  it('deduplicates one wait while recovering a later step on the same order and policy', async () => {
    const base = 'assisted_applications/operational_test';
    const flowPath = `${base}/automation/flow`;
    const store = createMemoryFirestore({
      [base]: { paymentStatus: 'paid', automationState: 'needs_candidate_action', operationalAnswerReconciledVersion: 'operational-preferences-v1' },
      [flowPath]: { ...approved, heldSince: 1000, dispatch: { ...approved.dispatch, requestedAt: 500 } },
      [`${base}/ai_drafts/current`]: draft,
    });
    const context = { db: store.db, apply: true, nowMs: 2000 };
    expect(await reconcileOperationalAnswers(context)).toMatchObject({ eligible: 1, queued: 1 });
    const firstKey = store.read(base).operationalAnswerReconciledKey;
    expect(await reconcileOperationalAnswers(context)).toMatchObject({ eligible: 0, alreadyQueued: 1 });
    store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['question:whatsapp'], heldSince: 3000, dispatch: { ...approved.dispatch, requestedAt: 2500 } });
    expect(await reconcileOperationalAnswers({ ...context, nowMs: 4000 })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(base).operationalAnswerReconciledKey).not.toBe(firstKey);
    store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['question:unknown_fact'] });
    expect(await reconcileOperationalAnswers(context)).toMatchObject({ eligible: 0, queued: 0 });
  });
});
