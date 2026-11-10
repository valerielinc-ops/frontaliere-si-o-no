#!/usr/bin/env node
/**
 * Backfill of the CV answers (owner decisions of 2026-11-10, functions/src/assistedApplicationCvAnswers.js)
 * on the orders whose draft was written before them: the required open text questions still waiting for
 * the candidate get the CV's answer, when the CV gives one that passes the checks, and a wait that no
 * longer holds is released through the normal clock (as reconcile-operational-answers.mjs does).
 *
 * It needs a model, unlike reconcile-operational-answers.mjs: not run by the deploy.
 *   node scripts/assisted-application/reconcile-cv-answers.mjs [--dry-run | --apply] [--order <id prefix>]... [--codex broker|local]
 * --dry-run (the default) writes nothing and prints, per order, the question ids asked, kept and still
 * open, with the reasons of a drop: never an answer's text.
 * --codex local runs the local `codex exec` (an operator's machine); broker (default when
 * CODEX_AUTH_BROKER_SOCKET is set) the job's broker.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { evaluateRedFlags, transition } from '../../functions/src/assistedApplicationFlow.js';
import { candidateWithEdits } from '../../functions/src/assistedApplicationCandidateEdits.js';
import { CV_ANSWERS_VERSION } from '../../functions/src/assistedApplicationCvAnswers.js';
import { cvAnswerable, draftCvAnswers } from './lib/cv-answers.mjs';
import { releasesWait } from './reconcile-operational-answers.mjs';

const WAITING_STATES = ['needs_candidate_action', 'candidate_review'];
const ANSWER_FIELDS = ['suggestedAnswer', 'answerEvidence', 'answerKind', 'answerMissingDetail'];

/** The required open questions the CV may answer and no earlier run answered. */
export function cvAnswerTargets({ order, flow, draft }) {
  const flags = evaluateRedFlags(draft, flow?.answers || {}, flow?.documents || {}, flow?.questionAnswers || {}, flow, order);
  const { answers, platformFacts } = candidateWithEdits({ order, draft, flow });
  const byId = new Map((draft?.questions || []).map((question) => [question.id, question]));
  return flags.candidate.filter((id) => {
    const question = byId.get(id);
    return question && !String(question.suggestedAnswer || '').trim() && cvAnswerable(question, { answers, facts: platformFacts });
  });
}

/** The draft's questions with the new answer fields of the targets only. */
function mergeAnswers(questions, updated, targets) {
  const byId = new Map(updated.map((question) => [question.id, question]));
  return questions.map((question) => {
    if (!targets.includes(question.id)) return question;
    const next = byId.get(question.id) || {};
    const fields = Object.fromEntries(ANSWER_FIELDS.filter((field) => Object.hasOwn(next, field)).map((field) => [field, next[field]]));
    return { ...question, ...fields };
  });
}

