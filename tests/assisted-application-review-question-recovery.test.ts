/**
 * The questions that hold a review are re-evaluated with the answer pipeline of today (owner directive
 * 2026-11-10: every question is answered by the platform, also on the orders written before it; to the
 * candidate only documents and what only they can give). The shapes are those of three orders held in
 * candidate_review by questions of their draft: a start date and two behavioural questions; a school
 * question; a start date with a document. All CVs and answers here are invented.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CANDIDATE_REVIEW_MS, evaluateRedFlags, transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateAnswerHistoryState, candidateAnswersForQuestions, candidateQuestionAnswerKey, candidateWithEdits, rememberCandidateAnswerHistory } from '../functions/src/assistedApplicationCandidateEdits.js';
import { withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';
import { runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
import { releasesWait } from '../scripts/assisted-application/reconcile-operational-answers.mjs';
import {
  REVIEW_QUESTION_MAX_ATTEMPTS,
  REVIEW_QUESTION_RETRY_MS,
  currentReviewQuestionVersion,
  reconcileReviewQuestions,
  reviewQuestionFingerprintFiles,
  reviewQuestionPlan,
} from '../scripts/assisted-application/reconcile-review-questions.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const CV = [
  'Candidato Prova — Tecnico di sistema',
  'Esperienza',
  '2019 – 2024 Tecnico di sistema, Alfa Servizi SA, Lugano',
  'Supporto agli utenti e risoluzione dei guasti della rete aziendale.',
  'Pianificazione degli interventi di manutenzione e documentazione delle attività.',
  'Formazione: Attestato federale di capacità informatico',
  'Lingue: italiano, tedesco',
].join('\n');
const ANCHOR_ROLE = '2019 – 2024 Tecnico di sistema, Alfa Servizi SA, Lugano';
const ANCHOR_PLANNING = 'Pianificazione degli interventi di manutenzione e documentazione delle attività.';

// The draft questions as the AI draft stored them (source «match»).
const availability = { id: 'availability', source: 'match', type: 'date', required: true, options: [], question: 'Da quale data puoi iniziare a lavorare?' };
const emergency = {
  id: 'emergency_decision_making', source: 'match', type: 'text', required: true, options: [],
  question: 'Descrivi brevemente un caso in cui hai preso decisioni in autonomia durante un’emergenza tecnica.',
};
const structured = {
  id: 'structured_reliable_work', source: 'match', type: 'text', required: true, options: [],
  question: 'Descrivi brevemente come organizzi il lavoro per mantenerlo strutturato e affidabile.',
};
const school = {
  id: 'school_performance', source: 'match', type: 'text', required: true, options: [],
  question: 'Haben Sie die Sekundarschule A oder das Niveau E besucht und welche schulischen Leistungen hatten Sie dort?',
};
// A personal fact the CV does not hold and nobody can deduce: it stays the candidate's.
const ahv = { id: 'ahv_number', source: 'match', type: 'text', required: true, options: [], question: 'Qual è il tuo numero AVS?' };
const goodConduct = { id: 'certificato_di_buona_condotta', label: 'Certificato di buona condotta', kind: 'certificate', required: true };

const EMERGENCY_ANSWER = 'Durante un guasto della rete aziendale ho valutato la situazione, deciso da solo le priorità e informato gli utenti fino alla risoluzione.';
const STRUCTURED_ANSWER = 'Pianifico gli interventi di manutenzione, documento ogni attività e tengo una lista di priorità, così il supporto agli utenti resta affidabile.';
const SCHOOL_ANSWER = 'Ich habe die Sekundarschule besucht und dort gute schulische Leistungen erzielt.';

const now = 1793449764000;
const order = { paymentStatus: 'paid', automationState: 'candidate_review', locale: 'it', applicantName: 'Candidato Prova', userId: 'u-test', companyName: 'Esempio SA' };
const draftOf = (questions: object[], extra: object = {}) => ({
  status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail' }, channel: { type: 'email' },
  factCheck: { ok: true, unsupported: [] }, factSources: { text: CV }, questions, language: 'it', ...extra,
});
const heldFlow = (heldBy: string[]) => ({
  state: 'candidate_review', round: 1, shownRounds: [1], heldBy, heldSince: now - 10 * 24 * 3600 * 1000,
  heldNudges: 3, reminderAt: null, deadlineAt: null,
});

type Request = { prompt: string, schema: any };
/** The excerpt id the citation schema gives to a CV line. */
function excerptId(request: Request, quote: string) {
  const ids: string[] = request.schema.properties.answers.items.properties.evidence.items.enum;
  return ids.find((id) => id && request.prompt.includes(`"id":"${id}","text":"${quote}"`)) || '';
}
/** The model of the draft: the CV answers call, then the decision engine's. */
function stubModel({ cv = {}, decisions = {} }: { cv?: Record<string, (request: Request) => object>, decisions?: Record<string, object> }) {
  const calls: string[] = [];
  const codex = async (request: Request) => {
    if (request.schema?.properties?.answers) {
      const ids: string[] = request.schema.properties.answers.items.properties.id.enum;
      calls.push(`cv:${ids.join(',')}`);
      return { answers: ids.filter((id) => cv[id]).map((id) => ({ id, ...cv[id](request) })) };
    }
    const ids: string[] = request.schema.properties.decisions.items.properties.id.enum;
    calls.push(`decision:${ids.join(',')}`);
    return { decisions: ids.filter((id) => decisions[id]).map((id) => ({ id, ...decisions[id] })) };
  };
  return { codex, calls };
}
const behavioural = (answer: string, anchor: string) => (request: Request) => ({
  kind: 'behavioral', suggestedAnswer: answer, evidence: [excerptId(request, anchor)], missingDetail: '',
});

