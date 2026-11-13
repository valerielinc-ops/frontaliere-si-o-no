#!/usr/bin/env node
/**
 * Re-evaluation of the questions that hold a review (owner directive 2026-11-10, DECISIONS.md: «ogni
 * domanda la risponde la piattaforma … modificabili, non bloccanti; al candidato solo documenti», and the
 * rules hold for the orders written before, the pending ones first).
 *
 * A draft written before a rule of the platform, the CV answers or the decision engine keeps the
 * `question:<id>` holds it was shown with: nothing asked again the pipeline of today. The same for a portal
 * step that stopped for the candidate (`needs_candidate_action`): the runner wrote the portal's questions on
 * the draft and held them, keyless or not (an order-local question is still a question of this draft, by its
 * id). This script does, for every paid order in `candidate_review`, `needs_candidate_action` (or
 * `owner_review`, before its questions become holds):
 *
 *   1. the questions a deterministic rule now answers (a start date three months ahead, a platform rule…)
 *      need no model: the normal tick drops their holds;
 *   2. the open questions the CV or the decision engine may answer are asked to the same model steps the
 *      draft runs (lib/cv-answers.mjs, then lib/decision-answers.mjs), and the verified answers are stored
 *      on the draft's questions, where the draft keeps them (`suggestedAnswer`, `platformDecision`): shown and
 *      editable on the review page, never written into the candidate's own answers;
 *   3. when a hold can drop, the order's clock is set due and the scheduled sweep runs the tick of the flow
 *      (assistedApplicationFlow.js): the holds the platform answers drop, and with none left the review goes
 *      on as when the candidate answers the last question (the 12 h clock), and a portal step resumes the
 *      submission (`resolved_candidate_answers`) through the sweep's own checks and the submission guard.
 *      Nothing is dispatched here, and an order whose application may already have left (submitted, a send
 *      on record, a final click nothing proved failed) is never touched;
 *   4. every answer the platform gives (a rule, a decision of the engine) is mirrored on its question in the
 *      field's shape (`suggestedAnswer`, `answerOrigin`, withPlatformSuggestions), as a new draft has it: also
 *      on the orders with nothing held, without a model. A mirror already right is not rewritten.
 *
 * What stays the candidate's (a document, an identifier, a legal declaration, a fact the CV does not hold)
 * stays held. The model is asked at most REVIEW_QUESTION_MAX_ATTEMPTS times per order and per episode (the
 * answer pipeline's source fingerprint, the round, the open questions and the holds), the second time after
 * REVIEW_QUESTION_RETRY_MS: a change of the rules or of the code opens a new episode, a run that changed
 * nothing never repeats itself.
 *
 *   node scripts/assisted-application/reconcile-review-questions.mjs [--dry-run | --apply] [--order <id prefix>]... [--codex broker|local|none]
 * --dry-run (the default) writes nothing; it prints, per order, question ids, topics and reasons only:
 * never an answer, a CV line or a name. --codex none (the default without a broker) asks no model and
 * reports which questions it would ask.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { evaluateRedFlags, transition } from '../../functions/src/assistedApplicationFlow.js';
import { sendMayHaveLeft } from '../../functions/src/assistedApplicationEmployerWithdrawal.js';
import { candidateAnswerHistoryState, candidateWithEdits } from '../../functions/src/assistedApplicationCandidateEdits.js';
import { verifiedCvAnswers } from '../../functions/src/assistedApplicationCvAnswers.js';
import { verifiedDecisionAnswers } from '../../functions/src/assistedApplicationDecisionAnswers.js';
import { withPlatformSuggestions, withoutPlatformSuggestions } from '../../functions/src/assistedApplicationOperationalAnswers.js';
import { cvAnswerable, draftCvAnswers } from './lib/cv-answers.mjs';
import { decisionAnswerable, draftDecisionAnswers } from './lib/decision-answers.mjs';
import { releasesWait } from './reconcile-operational-answers.mjs';

// needs_candidate_action: a portal step held by questions of the draft resumes the submission once the
// platform answers them (the tick's `resolved_candidate_answers`), as a review goes on.
export const REVIEW_QUESTION_STATES = Object.freeze(['candidate_review', 'owner_review', 'needs_candidate_action']);
// The states where the application may already be on its way: the submission record is read before any write.
const SUBMISSION_STATES = new Set(['needs_candidate_action']);
const SETTLED_SUBMISSIONS = new Set(['submitted', 'withdrawn']);
export const REVIEW_QUESTION_MAX_ATTEMPTS = 2;
export const REVIEW_QUESTION_RETRY_MS = 6 * 60 * 60 * 1000;
// What the draft keeps on a question it answered (lib/cv-answers.mjs, lib/decision-answers.mjs, and the
// mirror of the platform's answer, withPlatformSuggestions).
const ANSWER_FIELDS = ['suggestedAnswer', 'answerEvidence', 'answerKind', 'answerMissingDetail', 'platformDecision', 'answerOrigin'];

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The sources that decide whether a question is answered: one list for the fingerprint and the workflow trigger. */
export function reviewQuestionFingerprintFiles() {
  return [
    'functions/src/assistedApplicationAiDraftCore.js',
    'functions/src/assistedApplicationAiPrompts.js',
    'functions/src/assistedApplicationCandidateEdits.js',
    'functions/src/assistedApplicationCvAnswers.js',
    'functions/src/assistedApplicationDecisionAnswers.js',
    'functions/src/assistedApplicationFlow.js',
    'functions/src/assistedApplicationOperationalAnswers.js',
    'functions/src/assistedApplicationPlatformDefaults.js',
    'functions/src/lib/answerRules.js',
    'functions/src/lib/numberDateMentions.js',
    'scripts/assisted-application/lib/cv-answers.mjs',
    'scripts/assisted-application/lib/decision-answers.mjs',
    'scripts/assisted-application/lib/portal/plan.mjs',
    'scripts/assisted-application/reconcile-operational-answers.mjs',
    'scripts/assisted-application/reconcile-review-questions.mjs',
  ];
}

