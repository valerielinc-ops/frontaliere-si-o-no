#!/usr/bin/env node
/**
 * mark-claude-terminal-outcome.mjs — telemetria granulare, zero-Claude, per le
 * run del fixer che muoiono PRIMA di poter postare il proprio verdetto.
 *
 * Sostituisce il blob node inline che stava in `issue-fix.yml` (step «Mark
 * error_max_turns»). Due motivi, entrambi vincolanti:
 *
 * 1. **Copriva un solo subtype.** Riconosceva `error_max_turns` e nient'altro.
 *    Misurato il 2026-08-05 su TUTTE le 61 run fallite della finestra 7gg
 *    2026-07-29 → 2026-08-05: `error_max_turns` = **0 occorrenze**, HTTP 429
 *    (quota) = **60**. Il caso davvero dominante non emetteva alcun marker
 *    granulare, quindi il backstop deterministico postava `no-pr-unspecified`,
 *    che `followup-drainer.mjs` scarta di proposito (BACKSTOP_MARKER) → outcome
 *    `null` → la issue veniva classificata «run morta, ri-tentabile» e
 *    ri-accodata tre volte contro la stessa quota esaurita, fino al park. Vedi
 *    `claude-rate-limit.mjs` per la catena assorbente completa.
 *
 * 2. **Duplicava il parsing dell'execution file** già necessario altrove
 *    (AGENTS.md #6: una logica duplicata letteralmente va estratta in un modulo
 *    condiviso, così il drift è impossibile by-construction). Ora il parsing e
 *    il riconoscimento del 429 vivono in `claude-rate-limit.mjs`.
 *
 * Precedenza: `max-turns` PRIMA di `rate-limited`. Sono mutuamente esclusivi nei
 * payload osservati, ma se mai coesistessero il budget di turni esaurito è il
 * verdetto più informativo (indica una issue too-large, che il drainer parka
 * subito con `needs-human`), mentre il 429 è una condizione ambientale
 * transitoria. Stessa precedenza che `pr-review-loop.yml` applica già nel suo
 * ramo bash.
 *
 * Nessun marker viene postato per gli altri failure (5xx transienti, crash
 * infra): restano senza verdetto e quindi legittimamente ri-tentabili dal
 * rescue del drainer. Nessuna falsa escalation.
 *
 * Env:
 *   GH_TOKEN     necessario per gh.
 *   GH_REPO      opzionale `owner/repo`.
 *   ISSUE        numero issue su cui postare.
 *   EXEC_FILE    path dell'execution file della claude-code-action.
 *   RUN_URL      opzionale, link alla run per il commento.
 *   WORKFLOW     opzionale, nome del workflow chiamante (default `issue-fix`).
 *   PR_DELIVERY_BASELINE_FILE  baseline JSON catturato prima del model step.
 *   GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT  identità del tentativo corrente.
 *   DRY_RUN      "1" → stampa e basta.
 *
 * Best-effort: non fa MAI fallire il job (exit 0 sempre).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectClaudeRateLimit,
  formatRateLimitComment,
  parseExecutionMessages,
} from './claude-rate-limit.mjs';
import {
  DELIVERY_STATUS,
  PR_LIST_FIELDS,
  PR_LIST_LIMIT,
  evaluatePrDelivery,
} from './lib/pr-delivery-evidence.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE;
const EXEC_FILE = process.env.EXEC_FILE;
const RUN_URL = process.env.RUN_URL || '';
const WORKFLOW = process.env.WORKFLOW || 'issue-fix';

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function ghResult(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }),
    };
  } catch (e) {
    console.log(`gh fallita (non bloccante): ${e && e.message ? e.message : e}`);
    return { ok: false, stdout: '' };
  }
}

function gh(args) {
  return ghResult(args).stdout;
}

/**
 * Il subtype del messaggio `result` più recente, o ''. Puro → testabile.
 * @param {string} raw
 */
export function resultSubtype(raw) {
  const msgs = parseExecutionMessages(raw);
  const r = [...msgs].reverse().find((m) => m && m.type === 'result');
  return String((r && r.subtype) || '');
}