function seed(base: string, flow: object, draft: object, extraOrder: object = {}) {
  return createMemoryFirestore({
    [base]: { ...order, ...extraOrder },
    [`${base}/automation/flow`]: flow,
    [`${base}/ai_drafts/current`]: draft,
  });
}
const sweep = async (store: ReturnType<typeof createMemoryFirestore>, nowMs: number) => {
  const effects: unknown[] = [];
  await runAutomationSweep({ db: store.db, nowMs, runEffect: async ({ effect }: { effect: unknown }) => { effects.push(effect); return { ok: true }; } });
  return effects;
};

describe('the flow drops the holds the platform answers', () => {
  it('keeps the document and drops the start date, without an e-mail and without a new clock', () => {
    const draft = draftOf([availability], { requiredDocuments: [goodConduct] });
    const flow = heldFlow(['question:availability', `document:${goodConduct.id}`]);
    // The start date is a platform rule now: three months ahead, editable.
    expect(evaluateRedFlags(draft, {}, {}, {}, flow, order)).toMatchObject({ candidate: [], documents: [goodConduct.id] });
    const { platformFacts } = candidateWithEdits({ order, draft, flow });
    expect(withOperationalQuestionAnswers(draft.questions, {}, { facts: platformFacts }).defaults.availability)
      .toMatchObject({ topic: 'platform:start_date', source: 'policy_default' });
    const tick = transition(flow, { type: 'tick' }, { order, draft, nowMs: now });
    expect(tick.flow).toMatchObject({ state: 'candidate_review', heldBy: [`document:${goodConduct.id}`], heldSince: flow.heldSince, deadlineAt: null });
    expect(tick.effects).toEqual([]);
    expect(releasesWait(flow, tick)).toBe(true);
    // Once dropped, nothing more is due.
    expect(transition(tick.flow, { type: 'tick' }, { order, draft, nowMs: now }).ignored).toBe('nothing_due');
  });

  it('never adds a hold the review did not have, nor drops one the candidate still owes', () => {
    const draft = draftOf([availability, ahv]);
    const flow = heldFlow(['question:availability']);
    // The AVS number is open but was not held: the tick leaves the holds as they are.
    expect(transition(flow, { type: 'tick' }, { order, draft, nowMs: now }).ignored).toBe('nothing_due');
    const both = heldFlow(['question:availability', 'question:ahv_number']);
    expect(transition(both, { type: 'tick' }, { order, draft, nowMs: now }).flow.heldBy).toEqual(['question:ahv_number']);
  });
});

