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
 *      Per le issue di failure (`failureReportBinding`: report dei timeout di
 *      `scan-job-timeouts.mjs`, titoli `Workflow|CI Failure`) il run verde deve
 *      anche appartenere allo stesso workflow del run originario citato nel
 *      corpo ed essere stato creato DOPO l'apertura della issue; senza run
 *      originaria leggibile, o per `Crawler Failure` (run nel corpus), niente.
 *   4. Solo allora: aggiunge `maybe-resolved` (la label di verifica gia' usata da
 *      reconcile-followups/check-issue-already-resolved), toglie `agent:fix` e
 *      `agent:fix-queued` se presenti, posta il marker
 *      `<!-- ALREADY_FIXED_ROUTED: ... -->` con l'evidenza verificata.
 *      MAI chiude la issue: la chiusura resta a chi verifica.
 *   5. `maybe-resolved` e' anche cio' che tiene la issue fuori dal ciclo dopo:
 *      il secondo passaggio di `triage-sweep.mjs` (triaged ma senza routing)
 *      la salta, altrimenti la ri-accoderebbe al giro successivo.
 *
 * Evidenza assente, malformata o non verificabile → nessuna mutazione, log del
 * motivo, exit 0.
 *
 * BUCKET GIORNALIERI (`follow-up(daily:…)`). Il contratto qui sopra vale per le
 * issue singole. Su un bucket `maybe-resolved` sull'intera issue non toglieva
 * l'item dalla selezione: il gate sul conio riaccodava il bucket finche' restava
 * un item `open` e `selectFirstOpenItem` restituiva lo stesso item (31 verdetti
 * `already-fixed` identici su un solo item). Per un bucket lo step lavora a
 * grana ITEM, sull'item che il workflow ha selezionato (`DAILY_ITEM_ID`):
 *   a. ogni esito di questa run lascia un `FU_ITEM_ATTEMPT` per l'item;
 *   b. `already-fixed` con terna verificata E legame con l'item (la PR ha
 *      toccato il suo `Target file` o un test della scheda, oppure e' una delle
 *      sue `Sources`) → `State: blocked` + `FU_ITEM_EVIDENCE` +
 *      `FU_ITEM_BLOCKED reason=awaiting-verification`;
 *   c. `already-fixed` senza prova o senza legame, per la seconda volta →
 *      `State: blocked` + `FU_ITEM_BLOCKED reason=already-fixed-unverified`;
 *   d. un verdetto non ritentabile che riguarda l'item (`no-root-cause`,
 *      `blocked-admin-settings`, `ITEM_BLOCKING_OUTCOMES`) senza PR consegnata
 *      → `State: blocked` + `FU_ITEM_BLOCKED reason=<esito>`. Prima l'esito
 *      lasciava solo il tentativo, e il prompt faceva differire all'agente
 *      l'INTERA issue (`automation-deferred`): un item senza causa sospendeva il
 *      bucket (9508, 9609). Ora il bucket resta in coda per l'item successivo;
 *      i veti di `QUEUE_VETO_LABELS` non cambiano.
 * MAI `State: done`: la terna prova che la PR esiste, non che l'item sia
 * risolto. `done` e la chiusura restano al reconciler (token) o a una persona.
 * Lo step gira nel job del fixer, fuori dal mutex `followup-daily-<repo>`: la
 * protezione e' rileggere titolo e corpo subito prima di scrivere e rinunciare
 * se sono cambiati (un aggiornamento perso costa una run, non un corpo rotto).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Contratto del marker e allowlist dei bot che possono emetterlo: una sola
// copia, condivisa con drainer/backoff (AGENTS.md #6), niente regex duplicate.
import { FIX_OUTCOME_RE } from './claude-rate-limit-contract.mjs';
import { AUTHORIZED_QUOTA_BEACON_BOTS } from './claude-rate-limit.mjs';
import {
  FOLLOWUP_ITEM_ID_SINGLE_RE,
  dailyBucketInfo,
  parseFollowupItems,
  selectFirstOpenItem,
  updateFollowupItemState,
} from './followup-resolution-match.mjs';
import {
  countItemAttempts,
  inertCommentText,
  itemAttemptMarker,
  itemBlockedMarker,
  itemEvidenceLink,
  itemEvidenceMarker,
  itemMetricLine,
  parseItemMarkers,
} from './lib/followup-item-evidence.mjs';
import { DELIVERY_STATUS, normalizeDeliveryEvidence } from './lib/pr-delivery-evidence.mjs';