/** Source-only fingerprint of the answer pipeline: no candidate data enters it. */
export function currentReviewQuestionVersion(root = defaultRoot) {
  const hash = createHash('sha256');
  for (const file of reviewQuestionFingerprintFiles()) {
    hash.update(file).update('\0').update(readFileSync(path.join(root, ...file.split('/')))).update('\0');
  }
  return hash.digest('hex');
}

const questionHolds = (flow) => (Array.isArray(flow?.heldBy) ? flow.heldBy : [])
  .map(String).filter((held) => held.startsWith('question:')).map((held) => held.slice('question:'.length));
const questionIdentity = (draft) => JSON.stringify((Array.isArray(draft?.questions) ? draft.questions : [])
  .map((question) => [question?.id, question?.question, question?.applicationQuestion, question?.type, question?.source]));
const sameHolds = (left, right) => JSON.stringify([...(left?.heldBy || [])].map(String).sort())
  === JSON.stringify([...(right?.heldBy || [])].map(String).sort());
const answerMap = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : {};
const candidateAnswerState = flow => ({ answers: answerMap(flow?.answers), questionAnswers: answerMap(flow?.questionAnswers),
  candidateAnswerHistory: candidateAnswerHistoryState(flow?.candidateAnswerHistory) });

/** An order whose current draft the reconciliation may touch: paid, in review, the draft of the round. */
function reviewDraftOf({ order, flow, draft }) {
  if (order?.paymentStatus !== 'paid' || order.refundStatus === 'pending') return false;
  if (SETTLED_SUBMISSIONS.has(order.submissionStatus)) return false;
  if (!REVIEW_QUESTION_STATES.includes(flow?.state)) return false;
  return Boolean(draft && Array.isArray(draft.questions) && Number(draft.round) === (Number(flow.round) || 1));
}

/**
 * The platform's answers mirrored on the draft's questions (step 4), and the ids whose mirror changes.
 * No model: the rules and the decisions already stored on the draft.
 * @returns {{questions:object[], ids:string[]}}
 */
export function platformSuggestionUpdate({ order, flow, draft }) {
  const questions = Array.isArray(draft?.questions) ? draft.questions : [];
  if (!reviewDraftOf({ order, flow, draft })) return { questions, ids: [] };
  const { answers, platformFacts } = candidateWithEdits({ order, draft, flow });
  const updated = withPlatformSuggestions(questions, { facts: platformFacts, locale: platformFacts?.locale, keepExisting: true, answers });
  const mirror = (question) => JSON.stringify([question?.suggestedAnswer ?? null, question?.answerOrigin ?? null]);
  const ids = updated.filter((question, index) => question?.id && mirror(question) !== mirror(questions[index])).map((question) => question.id);
  return { questions: updated, ids };
}

/**
 * What the pipeline of today can still do for an order, without a model: null when nothing (not paid, not
 * in review, no open question and no question hold).
 * @returns {null|{held:string[], open:string[], targets:string[], candidateOnly:string[], answers:object, platformFacts:object}}
 */