// --- Lavoro recuperabile lasciato sul branch --------------------------------
// Il prompt di issue-fix.yml (passo 4, anti-100%-loss #4337) committa e pusha un
// checkpoint WIP su `fix/issue-<N>` appena la modifica è applicata, proprio perché una
// morte al cap dei turni non porti via il diff col container. Chi legge la telemetria a
// valle, però, cercava una sola prova di consegna — un marker `pr-created` — quindi un
// branch con commit veri e nessuna PR risultava identico a una run che non ha prodotto
// niente. Misurato sul corpus su 31 morti `max-turns`: consegnate 0, RECUPERABILI 11,
// vuote 20; due di quelle undici sono state riaperte a mano e mergiate (#5767 → PR #5774,
// corpus #166 → PR #293).
//
// Il posto giusto per rilevarlo è qui: siamo dentro il job che ha appena pushato il
// branch, l'informazione costa una chiamata sola e resta scritta accanto al marker anche
// se il branch verrà cancellato da un merge. `harvest-agent-lessons.mjs` legge questo
// stamp senza spendere API, e ricade su `compare` solo quando manca.

/**
 * Riga machine-readable da appendere al marker `max-turns`, o '' se non c'è lavoro da
 * recuperare. Pura → testabile.
 * @param {{branch?: string, aheadBy?: number}} work
 */
export function formatRecoverableBranchStamp(work) {
  const branch = String((work && work.branch) || '');
  const aheadBy = Number(work && work.aheadBy);
  if (!branch || !Number.isFinite(aheadBy) || aheadBy <= 0) return '';
  return `\n<!-- RECOVERABLE_BRANCH: ${branch} ahead=${aheadBy} -->\n` +
    `♻️ La run ha lasciato **${aheadBy} commit** su \`${branch}\`, avanti a \`main\`, senza aprire la PR ` +
    `(checkpoint WIP del passo 4). Non è una run a vuoto: il retry riprende da lì (resume-aware), ` +
    `oppure la PR si apre a mano da quel branch.`;
}

/**
 * Quanti commit ha `fix/issue-<N>` avanti a `main`, o null. Impura (gh) e FAIL-SAFE:
 * qualunque errore / branch assente → null, cioè il comportamento di prima.
 * @param {string|number} issue
 */
export function recoverableBranchWork(issue) {
  const branch = `fix/issue-${issue}`;
  const repo = process.env.GH_REPO ? process.env.GH_REPO : '{owner}/{repo}';
  const raw = gh(['api', `repos/${repo}/compare/main...${branch}`, '--jq', '.ahead_by']).trim();
  const aheadBy = Number(raw);
  return Number.isFinite(aheadBy) && aheadBy > 0 ? { branch, aheadBy } : null;
}

// --- Consegna avvenuta nonostante il cap dei turni --------------------------
// `error_max_turns` è il subtype della CLI, non l'esito del lavoro: la morte al
// cap arriva spessissimo DOPO `gh pr create`, perché la coda del flusso (gate
// sibling, riscrittura del body, watch della PR) è proprio dove i turni si
// esauriscono. Misurato sul sito il 2026-09-05, finestra 5 giorni: 124 issue
// distinte con marker `max-turns`, di cui **74 avevano una PR da
// `fix/issue-<N>` e tutte e 74 erano già MERGED**; 10 di quelle risultano
// comunque parcheggiate `needs-human`/`agent:decompose`.
//
// Il danno non è il marker sbagliato in sé, è dove finisce: `max-turns` sta in
// `PREPASS_VERDICT_BEATS_FAMILY` di `followup-drainer.mjs`, quindi al primo
// tentativo manda la issue in `fu-parked` + `needs-human` (stato assorbente) o
// nella coda di decomposizione — su una issue il cui fix è già in `main`.
//
// Il predicato è quello che lo step «Classify outcome» di `issue-fix.yml` usa
// già per decidere il colore del job («colore = work-done, non CLI exit»); qui
// arriva prima, così il verdetto letto dal drainer dice la stessa cosa del
// verdetto letto dall'umano che guarda il run.

/**
 * Current-attempt delivery evidence. An unavailable lookup is intentionally
 * distinct from a verified empty list: callers must not turn it into a
 * `pr-created` or `max-turns` marker.
 * @param {string|number} issue
 */
export function deliveryEvidence(issue) {
  const baselineFile = process.env.PR_DELIVERY_BASELINE_FILE;
  if (!baselineFile) return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'baseline-missing', prNumber: null };

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } catch {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'baseline-unreadable', prNumber: null };
  }

  const repo = process.env.GH_REPO || baseline?.repo;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const branch = `fix/issue-${issue}`;
  if (!repo || !runId || !runAttempt) {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'run-identity-missing', prNumber: null };
  }

  const listed = ghResult([
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    String(PR_LIST_LIMIT),
    ...(repo ? ['--repo', repo] : []),
    '--json',
    PR_LIST_FIELDS.join(','),
  ]);
  if (!listed.ok) return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'github-read-failed', prNumber: null };

  let currentPrs;
  try {
    currentPrs = JSON.parse(listed.stdout);
  } catch {
    return { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'pr-list-invalid-json', prNumber: null };
  }
  return evaluatePrDelivery({
    baseline,
    currentPrs,
    currentPrsComplete: Array.isArray(currentPrs) && currentPrs.length < PR_LIST_LIMIT,
    repo,
    issue,
    branch,
    runId,
    runAttempt,
  });
}

