#!/usr/bin/env node
/**
 * Post-step di `issue-fix.yml` (#9742): instrada verso la verifica una issue su
 * cui il fixer ha concluso `FIX_OUTCOME: already-fixed` CON evidenza
 * strutturata, invece di lasciarla con `agent:fix` a essere ripresa.
 *
 * Il difetto: il pre-flight deterministico (`check-issue-already-resolved.mjs`)
 * toglie gia' `agent:fix` quando e' LUI a trovare la issue risolta, ma quando lo
 * stesso verdetto arriva dall'agente (dopo la diagnosi) nessuno step lo leggeva:
 * la issue restava `agent:fix` e il ciclo rispendeva una run intera per arrivare
 * alla stessa conclusione (#8061: run 36030725501 `already-fixed`, poi un secondo
 * lavoro locale; #9578: `already-fixed` alle 17:26Z e issue ancora aperta).
 *
 * Contratto (fail-closed in ogni ramo: nel dubbio NON si muta niente, cioe' il
 * comportamento di prima):
 *   1. L'ULTIMO commento `FIX_OUTCOME` postato da QUESTA run (createdAt >=
 *      runStartedAt del baseline delivery) dice `already-fixed`, l'ha scritto un
 *      autore fidato e la delivery della run e' `verified-none` (nessuna PR).
 *   2. Lo stesso commento porta `<!-- FIX_EVIDENCE: pr=<N> commit=<sha> run=<id> -->`
 *      con `run` obbligatorio e almeno uno fra `pr` e `commit`.
 *   3. L'evidenza si verifica via API: PR `MERGED` su `main`; commit della fix
 *      raggiungibile da `main`; run `completed/success` su `main`, diversa da
 *      questa run e da un'altra run del fixer, il cui HEAD contiene la fix.
 *   4. Solo allora: aggiunge `maybe-resolved` (la label di verifica gia' usata da
 *      reconcile-followups/check-issue-already-resolved), toglie `agent:fix` e
 *      `agent:fix-queued` se presenti, posta il marker
 *      `<!-- ALREADY_FIXED_ROUTED: ... -->` con l'evidenza verificata.
 *      MAI chiude la issue: la chiusura resta a chi verifica.
 *
 * Evidenza assente, malformata o non verificabile → nessuna mutazione, log del
 * motivo, exit 0.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERIFY_LABEL = 'maybe-resolved';
export const ROUTING_LABELS = Object.freeze(['agent:fix', 'agent:fix-queued']);
export const ROUTED_MARKER = 'ALREADY_FIXED_ROUTED';
const FIXER_WORKFLOW_PATH = '.github/workflows/issue-fix.yml';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_LOGINS = new Set([
  'frontaliere-automation',
  'frontaliere-automation[bot]',
  'github-actions',
  'github-actions[bot]',
  'claude',
  'claude[bot]',
]);

const OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/giu;
const EVIDENCE_RE = /<!--\s*FIX_EVIDENCE:([^>]*?)-->/gu;

/**
 * Ultimo codice `FIX_OUTCOME` presente nel body, o null.
 * @param {string} body
 */
export function outcomeOf(body) {
  let last = null;
  for (const m of String(body ?? '').matchAll(OUTCOME_RE)) last = m[1].toLowerCase();
  return last;
}

/**
 * Parser del marker `<!-- FIX_EVIDENCE: pr=<N> commit=<sha> run=<id> -->`.
 * Stretto per costruzione: chiavi ignote, duplicate o valori malformati
 * rendono l'evidenza non valida (mai "meta' evidenza").
 * @param {string} body
 * @returns {{status: 'missing'} | {status: 'malformed', reason: string} |
 *   {status: 'ok', evidence: {pr: number|null, commit: string|null, run: number}}}
 */
