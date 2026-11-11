/**
 * A portal step that stopped for the candidate (needs_candidate_action) on questions the platform answers
 * today (owner directive 2026-11-10: every question is answered by the platform, by its rules, the CV, the
 * decision engine or a plausible deduction; to the candidate only documents). The shapes are those of an SBB
 * SuccessFactors order (ifB89NW2…, a concierge child): three required choice fields the runner wrote on the
 * draft with their German labels, an unproven address context and no shared answer key. The record question
 * has the owner's rule (no entry); the two experience questions go to the decision engine. The CV, the
 * candidate and every answer here are invented.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evaluateRedFlags, transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateQuestionAnswerKey, candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { orderQuestionAnswerIdentity } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { runAutomationSweep } from '../functions/src/assistedApplicationAutomation.js';
import { reconcileOperationalAnswers, releasesWait } from '../scripts/assisted-application/reconcile-operational-answers.mjs';
import {
  REVIEW_QUESTION_MAX_ATTEMPTS,
  REVIEW_QUESTION_RETRY_MS,
  REVIEW_QUESTION_STATES,
  reconcileReviewQuestions,
  reviewQuestionPlan,
} from '../scripts/assisted-application/reconcile-review-questions.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const CV = [
  'Candidato Prova — Cloud Engineer',
  'Esperienza',
  '2018 – 2025 Cloud Engineer, Beta Hosting SA, Bellinzona',
  'Betrieb von Datenbanken und Container Plattformen für Geschäftskunden.',
  'Coordinamento dei rilasci con il team di sviluppo.',
  'Lingue: italiano, tedesco, inglese',
].join('\n');
const DATABASES_LINE = 'Betrieb von Datenbanken und Container Plattformen für Geschäftskunden.';

// The section text and owners the runner read around the fields: the form's own, never proven an address block.
const addressContext = (label: string) => ({
  section: 'Hinweis: Bitte kontrolliere nach abgeschlossener Bewerbung auch den Spam-Ordner auf allfällige Korrespondenz.',
  owners: [label, 'Bewerbungsbezogene Angaben', 'Stellenbewerbungsformular'],
  unknown: true,
});
const portalChoice = (id: string, label: string, question: string, yesFirst: boolean) => ({
  id,
  question,
  applicationQuestion: label,
  applicationOptions: yesFirst ? ['Ja', 'Nein'] : ['Nein', 'Ja'],
  applicationOptionValues: yesFirst ? ['Ja', 'Nein'] : ['Nein', 'Ja'],
  optionMap: yesFirst
    ? [{ candidate: 'Sì', application: 'Ja' }, { candidate: 'No', application: 'Nein' }]
    : [{ candidate: 'No', application: 'Nein' }, { candidate: 'Sì', application: 'Ja' }],
  addressContext: addressContext(label),
  why: 'Il portale richiede questa informazione.',
  type: 'choice',
  options: yesFirst ? ['Sì', 'No'] : ['No', 'Sì'],
  required: true,
  validation: { pattern: '', minLength: 0, maxLength: 500, min: null, max: null, minDate: '', example: '', message: 'Inserisci una risposta valida.' },
  source: 'portal',
  applicationQuestionLocale: 'de',
  localizationStatus: 'translated',
});
const record = portalChoice('portal_hast_du_einen_eintrag_im_strafregister_oder_im_bet_tpj8im',
  '* Hast du einen Eintrag im Strafregister oder im Betreibungsregister?',
  "* Hai un'iscrizione nel casellario giudiziale o nel registro delle esecuzioni?", false);
const databases = portalChoice('portal_hast_du_erfahrungen_mit_datenbanken_managed_os_con_1esmert',
  '* Hast du Erfahrungen mit Datenbanken, Managed OS, Container Plattformen?',
  '* Hai esperienza con database, Managed OS e piattaforme container?', true);
const safe = portalChoice('portal_hast_du_safe_product_owner_und_product_manager_erf_1hu1v4l',
  '* Hast du SAFe Product Owner und Product Manager Erfahrung?',
  '* Hai esperienza come SAFe Product Owner e Product Manager?', true);

const now = 1794411037396;
const order = {
  paymentStatus: 'paid', automationState: 'needs_candidate_action', submissionStatus: 'awaiting_upload', locale: 'it',
  applicantName: 'Candidato Prova', userId: 'u-test', companyName: 'Esempio Bahn AG', parentServiceId: 'svc-test',
};
const draft = {
  status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail', title: 'Cloud Engineer' }, channel: { type: 'successfactors' },
  factCheck: { ok: true, unsupported: [] }, factSources: { text: CV }, language: 'de', candidateLocale: 'it',
  requirements: ['Erfahrung mit Datenbanken und Container Plattformen'],
  questions: [record, databases, safe],
};
const holds = [record, databases, safe].map((question) => `question:${question.id}`);
// The run went to the portal (dispatch submit of the round) and stopped there: nothing was clicked.
const heldFlow = (heldBy = holds) => ({
  state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy, heldSince: now - 2 * 24 * 3600 * 1000,
  heldNudges: 1, reminderAt: null, deadlineAt: null, dispatch: { mode: 'submit', round: 1, requestedAt: now - 3 * 24 * 3600 * 1000 },
});
const failedNotSent = { r1: { state: 'failed', channel: 'portal', confirmedNotSent: true } };

type Request = { prompt: string, schema: any };
function stubModel(decisions: Record<string, object>) {
  const calls: string[] = [];
  const codex = async (request: Request) => {
    if (request.schema?.properties?.answers) {
      calls.push('cv');
      return { answers: [] };
    }
    const ids: string[] = request.schema.properties.decisions.items.properties.id.enum;
    calls.push(`decision:${[...ids].sort().join(',')}`);
    return { decisions: ids.filter((id) => decisions[id]).map((id) => ({ id, category: '', evidence: [], ...decisions[id] })) };
  };
  return { codex, calls };
}
const engine = () => stubModel({
  // A yes the CV shows, with its quote verbatim.
  [databases.id]: { decision: 'answer', value: 'Sì', principle: 'cv_fact', evidence: [DATABASES_LINE], reason: 'The CV shows database and container platform operations.' },
  // The CV is silent on SAFe: the plausible deduction from the career.
  [safe.id]: { decision: 'answer', value: 'No', principle: 'plausible_deduction', reason: 'The CV shows engineering roles, not product ownership.' },
});

function seed(base: string, { flow = heldFlow(), submission = failedNotSent, extraOrder = {}, questions = draft.questions }: { flow?: object, submission?: object, extraOrder?: object, questions?: object[] } = {}) {
  return createMemoryFirestore({
    [base]: { ...order, ...extraOrder },
    [`${base}/automation/flow`]: flow,
    [`${base}/automation/submission`]: submission,
    [`${base}/ai_drafts/current`]: { ...draft, questions },
  });
}
const sweep = async (store: ReturnType<typeof createMemoryFirestore>, nowMs: number) => {
  const effects: any[] = [];
  await runAutomationSweep({ db: store.db, nowMs, runEffect: async ({ effect }: { effect: unknown }) => { effects.push(effect); return { ok: true }; } });
  return effects;
};

describe('the three SBB portal questions', () => {
  it('have no shared answer key, only the order-local identity', () => {
    for (const question of [record, databases, safe]) {
      expect(candidateQuestionAnswerKey(question)).toBe('');
      expect(orderQuestionAnswerIdentity(question)).not.toBe('');
    }
  });

  it('the record question is the platform\'s (no entry), the two experience questions are still open', () => {
    const flow = heldFlow();
    expect(evaluateRedFlags(draft, {}, {}, {}, flow, order)).toMatchObject({ owner: [], candidate: [databases.id, safe.id], documents: [] });
    const { platformFacts } = candidateWithEdits({ order, draft, flow });
    const { answers, defaults } = withOperationalQuestionAnswers(draft.questions, {}, { facts: platformFacts, locale: 'it' });
    expect(defaults[record.id]).toMatchObject({ topic: 'platform:criminal_or_debt_record', source: 'policy_default' });
    expect(answers[record.id]).toBe('No');
  });
});

describe('the flow of a portal step held by questions the platform answers', () => {
  it('drops the answered hold and keeps waiting for the rest, without an e-mail', () => {
    const flow = heldFlow();
    const tick = transition(flow, { type: 'tick' }, { order, draft, nowMs: now });
    expect(tick.flow).toMatchObject({ state: 'needs_candidate_action', heldBy: [`question:${databases.id}`, `question:${safe.id}`], heldSince: flow.heldSince });
    expect(tick.effects).toEqual([]);
    expect(releasesWait(flow, tick)).toBe(true);
    expect(transition(tick.flow, { type: 'tick' }, { order, draft, nowMs: now }).ignored).toBe('nothing_due');
  });

  it('a step that stopped only on the record question resumes the submission on the operational reconciliation', async () => {
    const base = 'assisted_applications/portal_step_record_only';
    const store = seed(base, { flow: heldFlow([`question:${record.id}`]), questions: [record] });
    expect(await reconcileOperationalAnswers({ db: store.db, nowMs: now, salaryEstimate: null })).toMatchObject({ eligible: 1, queued: 0 });
    expect(store.read(base).automationDueAt).toBeUndefined();
    expect(await reconcileOperationalAnswers({ db: store.db, nowMs: now, apply: true, salaryEstimate: null })).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(base).automationDueAt).toBe(now);
    const effects = await sweep(store, now);
    expect(effects).toContainEqual(expect.objectContaining({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }));
    expect(store.read(`${base}/automation/flow`).state).toBe('submitting');
    // Idempotent: the same wait is never queued twice.
    expect(await reconcileOperationalAnswers({ db: store.db, nowMs: now + 1, apply: true, salaryEstimate: null })).toMatchObject({ queued: 0 });
  });

  it('the operational reconciliation narrows the mixed wait of the three questions', async () => {
    const base = 'assisted_applications/portal_step_operational';
    const store = seed(base);
    expect(await reconcileOperationalAnswers({ db: store.db, nowMs: now, apply: true, salaryEstimate: null })).toMatchObject({ scanned: 1, eligible: 1, queued: 1 });
    expect(await sweep(store, now)).toEqual([]);
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'needs_candidate_action', heldBy: [`question:${databases.id}`, `question:${safe.id}`] });
  });
});

describe('the review-question reconciliation reaches the portal step', () => {
  const base = 'assisted_applications/portal_step_questions';

  it('scans needs_candidate_action and plans the two experience questions for the decision engine', () => {
    expect(REVIEW_QUESTION_STATES).toContain('needs_candidate_action');
    expect(reviewQuestionPlan({ order, flow: heldFlow(), draft })).toMatchObject({
      held: [record.id, databases.id, safe.id], open: [databases.id, safe.id], targets: [databases.id, safe.id], candidateOnly: [],
    });
  });

  it('dry run, by id prefix: names what it would ask and release, writes nothing, prints no answer', async () => {
    const store = seed(base);
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    const report = await reconcileReviewQuestions({ db: store.db, codex: engine().codex, nowMs: now, orderPrefixes: ['portal_s'] });
    expect(report).toMatchObject({ scanned: 1, withQuestions: 1, asked: 2, answered: 2, queued: 1, written: 0 });
    expect(report.orders[0]).toMatchObject({ state: 'needs_candidate_action', answered: [databases.id, safe.id], stillOpen: [], releases: true, heldAfter: [] });
    expect(JSON.stringify(report)).not.toContain('Betrieb');
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    // Without a model it names the questions it would ask, and releases nothing.
    const none = await reconcileReviewQuestions({ db: store.db, codex: null, nowMs: now });
    expect(none.orders[0]).toMatchObject({ model: 'not_asked', targets: [databases.id, safe.id], releases: true, heldAfter: [`question:${databases.id}`, `question:${safe.id}`] });
  });

  it('apply: the decisions stay on the draft, editable, and the sweep resumes the submission', async () => {
    const store = seed(base);
    const { codex, calls } = engine();
    expect(await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true })).toMatchObject({ answered: 2, written: 1, queued: 1 });
    expect(calls).toEqual([`decision:${[databases.id, safe.id].sort().join(',')}`]);
    const questions = store.read(`${base}/ai_drafts/current`).questions;
    expect(questions.find((question: any) => question.id === databases.id).platformDecision)
      .toMatchObject({ decision: 'answer', value: 'Sì', applicationValue: 'Ja', principle: 'cv_fact', evidence: [DATABASES_LINE] });
    expect(questions.find((question: any) => question.id === safe.id).platformDecision)
      .toMatchObject({ decision: 'answer', value: 'No', applicationValue: 'Nein', principle: 'plausible_deduction' });
    // The platform's answers are proposals mirrored on the questions, never the candidate's own answers.
    expect(questions.find((question: any) => question.id === record.id)).toMatchObject({ suggestedAnswer: 'No', answerOrigin: 'platform_rule' });
    expect(store.read(`${base}/automation/flow`).answers).toBeUndefined();
    expect(store.read(base)).toMatchObject({ automationDueAt: now, reviewQuestionRecovery: { attempts: 1, nextAttemptAt: null } });
    const effects = await sweep(store, now);
    expect(effects).toContainEqual(expect.objectContaining({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' }));
    expect(store.read(`${base}/automation/flow`).state).toBe('submitting');
    // Idempotent: nothing left to ask, queue or write.
    const again = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex: again.codex, nowMs: now + 1, apply: true })).toMatchObject({ withQuestions: 0, written: 0, queued: 0 });
    expect(again.calls).toEqual([]);
  });

  it('an engine that decides nothing: the questions stay, asked again once after the pause, then no more', async () => {
    const store = seed(base);
    const first = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex: first.codex, nowMs: now, apply: true })).toMatchObject({ answered: 0, queued: 1 });
    expect(first.calls).toHaveLength(1);
    // The record hold still drops through the clock; the experience questions wait for the second attempt.
    expect(store.read(base).reviewQuestionRecovery).toMatchObject({ attempts: 1, nextAttemptAt: now + REVIEW_QUESTION_RETRY_MS });
    expect(await sweep(store, now)).toEqual([]);
    expect(store.read(`${base}/automation/flow`)).toMatchObject({ state: 'needs_candidate_action', heldBy: [`question:${databases.id}`, `question:${safe.id}`] });
    // The dropped record hold opens no new episode: within the pause, no model call.
    const paused = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex: paused.codex, nowMs: now + 1000, apply: true })).toMatchObject({ exhausted: 1, written: 0 });
    expect(paused.calls).toEqual([]);
    const second = stubModel({});
    await reconcileReviewQuestions({ db: store.db, codex: second.codex, nowMs: now + REVIEW_QUESTION_RETRY_MS, apply: true });
    expect(second.calls).toHaveLength(1);
    expect(store.read(base).reviewQuestionRecovery).toMatchObject({ attempts: REVIEW_QUESTION_MAX_ATTEMPTS, nextAttemptAt: null });
    const third = stubModel({});
    expect(await reconcileReviewQuestions({ db: store.db, codex: third.codex, nowMs: now + 10 * REVIEW_QUESTION_RETRY_MS, apply: true })).toMatchObject({ exhausted: 1 });
    expect(third.calls).toEqual([]);
    // Nothing was resumed: the experience questions still hold the step.
    expect(store.read(`${base}/automation/flow`).state).toBe('needs_candidate_action');
  });
});

describe('an application that may have left is never resumed', () => {
  it('a final click nothing proved failed: no model, no write, no clock', async () => {
    const base = 'assisted_applications/portal_step_clicked';
    const store = seed(base, { submission: { r1: { state: 'failed', channel: 'portal', clickedAt: now - 3600_000, confirmedNotSent: false } } });
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    const { codex, calls } = engine();
    const report = await reconcileReviewQuestions({ db: store.db, codex, nowMs: now, apply: true });
    expect(report).toMatchObject({ sendMayHaveLeft: 1, withQuestions: 0, written: 0, queued: 0 });
    expect(report.orders[0]).toMatchObject({ skipped: 'send_may_have_left' });
    expect(calls).toEqual([]);
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    expect(store.read(base).automationDueAt).toBeUndefined();
  });

  it('a submitted order is out of the plan', () => {
    expect(reviewQuestionPlan({ order: { ...order, submissionStatus: 'submitted' }, flow: heldFlow(), draft })).toBeNull();
  });
});

describe('the recovery workflow', () => {
  it('asks the decision engine through the Codex broker', () => {
    const workflow = parse(readFileSync(new URL('../.github/workflows/assisted-application-question-recovery.yml', import.meta.url), 'utf8')) as any;
    const apply = workflow.jobs.recover.steps.find((step: any) => String(step.run || '').includes('reconcile-review-questions.mjs'));
    expect(apply.run).toContain('--apply --codex broker');
    expect(apply.env.CODEX_AUTH_BROKER_SOCKET).toContain('codex_auth_broker_socket');
  });
});