describe('a start date and two behavioural questions (order G6q8…)', () => {
  const base = 'assisted_applications/review_questions_three';
  const draft = draftOf([availability, emergency, structured]);
  const flow = heldFlow(['question:availability', `question:${emergency.id}`, `question:${structured.id}`]);
  const model = () => stubModel({ cv: {
    [emergency.id]: behavioural(EMERGENCY_ANSWER, ANCHOR_ROLE),
    [structured.id]: behavioural(STRUCTURED_ANSWER, ANCHOR_PLANNING),
  } });

  it('plans: the start date needs no model, the two descriptions go to the draft\'s model steps', () => {
    const plan = reviewQuestionPlan({ order, flow, draft });
    expect(plan).toMatchObject({ held: ['availability', emergency.id, structured.id], open: [emergency.id, structured.id], targets: [emergency.id, structured.id], candidateOnly: [] });
  });

  it('dry run: names the questions it would answer, writes nothing, prints no answer', async () => {
    const store = seed(base, flow, draft);
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    const { codex } = model();
    const report = await reconcileReviewQuestions({ db: store.db, codex, nowMs: now });
    expect(report).toMatchObject({ withQuestions: 1, asked: 2, answered: 2, queued: 1, written: 0 });
    expect(report.orders[0]).toMatchObject({ answered: [emergency.id, structured.id], stillOpen: [], releases: true, heldAfter: [] });
    expect(JSON.stringify(report)).not.toContain('guasto');
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    expect(store.read(base).automationDueAt).toBeUndefined();
  });

  it('apply: stores the answers on the draft, and the sweep goes on as when the candidate answers the last question', async () => {
    const store = seed(base, flow, draft);
    const { codex, calls } = model();
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ written: 1, queued: 1 });
    // The CV answered both: the decision engine had nothing left to decide.
    expect(calls).toEqual([`cv:${emergency.id},${structured.id}`]);
    const questions = store.read(`${base}/ai_drafts/current`).questions;
    expect(questions.find((question: any) => question.id === emergency.id)).toMatchObject({ suggestedAnswer: EMERGENCY_ANSWER, answerKind: 'behavioral', answerEvidence: [ANCHOR_ROLE] });
    // The start date the platform proposes is mirrored on its question, as a new draft has it (2026-11-10).
    expect(questions.find((question: any) => question.id === availability.id)).toMatchObject({ suggestedAnswer: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), answerOrigin: 'platform_rule' });
    // Proposals, editable on the review page: never the candidate's own answers.
    expect(store.read(`${base}/automation/flow`).answers).toBeUndefined();
    expect(store.read(base)).toMatchObject({ automationDueAt: now, reviewQuestionRecovery: { attempts: 1, nextAttemptAt: null } });
    expect(await sweep(store, now)).toEqual([]);
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'candidate_review', heldBy: [], deadlineAt: now + CANDIDATE_REVIEW_MS });
    // Idempotent: a second run finds nothing to ask, queue or write.
    const again = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex: again.codex, nowMs: now + 1, apply: true })).toMatchObject({ withQuestions: 0, written: 0, queued: 0 });
    expect(again.calls).toEqual([]);
  });
});

