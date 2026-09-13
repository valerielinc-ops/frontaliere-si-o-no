/**
 * Native auto-merge guard.
 *
 * GitHub's native auto-merge remains the merger. This helper is only the
 * fail-closed opt-in gate: it must see the latest reviewer-bot verdict on the
 * current HEAD and a completed required Vitest check before calling
 * `gh pr merge --auto`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isReviewerBot,
  REDFLAG_IMPORTANT_RE,
  VITEST_CHECK_NAME,
} from './lib/constants.mjs';

const NIT_MARKER_RE = /^[^\n🔴🟢]*(?<!`)🟡\s*\*{0,2}\s*Nit\s*\*{0,2}\s*[:—-]/mu;
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function reviewTimestamp(review) {
  const raw = review?.submitted_at || review?.created_at || '';
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Return the latest reviewer-bot review that is anchored to `head`. */
export function latestBotReviewOnHead(reviews, head) {
  if (!Array.isArray(reviews) || typeof head !== 'string' || !head) return null;
  const candidates = flattenPages(reviews)
    .map((review, index) => ({ review, index, timestamp: reviewTimestamp(review) }))
    .filter(({ review, timestamp }) => isReviewerBot(review?.user) && review?.commit_id === head
      && timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp
      || Number(left.review.id || left.index) - Number(right.review.id || right.index));
  return candidates.at(-1)?.review || null;
}

/** Require the explicit reviewer summary, rather than inferring zero findings. */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  const findingsHeading = body.split(/\r?\n/).find((line) => FINDINGS_HEADING_RE.test(line));
  if (!findingsHeading) return false;
  return /\bImportant\s*:\s*0\b/i.test(findingsHeading)
    && /\bNit\s*:\s*0\b/i.test(findingsHeading)
    && !REDFLAG_IMPORTANT_RE.test(body)
    && !NIT_MARKER_RE.test(body);
}

export function reviewHasLgtm(body) {
  return typeof body === 'string' && LGTM_HEADING_RE.test(body);
}

export function reviewIsApprovedOnHead(review, head) {
  if (!review || review.commit_id !== head) return false;
  if (!isReviewerBot(review.user)) return false;
  if (!['APPROVED', 'COMMENTED'].includes(String(review.state || '').toUpperCase())) return false;
  return reviewHasZeroFindings(review.body) && reviewHasLgtm(review.body);
}

/** Select the newest completed required check; an active run always blocks. */
export function requiredVitestDecision(checkRuns, head) {
  if (!Array.isArray(checkRuns) || typeof head !== 'string' || !head) {
    return { allow: false, reason: 'check-runs non verificabili' };
  }
  const runs = checkRuns.filter((check) => check?.name === VITEST_CHECK_NAME && check.head_sha === head);
  if (runs.length === 0) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} assente sulla HEAD` };
  }
  if (runs.some((check) => check.status !== 'completed')) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} pending sulla HEAD` };
  }
  if (runs.some((check) => !check.conclusion || !Number.isFinite(Date.parse(check.completed_at || '')))) {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} senza verdetto completato` };
  }
  const latest = [...runs].sort(
    (left, right) => Date.parse(left.completed_at) - Date.parse(right.completed_at),
  ).at(-1);
  if (latest.conclusion !== 'success') {
    return { allow: false, reason: `check required ${VITEST_CHECK_NAME} conclusion=${latest.conclusion}` };
  }
  return { allow: true, reason: `${VITEST_CHECK_NAME} success sulla HEAD` };
}

/** Pure decision function used by the workflow and deterministic tests. */
export function evaluateNativeAutoMerge({ pr, reviews, checkRuns } = {}) {
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return { allow: false, reason: 'PR non aperta, draft o non basata su main' };
  }
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid) {
    return { allow: false, reason: 'HEAD SHA mancante' };
  }
  if (!Object.hasOwn(pr, 'autoMergeRequest')) {
    return { allow: false, reason: 'stato auto-merge non verificabile' };
  }
  if (pr.autoMergeRequest !== null) {
    return { allow: false, reason: 'native auto-merge già abilitato' };
  }

  const review = latestBotReviewOnHead(reviews, pr.headRefOid);
  if (!review) {
    return { allow: false, reason: 'nessuna review bot con exact-head verificabile' };
  }
  if (!reviewIsApprovedOnHead(review, pr.headRefOid)) {
    return { allow: false, reason: 'ultima review bot exact-head non è Important 0/Nit 0 + LGTM' };
  }

  const check = requiredVitestDecision(checkRuns, pr.headRefOid);
  if (!check.allow) return check;
  return {
    allow: true,
    reason: `review exact-head ✔; ${check.reason}`,
    reviewId: review.id,
  };
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  }));
}

function loadReviews(repo, pr) {
  return flattenPages(ghJson([
    'api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp',
  ]));
}

function loadCheckRuns(repo, head) {
  const pages = ghJson([
    'api', `repos/${repo}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp',
  ]);
  return (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
}

function skip(reason) {
  console.log(`Native auto-merge guard: ${reason} — nessun merge.`);
}

function main() {
  const repo = process.argv[2] || process.env.REPOSITORY || process.env.GITHUB_REPOSITORY || '';
  const prNumber = process.argv[3] || process.env.PR_NUMBER || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(prNumber)) {
    return skip('target PR mancante o non valido');
  }

  let pr;
  try {
    pr = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'number,state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: impossibile leggere PR #${prNumber}: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== 'main') {
    return skip('PR non aperta, draft o non basata su main');
  }
  if (pr.autoMergeRequest !== null) return skip('native auto-merge già abilitato');

  let reviews;
  let checkRuns;
  try {
    reviews = loadReviews(repo, prNumber);
    checkRuns = loadCheckRuns(repo, pr.headRefOid);
  } catch (error) {
    console.error(`::error::native auto-merge guard: lettura review/check fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }

  const decision = evaluateNativeAutoMerge({ pr, reviews, checkRuns });
  console.log(`Native auto-merge guard PR #${prNumber} HEAD=${pr.headRefOid}: ${decision.reason}`);
  if (!decision.allow) return;

  // Close the head race between the reads and the native opt-in. A new HEAD
  // invalidates the exact-head review/check pair and must be re-evaluated.
  let current;
  try {
    current = ghJson(['pr', 'view', prNumber, '--repo', repo, '--json',
      'state,isDraft,baseRefName,headRefOid,autoMergeRequest']);
  } catch (error) {
    console.error(`::error::native auto-merge guard: conferma HEAD fallita: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
    return;
  }
  if (current.state !== 'OPEN' || current.isDraft !== false || current.baseRefName !== 'main'
    || current.headRefOid !== pr.headRefOid) {
    return skip('HEAD/stato cambiato dopo i gate; serve una nuova review exact-head');
  }
  if (current.autoMergeRequest !== null) return skip('native auto-merge già abilitato durante la verifica');

  try {
    execFileSync('gh', [
      'pr', 'merge', prNumber, '--repo', repo, '--auto', '--squash', '--delete-branch',
    ], { encoding: 'utf8', stdio: 'inherit', env: { ...process.env } });
  } catch (error) {
    console.error(`::error::native auto-merge opt-in fallito: ${String(error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