export async function reconcileCvAnswers({ db, codex, apply = false, nowMs = Date.now(), orderPrefixes = [], log = () => {} }) {
  const report = { scanned: 0, withTargets: 0, asked: 0, kept: 0, released: 0, written: 0, orders: [] };
  for (const state of WAITING_STATES) {
    let cursor;
    do {
      let query = db.collection('assisted_applications').where('automationState', '==', state).orderBy('__name__').limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.docs.length) break;
      for (const doc of page.docs) {
        if (orderPrefixes.length && !orderPrefixes.some((prefix) => doc.id.startsWith(prefix))) continue;
        report.scanned++;
        const order = doc.data();
        if (order.paymentStatus !== 'paid' || order.refundStatus === 'pending') continue;
        const flowRef = doc.ref.collection('automation').doc('flow');
        const draftRef = doc.ref.collection('ai_drafts').doc('current');
        const [flowDoc, draftDoc] = await Promise.all([flowRef.get(), draftRef.get()]);
        const flow = flowDoc.data() || {};
        const draft = draftDoc.data() || {};
        if (Number(draft.round) !== (Number(flow.round) || 1)) continue;
        const targets = cvAnswerTargets({ order, flow, draft });
        if (!targets.length) continue;
        report.withTargets++;
        const { answers, platformFacts } = candidateWithEdits({ order, draft, flow });
        const result = await draftCvAnswers({
          questions: draft.questions, answers, facts: platformFacts, cvText: draft?.factSources?.text,
          codex, locale: order.locale || 'it', log, onlyIds: targets,
        });
        const questions = mergeAnswers(draft.questions || [], result.questions, result.kept);
        const after = { ...draft, questions };
        const stillOpen = evaluateRedFlags(after, flow.answers || {}, flow.documents || {}, flow.questionAnswers || {}, flow, order).candidate;
        const tick = transition(flow, { type: 'tick' }, { order, draft: after, answers: flow.answers || {}, documents: flow.documents || {}, nowMs });
        const releases = releasesWait(flow, tick);
        report.asked += result.asked.length;
        report.kept += result.kept.length;
        if (releases) report.released++;
        report.orders.push({
          order: doc.id.slice(0, 8), state, targets, kept: result.kept,
          decisions: result.decisions.map(({ id, modelKind, kept, reasons }) => ({ id, modelKind, kept, reasons })),
          stillOpen, releases,
        });
        if (!apply || !result.kept.length) continue;
        const written = await db.runTransaction(async (transaction) => {
          const [currentDraft, currentFlow] = await Promise.all([transaction.get(draftRef), transaction.get(flowRef)]);
          const fresh = currentDraft.data() || {};
          // A new round or edited questions since the read: the next draft answers them itself.
          if (Number(fresh.round) !== Number(draft.round) || Number(currentFlow.data()?.round) !== Number(flow.round)
            || JSON.stringify((fresh.questions || []).map((question) => [question.id, question.question, question.applicationQuestion]))
              !== JSON.stringify((draft.questions || []).map((question) => [question.id, question.question, question.applicationQuestion]))) return false;
          transaction.set(draftRef, { questions: mergeAnswers(fresh.questions || [], result.questions, result.kept), cvAnswersVersion: CV_ANSWERS_VERSION }, { merge: true });
          // The scheduled sweep rechecks the posting and the state machine before anything is sent.
          if (releases) transaction.set(doc.ref, { automationDueAt: nowMs, cvAnswersReconciledVersion: CV_ANSWERS_VERSION }, { merge: true });
          return true;
        });
        if (written) report.written++;
      }
      cursor = page.docs.at(-1);
      if (page.docs.length < 100) break;
    } while (cursor);
  }
  return report;
}

/** The local Codex CLI with the request's schema, for an operator's run. */
export function localCodexClient({ bin = 'codex', run = runProcess } = {}) {
  return async ({ prompt, schema, timeoutMs }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cv-answers-'));
    try {
      const schemaFile = path.join(dir, 'schema.json');
      const outFile = path.join(dir, 'out.json');
      await writeFile(schemaFile, JSON.stringify(schema));
      await run(bin, ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--output-schema', schemaFile, '-o', outFile, '-'], { input: prompt, timeoutMs, cwd: dir });
      return JSON.parse(await readFile(outFile, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function runProcess(bin, args, { input, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('codex_timeout')); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`codex_exit_${code}`)); });
    child.stdin.end(input);
  });
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const orderPrefixes = [];
  let apply = false;
  let dryRun = false;
  let lane = process.env.CODEX_AUTH_BROKER_SOCKET ? 'broker' : 'local';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--order' && args[index + 1]) orderPrefixes.push(args[++index]);
    else if (arg === '--codex' && ['broker', 'local'].includes(args[index + 1])) lane = args[++index];
    else throw new Error('Usage: reconcile-cv-answers.mjs [--dry-run | --apply] [--order <id prefix>]... [--codex broker|local]');
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run exclude each other');
  const codex = lane === 'broker'
    ? (await import('../lib/ai-models.mjs')).requestCodexBrokerJson
    : localCodexClient();
  const db = await getFirestoreDb();
  const report = await reconcileCvAnswers({ db, codex, apply, orderPrefixes, log: (...parts) => console.error(...parts) });
  console.log(JSON.stringify({ apply, ...report }, null, 1));
}