export const VERIFY_LABEL = 'maybe-resolved';
export const ROUTING_LABELS = Object.freeze(['agent:fix', 'agent:fix-queued']);
export const ROUTED_MARKER = 'ALREADY_FIXED_ROUTED';
export const QUEUE_LABEL = 'agent:fix-queued';
// Gli stessi veti che impediscono al gate sul conio di riaccodare un bucket,
// piu' il padre gia' decomposto (tracker, non lavoro del fixer).
export const QUEUE_VETO_LABELS = Object.freeze(['needs-human', 'automation-deferred', 'fu-parked', 'decomposed:1']);
// Verdetti del fixer che su un bucket riguardano SOLO l'item selezionato: lo
// tolgono dalla selezione (`State: blocked`) invece di fermare l'intera issue.
// Insieme chiuso, sottoinsieme di `ITEM_BLOCKED_REASONS`. Fuori, per scelta:
// `blocked-workflows-scope` (lo step non gira), `skip-duplicate-diagnosis` e
// `revenue-tracker-manual` (riguardano la issue), `already-fixed` (rami b/c).
export const ITEM_BLOCKING_OUTCOMES = Object.freeze(['no-root-cause', 'blocked-admin-settings']);
const FIXER_WORKFLOW_PATH = '.github/workflows/issue-fix.yml';
const DAILY_TITLE_PREFIX_RE = /^follow-up\(daily:/iu;

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// Gli stessi bot autorizzati a emettere un `FIX_OUTCOME` in claude-rate-limit.mjs.
// GraphQL (`gh issue view --json comments`) espone il login senza `[bot]`,
// REST con il suffisso: si confronta la forma canonica.
const TRUSTED_BOTS = new Set(AUTHORIZED_QUOTA_BEACON_BOTS);

const EVIDENCE_RE = /<!--\s*FIX_EVIDENCE:([^>]*?)-->/gu;
const JOB_TIMEOUT_REPORT_SIGNATURE = 'scripts/ci/scan-job-timeouts.mjs';
const WORKFLOW_FILE_RE = /^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/u;

// Il report dei timeout porta la run su una riga `**Run:** <url>` sua; gli altri
// reporter di failure la scrivono in forme diverse (`**Run:**`, `- **Run:**`,
// `- run:`), quindi per loro vale il primo link a una run del corpo.
const TIMEOUT_REPORT_RUN_RE = /^\*\*Run:\*\*\s*https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/([1-9][0-9]*)\s*$/mu;
const FIRST_RUN_LINK_RE = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/([1-9][0-9]*)/u;
// La famiglia dei titoli di failure il cui guasto e' una run di UN workflow del
// sito: `Workflow Failure: …`, `CI Failure: …` e `CI Failure (<evento>): …`.
const WORKFLOW_FAILURE_TITLE_RE = /^(?:Workflow|CI) Failure(?:\s*\([^)]*\))?\s*:/iu;
// `Crawler Failure: Run <slug>`: la run e' nel corpus, la prova e' lo step del gruppo.
const CRAWLER_FAILURE_TITLE_RE = /^Crawler Failure\s*:/iu;

/**
 * Extract the original Actions run from a timeout issue emitted by
 * `scan-job-timeouts.mjs`. Those issues need evidence from the same workflow;
 * an unrelated green `tests` run cannot prove an E2E timeout was fixed.
 * @param {string} issueBody
 * @param {string} repo owner/name
 * @returns {{required: false, runId: null} | {required: true, runId: number|null, reason?: string}}
 */
export function timeoutReportSourceRun(issueBody, repo) {
  const body = String(issueBody ?? '');
  if (!body.includes(`\`${JOB_TIMEOUT_REPORT_SIGNATURE}\``)) {
    return { required: false, runId: null };
  }
  return sourceRunFromMatch(TIMEOUT_REPORT_RUN_RE.exec(body), repo);
}

