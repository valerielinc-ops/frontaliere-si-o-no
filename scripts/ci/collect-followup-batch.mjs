/**
 * collect-followup-batch.mjs — produce the FINAL batch of merged PRs to triage in
 * ONE scheduled Claude session (zero-Claude, deterministico).
 *
 * `post-merge-followup.yml` was triggered `pull_request:[closed]` → UNA run Claude
 * (sonnet, ~20 turni) per OGNI PR mergiata dall'owner. Il ~60-80% di quelle run
 * creava ZERO issue (i due gate per-PR `is-followup-fix-pr.mjs` /
 * `followup-has-candidates.mjs` arrivavano dopo aver già speso una run, oppure il
 * triage girava a vuoto). Sulla quota Max OAuth CONDIVISA con la sessione interattiva
 * owner (AGENTS.md § frugalità) è il #2 consumatore. Questo script converte il modello
 * a SCHEDULED-BATCH: una sola sessione ogni ~3h triagia tutte le PR mergiate dalla
 * finestra precedente.
 *
 * SICUREZZA > VELOCITÀ — mai perdere un follow-up:
 *  - **Watermark = ultima run di SUCCESSO** di questo workflow (non l'ultima run).
 *    Una run fallita NON avanza il watermark → la finestra viene ri-coperta dalla
 *    run schedulata successiva = nessuna perdita (at-least-once by-construction).
 *    Fallback se nessun successo storico: now − 6h (2× la cadenza cron = margine).
 *  - **Idempotenza:** scarta le PR che hanno GIÀ un commento
 *    `## Post-merge follow-up triage` (il marker che Claude posta su OGNI PR
 *    processata) → niente doppio-triage sulla finestra di overlap.
 *    Una PR di fix daily con `Addresses` + `Follow-up item: FU-...` è l'unica
 *    eccezione al grandchild gate: passa per cercare finding nuovi nel bucket padre.
 *  - **Gate per-PR riusati BYTE-PER-BYTE:** ogni candidato passa per i due gate
 *    deterministici esistenti, invocati come subprocess (`is-followup-fix-pr.mjs`
 *    grandchild-suppression + `followup-has-candidates.mjs` no-op), così il risparmio
 *    dei gate è preservato anche nel modello batch. Tieni solo le PR che passano
 *    ENTRAMBI (mirror esatto dell'`if:` che il workflow aveva sullo step Claude).
 *  - **PROCEED-SAFE per i gate per-PR:** un gate inconcludente lascia la PR nel
 *    batch (mai persa). Le sorgenti della raccolta — watermark, elenco paginato e
 *    commenti — invece falliscono chiuse: un output vuoto non può mascherare un
 *    errore e far avanzare il watermark.
 *
 * Output (GITHUB_OUTPUT): `collection_ok=true|false`, `batch_prs=<csv di numeri>`,
 *   `batch_count=<n>`, `max_turns=<n>` e `daily_key=YYYY-MM-DD` (giorno di triage
 *   riuscito in Zurich).
 *
 * Uso:  node scripts/ci/collect-followup-batch.mjs
 * Env:  GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz),
 *       FALLBACK_HOURS (opz, default 6).
 *       Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dailyKeyZurich } from './followup-resolution-match.mjs';

const WORKFLOW = 'post-merge-followup.yml';
const TRIAGE_COMMENT_PREFIX = '## Post-merge follow-up triage';
const FALLBACK_HOURS = Number(process.env.FALLBACK_HOURS) || 6;
const SEARCH_PAGE_SIZE = 100;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const repoArgs = REPO
  ? ['--repo', REPO]
  : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// ── Pure helpers (no I/O) → unit-testable ───────────────────────────

/**
 * Eligible PR authors. The `pull_request` trigger filtered on the REST
 * `user.login` form (`valerielinc-ops` / `frontaliere-automation[bot]`); the batch
 * model reads authors via `gh pr list --json author`, whose GraphQL form prefixes
 * apps with `app/` and drops `[bot]` (e.g. `app/frontaliere-automation`). We
 * canonicalise both forms to a bare login so the allowlist matches regardless of
 * source — same author SCOPE as the original trigger, no expansion.
 */
const ELIGIBLE_AUTHORS = new Set(['valerielinc-ops', 'frontaliere-automation']);