export function parseFixEvidence(body) {
  const markers = [...String(body ?? '').matchAll(EVIDENCE_RE)];
  if (markers.length === 0) return { status: 'missing' };
  if (markers.length > 1) return { status: 'malformed', reason: 'piu-marker-FIX_EVIDENCE' };
  const tokens = markers[0][1].trim().split(/\s+/u).filter(Boolean);
  const seen = new Map();
  for (const token of tokens) {
    const m = /^([a-z]+)=(.+)$/u.exec(token);
    if (!m) return { status: 'malformed', reason: `token-non-chiave-valore:${token}` };
    const [, key, value] = m;
    if (seen.has(key)) return { status: 'malformed', reason: `chiave-duplicata:${key}` };
    seen.set(key, value);
  }
  const evidence = { pr: null, commit: null, run: null };
  for (const [key, value] of seen) {
    if (key === 'pr') {
      const n = /^#?([1-9][0-9]{0,9})$/u.exec(value);
      if (!n) return { status: 'malformed', reason: `pr-invalida:${value}` };
      evidence.pr = Number(n[1]);
    } else if (key === 'commit') {
      if (!/^[0-9a-f]{7,40}$/u.test(value)) return { status: 'malformed', reason: `commit-invalido:${value}` };
      evidence.commit = value;
    } else if (key === 'run') {
      if (!/^[1-9][0-9]{0,15}$/u.test(value)) return { status: 'malformed', reason: `run-invalida:${value}` };
      evidence.run = Number(value);
    } else {
      return { status: 'malformed', reason: `chiave-ignota:${key}` };
    }
  }
  if (evidence.run === null) return { status: 'malformed', reason: 'run-mancante' };
  if (evidence.pr === null && evidence.commit === null) return { status: 'malformed', reason: 'pr-o-commit-mancante' };
  return { status: 'ok', evidence };
}

function isTrustedAuthor(comment) {
  const login = comment?.author?.login;
  if (typeof login === 'string' && TRUSTED_LOGINS.has(login)) return true;
  return TRUSTED_ASSOCIATIONS.has(String(comment?.authorAssociation ?? ''));
}

/**
 * Decisione pura dal solo stato gia' letto. Nessuna I/O.
 * @param {{comments: Array<{body?: string, createdAt?: string, author?: {login?: string}, authorAssociation?: string}>,
 *   runStartedAt: string|null, deliveryStatus: string|null, isGroup?: boolean}} input
 * @returns {{action: 'verify', evidence: {pr: number|null, commit: string|null, run: number}} |
 *   {action: 'none', reason: string}}
 */