function sourceRunFromMatch(match, repo) {
  if (!match) return { required: true, runId: null, reason: 'run-originaria-assente' };
  if (match[1].toLowerCase() !== String(repo ?? '').trim().toLowerCase()) {
    return { required: true, runId: null, reason: 'run-originaria-repo-diverso' };
  }
  const runId = Number(match[2]);
  if (!Number.isSafeInteger(runId)) return { required: true, runId: null, reason: 'run-originaria-id-invalido' };
  return { required: true, runId };
}

/**
 * Legame fra una issue di failure e il workflow del guasto: per queste issue un
 * `already-fixed` vale solo con una run verde DELLO STESSO workflow della run
 * originaria (#7421: una run `tests` verde citata come prova di un guasto di
 * `cathedral-seo-gates-check`, che sulla stessa SHA era fallito).
 *   - corpo dello scanner dei timeout → `timeoutReportSourceRun`, invariato;
 *   - titolo `Workflow|CI Failure` (anche `CI Failure (<evento>): …`) → la
 *     prima run citata nel corpo, dello stesso repo;
 *   - `Crawler Failure: …` → run nel corpus: mai verificabile da qui;
 *   - ogni altra issue → nessun legame (comportamento di prima).
 * `required` con `runId: null` significa: non si muta niente.
 * @param {string} title
 * @param {string} issueBody
 * @param {string} repo owner/name
 * @returns {{required: false, runId: null, reason: string} | {required: true, runId: number|null, reason?: string}}
 */
export function failureReportBinding(title, issueBody, repo) {
  const timeout = timeoutReportSourceRun(issueBody, repo);
  if (timeout.required) return timeout;
  const t = String(title ?? '').trim();
  if (CRAWLER_FAILURE_TITLE_RE.test(t)) return { required: true, runId: null, reason: 'crawler-run-cross-repo' };
  if (!WORKFLOW_FAILURE_TITLE_RE.test(t)) return { required: false, runId: null, reason: 'issue-non-di-failure' };
  return sourceRunFromMatch(FIRST_RUN_LINK_RE.exec(String(issueBody ?? '')), repo);
}

/** Normalize a REST Actions run path and reject values outside workflow files. */
export function workflowFileFromRunPath(value) {
  const workflowPath = String(value ?? '').split('@', 1)[0];
  if (!WORKFLOW_FILE_RE.test(workflowPath) || workflowPath.split('/').includes('..')) return null;
  return workflowPath;
}

/**
 * Codice `FIX_OUTCOME` del body, o null. Stessa semantica di tutti gli altri
 * consumer del marker (`FIX_OUTCOME_RE`, primo marker del commento).
 * @param {string} body
 */