/** Strip the `app/` prefix (gh GraphQL bot form) and `[bot]` suffix (REST form). */
export function canonicalLogin(login) {
  return String(login || '').trim().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/**
 * Watermark = start of the LAST SUCCESSFUL run of this workflow. A failed run does
 * NOT advance it → the window is re-covered next time (no follow-up lost). Prefers
 * `startedAt`, falls back to `createdAt`, then to now − FALLBACK_HOURS.
 * @param {string} runListJson  output of `gh run list ... --json createdAt,startedAt`
 * @param {number} [nowMs]
 * @param {number} [fallbackHours]
 * @returns {string} ISO8601
 */
export function computeWatermarkISO(runListJson, nowMs = Date.now(), fallbackHours = FALLBACK_HOURS) {
  let runs = [];
  try {
    runs = JSON.parse(runListJson || '[]');
  } catch {
    runs = [];
  }
  const r = Array.isArray(runs) && runs.length ? runs[0] : null;
  const ts = r && (r.startedAt || r.createdAt);
  if (ts && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return new Date(nowMs - fallbackHours * 3600_000).toISOString();
}

/**
 * Validate the successful-run response before it is allowed to define a
 * watermark. An empty list is a valid first run; a non-empty list with an
 * unreadable first timestamp is an incomplete API response and must block the
 * collector instead of silently falling back to now-minus-six-hours.
 *
 * @param {string} runListJson
 * @returns {Array<{createdAt?:string,startedAt?:string}>|null}
 */
export function parseSuccessfulRunList(runListJson) {
  let runs;
  try {
    runs = JSON.parse(runListJson || '');
  } catch {
    return null;
  }
  if (!Array.isArray(runs)) return null;
  if (!runs.length) return runs;
  const first = runs[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const timestamp = first.startedAt || first.createdAt;
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return null;
  return runs;
}

/**
 * Parse one complete `gh api --paginate --slurp search/issues` response. Search API
 * caps a query at 1,000 results; a short page set or `incomplete_results` is therefore
 * an error, not an empty collection. The caller must keep the watermark unchanged.
 *
 * @param {string} searchPagesJson
 * @returns {Array<{number:number,title?:string,author?:{login:string},mergedAt?:string,headRefName?:string}>|null}
 */
export function parseMergedPRPages(searchPagesJson) {
  let pages;
  try {
    pages = JSON.parse(searchPagesJson || '');
  } catch {
    return null;
  }
  if (!Array.isArray(pages) || !pages.length) return null;
  const records = [];
  const seen = new Set();
  let totalCount = null;
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)
        || page.incomplete_results !== false || !Array.isArray(page.items)) return null;
    const pageTotal = Number(page.total_count);
    if (!Number.isInteger(pageTotal) || pageTotal < 0) return null;
    if (totalCount === null) totalCount = pageTotal;
    if (pageTotal !== totalCount) return null;
    for (const item of page.items) {
      const number = Number(item?.number);
      const login = item?.user?.login;
      const mergedAt = item?.pull_request?.merged_at;
      if (!Number.isInteger(number) || number <= 0 || typeof login !== 'string' || !login.trim()
          || typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) return null;
      if (seen.has(number)) return null;
      seen.add(number);
      records.push({
        number,
        title: item.title,
        author: { login },
        mergedAt,
        headRefName: item?.head?.ref || '',
      });
    }
  }
  return totalCount === records.length ? records : null;
}

/**
 * Parse a legacy `gh pr list --json number,title,author,mergedAt,headRefName` payload
 * and keep only eligible-author PRs. This pure compatibility helper remains lenient;
 * the CLI uses `parseMergedPRPages()` above and fails closed before calling it.
 * @param {string} prListJson
 * @returns {Array<{number:number, title?:string, headRefName?:string}>}
 */