describe('a school question (order mAEU…)', () => {
  const base = 'assisted_applications/review_questions_school';
  const draft = draftOf([school], { language: 'de' });
  const flow = heldFlow([`question:${school.id}`]);

  it('the CV states no school result, so the decision engine deduces a plausible one', async () => {
    const store = seed(base, flow, draft, { locale: 'de' });
    const { codex, calls } = stubModel({
      // A school result is a fact the CV must state for a cited answer: none here.
      cv: { [school.id]: () => ({ kind: 'technical', suggestedAnswer: '', evidence: [], missingDetail: '' }) },
      decisions: { [school.id]: { decision: 'answer', value: SCHOOL_ANSWER, principle: 'plausible_deduction', category: '', reason: 'School track consistent with the later vocational training.' } },
    });
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ answered: 1, written: 1, queued: 1 });
    expect(calls).toEqual([`cv:${school.id}`, `decision:${school.id}`]);
    expect(store.read(`${base}/ai_drafts/current`).questions[0].platformDecision).toMatchObject({ decision: 'answer', value: SCHOOL_ANSWER, principle: 'plausible_deduction' });
    await sweep(store, now);
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'candidate_review', heldBy: [] });
  });

  it('a grade the CV lacks is no plausible deduction: dropped, the question stays open, asked again at most once', async () => {
    const store = seed(base, flow, draft, { locale: 'de' });
    const invented = { [school.id]: { decision: 'answer', value: 'Ich habe die Sekundarschule besucht und einen Notendurchschnitt von 5,4 erreicht.', principle: 'plausible_deduction', category: '', reason: 'x' } };
    const first = stubModel({ decisions: invented });
    expect(await reconcileReviewQuestions({ db: store.db, codex: first.codex, nowMs: now, apply: true })).toMatchObject({ answered: 0, written: 1, queued: 0 });
    expect(store.read(base).reviewQuestionRecovery).toMatchObject({ attempts: 1, nextAttemptAt: now + REVIEW_QUESTION_RETRY_MS });
    expect(store.read(base).automationDueAt).toBeUndefined();
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual([`question:${school.id}`]);
    // Within the pause, no model call.
    const paused = stubModel({ decisions: invented });
    expect(await reconcileReviewQuestions({ db: store.db, codex: paused.codex, nowMs: now + 1000, apply: true })).toMatchObject({ exhausted: 1, written: 0 });
    expect(paused.calls).toEqual([]);
    // After it, the last attempt of this episode.
    const second = stubModel({ decisions: invented });
    await reconcileReviewQuestions({ db: store.db, codex: second.codex, nowMs: now + REVIEW_QUESTION_RETRY_MS, apply: true });
    expect(second.calls.length).toBeGreaterThan(0);
    expect(store.read(base).reviewQuestionRecovery).toMatchObject({ attempts: REVIEW_QUESTION_MAX_ATTEMPTS, nextAttemptAt: null });
    const third = stubModel({ decisions: invented });
    expect(await reconcileReviewQuestions({ db: store.db, codex: third.codex, nowMs: now + 10 * REVIEW_QUESTION_RETRY_MS, apply: true })).toMatchObject({ exhausted: 1 });
    expect(third.calls).toEqual([]);
    // A change of the answer pipeline opens a new episode.
    const fixed = stubModel({ decisions: { [school.id]: { ...invented[school.id], value: SCHOOL_ANSWER } } });
    expect(await reconcileReviewQuestions({ db: store.db, codex: fixed.codex, nowMs: now + 11 * REVIEW_QUESTION_RETRY_MS, apply: true, version: 'next-pipeline' }))
      .toMatchObject({ answered: 1, queued: 1 });
  });
});

describe('a start date with a document (order ogeY…)', () => {
  const base = 'assisted_applications/review_questions_document';
  const draft = draftOf([availability], { requiredDocuments: [goodConduct] });
  const flow = heldFlow(['question:availability', `document:${goodConduct.id}`]);

  it('needs no model: the start date drops through the clock, the document stays the candidate\'s', async () => {
    const store = seed(base, flow, draft);
    const { codex, calls } = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ asked: 0, written: 1, queued: 1 });
    expect(calls).toEqual([]);
    // Only the mirror of the platform's start date is written on the draft: no answer of the model.
    const written = store.read(`${base}/ai_drafts/current`);
    expect({ ...written, questions: written.questions.map(({ suggestedAnswer: _s, answerOrigin: _o, ...rest }: any) => rest) }).toEqual(draft);
    expect(written.questions[0]).toMatchObject({ suggestedAnswer: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), answerOrigin: 'platform_rule' });
    expect(await sweep(store, now)).toEqual([]);
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'candidate_review', heldBy: [`document:${goodConduct.id}`] });
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now + 1, apply: true })).toMatchObject({ withQuestions: 0, queued: 0 });
  });
});