export function reviewQuestionPlan({ order, flow, draft }) {
  if (!reviewDraftOf({ order, flow, draft })) return null;
  const held = questionHolds(flow);
  const open = evaluateRedFlags(draft, flow.answers || {}, flow.documents || {}, flow.questionAnswers || {}, flow, order).candidate;
  if (!held.length && !open.length) return null;
  const { answers, platformFacts } = candidateWithEdits({ order, draft, flow });
  const byId = new Map(draft.questions.map((question) => [question?.id, question]));
  const targets = open.filter((id) => {
    const question = byId.get(id);
    return Boolean(question) && (cvAnswerable(question, { answers, facts: platformFacts })
      || decisionAnswerable(question, { answers, facts: platformFacts }));
  });
  return { held, open, targets, candidateOnly: open.filter((id) => !targets.includes(id)), answers, platformFacts };
}

/** The application of the order may already have left: settled, or a send on record in a submission state. */
function mayHaveLeft(order, flow, draft, submission) {
  return SETTLED_SUBMISSIONS.has(order?.submissionStatus)
    || (SUBMISSION_STATES.has(flow?.state) && sendMayHaveLeft({ draft, submission: submission || {} }));
}

/**
 * One episode of an order: the same pipeline, round, open questions and holds. A question hold a platform rule
 * already answers is left out: the tick that drops it changes nothing the model is asked, so it opens no new
 * episode and no further model attempt.
 */
export function reviewQuestionEpisodeKey({ version, flow, plan }) {
  const open = new Set(plan.open);
  const holds = (flow?.heldBy || []).map(String)
    .filter((held) => !held.startsWith('question:') || open.has(held.slice('question:'.length)));
  return createHash('sha256').update(JSON.stringify([
    version, Number(flow?.round) || 1, [...plan.open].sort(), holds.sort(),
  ])).digest('hex');
}

/** Whether the model may be asked again for this episode: bounded attempts, with a pause between them. */
export function modelAttemptAllowed(ledger, key, nowMs) {
  if (!ledger || ledger.key !== key) return true;
  if ((Number(ledger.attempts) || 0) >= REVIEW_QUESTION_MAX_ATTEMPTS) return false;
  return !(Number(ledger.nextAttemptAt) > nowMs);
}

/** The draft's questions with the answer fields of the given ids taken from the updated ones. */
function mergeAnswerFields(questions, updated, ids) {
  const byId = new Map((Array.isArray(updated) ? updated : []).map((question) => [question?.id, question]));
  return (Array.isArray(questions) ? questions : []).map((question) => {
    if (!ids.includes(question?.id) || !byId.has(question.id)) return question;
    const next = byId.get(question.id);
    const merged = { ...question };
    for (const field of ANSWER_FIELDS) {
      if (Object.hasOwn(next, field)) merged[field] = next[field];
      else delete merged[field];
    }
    return merged;
  });
}

/** The model steps of the draft, on the targets only: the CV first, then the decision engine. */
async function answerTargets({ order, draft, plan, codex, log }) {
  const cvText = draft?.factSources?.text;
  const locale = order?.locale || draft?.candidateLocale || 'it';
  const jobTitle = String(draft?.job?.title || draft?.requirementsRaw?.roleTitle || order?.jobTitle || '').slice(0, 300);
  // A mirrored platform proposal is never an input of the model steps (it is recomputed afterwards).
  const cv = await draftCvAnswers({
    questions: withoutPlatformSuggestions(draft.questions), answers: plan.answers, facts: plan.platformFacts, cvText, codex, locale, log, onlyIds: plan.targets,
  });
  const decided = await draftDecisionAnswers({
    questions: cv.questions, answers: plan.answers, cvText, codex, log, onlyIds: plan.targets,
    employer: order?.companyName || '',
    jobTitle,
    postingRequirements: Array.isArray(draft?.requirements) ? draft.requirements : [],
    facts: {
      ...plan.platformFacts,
      cvAnswers: verifiedCvAnswers(cv.questions, cvText, draft?.profile),
      decisionAnswers: verifiedDecisionAnswers(cv.questions, cvText, { postingTitle: draft?.job?.title || '', postingRequirements: Array.isArray(draft?.requirements) ? draft.requirements : [] }),
    },
  });
  return {
    questions: decided.questions,
    asked: [...new Set([...cv.asked, ...decided.asked])],
    reasons: [...cv.decisions, ...decided.decisions].map(({ id, kept, reasons }) => ({ id, kept, reasons })),
  };
}