export function outcomeOf(body) {
  const m = FIX_OUTCOME_RE.exec(String(body ?? ''));
  return m ? m[1].toLowerCase() : null;
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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

export function isTrustedAuthor(comment) {
  const login = String(comment?.author?.login ?? '').trim().toLowerCase().replace(/\[bot\]$/u, '');
  if (login && TRUSTED_BOTS.has(login)) return true;
  return TRUSTED_ASSOCIATIONS.has(String(comment?.authorAssociation ?? ''));
}

/**
 * L'ULTIMO commento `FIX_OUTCOME` postato da questa run, qualunque sia l'autore
 * (la fiducia la decide il chiamante). Nessuna I/O.
 * @returns {{last: object} | {reason: string}}
 */
export function lastOutcomeCommentOfRun({ comments, runStartedAt }) {
  const startedMs = timestampMs(runStartedAt);
  if (startedMs === null) return { reason: 'runStartedAt-non-verificabile' };
  if (!Array.isArray(comments)) return { reason: 'commenti-non-leggibili' };
  // Confronto numerico, non lessicografico: il baseline e' canonicalizzato con
  // i millisecondi (`.000Z`), i `createdAt` di GitHub no.
  const current = comments
    .map((c) => ({ c, at: timestampMs(c?.createdAt) }))
    .filter(({ c, at }) => at !== null && at >= startedMs && outcomeOf(c?.body) !== null)
    .sort((a, b) => a.at - b.at)
    .map(({ c }) => c);
  const last = current.at(-1);
  return last ? { last } : { reason: 'nessun-FIX_OUTCOME-in-questa-run' };
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
  if (deliveryStatus !== DELIVERY_STATUS.NONE) {
    return { action: 'none', reason: `delivery=${deliveryStatus ?? 'unavailable'}: serve ${DELIVERY_STATUS.NONE}` };
  }
  const found = lastOutcomeCommentOfRun({ comments, runStartedAt });
  if (!found.last) return { action: 'none', reason: found.reason };
  const { last } = found;
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
 *   defaultBranch?: string, currentRunId?: number|null, expectedWorkflowPath?: string,
 *   issueCreatedAt?: string|null }} deps
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
  if (deps.expectedWorkflowPath !== undefined) {
    const expectedWorkflowPath = workflowFileFromRunPath(deps.expectedWorkflowPath);
    const actualWorkflowPath = workflowFileFromRunPath(run?.path);
    if (!expectedWorkflowPath || !actualWorkflowPath) {
      return { ok: false, reason: `run-${evidence.run}-workflow-non-verificabile` };
    }
    if (actualWorkflowPath !== expectedWorkflowPath) {
      return {
        ok: false,
        reason: `run-${evidence.run}-workflow-diverso:${actualWorkflowPath}-atteso:${expectedWorkflowPath}`,
      };
    }
  }
  // Una run creata prima che il guasto fosse segnalato non puo' provarne la
  // guarigione. `undefined` = il chiamante non lo chiede; un valore illeggibile
  // (anche quello della run) e' fail-closed.
  if (deps.issueCreatedAt !== undefined) {
    const issueMs = timestampMs(deps.issueCreatedAt);
    if (issueMs === null) return { ok: false, reason: 'issue-createdAt-non-verificabile' };
    const runMs = timestampMs(run?.created_at);
    if (runMs === null) return { ok: false, reason: `run-${evidence.run}-created_at-non-verificabile` };
    if (runMs <= issueMs) return { ok: false, reason: `run-${evidence.run}-precedente-alla-issue` };
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
// Bucket giornalieri: decisione a grana item (pura)

const SELECTABLE_ITEM_STATES = new Set(['open', 'in-progress']);

/**
 * Regola per l'ID: l'item selezionato dal workflow deve esistere nel corpo con
 * stato `open` o `in-progress`. Altrimenti non si muta niente.
 * @returns {{item: object} | {reason: string}}
 */
export function selectableBucketItem(body, itemId) {
  const id = String(itemId ?? '').trim().toUpperCase();
  if (!FOLLOWUP_ITEM_ID_SINGLE_RE.test(id)) return { reason: 'DAILY_ITEM_ID-assente-o-invalido' };
  const item = parseFollowupItems(body).find((candidate) => candidate.id?.toUpperCase() === id);
  if (!item) return { reason: `item-${id}-non-nel-corpo` };
  if (!SELECTABLE_ITEM_STATES.has(item.state)) return { reason: `item-${id}-stato=${item.state ?? 'illeggibile'}` };
  return { item };
}

/**
 * Cosa fare dell'item selezionato dopo l'esito di questa run. Nessuna I/O.
 * L'unico stato che questa funzione scrive e' `blocked`: mai `done`.
 *
 * @param {{body: string, itemId: string, outcome: string, deliveryStatus: string|null,
 *   verified: boolean, link: 'target-file'|'source-pr'|'none', priorAlreadyFixedAttempts: number}} input
 * @returns {{action: 'none', reason: string} |
 *   {action: 'attempt', reason: string, item: object} |
 *   {action: 'block', blockedReason: 'awaiting-verification'|'already-fixed-unverified'|'no-root-cause'|'blocked-admin-settings',
 *    item: object, nextBody: string, openRemaining: boolean}}
 */
export function decideBucketItemRouting({
  body, itemId, outcome, deliveryStatus, verified, link, priorAlreadyFixedAttempts,
}) {
  const selected = selectableBucketItem(body, itemId);
  if (!selected.item) return { action: 'none', reason: selected.reason };
  const { item } = selected;
  const id = item.id.toUpperCase();
  let blockedReason = null;
  if (ITEM_BLOCKING_OUTCOMES.includes(outcome)) {
    // Una PR consegnata (o una delivery illeggibile) smentisce il verdetto o non
    // lo prova: si registra il tentativo, come prima.
    if (deliveryStatus !== DELIVERY_STATUS.NONE) {
      return { action: 'attempt', reason: `outcome=${outcome}, delivery=${deliveryStatus ?? 'unavailable'}`, item };
    }
    blockedReason = outcome;
  } else if (outcome !== 'already-fixed') {
    return { action: 'attempt', reason: `outcome=${outcome}`, item };
  } else if (verified && link !== 'none') blockedReason = 'awaiting-verification';
  // Un PR consegnata in questa run smentisce il verdetto: non e' un giro a vuoto.
  else if (deliveryStatus === DELIVERY_STATUS.NONE && priorAlreadyFixedAttempts >= 1) blockedReason = 'already-fixed-unverified';
  if (!blockedReason) {
    return { action: 'attempt', reason: verified ? 'evidenza-senza-legame-con-l-item' : 'evidenza-non-verificata', item };
  }
  const nextBody = updateFollowupItemState(body, id, 'blocked');
  if (!nextBody || nextBody === body) return { action: 'none', reason: `stato-item-${id}-non-aggiornabile` };
  return { action: 'block', blockedReason, item, nextBody, openRemaining: selectFirstOpenItem(nextBody) !== null };
}

/**
 * Argomenti label di `gh issue edit` per un bucket dopo che un item e' uscito
 * dalla selezione. Restano item `open` → il bucket resta lavoro del fixer:
 * niente `maybe-resolved`, coda conservata o riaggiunta salvo veto. Non ne
 * restano → `maybe-resolved` (stadio di verifica, non una chiusura) e nessuna coda.
 * @param {string[]} labels
 * @param {{openRemaining: boolean}} options
 */
export function bucketLabelEditArgs(labels, { openRemaining }) {
  const present = new Set((labels ?? []).map((label) => String(label).toLowerCase()));
  const args = [];
  const add = (label) => { if (!present.has(label)) args.push('--add-label', label); };
  const remove = (label) => { if (present.has(label)) args.push('--remove-label', label); };
  remove('agent:fix');
  if (openRemaining) {
    remove(VERIFY_LABEL);
    if (QUEUE_VETO_LABELS.some((label) => present.has(label))) remove(QUEUE_LABEL);
    else add(QUEUE_LABEL);
  } else {
    add(VERIFY_LABEL);
    remove(QUEUE_LABEL);
  }
  return args;
}

const LINK_PROSE = Object.freeze({
  'target-file': 'la PR ha toccato il `Target file` dell\'item o un test citato nella sua scheda',
  'source-pr': 'la PR e\' una delle `Sources` dell\'item',
});

/**
 * Il commento unico della run sul bucket. I marker stanno in testa; il primo
 * resta `ALREADY_FIXED_ROUTED` quando l'evidenza e' verificata e legata.
 */
export function bucketItemCommentBody({
  itemId, outcome, runId = null, blockedReason = null, evidence = null, verified = null,
  link = 'none', metric = '', openRemaining = false, attemptReason = '',
}) {
  const attempt = itemAttemptMarker({ item: itemId, outcome, run: runId });
  // Il motivo puo' portare un messaggio d'errore di `gh`: stesso canale della METRICA.
  const reason = inertCommentText(attemptReason);
  if (!blockedReason) {
    return [
      attempt,
      `📝 Item \`${itemId}\`: esito \`${outcome}\` registrato${reason ? ` (${reason})` : ''}. Nessun cambio di stato.`,
      outcome === 'already-fixed'
        ? 'Un secondo `already-fixed` senza prova verificata e legata all\'item lo porta a `State: blocked`, fuori dalla selezione del fixer.'
        : null,
    ].filter((line) => line !== null).join('\n');
  }
  const next = openRemaining
    ? 'Restano item `open`: il bucket resta in coda e il prossimo giro prende l\'item successivo.'
    : `Non restano item \`open\`: applicata \`${VERIFY_LABEL}\` (stadio di verifica, non una chiusura).`;
  if (blockedReason === 'awaiting-verification') {
    const routed = [
      evidence.pr !== null ? `pr=${evidence.pr}` : null,
      `commit=${verified.fixSha}`,
      `run=${evidence.run}`,
    ].filter(Boolean).join(' ');
    return [
      `<!-- ${ROUTED_MARKER}: ${routed} -->`,
      attempt,
      itemEvidenceMarker({ item: itemId, pr: evidence.pr, commit: verified.fixSha, run: evidence.run, link }),
      itemBlockedMarker({ item: itemId, reason: blockedReason }),
      `🔎 **Item \`${itemId}\` in attesa di verifica esplicita: la terna prova che la PR esiste, non che l'item sia risolto.**`,
      '',
      evidence.pr !== null ? `- PR #${evidence.pr} MERGED su \`main\`.` : null,
      `- Fix \`${verified.fixSha.slice(0, 12)}\` raggiungibile da \`main\`.`,
      `- Run ${evidence.run} \`success\` su \`main\`, con HEAD \`${verified.runHeadSha.slice(0, 12)}\` che contiene la fix.`,
      `- Legame con l'item (\`${link}\`): ${LINK_PROSE[link]}.`,
      metric ? `- METRICA dell'item, da rimisurare: ${metric}` : null,
      '',
      `Stato dell'item → \`blocked\` (non \`done\`): esce dalla selezione del fixer, il bucket **non** si chiude. ${next}`,
      'Esce da qui quando il token di accettazione diventa vero (lo marca il reconciler) o quando una persona verifica e chiude con evidenza. Se il difetto c\'e\' ancora, riporta l\'item a `State: open`.',
    ].filter((line) => line !== null).join('\n');
  }
  if (ITEM_BLOCKING_OUTCOMES.includes(blockedReason)) {
    return [
      attempt,
      itemBlockedMarker({ item: itemId, reason: blockedReason }),
      `🛑 **Item \`${itemId}\`: verdetto \`${blockedReason}\` del fixer, che vale per questo item e non per il bucket.**`,
      '',
      `Stato dell'item → \`blocked\` (non \`done\`): esce dalla selezione del fixer, il bucket **non** viene differito. ${next}`,
      metric ? `METRICA dell'item, da rimisurare: ${metric}` : null,
      'Per rimetterlo in lavoro serve un input nuovo (scheda, causa, osservabilità): riporta l\'item a `State: open`.',
    ].filter((line) => line !== null).join('\n');
  }
  return [
    attempt,
    itemBlockedMarker({ item: itemId, reason: blockedReason }),
    `🛑 **Item \`${itemId}\`: secondo \`already-fixed\` senza prova verificata e legata all'item.**`,
    '',
    `Stato dell'item → \`blocked\` (non \`done\`): esce dalla selezione del fixer invece di ricevere un altro giro identico, il bucket **non** si chiude. ${next}`,
    metric ? `METRICA dell'item, da rimisurare: ${metric}` : null,
    'Serve una verifica esplicita: se il lavoro e\' dovuto, riporta l\'item a `State: open` con una condizione di accettazione misurabile.',
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

/**
 * Verifica via API l'evidenza citata (compreso il vincolo di workflow per le
 * issue di failure, `failureReportBinding`). `message` e' il log completo quando
 * il motivo riguarda il run originario; altrimenti `reason` e' quello di
 * `verifyEvidence`.
 */
function verifyRunEvidence({ repo, view, evidence, withFiles = false }) {
  const sourceRun = failureReportBinding(view?.title, view?.body, repo);
  let expectedWorkflowPath;
  if (sourceRun.required) {
    if (sourceRun.runId === null) {
      return { ok: false, message: `route-already-fixed: workflow originario non verificabile (${sourceRun.reason}) — nessuna mutazione.` };
    }
    let failedRun;
    try {
      failedRun = JSON.parse(gh([
        'api', `repos/${repo}/actions/runs/${sourceRun.runId}`,
        '--jq', '{status,conclusion,path}',
      ]));
    } catch (e) {
      return { ok: false, message: `route-already-fixed: lookup workflow originario non disponibile (${String(e?.message ?? e).slice(0, 120)}) — nessuna mutazione.` };
    }
    if (failedRun?.status !== 'completed' || !['cancelled', 'failure', 'timed_out'].includes(failedRun?.conclusion)) {
      return { ok: false, message: `route-already-fixed: il run originario non risulta un timeout/fallimento terminale (${failedRun?.status}/${failedRun?.conclusion}) — nessuna mutazione.` };
    }
    expectedWorkflowPath = workflowFileFromRunPath(failedRun?.path);
    if (!expectedWorkflowPath) {
      return { ok: false, message: `route-already-fixed: path workflow originario non verificabile (run ${sourceRun.runId}) — nessuna mutazione.` };
    }
  }
  let prFiles = [];
  const verified = verifyEvidence(evidence, {
    defaultBranch: process.env.DEFAULT_BRANCH || 'main',
    currentRunId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    ...(expectedWorkflowPath ? { expectedWorkflowPath } : {}),
    // Solo per le issue legate a un workflow: la prova deve seguire la segnalazione.
    ...(sourceRun.required ? { issueCreatedAt: view?.createdAt ?? null } : {}),
    // Per i bucket la stessa lettura porta anche i file toccati (legame con l'item).
    pr: (n) => {
      const pr = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', withFiles ? 'state,baseRefName,mergeCommit,files' : 'state,baseRefName,mergeCommit']));
      prFiles = Array.isArray(pr?.files) ? pr.files.map((file) => file?.path).filter(Boolean) : [];
      return pr;
    },
    run: (id) => JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '{status,conclusion,head_branch,head_sha,path,created_at}'])),
    // `per_page=1`: serve solo `.status`, non la lista dei commit fra i due ref.
    compare: (base, head) => gh(['api', `repos/${repo}/compare/${base}...${head}?per_page=1`, '--jq', '.status']).trim(),
  });
  return { ...verified, prFiles };
}

