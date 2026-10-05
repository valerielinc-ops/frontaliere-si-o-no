/**
 * followup-ci-suite-proof.mjs — un item bloccato SOLO dalla guardia risorse
 * locale diventa `done` quando la CI required della sua PR ha eseguito verde la
 * suite dell'item.
 *
 * Decisione del proprietario I4 (2026-10-05): e' un allargamento VOLUTO del
 * criterio di chiusura. Prima un item come «CI verification of …» con
 * `Stato dichiarato nella PR: blocked: il resource guard blocca vitest` non
 * aveva uscita automatica: il token di accettazione e' la scheda (`COMANDO:
 * npx vitest run tests/…`), che `detectAlreadyResolved` non misura per
 * costruzione, e il blocco dichiarato («serve il verdetto della CI») era gia'
 * caduto quando la CI della PR aveva girato. Misurato il 2026-10-05: 10 item
 * cosi' fra site#10433 e site#10283, tutti su PR mergiate il 27-28/09.
 *
 * Il criterio, tutto fail-closed (ogni dubbio lascia l'item com'e'):
 * 1. il blocco dichiarato (`Stato dichiarato nella PR`, o `Blocked on` se il
 *    primo manca) nomina la guardia risorse locale e NESSUN altro blocco;
 * 2. la suite dell'item e' la `COMANDO` della scheda, `npx vitest run` seguito
 *    SOLO da file di test (un flag, un glob o un altro comando: niente suite),
 *    e l'item non chiede la suite intera (titolo o testo: «suite completa»,
 *    «full suite»), che la selezione della CI non esegue;
 * 3. la PR dell'item e' UNA sola fra le `Sources`, ed e' mergiata;
 * 4. la run piu' recente e completata di `tests.yml` sullo sha di merge o
 *    sull'ultima head della PR ha il job required `vitest (unit + integration)`
 *    verde E ha eseguito ogni file della suite con almeno un test passato e
 *    nessun fallito (report JSON di vitest se l'artifact esiste ancora,
 *    altrimenti le righe per file del log del job);
 * 5. nessuna delle due run contraddice: un file della suite fallito, o una run
 *    rossa di cui non si legge l'esito per file, lasciano l'item bloccato. Una
 *    run rossa PRIMA di vitest (lo step di vitest `skipped`, per esempio
 *    `Assemble + migrate` fallito sul push di `main`) non ha eseguito nulla:
 *    non e' una prova e non contraddice.
 *
 * La prova (PR, sha, run, job) resta nel marker `FU_ITEM_CI_SUITE` del
 * commento e il gate di chiusura del bucket la conta come conferma dell'item.
 *
 * Modulo puro: le letture GitHub le fa il reconciler e arrivano qui gia'
 * parse.
 */
import {
  dailyBucketSourcePrNumbers,
  schedaCommand,
  stripFencedBlocks,
  updateFollowupItemState,
  parseFollowupItems,
} from '../followup-resolution-match.mjs';
import { inertCommentText, itemCiSuiteMarker } from './followup-item-evidence.mjs';

/** Il workflow della CI required e l'artifact col report JSON di vitest. */
export const CI_SUITE_WORKFLOW_FILE = 'tests.yml';
export const CI_SUITE_REPORT_ARTIFACT = 'shard-timing-related';

/** Lo step che esegue vitest nel job required (`tests.yml`: «vitest related (PR diff)»). */
export function vitestStepConclusion(steps) {
  const list = (Array.isArray(steps) ? steps : []).filter((step) => /^vitest\b/iu.test(String(step?.name ?? '')));
  return list.length === 1 ? (list[0].conclusion ?? null) : null;
}

/** Stati da cui la prova porta a `done`: `in-progress` ha un fixer al lavoro. */
const CANDIDATE_STATES = new Set(['open', 'blocked']);

