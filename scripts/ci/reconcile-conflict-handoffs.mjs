#!/usr/bin/env node
/**
 * reconcile-conflict-handoffs.mjs — chiude gli hand-off di conflitto il cui
 * lavoro e' gia' fatto (zero-Claude).
 *
 * `pr-autorebase.mjs` apre «Conflitto con main[ dopo LGTM]: riapplicare la PR
 * #N su main» e la affida a issue-fix. L'unica via di chiusura era il `Closes`
 * della PR di riapplicazione. Quando invece il conflitto rientra sul branch
 * originale e #N mergia, nessuno la chiudeva: il pre-flight di issue-fix
 * toglieva `agent:fix` e «non chiudo», il drainer gira con
 * `FOLLOWUP_NO_AUTOCLOSE=1`, il bridge del fixer non puo' chiudere issue.
 * Misurato il 2026-10-01: 5 hand-off aperti su 8 avevano la PR di origine gia'
 * mergiata (#10383 #10385 #10444 #10536 #10657), piu' un duplicato nato da due
 * run concorrenti di pr-autorebase (#10587 di #10586). Il pre-flight ora chiude
 * da se' (`closeResolvedHandoff`), ma gira solo quando issue-fix parte: questo
 * sweep copre gli hand-off che nessuno rilancia.
 *
 * Ogni tick (followup-drainer.yml, prima del drain) per ogni hand-off aperto:
 *   1. duplicati della stessa PR di origine → resta quella con un claim o una
 *      PR in volo, altrimenti la piu' vecchia; le altre chiuse `duplicate`;
 *   2. una PR mergiata dichiara `Closes #<issue>` o `Supersedes #N` → chiusa
 *      `completed` (riapplicazione mergiata, keyword non eseguita da GitHub);
 *   3. la PR di origine e' MERGED → chiusa `completed`;
 *   4. la PR di origine e' OPEN, il conflitto e' rientrato (`handoffResolution`,
 *      la stessa regola del pre-flight) e nessuna PR la sta riapplicando →
 *      chiusa `completed`;
 *   altrimenti resta aperta: c'e' ancora un contributo da riapplicare.
 * Solo segnali deterministici: stato GitHub della PR, label `has-conflicts`
 * scritta da merge-tree, keyword di una PR mergiata. Mai un match di contenuto.
 * Un hand-off con `agent:in-progress` non si tocca (il fixer ci sta lavorando:
 * decide il tick dopo). Qualunque lettura fallita → la issue resta com'e'.
 *
 * Uso:  node scripts/ci/reconcile-conflict-handoffs.mjs
 * Env:  GH_TOKEN (issues: write, pull-requests: read), GH_REPO o
 *       GITHUB_REPOSITORY, DRY_RUN=1 (solo log), CI_JOB_DEADLINE_EPOCH.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conflictHandoffExpectedHead,
  conflictHandoffOriginPr,
  handoffResolution,
} from './check-issue-already-resolved.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';
import { CLAIM_LABEL } from './stale-claim-detector.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

export const RECONCILE_MARKER = '<!-- CONFLICT_HANDOFF_RECONCILE -->';
// Bound per run (AGENTS.md no-silent-cap: le eccedenze sono loggate e restano
// al tick successivo, 20 minuti dopo).
export const MAX_CLOSES_PER_RUN = 20;
// Le PR mergiate lette per riconoscere una riapplicazione. Un hand-off vive
// ore, non settimane: una riapplicazione piu' vecchia di questa finestra ha
// gia' chiuso la sua issue con il `Closes` di GitHub.
export const MERGED_PR_WINDOW = 200;

function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function ghJson(args) {
  const raw = gh(args);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const numberRef = (n) => `#${Number(n)}(?!\\d)`;

/** Una PR (body) dichiara di chiudere la issue? Una keyword per issue, come GitHub. Pura. */
export function declaresClosing(body, issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${numberRef(issueNumber)}`, 'i')
    .test(String(body || ''));
}

/** Una PR (body) dichiara di sostituire la PR di origine? Pura. */
export function declaresSupersede(body, originNumber) {
  return new RegExp(`\\bsupersedes\\s+${numberRef(originNumber)}`, 'i').test(String(body || ''));
}

/**
 * La PR aperta che sta riapplicando l'hand-off, se c'e': il branch del fixer
 * (`fix/issue-<issue>`) o una keyword verso la issue o la PR di origine. La PR
 * di origine stessa non conta. Pura.
 */
export function reapplyInFlight(openPrs, { issueNumber, originNumber }) {
  return (openPrs || []).find((pr) => Number(pr?.number) !== Number(originNumber) && (
    new RegExp(`(^|/)issue-${Number(issueNumber)}$`).test(String(pr?.headRefName || ''))
    || declaresClosing(pr?.body, issueNumber)
    || declaresSupersede(pr?.body, originNumber)
  )) || null;
}

const labelNames = (issue) => (issue?.labels || [])
  .map((label) => (typeof label === 'string' ? label : label?.name))
  .filter(Boolean);

/** L'hand-off ha lavoro avviato: un claim del fixer o una PR che lo riapplica. Pura. */
export function handoffBusy(issue, originNumber, openPrs) {
  return labelNames(issue).includes(CLAIM_LABEL)
    || reapplyInFlight(openPrs, { issueNumber: issue?.number, originNumber }) !== null;
}

/**
 * Raggruppa gli hand-off aperti per PR di origine ed elegge chi resta: prima
 * chi ha lavoro avviato (`handoffBusy`), poi il numero piu' basso. Gli altri
 * sono duplicati. Pura.
 *
 * @returns {Array<{ origin: number, keeper: object, duplicates: object[] }>}
 */
export function groupHandoffs(issues, openPrs = []) {
  const groups = new Map();
  for (const issue of issues || []) {
    const origin = conflictHandoffOriginPr(issue?.title);
    if (origin === null) continue;
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin).push(issue);
  }
  return [...groups.entries()].map(([origin, members]) => {
    const sorted = [...members].sort((a, b) => Number(a.number) - Number(b.number));
    const keeper = sorted.find((issue) => handoffBusy(issue, origin, openPrs)) || sorted[0];
    return { origin, keeper, duplicates: sorted.filter((issue) => issue !== keeper) };
  });
}

/**
 * Decisione su un hand-off (il keeper del suo gruppo). Pura: tutto l'input e'
 * gia' letto.
 *
 * @param {object} p
 * @param {{number:number, title:string, body:string, labels:any[]}} p.issue
 * @param {object|null} p.origin  `gh pr view --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,labels`
 * @param {Array<{number:number, body:string}>|null} p.mergedPrs
 * @param {Array<{number:number, headRefName:string, body:string}>|null} p.openPrs
 * @returns {{ action: 'close'|'keep', reason: string, pr?: number }}
 */
export function decideHandoff({ issue, origin, mergedPrs, openPrs }) {
  const originNumber = conflictHandoffOriginPr(issue?.title);
  if (originNumber === null) return { action: 'keep', reason: 'not-a-handoff' };
  if (labelNames(issue).includes(CLAIM_LABEL)) return { action: 'keep', reason: 'claim-active' };

  if (Array.isArray(mergedPrs)) {
    const replacement = mergedPrs.find((pr) => Number(pr?.number) !== originNumber && (
      declaresClosing(pr?.body, issue.number) || declaresSupersede(pr?.body, originNumber)
    ));
    if (replacement) return { action: 'close', reason: 'reapplied', pr: Number(replacement.number) };
  }

  const state = String(origin?.state || '').toUpperCase();
  if (!state) return { action: 'keep', reason: 'origin-unreadable' };
  if (state === 'MERGED') return { action: 'close', reason: 'origin-merged', pr: originNumber };
  if (state !== 'OPEN') return { action: 'keep', reason: `origin-${state.toLowerCase()}` };

  // Una PR aperta lo sta gia' riapplicando: chi mergia per primo decide, e una
  // lista illeggibile vale «forse in volo».
  if (!Array.isArray(openPrs)) return { action: 'keep', reason: 'open-prs-unreadable' };
  const inFlight = reapplyInFlight(openPrs, { issueNumber: issue.number, originNumber });
  if (inFlight) return { action: 'keep', reason: 'reapply-in-flight', pr: Number(inFlight.number) };

  const verdict = handoffResolution(origin, { expectedHead: conflictHandoffExpectedHead(issue.body) });
  if (verdict.resolved) return { action: 'close', reason: verdict.reason, pr: originNumber };
  return { action: 'keep', reason: verdict.reason };
}

/** Testo del commento di chiusura. Puro. */
export function closingComment({ reason, pr, originNumber, keeper }) {
  const why = {
    duplicate: `è un duplicato di #${keeper}: stesso hand-off della PR #${originNumber}, aperto da una seconda run concorrente di \`pr-autorebase\`. Il lavoro prosegue su #${keeper}.`,
    reapplied: `la PR **#${pr}**, già mergiata, riapplica la PR #${originNumber} (\`Closes\`/\`Supersedes\`), ma GitHub non ha chiuso questa issue.`,
    'origin-merged': `la PR di origine **#${originNumber}** è stata mergiata: il conflitto è stato risolto sul suo branch e il contributo è su \`main\`. Una riapplicazione sarebbe un duplicato.`,
    'conflict-resolved': `la PR di origine **#${originNumber}** è di nuovo mergeable sulla stessa HEAD: il conflitto è rientrato e la PR prosegue nel proprio ciclo di review e merge.`,
    'conflict-resolved-new-head': `la PR di origine **#${originNumber}** ha una HEAD nuova, mergeable e senza \`has-conflicts\` (merge-tree pulito): il conflitto è stato risolto sul suo branch, che prosegue nel proprio ciclo di review e merge.`,
  }[reason];
  return [
    RECONCILE_MARKER,
    `✅ **Hand-off riconciliato (zero-Claude)**: ${why || reason}`,
    '',
    reason === 'duplicate'
      ? 'Chiusa come **duplicate**.'
      : 'Chiusa come **completed**: non resta nessun contributo da riapplicare. Se la PR di origine torna in conflitto su una HEAD nuova, `pr-autorebase` apre un hand-off nuovo.',
    '',
    '_Segnale deterministico da `scripts/ci/reconcile-conflict-handoffs.mjs` (followup-drainer)._',
  ].join('\n');
}