export async function reconcileReviewQuestions({
  db, codex = null, apply = false, nowMs = Date.now(), version = currentReviewQuestionVersion(), orderPrefixes = [], log = () => {},
}) {
  const report = { apply, scanned: 0, withQuestions: 0, asked: 0, answered: 0, mirrored: 0, queued: 0, written: 0, exhausted: 0, sendMayHaveLeft: 0, orders: [] };
  for (const state of REVIEW_QUESTION_STATES) {
    let cursor;
    do {
      let query = db.collection('assisted_applications').where('automationState', '==', state).orderBy('__name__').limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.docs.length) break;
      for (const doc of page.docs) {
        if (orderPrefixes.length && !orderPrefixes.some((prefix) => doc.id.startsWith(prefix))) continue;
        report.scanned++;
        const order = doc.data() || {};
        const flowRef = doc.ref.collection('automation').doc('flow');
        const draftRef = doc.ref.collection('ai_drafts').doc('current');
        const submissionRef = doc.ref.collection('automation').doc('submission');
        const [flowDoc, draftDoc] = await Promise.all([flowRef.get(), draftRef.get()]);
        const flow = flowDoc.data() || {};
        const draft = draftDoc.data() || null;
        // A portal step that stopped after the application may have left is never resumed from here: the
        // owner's tools and the submission guard own it (no second send).
        if (SUBMISSION_STATES.has(flow.state)
          && sendMayHaveLeft({ draft, submission: (await submissionRef.get()).data() || {} })) {
          report.sendMayHaveLeft++;
          report.orders.push({ order: doc.id.slice(0, 8), state: flow.state, skipped: 'send_may_have_left' });
          continue;
        }
        const plan = reviewQuestionPlan({ order, flow, draft });
        if (!plan) {
          // Nothing held or open: only the mirror of the platform's answers, without a model (step 4).
          const mirror = platformSuggestionUpdate({ order, flow, draft });
          if (!mirror.ids.length) continue;
          report.mirrored += mirror.ids.length;
          report.orders.push({ order: doc.id.slice(0, 8), state: flow.state, mirrored: mirror.ids });
          if (!apply) continue;
          const written = await db.runTransaction(async (transaction) => {
            const [orderNow, flowNow, draftNow, submissionNow] = await Promise.all([transaction.get(doc.ref), transaction.get(flowRef), transaction.get(draftRef), transaction.get(submissionRef)]);
            const freshFlow = flowNow.data() || {};
            const freshDraft = draftNow.data() || {};
            if (freshFlow.state !== flow.state || Number(freshFlow.round) !== Number(flow.round)
              || Number(freshDraft.round) !== Number(draft.round) || questionIdentity(freshDraft) !== questionIdentity(draft)) return false;
            if (mayHaveLeft(orderNow.data(), freshFlow, freshDraft, submissionNow.data())) return false;
            const fresh = platformSuggestionUpdate({ order: orderNow.data() || {}, flow: freshFlow, draft: freshDraft });
            if (!fresh.ids.length) return false;
            transaction.set(draftRef, { questions: fresh.questions }, { merge: true });
            transaction.set(doc.ref.collection('events').doc(), {
              type: 'review_questions_mirrored', actor: 'system', at: nowMs, version: version.slice(0, 16), mirrored: fresh.ids,
            });
            return true;
          });
          if (written) report.written++;
          continue;
        }
        report.withQuestions++;
        const key = reviewQuestionEpisodeKey({ version, flow, plan });
        const ledger = order.reviewQuestionRecovery || null;
        const entry = { order: doc.id.slice(0, 8), state: flow.state, held: plan.held, open: plan.open, targets: plan.targets, candidateOnly: plan.candidateOnly };
        let after = draft;
        let asked = [];
        if (plan.targets.length && !modelAttemptAllowed(ledger, key, nowMs)) {
          report.exhausted++;
          entry.model = 'exhausted';
        } else if (plan.targets.length && typeof codex !== 'function') {
          entry.model = 'not_asked';
        } else if (plan.targets.length) {
          const result = await answerTargets({ order, draft, plan, codex, log });
          after = { ...draft, questions: result.questions };
          asked = result.asked;
          entry.model = 'asked';
          entry.reasons = result.reasons;
        }
        const stillOpen = evaluateRedFlags(after, flow.answers || {}, flow.documents || {}, flow.questionAnswers || {}, flow, order).candidate;
        const answered = plan.targets.filter((id) => !stillOpen.includes(id));
        // The platform's answers mirrored on the questions, the model's new ones included (step 4).
        const mirror = platformSuggestionUpdate({ order, flow, draft: after });
        after = { ...after, questions: mirror.questions };
        const changed = [...new Set([...answered, ...mirror.ids])];
        const tick = transition(flow, { type: 'tick' }, { order, draft: after, answers: flow.answers || {}, documents: flow.documents || {}, nowMs });
        if (!isDeepStrictEqual(candidateAnswerState(flow), candidateAnswerState(tick.flow))) {
          throw new Error('candidate answers changed during review-question reconciliation');
        }
        const releases = releasesWait(flow, tick);
        Object.assign(entry, { answered, stillOpen, releases, heldAfter: releases ? tick.flow.heldBy : flow.heldBy, mirrored: mirror.ids });
        report.asked += asked.length;
        report.answered += answered.length;
        report.mirrored += mirror.ids.length;
        report.orders.push(entry);
        const queue = releases && ledger?.queuedKey !== key;
        if (!apply || (!asked.length && !queue && !mirror.ids.length)) {
          if (queue) report.queued++;
          continue;
        }
        const written = await db.runTransaction(async (transaction) => {
          const [orderNow, flowNow, draftNow, submissionNow] = await Promise.all([transaction.get(doc.ref), transaction.get(flowRef), transaction.get(draftRef), transaction.get(submissionRef)]);
          const freshOrder = orderNow.data() || {};
          const freshFlow = flowNow.data() || {};
          const freshDraft = draftNow.data() || {};
          // Sent, or on its way since the read: nothing is resumed.
          if (mayHaveLeft(freshOrder, freshFlow, freshDraft, submissionNow.data())) return false;
          // A new round, another state, other holds or edited questions since the read: the next run (or the
          // next draft) starts from them.
          if (freshFlow.state !== flow.state || Number(freshFlow.round) !== Number(flow.round) || !sameHolds(freshFlow, flow)
            || !isDeepStrictEqual(candidateAnswerState(freshFlow), candidateAnswerState(flow))
            || Number(freshDraft.round) !== Number(draft.round) || questionIdentity(freshDraft) !== questionIdentity(draft)) return false;
          const freshLedger = freshOrder.reviewQuestionRecovery || null;
          // Another run took this attempt already.
          if (asked.length && !modelAttemptAllowed(freshLedger, key, nowMs)) return false;
          if (changed.length) {
            transaction.set(draftRef, { questions: mergeAnswerFields(freshDraft.questions, after.questions, changed) }, { merge: true });
          }
          const sameEpisode = freshLedger?.key === key;
          const attempts = (sameEpisode ? Number(freshLedger.attempts) || 0 : 0) + (asked.length ? 1 : 0);
          const unanswered = plan.targets.some((id) => stillOpen.includes(id));
          transaction.set(doc.ref, {
            reviewQuestionRecovery: {
              key,
              version: version.slice(0, 16),
              attempts,
              ...(asked.length ? { lastAttemptAt: nowMs } : {}),
              nextAttemptAt: asked.length && unanswered && attempts < REVIEW_QUESTION_MAX_ATTEMPTS ? nowMs + REVIEW_QUESTION_RETRY_MS : null,
              ...(queue ? { queuedKey: key } : sameEpisode && freshLedger.queuedKey ? { queuedKey: freshLedger.queuedKey } : {}),
            },
            // The scheduled sweep runs the flow's tick: it rechecks the state, the posting and the holds.
            ...(queue ? { automationDueAt: nowMs } : {}),
          }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), {
            type: 'review_questions_reconciled', actor: 'system', at: nowMs, version: version.slice(0, 16),
            asked, answered, stillOpen, queued: queue, mirrored: mirror.ids,
          });
          return true;
        });
        if (written) {
          report.written++;
          if (queue) report.queued++;
        }
      }
      cursor = page.docs.at(-1);
      if (page.docs.length < 100) break;
    } while (cursor);
  }
  return report;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const orderPrefixes = [];
  let apply = false;
  let dryRun = false;
  let lane = process.env.CODEX_AUTH_BROKER_SOCKET ? 'broker' : 'none';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--order' && args[index + 1]) orderPrefixes.push(args[++index]);
    else if (arg === '--codex' && ['broker', 'local', 'none'].includes(args[index + 1])) lane = args[++index];
    else throw new Error('Usage: reconcile-review-questions.mjs [--dry-run | --apply] [--order <id prefix>]... [--codex broker|local|none]');
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run exclude each other');
  const codex = lane === 'broker'
    ? (await import('../lib/ai-models.mjs')).requestCodexBrokerJson
    : lane === 'local' ? (await import('./reconcile-cv-answers.mjs')).localCodexClient() : null;
  const report = await reconcileReviewQuestions({
    db: await getFirestoreDb(), codex, apply, orderPrefixes, log: (...parts) => console.error(...parts),
  });
  // The Actions log of this public repository carries the counts only; the dry run, an operator's, the ids too.
  const { orders, ...counts } = report;
  console.log(JSON.stringify(apply ? counts : report, null, 1));
}