export function parseMergedPRs(prListJson) {
  let prs = [];
  try {
    prs = JSON.parse(prListJson || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];
  return prs.filter((pr) => pr && pr.author && ELIGIBLE_AUTHORS.has(canonicalLogin(pr.author.login)));
}

/**
 * True if the PR already carries a `## Post-merge follow-up triage` comment (any
 * variant: the normal summary, "zero outstanding items", "(backfill skipped)"). The
 * comment is the idempotency marker Claude posts on EVERY processed PR.
 * Proceed-safe: parse error → false (NOT deduped → PR stays a candidate).
 * @param {string} commentsJson  output of `gh pr view N --json comments`
 * @param {string} [prefix]
 * @returns {boolean}
 */
export function hasTriageComment(commentsJson, prefix = TRIAGE_COMMENT_PREFIX) {
  let data;
  try {
    data = JSON.parse(commentsJson || '');
  } catch {
    return false;
  }
  const comments = Array.isArray(data) ? data : data && Array.isArray(data.comments) ? data.comments : [];
  return comments.some((c) => typeof c?.body === 'string' && c.body.trimStart().startsWith(prefix));
}

/**
 * Turni Claude proporzionati al batch: min(26 + 8*n, 80), floor 26 (mai abbassare).
 * Era min(20+6n,60) — bump fleet-wide 2026-07-17 (owner) di tutti i cap max-turns
 * Claude dopo l'ennesimo error_max_turns (cap = anti-runaway, non budget di lavoro).
 */
export function maxTurnsFor(batchCount) {
  return Math.min(26 + 8 * Math.max(0, Number(batchCount) || 0), 80);
}

/**
 * The bucket key belongs to the triage run, not to an individual merge event. An
 * explicit value is accepted for workflow retries/tests, while the default is the
 * current successful triage day in Europe/Zurich.
 */
export function triageDailyKey(nowMs = Date.now()) {
  return process.env.TRIAGE_DAILY_KEY || dailyKeyZurich(nowMs);
}

/**
 * Keep ordinary follow-up fixes out of the batch, but let a marker-complete daily
 * partial fix reach the parent-bucket triage path. Unknown gate results stay fail-open.
 */
export function shouldTriageAfterFixGate({ isFollowupFix, followupPartial } = {}) {
  return isFollowupFix !== true || followupPartial === true;
}

/**
 * A marker-complete daily partial fix must still reach Claude even when the
 * source PR has no ordinary `## Non implementato`/reviewer candidate. Its
 * purpose is to inspect the fix PR for genuinely new findings and append them
 * to the parent bucket; the no-op gate cannot see that parent-bucket contract.
 */
export function shouldTriageAfterCandidateGate({ hasCandidates, followupPartial } = {}) {
  return hasCandidates !== false || followupPartial === true;
}

// ── I/O helpers ─────────────────────────────────────────────────────

/**
 * Invoke an existing per-PR gate script as a subprocess. GITHUB_OUTPUT/STEP_SUMMARY
 * are blanked for the child so it only prints to stdout (no pollution of OUR outputs).
 * @returns {string|null} stdout, or null when inconclusive (proceed-safe).
 */
function runGateOutput(scriptName, prNumber) {
  try {
    return execFileSync('node', [path.join(HERE, scriptName)], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PR_NUMBER: String(prNumber), GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
    });
  } catch {
    return null; // proceed-safe: gate crash → inconclusive → caller includes the PR.
  }
}

function gateBoolean(output, outputKey) {
  if (output === null) return null;
  const m = new RegExp(`(?:^|\\n)${outputKey}=(true|false)(?:\\n|$)`).exec(output);
  return m ? m[1] === 'true' : null;
}

function runGate(scriptName, prNumber, outputKey) {
  return gateBoolean(runGateOutput(scriptName, prNumber), outputKey);
}