// --- I/O --------------------------------------------------------------------

function listOpenHandoffs() {
  // Elenco REST (consistente), non la search API: una issue appena creata deve
  // comparire, altrimenti un duplicato sfugge al raggruppamento.
  const raw = gh(['api', '--paginate', `repos/${REPO}/issues?state=open&per_page=100`, '--jq',
    '.[] | select(.pull_request == null) | select(.title | startswith("Conflitto con main")) '
    + '| {number, title, body, created_at, labels: [.labels[].name]}']);
  if (raw === null) return null;
  const issues = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      issues.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return issues.filter((issue) => conflictHandoffOriginPr(issue.title) !== null);
}

function readOrigin(num) {
  return ghJson(['pr', 'view', String(num), '--repo', REPO,
    '--json', 'state,mergedAt,mergeable,mergeStateStatus,headRefOid,labels']);
}

function closeIssue(number, { reason, comment }) {
  if (gh(['issue', 'comment', String(number), '--repo', REPO, '--body', comment]) === null) return false;
  if (reason === 'duplicate') {
    if (gh(['api', '-X', 'PATCH', `repos/${REPO}/issues/${number}`,
      '-f', 'state=closed', '-f', 'state_reason=duplicate']) !== null) return true;
    return gh(['issue', 'close', String(number), '--repo', REPO, '--reason', 'not planned']) !== null;
  }
  return gh(['issue', 'close', String(number), '--repo', REPO, '--reason', 'completed']) !== null;
}