// La guardia risorse locale (`bin/agent-resource-guard.mjs`), nei modi in cui
// i body delle PR la nominano.
const LOCAL_GUARD_RE = /\b(?:resource[- ]guard|guardia(?:\s+delle?)?\s+risorse|agent-resource-guard)\b/iu;
// Qualunque altro blocco nella stessa dichiarazione: un lotto o una PR da
// attendere, una decisione, una dipendenza, la produzione, un'altra issue.
const OTHER_BLOCKER_RE = /(?:#\d+|\blott[oi]\b|\bdecision[ei]\b|\bpropriet|\bowner\b|\bdipendenz|\bdeploy|\bproduzion|\bend-to-end\b|\brun naturale\b|\bdati\b|\bsecret\b|\bcredenzial|\bquota\b|\brate[- ]limit)/iu;

// L'item chiede la suite INTERA (dopo un'installazione pulita, per esempio):
// la selezione `related` della CI non la esegue, e la `COMANDO` con un solo
// file non la rappresenta. Caso reale: site#10831, FU-2026-10-02-004.
const FULL_SUITE_RE = /\b(?:full[- ]suite|suite\s+(?:completa|intera)|intera\s+suite|tutta\s+la\s+suite)\b/iu;

const SUITE_FILE_RE = /^tests\/(?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;

/** Il valore del campo `- <name>:` dell'item fuori da citazioni e blocchi di codice. */
function itemField(item, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const re = new RegExp(`^\\s*-\\s+${escaped}\\s*:\\s*(.*?)\\s*$`, 'iu');
  for (const line of stripFencedBlocks(item?.text ?? '').split('\n')) {
    if (/^\s*>/u.test(line)) continue;
    const match = re.exec(line);
    if (match) return match[1];
  }
  return '';
}

/**
 * Il blocco dell'item e' SOLO la guardia risorse locale?
 * @param {{state?: string, text?: string}} item
 * @returns {{guardOnly: boolean, why: string}}
 */
export function localGuardBlock(item) {
  if (!CANDIDATE_STATES.has(String(item?.state ?? ''))) return { guardOnly: false, why: 'state' };
  const declared = itemField(item, 'Stato dichiarato nella PR');
  const blockedOn = itemField(item, 'Blocked on');
  const primary = declared || blockedOn;
  if (!primary) return { guardOnly: false, why: 'no-declared-block' };
  if (declared && !/^`?blocked\b/iu.test(declared)) return { guardOnly: false, why: 'declared-not-blocked' };
  if (!LOCAL_GUARD_RE.test(primary)) return { guardOnly: false, why: 'not-local-guard' };
  if ([declared, blockedOn].some((text) => text && OTHER_BLOCKER_RE.test(text))) return { guardOnly: false, why: 'other-blocker' };
  return { guardOnly: true, why: 'local-guard' };
}

/**
 * I file della suite dell'item, dalla `COMANDO` della scheda. `null` se il
 * comando non e' `npx vitest run <file di test>…` e nient'altro.
 * @returns {string[]|null}
 */
export function itemSuiteFiles(item) {
  const command = schedaCommand(item?.text ?? '');
  const match = /^(?:npx\s+)?vitest\s+run\s+(.+)$/u.exec(String(command ?? '').trim());
  if (!match) return null;
  const files = match[1].trim().split(/\s+/u).map((token) => token.replace(/^\.\//u, ''));
  if (!files.length || files.some((file) => !SUITE_FILE_RE.test(file) || file.split('/').includes('..'))) return null;
  return [...new Set(files)];
}

/** La PR dell'item: esattamente una fra le `Sources`, altrimenti `null`. */
export function itemSourcePr(item) {
  const numbers = dailyBucketSourcePrNumbers(item?.raw ?? '');
  return numbers.length === 1 ? numbers[0] : null;
}

/**
 * Gli item di un corpo che questa regola puo' chiudere, con suite e PR.
 * Gli altri compaiono con il motivo per cui non sono candidati.
 * @returns {Array<{id: string, item: object, candidate: boolean, why: string, suite?: string[], pr?: number}>}
 */
export function ciSuiteCandidates(body) {
  const out = [];
  for (const item of parseFollowupItems(body)) {
    if (!item.id || !CANDIDATE_STATES.has(item.state)) continue;
    const block = localGuardBlock(item);
    if (!block.guardOnly) {
      if (block.why !== 'no-declared-block' && block.why !== 'not-local-guard' && block.why !== 'declared-not-blocked') {
        out.push({ id: item.id, item, candidate: false, why: block.why });
      }
      continue;
    }
    if (FULL_SUITE_RE.test(`${item.title ?? ''}\n${item.text ?? ''}`)) { out.push({ id: item.id, item, candidate: false, why: 'full-suite-requested' }); continue; }
    const suite = itemSuiteFiles(item);
    if (!suite) { out.push({ id: item.id, item, candidate: false, why: 'no-vitest-suite' }); continue; }
    const pr = itemSourcePr(item);
    if (!pr) { out.push({ id: item.id, item, candidate: false, why: 'no-single-source-pr' }); continue; }
    out.push({ id: item.id, item, candidate: true, why: 'local-guard', suite, pr });
  }
  return out;
}

/**
 * Esito per file dal report JSON di vitest (`--reporter=json`). `null` se il
 * report non ha la forma attesa.
 * @returns {Array<{file: string, passed: number, failed: number, skipped: number}>|null}
 */
export function suiteResultsFromVitestReport(report) {
  const list = report?.testResults;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const entry of list) {
    const file = String(entry?.name ?? '');
    if (!file) return null;
    const assertions = Array.isArray(entry?.assertionResults) ? entry.assertionResults : [];
    const count = (status) => assertions.filter((assertion) => assertion?.status === status).length;
    // Un file che fallisce prima dei test (import rotto) ha `status: failed` e zero asserzioni.
    const failed = count('failed') + (entry?.status === 'failed' && count('failed') === 0 ? 1 : 0);
    out.push({ file, passed: count('passed'), failed, skipped: assertions.length - count('passed') - count('failed') });
  }
  return out;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/gu;
// ` ✓  node  tests/x.test.ts (15 tests | 1 skipped) 44ms`, dopo il timestamp del log.
const LOG_FILE_LINE_RE = /^(?:\S+Z\s+)?\s*([✓❯×↓])\s+(?:\S+\s+)?((?:\S+\/)?tests\/\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+)\s+tests?((?:\s*\|\s*\d+\s+\w+)*)\)/u;

/**
 * Esito per file dalle righe di riepilogo del reporter `default` di vitest nel
 * log del job. `null` se il log non ne contiene nessuna (vitest non ha girato,
 * o il formato e' cambiato: «non so», mai «niente»).
 * @returns {Array<{file: string, passed: number, failed: number, skipped: number}>|null}
 */
export function suiteResultsFromJobLog(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const match = LOG_FILE_LINE_RE.exec(rawLine.replace(ANSI_RE, '').replace(/^﻿/u, ''));
    if (!match) continue;
    const [, symbol, file, total, tail] = match;
    const counts = { failed: 0, skipped: 0 };
    for (const part of tail.matchAll(/(\d+)\s+(failed|skipped|todo)/gu)) {
      if (part[2] === 'failed') counts.failed += Number(part[1]);
      else counts.skipped += Number(part[1]);
    }
    if (symbol === '❯' || symbol === '×') counts.failed = Math.max(counts.failed, 1);
    const passed = Math.max(0, Number(total) - counts.failed - counts.skipped);
    out.push({ file, passed: symbol === '↓' ? 0 : passed, failed: counts.failed, skipped: counts.skipped });
  }
  return out.length ? out : null;
}

// Il report JSON di vitest nomina i file col path assoluto del checkout del
// runner (`$GITHUB_WORKSPACE` = `/home/runner/work/<repo>/<repo>/`).
const RUNNER_WORKSPACE_RE = /^\/home\/runner\/work\/[^/]+\/[^/]+\//u;

/** Il path di un file di test relativo alla radice del repository. */
export function repoRelativeTestPath(file) {
  return String(file ?? '').replace(RUNNER_WORKSPACE_RE, '').replace(/^\.\//u, '');
}

/**
 * Esito di UN file della suite nei risultati di una run:
 * `passed` (almeno un test passato, nessun fallito), `failed`, `missing`
 * (non eseguito, o solo test saltati). Il confronto e' sul path esatto
 * relativo al repository: `packages/x/tests/a.test.ts` non e' `tests/a.test.ts`.
 */
export function suiteFileVerdict(results, file) {
  const own = (Array.isArray(results) ? results : [])
    .filter((entry) => repoRelativeTestPath(entry.file) === file);
  if (!own.length) return 'missing';
  if (own.some((entry) => entry.failed > 0)) return 'failed';
  return own.some((entry) => entry.passed > 0) ? 'passed' : 'missing';
}

/**
 * Decisione per un item. `candidates` sono le run lette: una per lo sha di
 * merge e una per l'ultima head della PR (stesso sha → una sola).
 * Ogni candidata: `{kind, sha, readError?, run: {id, conclusion}|null,
 * job: {id, conclusion, vitestStep?}|null, results: Array|null, source: 'report'|'log'|null}`.
 *
 * - `done`: una run col job required verde ha eseguito verde ogni file della
 *   suite, e nessuna run contraddice;
 * - `waiting`: la prova manca o e' contraddetta (`why`);
 * - `unknown`: una lettura e' fallita.
 * @returns {{outcome: 'done'|'waiting'|'unknown', why: string, proof?: object}}
 */
export function decideCiSuiteProof({ suite, candidates }) {
  const files = Array.isArray(suite) ? suite : [];
  if (!files.length) return { outcome: 'waiting', why: 'no-vitest-suite' };
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { outcome: 'waiting', why: 'no-ci-run' };
  if (list.some((candidate) => candidate?.readError)) return { outcome: 'unknown', why: 'ci-read-unavailable' };
  let proof = null;
  let sawRun = false;
  let sawGreen = false;
  for (const candidate of list) {
    if (!candidate?.run || !candidate.job) continue;
    sawRun = true;
    const readable = Array.isArray(candidate.results);
    const verdicts = readable ? files.map((file) => suiteFileVerdict(candidate.results, file)) : null;
    if (verdicts?.includes('failed')) return { outcome: 'waiting', why: 'suite-failed' };
    const allPassed = Boolean(verdicts && verdicts.every((verdict) => verdict === 'passed'));
    if (candidate.job.conclusion !== 'success') {
      // Rosso altrove e' tollerato solo se si legge che la suite dell'item e'
      // passata, o se vitest non ha girato affatto (step `skipped`).
      if (!allPassed && candidate.job.vitestStep !== 'skipped') return { outcome: 'waiting', why: 'red-run' };
      continue;
    }
    sawGreen = true;
    if (!readable) continue;
    if (allPassed && !proof) {
      proof = {
        kind: candidate.kind,
        sha: candidate.sha,
        run: candidate.run.id,
        job: candidate.job.id,
        source: candidate.source,
        files,
      };
    }
  }
  if (proof) return { outcome: 'done', why: 'ci-suite-green', proof };
  if (!sawRun) return { outcome: 'waiting', why: 'no-ci-run' };
  if (!sawGreen) return { outcome: 'waiting', why: 'red-run' };
  return { outcome: 'waiting', why: list.some((candidate) => candidate?.job?.conclusion === 'success' && !Array.isArray(candidate.results)) ? 'ci-results-unreadable' : 'suite-not-run' };
}

/** La run piu' recente e COMPLETATA fra quelle di uno sha (`workflow_runs` dell'API). */
export function latestCompletedRun(runs) {
  const done = (Array.isArray(runs) ? runs : []).filter((run) => run?.status === 'completed' && Number.isSafeInteger(Number(run?.id)));
  done.sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) || Number(b.id) - Number(a.id));
  return done[0] ?? null;
}

/**
 * Le run candidate di una PR, lette con i lettori iniettati:
 * - `pull(n)` → `{status: 'ok', merged, mergeSha, headSha}` | `{status: 'error'}`;
 * - `latestRun(sha)` → `{status: 'ok', run: {id, conclusion}|null}` | `{status: 'error'}`;
 * - `vitestJob(runId)` → `{status: 'ok', job: {id, conclusion}|null}` | `{status: 'error'}`;
 * - `results(runId, jobId)` → `{status: 'ok', results: Array|null, source}` | `{status: 'error'}`.
 * Ogni `status` diverso da `ok` (anche `budget`) e' una lettura fallita.
 * @returns {{status: 'ok', candidates: object[]}|{status: 'not-merged'|'error'}}
 */
export function readCiSuiteCandidates(prNumber, readers) {
  const call = (name, ...args) => {
    try {
      return typeof readers?.[name] === 'function' ? readers[name](...args) : { status: 'error' };
    } catch {
      return { status: 'error' };
    }
  };
  const pull = call('pull', prNumber);
  if (pull?.status !== 'ok') return { status: 'error' };
  if (!pull.merged) return { status: 'not-merged' };
  const shas = [];
  for (const [kind, sha] of [['merge', pull.mergeSha], ['head', pull.headSha]]) {
    if (SHA_RE.test(String(sha ?? '')) && !shas.some((entry) => entry.sha === sha)) shas.push({ kind, sha });
  }
  if (!shas.length) return { status: 'error' };
  const candidates = [];
  for (const { kind, sha } of shas) {
    const runRead = call('latestRun', sha);
    if (runRead?.status !== 'ok') { candidates.push({ kind, sha, readError: true }); continue; }
    if (!runRead.run) { candidates.push({ kind, sha, run: null, job: null, results: null, source: null }); continue; }
    const jobRead = call('vitestJob', runRead.run.id);
    if (jobRead?.status !== 'ok') { candidates.push({ kind, sha, readError: true }); continue; }
    if (!jobRead.job) { candidates.push({ kind, sha, run: runRead.run, job: null, results: null, source: null }); continue; }
    const resultsRead = call('results', runRead.run.id, jobRead.job.id);
    if (resultsRead?.status !== 'ok') { candidates.push({ kind, sha, readError: true }); continue; }
    candidates.push({
      kind,
      sha,
      run: runRead.run,
      job: jobRead.job,
      results: Array.isArray(resultsRead.results) ? resultsRead.results : null,
      source: resultsRead.source ?? null,
    });
  }
  return { status: 'ok', candidates };
}

/**
 * Il piano di UN bucket: per ogni item bloccato solo dalla guardia locale,
 * `done` con la prova, `waiting` o `unknown`. Non scrive nulla.
 * Salta i padri decomposti (il lavoro e' nelle figlie) e i bucket di un altro
 * repository (le `Sources` sono PR del repository del bucket).
 * @returns {{skipped: string|null, results: Array<object>}}
 */
export function planCiSuiteProof({ body, labels = [], readers, targetRepository = '', localRepository = '' }) {
  if ((Array.isArray(labels) ? labels : []).includes('decomposed:1')) return { skipped: 'decomposed', results: [] };
  const target = String(targetRepository ?? '').trim().toLowerCase();
  const local = String(localRepository ?? '').trim().toLowerCase();
  if (!target || !local || target !== local) return { skipped: 'foreign-target-repository', results: [] };
  const results = [];
  for (const entry of ciSuiteCandidates(body)) {
    const base = { id: entry.id, item: entry.item, pr: entry.pr ?? null, suite: entry.suite ?? null };
    if (!entry.candidate) { results.push({ ...base, outcome: 'waiting', why: entry.why }); continue; }
    const read = readCiSuiteCandidates(entry.pr, readers);
    if (read.status === 'not-merged') { results.push({ ...base, outcome: 'waiting', why: 'pr-not-merged' }); continue; }
    if (read.status !== 'ok') { results.push({ ...base, outcome: 'unknown', why: 'ci-read-unavailable' }); continue; }
    results.push({ ...base, ...decideCiSuiteProof({ suite: entry.suite, candidates: read.candidates }) });
  }
  return { skipped: null, results };
}

/**
 * Il corpo con gli item provati portati a `done`: solo item ancora `open`/
 * `blocked` e ancora bloccati SOLO dalla guardia locale (riclassificati qui).
 */
export function applyCiSuiteProof(body, ids = []) {
  let next = String(body ?? '');
  const applied = [];
  for (const id of ids) {
    const current = parseFollowupItems(next).find((item) => item.id === id);
    if (!current || !localGuardBlock(current).guardOnly) continue;
    const updated = updateFollowupItemState(next, id, 'done');
    if (updated && updated !== next) { next = updated; applied.push(id); }
  }
  return { body: next, applied };
}

/** Il commento della prova (marker in testa); `proof.sha` deve essere uno sha completo. */
export function ciSuiteProofCommentBody({ id, pr, proof, repository = '' }) {
  if (!SHA_RE.test(String(proof?.sha ?? ''))) throw new TypeError(`sha-invalido:${String(proof?.sha)}`);
  const repo = inertCommentText(repository);
  const runRef = repo ? `[run ${proof.run}](https://github.com/${repo}/actions/runs/${proof.run}/job/${proof.job})` : `run ${proof.run}, job ${proof.job}`;
  const where = proof.kind === 'merge' ? 'sullo sha di merge' : "sull'ultima head";
  const source = proof.source === 'report' ? 'report JSON di vitest' : 'righe per file del log del job';
  return [
    itemCiSuiteMarker({ item: id, pr, commit: proof.sha, run: proof.run, job: proof.job }),
    `✅ **Item \`${id}\` → \`done\`** (decisione I4 del 2026-10-05): il blocco dichiarato era solo la guardia risorse locale, e la CI required della PR #${Number(pr)} ${where} \`${String(proof.sha).slice(0, 12)}\` (${runRef}, job \`vitest (unit + integration)\` verde) ha eseguito verde la suite dell'item (${source}):`,
    ...proof.files.map((file) => `- \`${inertCommentText(file)}\``),
  ].join('\n');
}

/**
 * Riga di riepilogo: `ci_suite_done=<n> waiting=<ID:motivo,…> unknown=<n>`.
 */
export function ciSuiteProofSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const waiting = list.filter((entry) => entry.outcome === 'waiting').map((entry) => `${entry.id}:${entry.why}`);
  return `ci_suite_done=${list.filter((entry) => entry.outcome === 'done').length} waiting=${waiting.length ? waiting.join(',') : '-'} unknown=${list.filter((entry) => entry.outcome === 'unknown').length}`;
}