/**
 * Compatibility scalar for callers that only need a verified current PR.
 * Lookup failure and verified absence both return null; use deliveryEvidence
 * when the distinction matters.
 * @param {string|number} issue
 */
export function deliveredPrNumber(issue) {
  const evidence = deliveryEvidence(issue);
  return evidence.status === DELIVERY_STATUS.DELIVERED ? evidence.prNumber : null;
}

/**
 * Corpo del marker da postare quando la CLI è morta al cap DOPO aver
 * consegnato. Puro → testabile.
 * @param {number} prNumber
 */
export function formatDeliveredDespiteMaxTurnsComment(prNumber) {
  return '<!-- FIX_OUTCOME: pr-created -->\n' +
    `_La CLI è uscita \`error_max_turns\`, ma la delivery corrente della PR #${prNumber} è verificata nel tentativo: il lavoro è stato consegnato._\n` +
    '_Il verdetto separa l\'esito della CLI dall\'evidenza di delivery. Questa riga viene emessa solo con una prova corrente; un lookup non disponibile non viene interpretato come assenza._';
}

function main() {
  if (!ISSUE) {
    console.log('ISSUE non impostata → niente telemetria da postare.');
    return;
  }
  if (!EXEC_FILE || !fs.existsSync(EXEC_FILE)) {
    console.log('Nessun execution file → skip (il backstop deterministico coprirà il caso).');
    return;
  }

  const raw = fs.readFileSync(EXEC_FILE, 'utf-8');
  const subtype = resultSubtype(raw);
  console.log(`claude result subtype: '${subtype || '<none>'}'`);

  // --- max-turns (precedenza, vedi docstring) --------------------------------
  if (subtype === 'error_max_turns') {
    const delivery = deliveryEvidence(ISSUE);
    if (delivery.status === DELIVERY_STATUS.DELIVERED) {
      const deliveredPr = delivery.prNumber;
      console.log(`Terminal outcome: error_max_turns MA la PR #${deliveredPr} esiste (open/merged) → marker \`pr-created\`, non \`max-turns\`.`);
      if (DRY_RUN) return;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
        formatDeliveredDespiteMaxTurnsComment(deliveredPr)]);
      return;
    }
    if (delivery.status === DELIVERY_STATUS.UNAVAILABLE) {
      console.log(`Terminal outcome: error_max_turns ma delivery non verificabile (${delivery.reason}) → nessun marker terminale.`);
      return;
    }
    console.log('Terminal outcome: error_max_turns → marker granulare `max-turns`.');
    const work = recoverableBranchWork(ISSUE);
    if (work) console.log(`Lavoro recuperabile: ${work.branch} è ${work.aheadBy} commit avanti a main (PR mai aperta).`);
    if (DRY_RUN) return;
    // Marker SENZA la stringa BACKSTOP_MARKER ('post-step deterministico') così
    // `latestFixOutcomeFromComments` del drainer lo legge come verdetto vero.
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
      '<!-- FIX_OUTCOME: max-turns -->\n_Run terminata error_max_turns (turn budget esaurito) — telemetria granulare per il drainer._' +
      formatRecoverableBranchStamp(work)]);
    return;
  }

  // --- quota / 429 -----------------------------------------------------------
  const { rateLimited, resetsAt, rateLimitType } = detectClaudeRateLimit(raw);
  if (rateLimited) {
    console.log(`Terminal outcome: rate limit (429, type=${rateLimitType || '?'}, resetsAt=${resetsAt || '?'}) → marker granulare \`rate-limited\` + beacon di backoff.`);
    if (DRY_RUN) return;
    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body',
      formatRateLimitComment({ resetsAt, rateLimitType, runUrl: RUN_URL, workflow: WORKFLOW })]);
    return;
  }

  console.log('Nessun terminal outcome noto (5xx transiente / crash infra) → nessun marker: la issue resta ri-tentabile dal rescue.');
}

// Best-effort assoluto: la telemetria non deve mai far fallire il job.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('mark-claude-terminal-outcome error (non bloccante):', e && e.message ? e.message : e);
  }
  process.exit(0);
}