function main() {
  if (!REPO) {
    console.log('::warning::GH_REPO/GITHUB_REPOSITORY assente → nessuna riconciliazione.');
    return;
  }
  const issues = listOpenHandoffs();
  if (issues === null) {
    console.log('::warning::elenco degli hand-off illeggibile → nessuna riconciliazione in questo tick.');
    return;
  }
  if (issues.length === 0) {
    console.log('Nessun hand-off di conflitto aperto.');
    return;
  }
  const openPrs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '300',
    '--json', 'number,headRefName,body']);
  const mergedPrs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'merged',
    '--limit', String(MERGED_PR_WINDOW), '--json', 'number,body']);

  const budget = runBudgetFromEnv();
  const actions = [];
  for (const { origin, keeper, duplicates } of groupHandoffs(issues, openPrs || [])) {
    for (const dup of duplicates) {
      // Lavoro avviato anche sul duplicato (due run parallele): nessuno dei
      // due si butta, decide il tick dopo, a run finite.
      if (openPrs === null || handoffBusy(dup, origin, openPrs)) {
        console.log(`#${dup.number} duplicato di #${keeper.number} ma con lavoro avviato (o PR aperte illeggibili) → al prossimo tick.`);
        continue;
      }
      actions.push({ issue: dup, reason: 'duplicate', originNumber: origin, keeper: keeper.number });
    }
    if (!budget.take(`#${keeper.number}`, 2_000)) continue;
    const decision = decideHandoff({ issue: keeper, origin: readOrigin(origin), mergedPrs, openPrs });
    console.log(`#${keeper.number} (PR di origine #${origin}): ${decision.action} — ${decision.reason}${decision.pr ? ` (#${decision.pr})` : ''}`);
    if (decision.action === 'close') {
      actions.push({ issue: keeper, reason: decision.reason, pr: decision.pr, originNumber: origin });
    }
  }

  const closed = [];
  for (const [index, action] of actions.entries()) {
    if (index >= MAX_CLOSES_PER_RUN) {
      console.log(`::warning::cap raggiunto (${MAX_CLOSES_PER_RUN}/run): ${actions.length - index} hand-off risolti restano aperti fino al prossimo tick.`);
      break;
    }
    const comment = closingComment(action);
    if (DRY_RUN) {
      console.log(`[dry] chiuderei #${action.issue.number} (${action.reason})`);
      continue;
    }
    if (closeIssue(action.issue.number, { reason: action.reason, comment })) {
      closed.push(action);
      console.log(`#${action.issue.number} chiusa (${action.reason}).`);
    } else {
      console.log(`::warning::#${action.issue.number}: chiusura fallita (${action.reason}) → ritento al prossimo tick.`);
    }
  }
  budget.report();

  const summary = `Hand-off di conflitto: ${issues.length} aperti, ${closed.length} chiusi${DRY_RUN ? ' (dry-run)' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = closed.map((a) => `- #${a.issue.number} → ${a.reason}${a.pr ? ` (#${a.pr})` : ''}`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n${lines.join('\n')}\n`);
  }
}

// Best-effort: un errore non deve mai far fallire il drain che segue.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`::warning::reconcile-conflict-handoffs: ${error?.message || error} → nessuna modifica ulteriore.`);
  }
}