/** Ramo bucket: una sola mutazione di stato (`blocked`) e un solo commento per run. */
function routeBucketItem({ repo, issue, view, runStartedAt, deliveryStatus }) {
  const skip = (reason) => {
    setOutput('routed', 'false');
    console.log(`route-already-fixed: bucket #${issue}, nessuna mutazione (${reason}).`);
  };
  const itemId = String(process.env.DAILY_ITEM_ID ?? '').trim().toUpperCase();
  if (process.env.IS_GROUP === 'true') return skip('gruppo-B19');
  if (view?.state !== 'OPEN') return skip(`issue non aperta: ${view?.state}`);
  const found = lastOutcomeCommentOfRun({ comments: view?.comments, runStartedAt });
  if (!found.last) return skip(found.reason);
  if (!isTrustedAuthor(found.last)) return skip(`autore-non-fidato:${found.last?.author?.login ?? '?'}`);
  const outcome = outcomeOf(found.last.body);
  const runId = /^[1-9][0-9]*$/u.test(String(process.env.GITHUB_RUN_ID ?? '')) ? Number(process.env.GITHUB_RUN_ID) : null;

  let evidence = null;
  let verified = { ok: false, reason: 'non-richiesta' };
  let link = 'none';
  // Prima la regola sull'ID (pura, zero API): un ID che non e' un item
  // selezionabile del corpo non merita nemmeno le letture di verifica.
  const selected = selectableBucketItem(view?.body, itemId);
  if (!selected.item) return skip(selected.reason);
  if (outcome === 'already-fixed') {
    const routing = decideAlreadyFixedRouting({ comments: view?.comments, runStartedAt, deliveryStatus });
    if (routing.action === 'verify') {
      evidence = routing.evidence;
      verified = verifyRunEvidence({ repo, view, evidence, withFiles: true });
      if (verified.ok) link = itemEvidenceLink(selected.item, { pr: evidence.pr, files: verified.prFiles });
    } else {
      verified = { ok: false, reason: routing.reason };
    }
  }
  const markers = parseItemMarkers(view?.comments, { isTrusted: isTrustedAuthor });
  const decision = decideBucketItemRouting({
    body: view?.body,
    itemId,
    outcome,
    deliveryStatus,
    verified: verified.ok,
    link,
    priorAlreadyFixedAttempts: countItemAttempts(markers, itemId, 'already-fixed', { excludeRun: runId }),
  });
  if (decision.action === 'none') return skip(decision.reason);

  const postComment = (body) => {
    try {
      gh(['issue', 'comment', String(issue), '--repo', repo, '--body', body]);
      return true;
    } catch {
      console.log('::warning::route-already-fixed: commento marker dell\'item non postato.');
      return false;
    }
  };
  // Un esito che `FIX_OUTCOME_RE` accetta ma il marker no (inizia con una
  // cifra, supera la lunghezza) non deve far terminare lo script con un errore.
  const compose = (fields) => {
    try { return bucketItemCommentBody({ itemId, outcome, runId, ...fields }); } catch (e) { return { error: String(e?.message ?? e).slice(0, 80) }; }
  };
  const attemptOnly = (attemptReason) => {
    const body = compose({ attemptReason });
    if (typeof body !== 'string') return skip(`marker-non-componibile:${body.error}`);
    setOutput('routed', 'false');
    postComment(body);
    console.log(`route-already-fixed: bucket #${issue}, item ${itemId}: tentativo registrato (${attemptReason}), stato invariato.`);
  };
  if (decision.action === 'attempt') {
    return attemptOnly(outcome === 'already-fixed' ? (verified.ok ? decision.reason : `${decision.reason}: ${verified.reason ?? verified.message}`) : decision.reason);
  }

  // Tutto il commento si costruisce PRIMA di scrivere: un marker non
  // componibile non deve lasciare un corpo modificato senza la sua prova.
  const comment = compose({
    blockedReason: decision.blockedReason,
    evidence,
    verified,
    link,
    metric: itemMetricLine(decision.item),
    openRemaining: decision.openRemaining,
  });
  if (typeof comment !== 'string') return skip(`marker-non-componibile:${comment.error}`);
  // Rilettura-confronto: lo step gira fuori dal mutex del bucket.
  let fresh;
  try {
    fresh = JSON.parse(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body,state']));
  } catch (e) {
    return attemptOnly(`rilettura non disponibile: ${String(e?.message ?? e).slice(0, 80)}`);
  }
  if (fresh?.state !== 'OPEN' || fresh?.title !== view?.title || fresh?.body !== view?.body) {
    return attemptOnly('corpo o titolo cambiati fra lettura e scrittura');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-already-fixed-'));
  try {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, decision.nextBody);
    try {
      gh(['issue', 'edit', String(issue), '--repo', repo, '--body-file', bodyFile]);
    } catch (e) {
      return attemptOnly(`scrittura del corpo fallita: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Da qui l'item E' `blocked`: il marker va postato comunque, anche se le
  // label falliscono (il gate sul conio ripara la coda al giro successivo).
  const labels = Array.isArray(view?.labels) ? view.labels.map((l) => l?.name).filter(Boolean) : [];
  const labelArgs = bucketLabelEditArgs(labels, { openRemaining: decision.openRemaining });
  if (labelArgs.length > 0) {
    try {
      gh(['issue', 'edit', String(issue), '--repo', repo, ...labelArgs]);
    } catch (e) {
      console.log(`::warning::route-already-fixed: edit label fallito (${String(e?.message ?? e).slice(0, 120)}).`);
    }
  }
  setOutput('routed', 'true');
  postComment(comment);
  console.log(`route-already-fixed: bucket #${issue}, item ${itemId} → blocked (${decision.blockedReason}, link=${link}).`);
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
  // Stesso confine del classificatore: un sidecar illeggibile o con uno stato
  // ignoto e' `unavailable`, mai un `verified-none` implicito.
  const delivery = normalizeDeliveryEvidence(readJson(process.env.PR_DELIVERY_EVIDENCE_FILE));
  let view;
  try {
    view = JSON.parse(gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body,comments,labels,state,createdAt']));
  } catch (e) {
    setOutput('routed', 'false');
    console.log(`::warning::route-already-fixed: lettura issue non disponibile (${String(e?.message ?? e).slice(0, 120)}) — nessuna mutazione.`);
    return;
  }
  const runStartedAt = typeof baseline?.runStartedAt === 'string' ? baseline.runStartedAt : null;
  if (dailyBucketInfo(view?.title)) {
    routeBucketItem({ repo, issue, view, runStartedAt, deliveryStatus: delivery.status });
    return;
  }
  // Stesso prefisso con cui il workflow riconosce un bucket: un titolo daily
  // che non si interpreta non deve ricadere su `maybe-resolved` sull'intera issue.
  if (DAILY_TITLE_PREFIX_RE.test(String(view?.title ?? ''))) {
    setOutput('routed', 'false');
    console.log(`route-already-fixed: bucket #${issue}, nessuna mutazione (titolo-daily-non-interpretabile).`);
    return;
  }
  const decision = decideAlreadyFixedRouting({
    comments: view?.comments,
    runStartedAt,
    deliveryStatus: delivery.status,
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
  const verified = verifyRunEvidence({ repo, view, evidence: decision.evidence });
  if (!verified.ok) {
    setOutput('routed', 'false');
    console.log(verified.message ?? `route-already-fixed: evidenza non verificata (${verified.reason}) — nessuna mutazione, agent:fix resta.`);
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