export function decideAlreadyFixedRouting({ comments, runStartedAt, deliveryStatus, isGroup = false }) {
  if (isGroup) return { action: 'none', reason: 'gruppo-B19: instradamento solo per issue singole' };
  if (deliveryStatus !== 'verified-none') {
    return { action: 'none', reason: `delivery=${deliveryStatus ?? 'unavailable'}: serve verified-none` };
  }
  if (typeof runStartedAt !== 'string' || !runStartedAt) return { action: 'none', reason: 'runStartedAt-non-verificabile' };
  if (!Array.isArray(comments)) return { action: 'none', reason: 'commenti-non-leggibili' };
  const current = comments
    .filter((c) => typeof c?.createdAt === 'string' && c.createdAt >= runStartedAt && outcomeOf(c.body) !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const last = current.at(-1);
  if (!last) return { action: 'none', reason: 'nessun-FIX_OUTCOME-in-questa-run' };
  const outcome = outcomeOf(last.body);
  if (outcome !== 'already-fixed') return { action: 'none', reason: `outcome=${outcome}` };
  if (!isTrustedAuthor(last)) return { action: 'none', reason: `autore-non-fidato:${last?.author?.login ?? '?'}` };
  const parsed = parseFixEvidence(last.body);
  if (parsed.status === 'missing') return { action: 'none', reason: 'evidenza-strutturata-assente' };
  if (parsed.status === 'malformed') return { action: 'none', reason: `evidenza-malformata:${parsed.reason}` };
  return { action: 'verify', evidence: parsed.evidence };
}

const CONTAINS = new Set(['ahead', 'identical']);

/**
 * Verifica l'evidenza con lookup iniettati (ognuno puo' lanciare: e' `unavailable`).
 * @param {{pr: number|null, commit: string|null, run: number}} evidence
 * @param {{ pr: (n: number) => any, run: (id: number) => any, compare: (base: string, head: string) => string,
 *   defaultBranch?: string, currentRunId?: number|null }} deps
 * @returns {{ok: true, fixSha: string, runHeadSha: string} | {ok: false, reason: string}}
 */
export function verifyEvidence(evidence, deps) {
  const defaultBranch = deps.defaultBranch || 'main';
  const guard = (label, fn) => {
    try { return { value: fn() }; } catch (e) { return { error: `${label}-non-disponibile:${String(e?.message ?? e).slice(0, 80)}` }; }
  };
  if (deps.currentRunId && Number(deps.currentRunId) === evidence.run) {
    return { ok: false, reason: 'run-citata-e-questa-run' };
  }
  let fixSha = evidence.commit;
  if (evidence.pr !== null) {
    const r = guard('pr', () => deps.pr(evidence.pr));
    if (r.error) return { ok: false, reason: r.error };
    const pr = r.value;
    if (pr?.state !== 'MERGED') return { ok: false, reason: `pr-#${evidence.pr}-non-mergiata:${pr?.state}` };
    if (pr?.baseRefName !== defaultBranch) return { ok: false, reason: `pr-#${evidence.pr}-base=${pr?.baseRefName}` };
    const oid = pr?.mergeCommit?.oid;
    if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/u.test(oid)) return { ok: false, reason: `pr-#${evidence.pr}-senza-merge-commit` };
    if (!fixSha) fixSha = oid;
  }
  const onMain = guard('compare-main', () => deps.compare(fixSha, defaultBranch));
  if (onMain.error) return { ok: false, reason: onMain.error };
  if (!CONTAINS.has(onMain.value)) return { ok: false, reason: `fix-${fixSha}-non-su-${defaultBranch}:${onMain.value}` };

  const rr = guard('run', () => deps.run(evidence.run));
  if (rr.error) return { ok: false, reason: rr.error };
  const run = rr.value;
  if (run?.status !== 'completed' || run?.conclusion !== 'success') {
    return { ok: false, reason: `run-${evidence.run}-non-verde:${run?.status}/${run?.conclusion}` };
  }
  if (run?.head_branch !== defaultBranch) return { ok: false, reason: `run-${evidence.run}-branch=${run?.head_branch}` };
  if (String(run?.path ?? '').split('@')[0] === FIXER_WORKFLOW_PATH) {
    return { ok: false, reason: `run-${evidence.run}-e-una-run-del-fixer` };
  }
  const runHeadSha = run?.head_sha;
  if (typeof runHeadSha !== 'string' || !/^[0-9a-f]{40}$/u.test(runHeadSha)) return { ok: false, reason: `run-${evidence.run}-senza-head-sha` };
  const covers = guard('compare-run', () => deps.compare(fixSha, runHeadSha));
  if (covers.error) return { ok: false, reason: covers.error };
  if (!CONTAINS.has(covers.value)) return { ok: false, reason: `run-${evidence.run}-non-contiene-la-fix:${covers.value}` };
  return { ok: true, fixSha, runHeadSha };
}

/**
 * Argomenti di `gh issue edit` per l'instradamento: aggiunge la label di
 * verifica e toglie solo le label di routing effettivamente presenti.
 * @param {string[]} labels
 */
export function routingEditArgs(labels) {
  const present = new Set(labels);
  const args = ['--add-label', VERIFY_LABEL];
  for (const label of ROUTING_LABELS) if (present.has(label)) args.push('--remove-label', label);
  return args;
}

