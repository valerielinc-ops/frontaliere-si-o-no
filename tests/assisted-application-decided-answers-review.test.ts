/**
 * Every answer the platform decides is shown to the candidate, already filled in and editable, with where it
 * comes from, and never counts as a question to answer (owner directive 2026-11-10, DECISIONS.md: «ogni domanda
 * la risponde la piattaforma … modificabili, non bloccanti; al candidato solo documenti»).
 *
 * The shapes are those of the reviews of 2026-11-10: a yes/no on support to other branches (order 8BhQ…), a
 * cited answer on a banking training (8BhQ…), the profile applied for in an open competition (CVRD…), a start
 * date three months ahead (ogeY…). All CVs, answers and names here are invented.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformDefaultAnswer, platformQuestionTopic } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { appliedPositionQuestion, decisionsSystemPrompt, decisionsUserText, verifyDecision } from '../functions/src/assistedApplicationDecisionAnswers.js';
import {
  platformAnswerProvenance,
  withOperationalQuestionAnswers,
  withPlatformSuggestions,
  withoutPlatformSuggestions,
} from '../functions/src/assistedApplicationOperationalAnswers.js';
import { verifiedCvAnswers } from '../functions/src/assistedApplicationCvAnswers.js';
import { candidateWithEdits as candidateWithEditsJs } from '../functions/src/assistedApplicationCandidateEdits.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { buildReviewPayload, defaultStartDate } from '../functions/src/assistedApplicationReview.js';
import { draftDecisionAnswers } from '../scripts/assisted-application/lib/decision-answers.mjs';
import { platformSuggestionUpdate, reconcileReviewQuestions } from '../scripts/assisted-application/reconcile-review-questions.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const CV = [
  'Candidata Prova — Impiegata di commercio',
  'Esperienza',
  '2018 – 2024 Impiegata di commercio, Gamma Servizi SA, Lugano',
  'Accoglienza dei clienti allo sportello e al telefono, gestione della corrispondenza e degli appuntamenti.',
  'Formazione: Attestato federale di capacità impiegata di commercio',
  'Lingue: italiano, tedesco, inglese',
].join('\n');
const ANCHOR = 'Accoglienza dei clienti allo sportello e al telefono, gestione della corrispondenza e degli appuntamenti.';
const TITLE = 'Collaboratore Amministrativo (concorso generale)';
const order = { paymentStatus: 'paid', automationState: 'candidate_review', locale: 'it', applicantName: 'Candidata Prova', userId: 'u-test', companyName: 'Esempio SA' };
const draftOf = (questions: object[], extra: object = {}) => ({
  status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail', title: TITLE }, channel: { type: 'email' },
  factCheck: { ok: true, unsupported: [] }, factSources: { text: CV }, questions, language: 'it', ...extra,
});
const flow = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [] };
// The JS module's inferred signature asks every option: the tests pass the ones they need.
const candidateWithEdits = candidateWithEditsJs as unknown as (input: object) => { platformFacts: any };

// The draft questions as the AI draft stores them (source «match»).
const branches = {
  id: 'branch_support_availability', source: 'match', type: 'yes_no', required: true, options: [],
  question: 'Sei disponibile a dare supporto nelle succursali di Bellinzona e Locarno?',
};
const availability = { id: 'availability', source: 'match', type: 'date', required: true, options: [], question: 'Da quale data sarebbe disponibile a entrare in servizio?' };
const reception = {
  id: 'customer_reception', source: 'match', type: 'text', required: true, options: [],
  question: 'Descrivi brevemente come accogli i clienti allo sportello.',
  suggestedAnswer: 'Accolgo i clienti allo sportello e al telefono con cortesia e gestisco corrispondenza e appuntamenti.',
  answerEvidence: [ANCHOR], answerKind: 'behavioral', answerMissingDetail: '',
};
const PROFILE_ANSWER = 'Mi candido per il profilo di Collaboratore Amministrativo.';
const profile = {
  id: 'applied_profile', source: 'match', type: 'text', required: true, options: [],
  question: 'Per quale profilo specifico desideri candidarti presso Esempio SA?',
  suggestedAnswer: '', answerEvidence: [], answerKind: '', answerMissingDetail: '',
  platformDecision: { decision: 'answer', shape: 'text', value: PROFILE_ANSWER, principle: 'plausible_deduction', reason: 'The posting names the profile.', version: 'decision-answers-v1' },
};
const smallTeam = {
  id: 'small_team', source: 'match', type: 'yes_no', required: true, options: [],
  question: 'Ti trovi a tuo agio in un piccolo team?',
  platformDecision: { decision: 'answer', shape: 'yes_no', value: 'yes', principle: 'application_success', reason: 'Flexibility helps the application.', version: 'decision-answers-v1' },
};
// A personal identifier nobody can deduce: the candidate's.
const ahv = { id: 'ahv_number', source: 'match', type: 'text', required: true, options: [], question: 'Qual è il tuo numero AVS?' };

describe('support to other sites or branches is a platform rule, like relocation and on-call duty', () => {
  it('answers yes to the availability, in the four languages and as a yes/no option', () => {
    for (const [question, locale, yes] of [
      [branches.question, 'it', 'Sì'],
      ['Sind Sie bereit, an anderen Standorten auszuhelfen?', 'de', 'Ja'],
      ['Are you willing to support our other branches when needed?', 'en', 'Yes'],
      ['Êtes-vous disponible pour renforcer nos autres sites ?', 'fr', 'Oui'],
      ['Sei disponibile a lavorare nella sede di Lugano?', 'it', 'Sì'],
      ['Hai flessibilità di sede?', 'it', 'Sì'],
    ]) {
      expect(platformQuestionTopic({ question, type: 'yes_no' }), question).toBe('other_sites');
      expect(platformDefaultAnswer({ question, type: 'yes_no', required: true }, null, { locale })).toMatchObject({ value: yes, topic: 'platform:other_sites', source: 'policy_default' });
    }
    expect(platformDefaultAnswer({ question: 'Disponibile a coprire le altre sedi?', type: 'choice', options: ['Sì', 'No'], required: true }, null, { locale: 'it' })?.value).toBe('Sì');
  });

  it('answers yes to guard and piquet duty asked as an availability', () => {
    expect(platformDefaultAnswer({ question: 'Êtes-vous disponible pour un service de piquet ?', type: 'yes_no', required: true }, null, { locale: 'fr' })).toMatchObject({ value: 'Oui', topic: 'platform:on_call' });
    expect(platformDefaultAnswer({ question: 'Sei disponibile a turni di guardia notturni?', type: 'yes_no', required: true }, null, { locale: 'it' })).toMatchObject({ value: 'Sì', topic: 'platform:on_call' });
  });

  it('leaves a fact of the past and a choice of place alone', () => {
    for (const question of [
      { question: 'Hai lavorato in una succursale bancaria?', type: 'yes_no' },
      { question: 'Hai svolto servizio di guardia?', type: 'yes_no' },
      { question: 'In quale sede preferisci lavorare?', type: 'text' },
      { question: 'Quale esperienza hai maturato nelle succursali?', type: 'text' },
    ]) expect(platformQuestionTopic(question), question.question).toBeNull();
  });

  it('is named among the platform rules the decision engine applies', () => {
    expect(decisionsSystemPrompt()).toContain('support to other sites or branches');
  });
});

describe('the review page shows every answer of the platform, filled in and editable (8BhQ…, CVRD…, ogeY…)', () => {
  const NOW = Date.parse('2026-11-10T10:00:00Z');
  const draft = draftOf([branches, availability, reception, profile, smallTeam]);

  it('shows them even when no question is open, with their provenance, and lets the candidate approve', () => {
    expect(evaluateRedFlags(draft, {}, {}, {}, null, order).candidate).toEqual([]);
    const payload = buildReviewPayload({ order, flow, draft, round: 1, coverLetterUrl: null, nowMs: NOW });
    expect(payload.questions.map((question: { id: string }) => question.id)).toEqual([branches.id, availability.id, reception.id, profile.id, smallTeam.id]);
    const byId = Object.fromEntries(payload.questions.map((question: { id: string }) => [question.id, question]));
    expect(byId[branches.id]).toMatchObject({ answeredByPlatform: true, answerProvenance: 'platform_rule' });
    expect(byId[availability.id]).toMatchObject({ answeredByPlatform: true, answerProvenance: 'platform_rule', suggested: defaultStartDate(NOW) });
    expect(byId[reception.id]).toMatchObject({ answeredByPlatform: true, answerProvenance: 'cv_plausible', answerFromCv: 'cv_plausible', suggestedAnswer: reception.suggestedAnswer });
    expect(byId[profile.id]).toMatchObject({ answeredByPlatform: true, answerProvenance: 'platform_decision', answerDecisionPrinciple: 'plausible_deduction', suggestedAnswer: PROFILE_ANSWER });
    expect(byId[smallTeam.id]).toMatchObject({ answeredByPlatform: true, answerProvenance: 'platform_decision', answerDecisionPrinciple: 'application_success', suggestedAnswer: 'Sì' });
    // Filled in: the values the page puts in the fields.
    expect(payload.answers).toMatchObject({
      [branches.id]: 'Sì', [availability.id]: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), [reception.id]: reception.suggestedAnswer,
      [profile.id]: PROFILE_ANSWER, [smallTeam.id]: 'Sì',
    });
    // Not «to answer»: nothing holds the approval.
    expect(payload.can.approve).toBe(true);
  });

  it('keeps only the question nobody answered as open', () => {
    const open = draftOf([branches, availability, ahv]);
    expect(evaluateRedFlags(open, {}, {}, {}, null, order).candidate).toEqual([ahv.id]);
    const payload = buildReviewPayload({ order, flow, draft: open, round: 1, coverLetterUrl: null, nowMs: NOW });
    expect(payload.questions.map((question: { id: string }) => question.id)).toEqual([branches.id, availability.id, ahv.id]);
    expect(payload.questions.find((question: { id: string }) => question.id === ahv.id).answeredByPlatform).toBeUndefined();
    expect(payload.answers[ahv.id]).toBe('');
    expect(payload.can.approve).toBe(false);
  });

  it('labels every provenance the page knows, in the four languages', () => {
    const keys = ['answerProvenanceLabel', 'answerFrom.cv_evidence', 'answerFrom.cv_plausible', 'answerFrom.platform_rule',
      ...['cv_fact', 'platform_rule', 'application_success', 'same_employer_consent', 'plausible_deduction'].map((principle) => `answerFrom.decision.${principle}`)];
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const source = readFileSync(new URL(`../services/locales/${locale}-core.ts`, import.meta.url), 'utf8');
      for (const key of keys) expect(source, `${locale} ${key}`).toContain(`'jobBoard.assisted.review.${key}':`);
    }
    expect(platformAnswerProvenance(null)).toBeNull();
  });
});

describe('the draft mirrors the platform\'s answers in the shape of the field', () => {
  const draft = draftOf([branches, availability, reception, profile, smallTeam, ahv]);
  const { platformFacts } = candidateWithEdits({ order, draft, flow });

  it('writes yes/no in the language, the sentence, the date; keeps a CV answer and leaves the open question', () => {
    const mirrored = withPlatformSuggestions(draft.questions, { facts: platformFacts, locale: 'it' });
    const byId = Object.fromEntries(mirrored.map((question: any) => [question.id, question]));
    expect(byId[branches.id]).toMatchObject({ suggestedAnswer: 'Sì', answerOrigin: 'platform_rule' });
    expect(byId[availability.id]).toMatchObject({ suggestedAnswer: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), answerOrigin: 'platform_rule' });
    expect(byId[profile.id]).toMatchObject({ suggestedAnswer: PROFILE_ANSWER, answerOrigin: 'platform_decision', platformDecision: profile.platformDecision });
    expect(byId[smallTeam.id]).toMatchObject({ suggestedAnswer: 'Sì', answerOrigin: 'platform_decision' });
    expect(byId[reception.id]).toEqual(reception);
    expect(byId[ahv.id]).toEqual(ahv);
    // The mirror is never read back as an answer of the CV, and changes nothing the page or the flow projects.
    expect(Object.keys(verifiedCvAnswers(mirrored, CV))).toEqual([reception.id]);
    const after = draftOf(mirrored);
    expect(evaluateRedFlags(after, {}, {}, {}, null, order).candidate).toEqual([ahv.id]);
    const facts = candidateWithEdits({ order, draft: after, flow }).platformFacts;
    expect(Object.keys(withOperationalQuestionAnswers(after.questions, {}, { facts }).defaults).sort())
      .toEqual(Object.keys(withOperationalQuestionAnswers(draft.questions, {}, { facts: platformFacts }).defaults).sort());
    // The candidate's own answer is the answer: no mirror of the platform's next to it.
    expect(withPlatformSuggestions(mirrored, { facts: platformFacts, locale: 'it', answers: { [branches.id]: 'No' } })
      .find((question: any) => question.id === branches.id)).toEqual(branches);
    // Idempotent, and removable.
    expect(withPlatformSuggestions(mirrored, { facts: platformFacts, locale: 'it' })).toEqual(mirrored);
    // The empty proposal the CV step left on the profile question is not restored: it carried nothing.
    const { suggestedAnswer: _empty, ...profileWithoutProposal } = profile;
    expect(withoutPlatformSuggestions(mirrored)).toEqual(draft.questions.map((question: any) => (question.id === profile.id ? profileWithoutProposal : question)));
  });

  it('writes the German words for a German candidate', () => {
    const german = { ...order, locale: 'de' };
    const facts = candidateWithEdits({ order: german, draft, flow, locale: 'de' }).platformFacts;
    const mirrored = withPlatformSuggestions(draft.questions, { facts, locale: 'de' });
    expect(mirrored.find((question: any) => question.id === branches.id)).toMatchObject({ suggestedAnswer: 'Ja', answerOrigin: 'platform_rule' });
  });

  it('drops the mirror of a decision that no longer passes, and keeps a start date computed another day', () => {
    const mirrored = withPlatformSuggestions(draft.questions, { facts: platformFacts, locale: 'it' });
    const dropped = mirrored.map((question: any) => (question.id === smallTeam.id ? { ...question, platformDecision: { ...question.platformDecision, value: 'forse' } } : question));
    const facts = candidateWithEdits({ order, draft: draftOf(dropped), flow }).platformFacts;
    const again = withPlatformSuggestions(dropped, { facts, locale: 'it' });
    expect(again.find((question: any) => question.id === smallTeam.id)).not.toHaveProperty('suggestedAnswer');
    expect(again.find((question: any) => question.id === smallTeam.id)).not.toHaveProperty('answerOrigin');
    const older = mirrored.map((question: any) => (question.id === availability.id ? { ...question, suggestedAnswer: '2027-01-02' } : question));
    expect(withPlatformSuggestions(older, { facts: platformFacts, locale: 'it', keepExisting: true }).find((question: any) => question.id === availability.id).suggestedAnswer).toBe('2027-01-02');
    expect(withPlatformSuggestions(older, { facts: platformFacts, locale: 'it' }).find((question: any) => question.id === availability.id).suggestedAnswer).not.toBe('2027-01-02');
  });
});

describe('the profile applied for (CVRD…): the posting is a source of the answer', () => {
  const decision = { decision: 'answer', value: PROFILE_ANSWER, principle: 'plausible_deduction', reason: 'The posting names the profile.' };

  it('accepts the posting\'s title for that question only, never as an experience of the candidate', () => {
    expect(appliedPositionQuestion(profile)).toBe(true);
    expect(verifyDecision(decision, { question: profile, cvText: CV }).reasons).toContain('invented_name');
    expect(verifyDecision(decision, { question: profile, cvText: CV, postingTitle: TITLE })).toMatchObject({ ok: true, value: PROFILE_ANSWER });
    const experience = { ...profile, id: 'experience', question: 'Descrivi la tua esperienza più recente.' };
    expect(appliedPositionQuestion(experience)).toBe(false);
    expect(verifyDecision({ ...decision, value: 'Ho lavorato come Collaboratore Amministrativo.' }, { question: experience, cvText: CV, postingTitle: TITLE }).ok).toBe(false);
  });

  it('gives the engine the posting\'s requirements and the rule to deduce the profile, and keeps the decision', async () => {
    const requests: Array<{ prompt: string }> = [];
    const codex = async (request: { prompt: string }) => {
      requests.push(request);
      return { decisions: [{ id: profile.id, ...decision, category: '' }] };
    };
    const { platformDecision: _stored, ...asked } = profile;
    const result = await draftDecisionAnswers({ questions: [asked], cvText: CV, codex, employer: 'Esempio SA', jobTitle: TITLE,
      postingRequirements: [{ requirement: 'Profilo amministrativo con esperienza di sportello' }] });
    expect(result.kept).toEqual([profile.id]);
    expect(result.questions[0].platformDecision).toMatchObject({ value: PROFILE_ANSWER, principle: 'plausible_deduction' });
    expect(requests[0].prompt).toContain('Profilo amministrativo con esperienza di sportello');
    expect(decisionsSystemPrompt()).toContain('which profile, position or role of the posting');
    expect(JSON.parse(decisionsUserText({ questions: [], postingRequirements: ['a'.repeat(400)] })).postingRequirements[0]).toHaveLength(200);
  });
});

describe('the reconciliation mirrors the answers on the drafts already written, without a model', () => {
  const base = 'assisted_applications/decided_answers_mirror';
  const seed = () => createMemoryFirestore({
    [base]: order,
    [`${base}/automation/flow`]: flow,
    [`${base}/ai_drafts/current`]: draftOf([branches, profile, reception]),
  });
  const NOW = Date.parse('2026-11-10T10:00:00Z');

  it('dry run: names the questions, writes nothing', async () => {
    const store = seed();
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    const report = await reconcileReviewQuestions({ db: store.db, nowMs: NOW });
    expect(report).toMatchObject({ withQuestions: 0, mirrored: 2, written: 0 });
    expect(report.orders[0]).toMatchObject({ mirrored: [branches.id, profile.id] });
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
  });

  it('apply: writes the mirror once, touches neither the flow nor the candidate\'s answers', async () => {
    const store = seed();
    const flowBefore = structuredClone(store.read(`${base}/automation/flow`));
    const calls: unknown[] = [];
    const codex = async (request: unknown) => { calls.push(request); return {}; };
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: NOW, apply: true })).toMatchObject({ mirrored: 2, written: 1 });
    expect(calls).toEqual([]);
    const questions = store.read(`${base}/ai_drafts/current`).questions;
    expect(questions[0]).toMatchObject({ suggestedAnswer: 'Sì', answerOrigin: 'platform_rule' });
    expect(questions[1]).toMatchObject({ suggestedAnswer: PROFILE_ANSWER, answerOrigin: 'platform_decision' });
    expect(questions[2]).toEqual(reception);
    expect(store.read(`${base}/automation/flow`)).toEqual(flowBefore);
    // Idempotent: a second run finds nothing to write.
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: NOW + 1, apply: true })).toMatchObject({ mirrored: 0, written: 0 });
    expect(platformSuggestionUpdate({ order, flow, draft: store.read(`${base}/ai_drafts/current`) }).ids).toEqual([]);
  });

  it('leaves an order outside the review alone', () => {
    const draft = draftOf([branches]);
    expect(platformSuggestionUpdate({ order, flow: { ...flow, state: 'submitted' }, draft }).ids).toEqual([]);
    expect(platformSuggestionUpdate({ order: { ...order, paymentStatus: 'pending' }, flow, draft }).ids).toEqual([]);
    expect(platformSuggestionUpdate({ order, flow, draft: { ...draft, round: 2 } }).ids).toEqual([]);
  });
});