describe('a banking-training question (order 8BhQ…)', () => {
  const base = 'assisted_applications/review_questions_banking';
  const banking = {
    id: 'banking_training', source: 'match', type: 'text', required: true, options: [],
    question: 'Quale formazione bancaria completa (AFC o equivalente) hai conseguito? Se non ne hai una, indicalo.',
  };
  const flow = heldFlow([`question:${banking.id}`]);
  const HONEST = 'Non ho una formazione bancaria formale; ho però esperienza nel supporto agli utenti e nella documentazione delle attività.';

  it('without banking training in the CV: an honest answer anchored to the related experience drops the hold', async () => {
    const draft = draftOf([banking]);
    const store = seed(base, flow, draft);
    const { codex } = stubModel({ cv: { [banking.id]: (request: Request) => ({ kind: 'technical', suggestedAnswer: HONEST, evidence: [excerptId(request, ANCHOR_PLANNING)], missingDetail: '' }) } });
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ answered: 1, queued: 1 });
    expect(store.read(`${base}/ai_drafts/current`).questions[0]).toMatchObject({ suggestedAnswer: HONEST, answerKind: 'technical', answerEvidence: [ANCHOR_PLANNING] });
    await sweep(store, now);
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual([]);
  });

  it('never a title the CV does not hold: an answer that claims or names one is dropped and the question stays open', async () => {
    const draft = draftOf([banking]);
    const store = seed(base, flow, draft);
    const { codex } = stubModel({ cv: { [banking.id]: (request: Request) => ({ kind: 'technical', suggestedAnswer: 'Ho conseguito l’AFC di impiegato di commercio ramo Banca.', evidence: [excerptId(request, ANCHOR_ROLE)], missingDetail: '' }) } });
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ answered: 0, queued: 0 });
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual([`question:${banking.id}`]);
  });

  it('with banking training in the CV: the answer cites it', async () => {
    const line = 'Formazione: Attestato federale di capacità impiegato di commercio, ramo banca';
    const draft = { ...draftOf([banking]), factSources: { text: `${CV}\n${line}` } };
    const store = seed(base, flow, draft);
    const answer = 'Ho conseguito l’attestato federale di capacità di impiegato di commercio, ramo banca.';
    const { codex } = stubModel({ cv: { [banking.id]: (request: Request) => ({ kind: 'technical', suggestedAnswer: answer, evidence: [excerptId(request, line)], missingDetail: '' }) } });
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ answered: 1 });
    expect(store.read(`${base}/ai_drafts/current`).questions[0]).toMatchObject({ suggestedAnswer: answer, answerEvidence: [line] });
  });
});

describe('a personal fact absent from the CV stays with the candidate', () => {
  const base = 'assisted_applications/review_questions_personal';
  const draft = draftOf([ahv]);
  const flow = heldFlow([`question:${ahv.id}`]);

  it('a number the CV lacks is never kept, the decision engine never decides it, and the review keeps waiting', async () => {
    const store = seed(base, flow, draft);
    // A model that invents the identifier, in both steps.
    const { codex, calls } = stubModel({
      cv: { [ahv.id]: behavioural('Il mio numero AVS è 756.1234.5678.97.', ANCHOR_ROLE) },
      decisions: { [ahv.id]: { decision: 'answer', value: '756.1234.5678.97', principle: 'plausible_deduction', category: '', reason: 'x' } },
    });
    const report = await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true });
    expect(report).toMatchObject({ withQuestions: 1, answered: 0, queued: 0 });
    // Only the CV step reads it (as the draft does): the identifier is not in the CV, so nothing is kept.
    expect(calls).toEqual([`cv:${ahv.id}`]);
    expect(report.orders[0]).toMatchObject({ stillOpen: [ahv.id], releases: false, heldAfter: [`question:${ahv.id}`] });
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(draft);
    expect(store.read(base).automationDueAt).toBeUndefined();
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual([`question:${ahv.id}`]);
    expect(evaluateRedFlags(store.read(`${base}/ai_drafts/current`), {}, {}, {}, store.read(`${base}/automation/flow`), order).candidate).toEqual([ahv.id]);
  });

  it('a draft of another round or an unpaid order is left alone', () => {
    expect(reviewQuestionPlan({ order, flow, draft: { ...draftOf([emergency]), round: 2 } })).toBeNull();
    expect(reviewQuestionPlan({ order: { ...order, paymentStatus: 'pending' }, flow, draft })).toBeNull();
    expect(reviewQuestionPlan({ order, flow: { ...flow, state: 'submitting' }, draft })).toBeNull();
  });
});