function emit(batch, dailyKey = triageDailyKey(), { collectionOk = true } = {}) {
  const csv = batch.join(',');
  const count = batch.length;
  const ok = collectionOk === true;
  const maxTurns = maxTurnsFor(count);
  console.log(`collection_ok=${ok}`);
  console.log(`batch_count=${count}`);
  console.log(`batch_prs=${csv}`);
  console.log(`max_turns=${maxTurns}`);
  console.log(`daily_key=${dailyKey}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `collection_ok=${ok}\nbatch_prs=${csv}\nbatch_count=${count}\nmax_turns=${maxTurns}\ndaily_key=${dailyKey}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Follow-up batch collected: ${count} PR\nDaily key: ${dailyKey} (Europe/Zurich).\n` +
      (count ? `PR: ${csv} — max-turns ${maxTurns}.\n` : `Nessuna PR da triagiare in questa finestra.\n`),
    );
  }
}

export function main() {
  const dailyKey = triageDailyKey();
  if (!REPO) throw new Error('GH_REPO/GITHUB_REPOSITORY mancante: raccolta non verificabile');
  console.log(`Daily key (successful triage day, Europe/Zurich): ${dailyKey}`);
  // 1. Watermark = start of the last SUCCESSFUL run (failed run → re-covered later).
  const runListRaw = gh([
    'run', 'list', `--workflow=${WORKFLOW}`, '--status', 'success',
    '--json', 'createdAt,startedAt', '--limit', '1', ...repoArgs,
  ]);
  if (runListRaw === null) throw new Error('gh run list non riuscita: watermark non verificabile');
  const successfulRuns = parseSuccessfulRunList(runListRaw);
  if (!successfulRuns) throw new Error('risposta gh run list non parsabile/incompleta: watermark non verificabile');
  const watermark = computeWatermarkISO(runListRaw);
  console.log(`Watermark (last successful run start, fallback now-${FALLBACK_HOURS}h): ${watermark}`);

  // 2. Merged PRs since the watermark, eligible authors only.
  // Search API pagination has an explicit total_count, unlike `gh pr list --limit`
  // which silently truncated the batch at 100 results and advanced the watermark.
  const query = `repo:${REPO} is:pr is:merged merged:>=${watermark}`;
  const prListRaw = gh([
    'api', `search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}`,
    '--paginate', '--slurp', ...repoArgs,
  ]);
  if (prListRaw === null) throw new Error('gh api search PR non riuscita: elenco incompleto');
  const mergedPages = parseMergedPRPages(prListRaw);
  if (!mergedPages) throw new Error('risposta paginata PR incompleta/non verificabile');
  const candidates = parseMergedPRs(JSON.stringify(mergedPages));
  console.log(`Merged PRs since watermark (eligible authors): ${candidates.length}`);

  const batch = [];
  for (const pr of candidates) {
    const n = pr.number;

    // Idempotency: already triaged?
    const commentsRaw = gh(['pr', 'view', String(n), ...repoArgs, '--json', 'comments']);
    if (commentsRaw === null) throw new Error(`commenti PR #${n} non leggibili: raccolta incompleta`);
    let commentsPayload;
    try { commentsPayload = JSON.parse(commentsRaw); } catch { commentsPayload = null; }
    if (!Array.isArray(commentsPayload)
        && !(commentsPayload && Array.isArray(commentsPayload.comments))) {
      throw new Error(`commenti PR #${n} non parsabili: raccolta incompleta`);
    }
    if (hasTriageComment(commentsRaw)) {
      console.log(`PR #${n}: already has '${TRIAGE_COMMENT_PREFIX}' comment → skip (idempotent).`);
      continue;
    }

    // Gate 1: grandchild-suppression. true → it's a follow-up fix → skip.
    const fixGateOutput = runGateOutput('is-followup-fix-pr.mjs', n);
    const isFix = gateBoolean(fixGateOutput, 'is_followup_fix');
    const isPartialDailyFix = gateBoolean(fixGateOutput, 'followup_partial');
    if (!shouldTriageAfterFixGate({ isFollowupFix: isFix, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: follow-up FIX (grandchild-suppression) → skip.`);
      continue;
    }
    if (isFix === null) console.log(`PR #${n}: grandchild gate inconclusive — PROCEED-SAFE (keep).`);
    if (isFix === true && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX → keep for parent-bucket triage; no grandchild issue.`);
    }

    // Gate 2: no-op candidate pre-gate. false → nothing to triage → skip.
    const hasCand = runGate('followup-has-candidates.mjs', n, 'has_candidates');
    if (!shouldTriageAfterCandidateGate({ hasCandidates: hasCand, followupPartial: isPartialDailyFix })) {
      console.log(`PR #${n}: no plausible candidate (no-op gate) → skip.`);
      continue;
    }
    if (hasCand === false && isPartialDailyFix === true) {
      console.log(`PR #${n}: partial daily follow-up FIX has no ordinary candidate → keep to inspect parent bucket for new findings.`);
    }
    if (hasCand === null) console.log(`PR #${n}: candidate gate inconclusive — PROCEED-SAFE (keep).`);

    batch.push(n);
    console.log(`PR #${n}: passes both gates → added to batch.`);
  }

  emit(batch, dailyKey);
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// An uncaught collection error emits an explicit failed output and exits nonzero;
// the workflow verifier then fails the job, so the success watermark cannot advance.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`collect-followup-batch: unexpected error (${e?.message || e}) — collection_ok=false, watermark invariato.`);
    try { emit([], triageDailyKey(), { collectionOk: false }); } catch (emitError) {
      console.error(`collect-followup-batch: impossibile scrivere gli output di errore (${emitError?.message || emitError}).`);
    }
    process.exitCode = 1;
  }
}
