/**
 * Answers «from the CV» (owner decisions of 2026-11-10): the application fills in every value the CV
 * holds; a technical question is answered only with cited CV evidence, a generic one with a plausible
 * description built from the CV; nothing that the CV does not contain (names, titles, qualifications,
 * dates, figures) ever enters an answer. All CVs here are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  cvAnswerFor,
  cvAnswerInventions,
  cvAnswerQuestionEligible,
  verifiedCvAnswers,
  verifyCvAnswer,
} from '../functions/src/assistedApplicationCvAnswers.js';
import { sanitizeApplicationAnswerSuggestions } from '../functions/src/assistedApplicationAiDraftCore.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { buildReviewPayload } from '../functions/src/assistedApplicationReview.js';
import { operationalEmailBody, withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { draftCvAnswers } from '../scripts/assisted-application/lib/cv-answers.mjs';
import { reconcileCvAnswers } from '../scripts/assisted-application/reconcile-cv-answers.mjs';
import { runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const CV_WITH_WINDOWS = [
  'Candidato Prova — Tecnico di sistema',
  'Esperienza',
  '2019 – 2024 Tecnico di sistema, Alfa Servizi SA, Lugano',
  'Gestione di Windows Server 2019 e Active Directory per gli uffici della sede.',
  'Supporto agli utenti e risoluzione dei guasti della rete aziendale.',
  'Formazione: Attestato federale di capacità informatico',
  'Lingue: italiano, inglese',
].join('\n');
const CV_WITHOUT_WINDOWS = [
  'Candidato Prova — Magazziniere',
  'Esperienza',
  '2018 – 2024 Magazziniere, Beta Logistica Sagl, Mendrisio',
  'Ricevimento merci, inventario e preparazione delle spedizioni con il team del turno.',
  'Lingue: italiano',
].join('\n');

const windows = {
  id: 'windows_server_ad_microsoft365', source: 'match', type: 'text', required: true, options: [],
  question: 'Please describe your hands-on experience with Windows Server, Active Directory and Microsoft 365.',
  validation: { pattern: '^(?:.+)$', minLength: 1, maxLength: 500, min: null, max: null, minDate: '', example: '', message: '' },
};
const leadership = {
  id: 'leadership_example', source: 'match', type: 'text', required: true, options: [],
  question: 'Descrivi un esempio in cui hai guidato o coordinato altre persone.',
  validation: { pattern: '', minLength: 20, maxLength: 500, min: null, max: null, minDate: '', example: '', message: '' },
};
const travel = {
  id: 'travel_availability', source: 'match', type: 'yes_no', required: true, options: [],
  question: 'Are you fully available for national and international business travel?',
};
const draftOf = (cvText: string, questions: object[]) => ({
  verdict: 'good', job: { source: 'job_detail' }, channel: { type: 'email' }, factCheck: { ok: true, unsupported: [] },
  factSources: { text: cvText }, questions, language: 'it',
});
const order = { locale: 'it', applicantName: 'Candidato Prova', userId: 'u-test' };

const windowsAnswer = 'I administered Windows Server 2019 and Active Directory for the offices of the site, and supported users.';
const windowsQuote = 'Gestione di Windows Server 2019 e Active Directory per gli uffici della sede.';
const leadershipAnswer = 'Come tecnico di sistema presso Alfa Servizi SA ho coordinato con i colleghi la risoluzione dei guasti della rete, stabilendo le priorità e tenendo informati gli utenti.';

describe('technical questions: answered only with CV evidence', () => {
  it('answers the Windows Server question from a CV that cites it, with the quote, and no longer holds the application', () => {
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: windows.id, kind: 'technical', suggestedAnswer: windowsAnswer, evidence: [windowsQuote], missingDetail: '' },
    ] }, [windows], CV_WITH_WINDOWS);
    expect(question).toMatchObject({ suggestedAnswer: windowsAnswer, answerEvidence: [windowsQuote], answerKind: 'technical' });
    const draft = draftOf(CV_WITH_WINDOWS, [question, travel]);
    // Only the travel question (not a rule of the owner, a fact only the candidate knows) is still open.
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual(['travel_availability']);
    const { answers, profile, platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    // Form-only: never in the answers or the profile the letter and the CV are written from.
    expect(answers[windows.id]).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain('administered');
    expect(platformFacts.cvAnswers[windows.id]).toMatchObject({ value: windowsAnswer, kind: 'technical', evidence: [windowsQuote] });
    const { defaults } = withOperationalQuestionAnswers(draft.questions, answers, { facts: platformFacts });
    expect(defaults[windows.id]).toMatchObject({ source: 'policy_default', topic: 'cv_answer:technical', origin: 'cv_evidence' });
    // The e-mail carries the CV: no separate line for an answer the CV gives.
    expect(operationalEmailBody({ ...draft, applicationEmail: { body: 'Gentili signori' } }, {}, { facts: platformFacts })).toBe('Gentili signori');
  });

  it('shows it on the review page as an editable proposal of the platform, with its evidence', () => {
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: windows.id, kind: 'technical', suggestedAnswer: windowsAnswer, evidence: [windowsQuote], missingDetail: '' },
    ] }, [windows], CV_WITH_WINDOWS);
    const draft = draftOf(CV_WITH_WINDOWS, [question, travel]);
    const payload = buildReviewPayload({ order, flow: { state: 'candidate_review', round: 1 }, draft, round: 1, coverLetterUrl: null });
    const shown = payload.questions.find((item: { id: string }) => item.id === windows.id);
    expect(shown).toMatchObject({ answeredByPlatform: true, suggestedAnswer: windowsAnswer, answerEvidence: [windowsQuote], answerFromCv: 'cv_evidence' });
    expect(payload.answers[windows.id]).toBe(windowsAnswer);
  });

  it('leaves the same question to the candidate when the CV does not mention it', () => {
    for (const item of [
      // A quote that is not in this CV.
      { kind: 'technical', suggestedAnswer: windowsAnswer, evidence: [windowsQuote] },
      // No quote at all.
      { kind: 'technical', suggestedAnswer: 'I managed Windows Server environments.', evidence: [] },
      // Labelled behavioural to dodge the evidence: the tools it names are not in the CV.
      { kind: 'behavioral', suggestedAnswer: 'In the warehouse I also managed Windows Server and Active Directory.', evidence: [] },
    ]) {
      const [question] = sanitizeApplicationAnswerSuggestions({ answers: [{ id: windows.id, missingDetail: '', ...item }] }, [windows], CV_WITHOUT_WINDOWS);
      expect(question.suggestedAnswer).toBe('');
      const draft = draftOf(CV_WITHOUT_WINDOWS, [question]);
      expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([windows.id]);
    }
  });

  it('never accepts a citation it cannot find verbatim in the CV text', () => {
    const paraphrase = 'Ho gestito Windows Server e Active Directory per tutta la sede.';
    expect(verifyCvAnswer({ kind: 'technical', answer: windowsAnswer, evidence: [paraphrase] }, { cvText: CV_WITH_WINDOWS, question: windows }))
      .toMatchObject({ ok: false, reasons: expect.arrayContaining(['evidence_not_in_cv']) });
    // Spacing and case are no difference.
    expect(verifyCvAnswer({ kind: 'technical', answer: windowsAnswer, evidence: [`  ${windowsQuote.toUpperCase()} `] }, { cvText: CV_WITH_WINDOWS, question: windows }).ok).toBe(true);
    // A suggestion stored on the draft is checked again on every read: another CV text drops it.
    const stored = { ...windows, suggestedAnswer: windowsAnswer, answerEvidence: [windowsQuote], answerKind: 'technical' };
    expect(verifiedCvAnswers([stored], CV_WITH_WINDOWS)[windows.id]).toBeTruthy();
    expect(verifiedCvAnswers([stored], CV_WITHOUT_WINDOWS)).toEqual({});
  });
});

describe('generic questions: a plausible description built from the CV', () => {
  it('accepts a leadership example the CV does not report, anchored to its role and employer', () => {
    expect(CV_WITH_WINDOWS).not.toMatch(/coordin|guid|leader/i);
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: leadership.id, kind: 'behavioral', suggestedAnswer: leadershipAnswer, evidence: [], missingDetail: '' },
    ] }, [leadership], CV_WITH_WINDOWS);
    expect(question).toMatchObject({ suggestedAnswer: leadershipAnswer, answerKind: 'behavioral', answerEvidence: [] });
    const draft = draftOf(CV_WITH_WINDOWS, [question]);
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
    const { platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    expect(withOperationalQuestionAnswers(draft.questions, {}, { facts: platformFacts }).defaults[leadership.id])
      .toMatchObject({ value: leadershipAnswer, origin: 'cv_plausible' });
  });

  it('discards an answer that invents a company, a title, a qualification, a date or a figure', () => {
    const invented = {
      name: 'Presso Alfa Servizi SA e poi alla Contoso ho coordinato i colleghi durante i guasti della rete.',
      legalForm: 'Ho coordinato i colleghi di Gamma Impianti AG durante i guasti della rete aziendale.',
      title: 'Nel ruolo di responsabile del reparto ho coordinato i colleghi durante i guasti della rete.',
      qualification: 'Grazie alla mia certificazione ho coordinato i colleghi durante i guasti della rete.',
      year: 'Nel 2016 ho coordinato i colleghi durante i guasti della rete aziendale della sede.',
      figure: 'Ho coordinato dodici colleghi durante i guasti della rete aziendale della sede.',
      percent: 'Ho coordinato i colleghi riducendo i tempi di intervento del 30% sulla rete aziendale.',
      month: 'A marzo ho coordinato i colleghi durante un guasto della rete aziendale della sede.',
    };
    for (const [why, answer] of Object.entries(invented)) {
      const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
        { id: leadership.id, kind: 'behavioral', suggestedAnswer: answer, evidence: [], missingDetail: '' },
      ] }, [leadership], CV_WITH_WINDOWS);
      expect(question.suggestedAnswer, why).toBe('');
      expect(evaluateRedFlags(draftOf(CV_WITH_WINDOWS, [question]), {}, {}, {}, null, order).candidate, why).toEqual([leadership.id]);
    }
    expect(cvAnswerInventions(invented.name, CV_WITH_WINDOWS)).toContainEqual({ kind: 'name', token: 'Contoso' });
    expect(cvAnswerInventions(leadershipAnswer, CV_WITH_WINDOWS)).toEqual([]);
  });

  it('checks a German answer by its name contexts, not by its capitalised nouns', () => {
    const cv = 'Lernender Informatiker\nSekundarschule Niveau E, Schulhaus Muster\nHobbys: Fussball, Programmieren';
    expect(cvAnswerInventions('Ich habe die Sekundarschule im Niveau E besucht und meine Aufgaben immer zuverlässig erledigt.', cv)).toEqual([]);
    expect(cvAnswerInventions('Ich habe bei der Firma Contoso gearbeitet und mit dem Team Projekte geplant.', cv))
      .toContainEqual({ kind: 'name', token: 'Contoso' });
  });
});

describe('what stays with the candidate', () => {
  it('a yes/no fact the owner rules do not cover (travel) is never answered from the CV', () => {
    expect(cvAnswerQuestionEligible(travel)).toBe(false);
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: travel.id, kind: 'behavioral', suggestedAnswer: 'Yes', evidence: [], missingDetail: '' },
    ] }, [travel], CV_WITH_WINDOWS);
    expect(question.suggestedAnswer).toBeUndefined();
  });

  it('a factual kind is never kept, whatever the text', () => {
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: leadership.id, kind: 'factual', suggestedAnswer: leadershipAnswer, evidence: [], missingDetail: '' },
    ] }, [leadership], CV_WITH_WINDOWS);
    expect(question.suggestedAnswer).toBe('');
  });

  it('the candidate\'s own answer always wins over the CV answer', () => {
    const [question] = sanitizeApplicationAnswerSuggestions({ answers: [
      { id: leadership.id, kind: 'behavioral', suggestedAnswer: leadershipAnswer, evidence: [], missingDetail: '' },
    ] }, [leadership], CV_WITH_WINDOWS);
    const draft = draftOf(CV_WITH_WINDOWS, [question]);
    const { platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    const own = 'La mia risposta, scritta da me per questa candidatura.';
    expect(withOperationalQuestionAnswers(draft.questions, { [leadership.id]: own }, { facts: platformFacts }).answers[leadership.id]).toBe(own);
  });
});

describe('backfill of the orders drafted before (reconcile-cv-answers.mjs)', () => {
  const base = 'assisted_applications/cv_answers_backfill';
  const now = 1793449764000;
  const seed = () => createMemoryFirestore({
    [base]: { paymentStatus: 'paid', automationState: 'needs_candidate_action', locale: 'it' },
    [`${base}/automation/flow`]: {
      state: 'needs_candidate_action', round: 1, heldBy: [`question:${windows.id}`],
      dispatch: { mode: 'submit', round: 1, attempts: 1 }, heldSince: now - 1000,
    },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, ...draftOf(CV_WITH_WINDOWS, [windows]), channel: { type: 'portal', applyUrl: 'https://jobs.example.test/apply' } },
  });
  const codex = async (request: { prompt: string, schema: { properties: { answers: { items: { properties: { evidence: { items: { enum: string[] } } } } } } } }) => {
    const ids = request.schema.properties.answers.items.properties.evidence.items.enum;
    const quoteId = ids.find((id) => id && request.prompt.includes(`"id":"${id}","text":"${windowsQuote}"`)) || '';
    return { answers: [{ id: windows.id, kind: 'technical', suggestedAnswer: windowsAnswer, evidence: [quoteId], missingDetail: '' }] };
  };

  it('dry run: reports the question ids it would answer, writes nothing, never prints an answer', async () => {
    const store = seed();
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    const report = await reconcileCvAnswers({ db: store.db, codex, nowMs: now });
    expect(report).toMatchObject({ withTargets: 1, asked: 1, kept: 1, released: 1, written: 0 });
    expect(report.orders[0]).toMatchObject({ targets: [windows.id], kept: [windows.id], stillOpen: [], releases: true });
    expect(JSON.stringify(report)).not.toContain('administered');
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    expect(store.read(base).automationDueAt).toBeUndefined();
  });

  it('apply: stores the verified answer on the draft and releases the wait through the normal sweep', async () => {
    const store = seed();
    expect(await reconcileCvAnswers({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ written: 1, released: 1 });
    expect(store.read(`${base}/ai_drafts/current`).questions[0]).toMatchObject({ id: windows.id, suggestedAnswer: windowsAnswer, answerKind: 'technical' });
    expect(store.read(base).automationDueAt).toBe(now);
    // Nothing reaches the candidate's own answers.
    expect(store.read(`${base}/automation/flow`).answers).toBeUndefined();
    const effects: unknown[] = [];
    await runAutomationSweep({ db: store.db, nowMs: now, runEffect: async ({ effect }: { effect: unknown }) => { effects.push(effect); return { ok: true }; } });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }]);
    // A second run finds nothing left to ask.
    expect(await reconcileCvAnswers({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ withTargets: 0, written: 0 });
  });
});

describe('the runner and the draft', () => {
  it('fills the same question read live on the portal, by its label', () => {
    const portal = { ...windows, id: 'portal_q1', source: 'portal', applicationQuestion: windows.question };
    const facts = { cvAnswers: verifiedCvAnswers([{ ...portal, suggestedAnswer: windowsAnswer, answerEvidence: [windowsQuote], answerKind: 'technical' }], CV_WITH_WINDOWS) };
    expect(cvAnswerFor({ label: `${windows.question} *`, type: 'textarea' }, facts)?.value).toBe(windowsAnswer);
    expect(cvAnswerFor({ label: 'Another question', type: 'text' }, facts)).toBeNull();
    expect(cvAnswerFor({ label: windows.question, type: 'select', options: ['Yes', 'No'] }, facts)).toBeNull();
  });

  it('asks the model with CV excerpt ids and keeps only what passes the checks', async () => {
    const requests: Array<{ prompt: string, schema: { properties: { answers: { items: { properties: { evidence: { items: { enum: string[] } } } } } } } }> = [];
    const codex = async (request: typeof requests[number]) => {
      requests.push(request);
      const ids = request.schema.properties.answers.items.properties.evidence.items.enum;
      const windowsId = ids.find((id) => id && request.prompt.includes(`"id":"${id}","text":"${windowsQuote}"`)) || '';
      return { answers: [
        { id: windows.id, kind: 'technical', suggestedAnswer: windowsAnswer, evidence: [windowsId], missingDetail: '' },
        { id: leadership.id, kind: 'behavioral', suggestedAnswer: leadershipAnswer, evidence: ['[[cv:999]]'], missingDetail: '' },
      ] };
    };
    const result = await draftCvAnswers({ questions: [windows, leadership, travel], cvText: CV_WITH_WINDOWS, codex, locale: 'it' });
    expect(requests).toHaveLength(1);
    expect(result.asked).toEqual([windows.id, leadership.id]);
    // An excerpt id the request never issued is an invented citation: dropped.
    expect(result.kept).toEqual([windows.id]);
    expect(result.decisions.find((item: { id: string }) => item.id === leadership.id)).toMatchObject({ kept: false, reasons: expect.arrayContaining(['evidence_id_unknown']) });
    expect(result.questions.find((item: { id: string }) => item.id === windows.id)).toMatchObject({ suggestedAnswer: windowsAnswer, answerKind: 'technical' });
  });
});