describe('candidate answers survive question reconciliation', () => {
  const previousQuestion = { id: 'passport_before', question: 'Do you hold a Swiss/EU/EFTA passport?',
    applicationQuestion: 'Do you hold a Swiss/EU/EFTA passport?', type: 'yes_no', options: ['Yes', 'No'], required: true, source: 'portal' };
  const changedQuestion = { ...previousQuestion, id: 'passport_after', type: 'choice', options: ['Yes', 'No', 'Not sure'] };
  const incompatibleQuestion = { ...changedQuestion, id: 'passport_incompatible', options: ['Swiss passport', 'Other'] };
  const answer = 'Yes';
  const history = () => rememberCandidateAnswerHistory({ questions: [previousQuestion], changed: { [previousQuestion.id]: answer },
    round: 1, confirmedAt: now, actor: 'candidate' });

  it('reapplies a saved answer to the same question after its id and compatible field type change', () => {
    const candidateAnswerHistory = history();
    expect(candidateAnswersForQuestions([changedQuestion], {}, {}, candidateAnswerHistory, now)[changedQuestion.id]).toBe(answer);
    expect(evaluateRedFlags(draftOf([changedQuestion]), {}, {}, {}, { state: 'candidate_review', round: 1,
      candidateAnswerHistory }, order).candidate).toEqual([]);
  });

  it('maps a normalized catalog match to the current option label', () => {
    const candidateAnswerHistory = history();
    const changedCatalog = { ...changedQuestion, options: ['YES', 'NO', 'NOT SURE'] };
    expect(candidateAnswersForQuestions([changedCatalog], {}, {}, candidateAnswerHistory, now)[changedCatalog.id]).toBe('YES');
  });

  it('keeps a value in the ledger and leaves the question open when the new option catalog rejects it', () => {
    const candidateAnswerHistory = history();
    const projected = candidateAnswersForQuestions([incompatibleQuestion], {}, {}, candidateAnswerHistory, now);
    expect(projected).not.toHaveProperty(incompatibleQuestion.id);
    expect(candidateAnswerHistoryState(candidateAnswerHistory)).toEqual(candidateAnswerHistory);
    expect(evaluateRedFlags(draftOf([incompatibleQuestion]), {}, {}, {}, { state: 'candidate_review', round: 1,
      candidateAnswerHistory }, order).candidate).toEqual([incompatibleQuestion.id]);
  });

  it('keeps a catalog answer in history when the current catalog is missing', () => {
    const previousChoice = { id: 'permit_before', question: 'Which permit do you hold?', type: 'choice',
      options: ['Permit G', 'Permit B'], required: true, source: 'portal' };
    const historyWithChoice = rememberCandidateAnswerHistory({ questions: [previousChoice],
      changed: { [previousChoice.id]: 'Permit G' }, round: 1, confirmedAt: now, actor: 'candidate' });
    const currentChoice = { ...previousChoice, id: 'permit_after', options: [] };
    expect(candidateAnswersForQuestions([currentChoice], {}, {}, historyWithChoice, now)).not.toHaveProperty(currentChoice.id);
    expect(candidateAnswerHistoryState(historyWithChoice)).toEqual(historyWithChoice);
    expect(evaluateRedFlags(draftOf([currentChoice]), {}, {}, {}, { state: 'candidate_review', round: 1,
      candidateAnswerHistory: historyWithChoice }, order).candidate).toEqual([currentChoice.id]);
  });

  it('reapplies a boolean checkbox answer that has no option catalog', () => {
    const previousCheckbox = { id: 'consent_before', question: 'Confirm the statement?', type: 'checkbox', options: [], required: true, source: 'portal' };
    const historyWithCheckbox = rememberCandidateAnswerHistory({ questions: [previousCheckbox],
      changed: { [previousCheckbox.id]: true }, round: 1, confirmedAt: now, actor: 'candidate' });
    const currentCheckbox = { ...previousCheckbox, id: 'consent_after' };
    expect(candidateAnswersForQuestions([currentCheckbox], {}, {}, historyWithCheckbox, now)[currentCheckbox.id]).toBe(true);
  });

  it('maps a saved checkbox answer to one current yes/no option pair', () => {
    const previousCheckbox = { id: 'consent_before', question: 'Confirm the statement?', type: 'checkbox', options: [], required: true, source: 'portal' };
    const historyWithCheckbox = rememberCandidateAnswerHistory({ questions: [previousCheckbox],
      changed: { [previousCheckbox.id]: true }, round: 1, confirmedAt: now, actor: 'candidate' });
    const currentBinary = { ...previousCheckbox, id: 'consent_after', type: 'yes_no', options: ['Yes', 'No'] };
    expect(candidateAnswersForQuestions([currentBinary], {}, {}, historyWithCheckbox, now)[currentBinary.id]).toBe('Yes');
  });

  it('maps a stated permit code to exactly one option in the current permit catalog', () => {
    const permit = { id: 'permit_before', question: 'Permesso?', type: 'choice', options: permitOptions('it'), required: false, source: 'portal' };
    const selected = permit.options.find((option: string) => option.includes('permesso G'));
    expect(candidateAnswersForQuestions([permit], { [permit.id]: 'G' })[permit.id]).toBe(selected);
  });

  it('does not map a work-permit code into a driving-licence question', () => {
    const drivingLicence = { id: 'licence_before', question: 'Do you hold a permit to drive?', type: 'choice',
      options: permitOptions('it'), required: true, source: 'portal' };
    expect(candidateAnswersForQuestions([drivingLicence], { [drivingLicence.id]: 'G' }))
      .not.toHaveProperty(drivingLicence.id);
  });

  it.each([['textarea', 'text'], ['text', 'textarea']])('reuses the same answer when the field changes from %s to %s', (previousType, currentType) => {
    const previous = { id: 'details_before', question: 'Describe your experience with customer support?',
      type: previousType, options: [], required: true, source: 'portal' };
    const saved = 'I documented requests and resolved customer issues.';
    const historyWithAnswer = rememberCandidateAnswerHistory({ questions: [previous],
      changed: { [previous.id]: saved }, round: 1, confirmedAt: now, actor: 'candidate' });
    const current = { ...previous, id: 'details_after', type: currentType };
    expect(candidateAnswersForQuestions([current], {}, {}, historyWithAnswer, now)[current.id]).toBe(saved);
  });

  it('does not let an invalid same-id value bypass the current option catalog', () => {
    const candidateAnswerHistory = history();
    const sameIdIncompatibleQuestion = { ...previousQuestion, options: ['Swiss passport', 'Other'] };
    const directAnswers = { [previousQuestion.id]: answer };
    const projected = candidateAnswersForQuestions([sameIdIncompatibleQuestion], directAnswers, {}, candidateAnswerHistory, now);
    expect(projected).not.toHaveProperty(sameIdIncompatibleQuestion.id);
    expect(candidateAnswerHistoryState(candidateAnswerHistory)).toEqual(candidateAnswerHistory);
    expect(evaluateRedFlags(draftOf([sameIdIncompatibleQuestion]), directAnswers, {}, {}, { state: 'candidate_review', round: 1,
      answers: directAnswers, candidateAnswerHistory }, order).candidate).toEqual([sameIdIncompatibleQuestion.id]);
  });

  it('does not restore a same-id date rejected by the new minimum from semantic memory', () => {
    const dateQuestion = { id: 'start_date_before', question: 'When can you start?', type: 'date', options: [], required: true, source: 'portal' };
    const dateAnswer = '2026-11-20';
    const changedContract = { ...dateQuestion, minDate: '2026-12-01' };
    const key = candidateQuestionAnswerKey(dateQuestion);
    const projected = candidateAnswersForQuestions([changedContract], { [dateQuestion.id]: dateAnswer }, { [key]: dateAnswer }, {}, now);
    expect(projected).not.toHaveProperty(dateQuestion.id);
  });

  it('does not reapply yesterday\'s start date when today\'s Zurich minimum is derived', () => {
    const previousStartDate = { id: 'start_date_before', question: 'From which date can you start working?',
      type: 'date', options: [], required: true, source: 'portal' };
    const historyWithDate = rememberCandidateAnswerHistory({ questions: [previousStartDate],
      changed: { [previousStartDate.id]: '2026-09-29' }, round: 1, confirmedAt: now - 1, actor: 'candidate' });
    const currentStartDate = { ...previousStartDate, id: 'start_date_after' };
    expect(candidateAnswersForQuestions([currentStartDate], {}, {}, historyWithDate, now)).not.toHaveProperty(currentStartDate.id);
  });

  it('keeps a date answer in history when a start-date question changes to free text', () => {
    const previousStartDate = { id: 'start_date_before', question: 'From which date can you start working?',
      type: 'date', options: [], required: true, source: 'portal' };
    const historyWithDate = rememberCandidateAnswerHistory({ questions: [previousStartDate],
      changed: { [previousStartDate.id]: '2026-12-15' }, round: 1, confirmedAt: now - 1, actor: 'candidate' });
    const currentStartDate = { ...previousStartDate, id: 'start_date_after', type: 'text' };
    expect(candidateAnswersForQuestions([currentStartDate], {}, {}, historyWithDate, now)).not.toHaveProperty(currentStartDate.id);
    expect(candidateAnswerHistoryState(historyWithDate)).toEqual(historyWithDate);
    expect(evaluateRedFlags(draftOf([currentStartDate]), {}, {}, {}, { state: 'candidate_review', round: 1,
      candidateAnswerHistory: historyWithDate }, order).candidate).toEqual([currentStartDate.id]);
  });

  it('does not let a same-id direct date answer bypass a changed text contract', () => {
    const previousStartDate = { id: 'start_date_before', question: 'From which date can you start working?',
      type: 'date', options: [], required: true, source: 'portal' };
    const dateAnswer = '2026-09-29';
    const historyWithDate = rememberCandidateAnswerHistory({ questions: [previousStartDate],
      changed: { [previousStartDate.id]: dateAnswer }, round: 1, confirmedAt: now - 1, actor: 'candidate' });
    const currentStartDate = { ...previousStartDate, type: 'text' };
    const directAnswers = { [currentStartDate.id]: dateAnswer };
    expect(candidateAnswersForQuestions([currentStartDate], directAnswers, {}, historyWithDate, now))
      .not.toHaveProperty(currentStartDate.id);
    expect(candidateAnswerHistoryState(historyWithDate)).toEqual(historyWithDate);
    expect(evaluateRedFlags(draftOf([currentStartDate]), directAnswers, {}, {}, { state: 'candidate_review', round: 1,
      answers: directAnswers, candidateAnswerHistory: historyWithDate }, order).candidate).toEqual([currentStartDate.id]);
  });

  it('does not apply a same-id answer when the portal reuses that id for a different question', () => {
    const previousQuestion = { id: 'shared_question_id', question: 'How many years of experience do you have?',
      type: 'text', options: [], required: true, source: 'portal' };
    const historyWithAnswer = rememberCandidateAnswerHistory({ questions: [previousQuestion],
      changed: { [previousQuestion.id]: '3' }, round: 1, confirmedAt: now - 1, actor: 'candidate' });
    const currentQuestion = { ...previousQuestion, question: 'How many employees did you supervise?' };
    const directAnswers = { [currentQuestion.id]: '3' };
    expect(candidateAnswersForQuestions([currentQuestion], directAnswers, {}, historyWithAnswer, now))
      .not.toHaveProperty(currentQuestion.id);
    expect(candidateAnswerHistoryState(historyWithAnswer)).toEqual(historyWithAnswer);
    expect(evaluateRedFlags(draftOf([currentQuestion]), directAnswers, {}, {}, { state: 'candidate_review', round: 1,
      answers: directAnswers, candidateAnswerHistory: historyWithAnswer }, order).candidate).toEqual([currentQuestion.id]);
  });

  it('preserves every candidate answer before and after a reconciliation tick', async () => {
    const base = 'assisted_applications/candidate_answer_history_reconcile';
    const candidateAnswerHistory = history();
    const previousFlow = { ...heldFlow([`question:${previousQuestion.id}`]), answers: { [previousQuestion.id]: answer },
      questionAnswers: { previous_answer_key: answer }, candidateAnswerHistory };
    const store = seed(base, previousFlow, draftOf([changedQuestion]));
    const before = {
      answers: structuredClone(previousFlow.answers), questionAnswers: structuredClone(previousFlow.questionAnswers),
      candidateAnswerHistory: structuredClone(previousFlow.candidateAnswerHistory),
    };
    const report = await reconcileReviewQuestions({ db: store.db, nowMs: now, apply: true });
    const afterFlow = store.read(`${base}/automation/flow`);
    const tick = transition(previousFlow, { type: 'tick' }, { order, draft: draftOf([changedQuestion]), nowMs: now });
    expect(report.orders[0]).toMatchObject({ stillOpen: [] });
    expect(tick.flow).toMatchObject(before);
    expect(afterFlow).toMatchObject(before);
    expect(candidateWithEdits({ order, draft: draftOf([changedQuestion]), flow: afterFlow }).answers[changedQuestion.id]).toBe(answer);
  });
});

describe('the recovery workflow', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/assisted-application-question-recovery.yml', import.meta.url), 'utf8')) as any;

  it('runs on every change of the answer pipeline it fingerprints', () => {
    const paths: string[] = workflow.on.push.paths;
    for (const file of reviewQuestionFingerprintFiles()) expect(paths).toContain(file);
    expect(currentReviewQuestionVersion()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('applies only behind the recovery marker, or on the daily clock', () => {
    const steps = workflow.jobs.recover.steps;
    const apply = steps.filter((step: any) => String(step.run || '').includes('--apply'));
    expect(apply).toHaveLength(1);
    expect(apply[0].if).toBe("${{ github.event_name == 'schedule' || steps.application_recovery.outputs.apply == 'true' }}");
    expect(steps.find((step: any) => step.id === 'application_recovery')?.run).toContain('resolve-application-recovery-marker.mjs');
  });
});