export function routedCommentBody(evidence, verified) {
  const parts = [
    evidence.pr !== null ? `pr=${evidence.pr}` : null,
    `commit=${verified.fixSha}`,
    `run=${evidence.run}`,
  ].filter(Boolean).join(' ');
  return [
    `<!-- ${ROUTED_MARKER}: ${parts} -->`,
    '🔎 **Instradata in verifica (zero-Claude, #9742)**: il fixer ha concluso `already-fixed` con evidenza strutturata, e il post-step l\'ha verificata:',
    '',
    evidence.pr !== null ? `- PR #${evidence.pr} MERGED su \`main\`.` : null,
    `- Fix \`${verified.fixSha.slice(0, 12)}\` raggiungibile da \`main\`.`,
    `- Run ${evidence.run} \`success\` su \`main\`, con HEAD \`${verified.runHeadSha.slice(0, 12)}\` che contiene la fix.`,
    '',
    `Tolto il routing \`agent:fix*\` (niente nuova run del fixer) e applicata \`${VERIFY_LABEL}\`. **Non chiudo** la issue: la chiusura resta a chi verifica il mapping. Se il difetto c'e' ancora, togli \`${VERIFY_LABEL}\` e ri-aggiungi \`agent:fix\`.`,
  ].filter((line) => line !== null).join('\n');
}

// ---------------------------------------------------------------------------
// CLI

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readJson(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function setOutput(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  const repo = process.env.REPO || process.env.GH_REPO;
  const issue = process.env.ISSUE || process.env.ISSUE_NUMBER;
  if (!repo || !/^[1-9][0-9]*$/u.test(String(issue ?? ''))) {
    setOutput('routed', 'false');
    console.log('route-already-fixed: REPO/ISSUE non validi — nessuna mutazione.');
    return;
  }
  const baseline = readJson(process.env.PR_DELIVERY_BASELINE_FILE);
  const delivery = readJson(process.env.PR_DELIVERY_EVIDENCE_FILE);
  let view;
  try {
    view = JSON.parse(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'comments,labels,state']));
  } catch (e) {
    setOutput('routed', 'false');
    console.log(`::warning::route-already-fixed: lettura issue non disponibile (${String(e?.message ?? e).slice(0, 120)}) — nessuna mutazione.`);
    return;
  }
  const decision = decideAlreadyFixedRouting({
    comments: view?.comments,
    runStartedAt: typeof baseline?.runStartedAt === 'string' ? baseline.runStartedAt : null,
    deliveryStatus: typeof delivery?.status === 'string' ? delivery.status : null,
    isGroup: process.env.IS_GROUP === 'true',
  });
  if (decision.action !== 'verify') {
    setOutput('routed', 'false');
    console.log(`route-already-fixed: nessun instradamento (${decision.reason}).`);
    return;
  }
  if (view?.state !== 'OPEN') {
    setOutput('routed', 'false');
    console.log(`route-already-fixed: issue non aperta (${view?.state}) — nessuna mutazione.`);
    return;
  }
  const verified = verifyEvidence(decision.evidence, {
    defaultBranch: process.env.DEFAULT_BRANCH || 'main',
    currentRunId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    pr: (n) => JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', 'state,baseRefName,mergeCommit'])),
    run: (id) => JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '{status,conclusion,head_branch,head_sha,path}'])),
    compare: (base, head) => gh(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.status']).trim(),
  });
  if (!verified.ok) {
    setOutput('routed', 'false');
    console.log(`route-already-fixed: evidenza non verificata (${verified.reason}) — nessuna mutazione, agent:fix resta.`);
    return;
  }
  const labels = Array.isArray(view?.labels) ? view.labels.map((l) => l?.name).filter(Boolean) : [];
  try {
    gh(['issue', 'edit', String(issue), '--repo', repo, ...routingEditArgs(labels)]);
  } catch (e) {
    setOutput('routed', 'false');
    console.log(`::warning::route-already-fixed: edit label fallito (${String(e?.message ?? e).slice(0, 120)}).`);
    return;
  }
  setOutput('routed', 'true');
  try {
    gh(['issue', 'comment', String(issue), '--repo', repo, '--body', routedCommentBody(decision.evidence, verified)]);
  } catch {
    console.log('::warning::route-already-fixed: label applicate, commento marker non postato.');
  }
  console.log(`route-already-fixed: #${issue} → ${VERIFY_LABEL} (fix ${verified.fixSha.slice(0, 12)}, run ${decision.evidence.run}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.log(`::warning::route-already-fixed: errore inatteso (${String(e?.message ?? e).slice(0, 160)}) — nessuna mutazione garantita.`);
    process.exit(0);
  }
}
