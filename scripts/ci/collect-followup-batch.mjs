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
 *  - **PROCEED-SAFE:** errore di query/parse su una singola PR (lista, commenti,
 *    gate inconcludente) → la PR viene INCLUSA nel batch (mai escludere per dubbio),
 *    con motivo loggato. Meglio una run Claude in più che perdere un follow-up.
 *
 * Output (GITHUB_OUTPUT): `batch_prs=<csv di numeri>`, `batch_count=<n>`,
 *   `max_turns=<n>` e `daily_key=YYYY-MM-DD` (giorno di triage riuscito in Zurich).
 *
 * Uso:  node scripts/ci/collect-followup-batch.mjs
 * Env:  GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz),
 *       FALLBACK_HOURS (opz, default 6), PR_LIMIT (opz, default 100).
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
const PR_LIMIT = Number(process.env.PR_LIMIT) || 100;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const repoArgs = (process.env.GH_REPO || process.env.GITHUB_REPOSITORY)
  ? ['--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY]
  : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return ''; // proceed-safe: any gh fault → caller treats as "can't confirm".
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
 * Parse `gh pr list --json number,title,author,mergedAt,headRefName` and keep only
 * eligible-author PRs. Proceed-safe: unparseable list → [] (the run logs it; the
 * next scheduled run re-covers the window since the watermark didn't advance).
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

function emit(batch, dailyKey = triageDailyKey()) {
  const csv = batch.join(',');
  const count = batch.length;
  const maxTurns = maxTurnsFor(count);
  console.log(`batch_count=${count}`);
  console.log(`batch_prs=${csv}`);
  console.log(`max_turns=${maxTurns}`);
  console.log(`daily_key=${dailyKey}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `batch_prs=${csv}\nbatch_count=${count}\nmax_turns=${maxTurns}\ndaily_key=${dailyKey}\n`,
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
  console.log(`Daily key (successful triage day, Europe/Zurich): ${dailyKey}`);
  // 1. Watermark = start of the last SUCCESSFUL run (failed run → re-covered later).
  const runListRaw = gh([
    'run', 'list', `--workflow=${WORKFLOW}`, '--status', 'success',
    '--json', 'createdAt,startedAt', '--limit', '1', ...repoArgs,
  ]);
  const watermark = computeWatermarkISO(runListRaw);
  console.log(`Watermark (last successful run start, fallback now-${FALLBACK_HOURS}h): ${watermark}`);

  // 2. Merged PRs since the watermark, eligible authors only.
  const prListRaw = gh([
    'pr', 'list', '--state', 'merged', '--search', `merged:>=${watermark}`,
    '--json', 'number,title,author,mergedAt,headRefName', '--limit', String(PR_LIMIT), ...repoArgs,
  ]);
  const candidates = parseMergedPRs(prListRaw);
  console.log(`Merged PRs since watermark (eligible authors): ${candidates.length}`);

  const batch = [];
  for (const pr of candidates) {
    const n = pr.number;

    // Idempotency: already triaged?
    const commentsRaw = gh(['pr', 'view', String(n), ...repoArgs, '--json', 'comments']);
    if (commentsRaw && hasTriageComment(commentsRaw)) {
      console.log(`PR #${n}: already has '${TRIAGE_COMMENT_PREFIX}' comment → skip (idempotent).`);
      continue;
    }
    if (!commentsRaw) {
      console.log(`PR #${n}: comments unreadable — PROCEED-SAFE (treat as not-yet-triaged).`);
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
// uncaught error → emit an empty batch (no run; the watermark holds → next
// scheduled run re-covers the window, nothing lost).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.log(`collect-followup-batch: unexpected error (${e?.message || e}) — emitting empty batch (window re-covered next run).`);
    emit([], triageDailyKey());
  }
}
