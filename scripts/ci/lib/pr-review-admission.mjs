#!/usr/bin/env node
/**
 * One terminal managed review per PR HEAD.
 *
 * `edited` (title/body) and a retried `tests` run are not a new contribution.
 * PRs #9066/#9074 posted a clean `## LGTM` and then a later `🔴 Important` on
 * the same SHA because the YAML guard forced a full model review on every
 * `edited` event. The first terminal verdict on the current HEAD is the only
 * one that may skip, approve, or start the 🔴 fixer.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isReviewerBot, REDFLAG_IMPORTANT_RE } from './constants.mjs';

export const CODEX_FALLBACK_REVIEW_MARKER = '<!-- CODEX_FALLBACK_REVIEW -->';
export const TEST_ONLY_REVIEW_MARKER = '<!-- TEST_ONLY_AUTOMATIC_REVIEW -->';
const CODEX_FALLBACK_REVIEWER_RE = /^github-actions\[bot\]$/i;
const TEST_ONLY_REVIEW_BOT_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/i;
const FINDINGS_HEADING_RE = /^\s{0,3}#{1,3}\s+Findings\b[^\n]*$/i;
const LGTM_HEADING_RE = /^\s{0,3}##\s+LGTM\s*$/m;
const TERMINAL_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
const NON_TERMINAL_STATES = new Set(['PENDING', 'DISMISSED']);

export function flattenReviewPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function reviewBody(review) {
  return String(review?.body || '');
}

export function isManagedReviewer(review) {
  if (isReviewerBot(review?.user)) return true;
  const login = review?.user?.login || '';
  const body = reviewBody(review);
  if (CODEX_FALLBACK_REVIEWER_RE.test(login) && body.includes(CODEX_FALLBACK_REVIEW_MARKER)) {
    return true;
  }
  return TEST_ONLY_REVIEW_BOT_RE.test(login) && body.includes(TEST_ONLY_REVIEW_MARKER);
}

export function isTerminalManagedReview(review) {
  if (!isManagedReviewer(review)) return false;
  const state = String(review?.state || 'COMMENTED').toUpperCase();
  if (NON_TERMINAL_STATES.has(state)) return false;
  return TERMINAL_STATES.has(state);
}

function reviewSubmittedAt(review) {
  const parsed = Date.parse(review?.submitted_at || review?.submittedAt || '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function reviewIdValue(review, fallback) {
  const id = Number(review?.id);
  return Number.isSafeInteger(id) ? id : fallback;
}

function sameReview(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id != null && right.id != null) return String(left.id) === String(right.id);
  return left.commit_id === right.commit_id
    && reviewBody(left) === reviewBody(right)
    && (left.submitted_at || left.submittedAt) === (right.submitted_at || right.submittedAt);
}

/** Oldest terminal managed review anchored to `head`. Later same-SHA reviews are ignored. */
export function firstTerminalBotReviewOnHead(reviews, head) {
  if (typeof head !== 'string' || !head) return null;
  const matches = flattenReviewPages(reviews)
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => isTerminalManagedReview(review) && review?.commit_id === head)
    .sort((left, right) => reviewSubmittedAt(left.review) - reviewSubmittedAt(right.review)
      || reviewIdValue(left.review, left.index) - reviewIdValue(right.review, right.index));
  return matches[0]?.review || null;
}

/**
 * Drop later same-HEAD terminals only when the first verdict is already a
 * clean LGTM. That is the 9066/9074 storm (LGTM then 🔴 Important). If the
 * first verdict is Important, later same-HEAD reviews stay visible so a
 * stale Codex fallback can still be classified against the real history.
 */
export function boundReviewsToFirstHeadVerdict(reviews, head) {
  const first = firstTerminalBotReviewOnHead(reviews, head);
  if (!first || !reviewBodyIsApproving(reviewBody(first))) return reviews;
  return flattenReviewPages(reviews).filter((review) => {
    if (review?.commit_id !== head) return true;
    if (!isTerminalManagedReview(review)) return true;
    return sameReview(review, first);
  });
}

/**
 * Skip the model reviewer when this HEAD already has a terminal verdict.
 * `eventAction` is accepted so callers can pass `edited` without changing the
 * decision: metadata churn is not a new contribution.
 */
export function shouldSkipModelReview({ headSha, reviews, eventAction } = {}) {
  void eventAction;
  return firstTerminalBotReviewOnHead(reviews, headSha) !== null;
}

/**
 * A corrected PR body is the one metadata change that deserves a second model
 * look on the same HEAD: the first verdict was not approving (typically a 🔴
 * on the body) and the author has edited the description since the latest
 * verdict on this HEAD. Without this, the review gate re-read the same 🔴
 * forever after `retry-code-check-after-body-edit.yml` re-ran the job, and
 * agents pushed empty commits to buy a new review — at tier high (7 cases on
 * 2026-09-19, e.g. #9262, #9216). The admitted review is `minimal`: the code
 * is unchanged by construction, so only the body is re-judged.
 *
 * A clean LGTM stays sticky (the #9066/#9074 storm), and the number of
 * verdicts on one HEAD is capped so a body edit loop cannot buy unlimited
 * reviews.
 */
export const MAX_BODY_REREVIEWS_PER_HEAD = 3;

export function shouldAdmitBodyReReview({ headSha, reviews, bodyEditedAt } = {}) {
  const first = firstTerminalBotReviewOnHead(reviews, headSha);
  if (!first || reviewBodyIsApproving(reviewBody(first))) return false;
  const editedAt = Date.parse(String(bodyEditedAt || ''));
  if (!Number.isFinite(editedAt)) return false;
  const onHead = flattenReviewPages(reviews)
    .filter((review) => isTerminalManagedReview(review) && review?.commit_id === headSha);
  if (onHead.length > MAX_BODY_REREVIEWS_PER_HEAD) return false;
  const latestAt = Math.max(...onHead.map((review) => {
    const at = Date.parse(review?.submitted_at || review?.submittedAt || '');
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  }));
  return editedAt > latestAt;
}

/**
 * The 🔴 fixer may run once for the first terminal Important on the current
 * HEAD. A second same-SHA review, or a review that names an older SHA, is not
 * a new round.
 */
export function shouldRunRedflagFixer({
  reviews,
  headSha,
  reviewId,
  reviewCommit,
} = {}) {
  if (typeof headSha !== 'string' || !headSha) return false;
  if (reviewCommit && reviewCommit !== headSha) return false;
  const first = firstTerminalBotReviewOnHead(reviews, headSha);
  if (!first) return false;
  if (reviewId != null && String(first.id) !== String(reviewId)) return false;
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  return REDFLAG_IMPORTANT_RE.test(reviewBody(first));
}

/**
 * Zero blocking findings. A missing `## Findings` heading is approving when
 * the body also has no real `🔴 Important` (the 9066/9074 clean-LGTM shape).
 * A Findings heading that declares Important != 0 still blocks.
 */
export function reviewHasZeroFindings(body) {
  if (typeof body !== 'string') return false;
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  if (REDFLAG_IMPORTANT_RE.test(body)) return false;
  const findingsHeading = body.split(/\r?\n/).find((line) => FINDINGS_HEADING_RE.test(line));
  if (!findingsHeading) return true;
  return /\bImportant\s*:\s*0\b/i.test(findingsHeading);
}

export function reviewHasLgtm(body) {
  return typeof body === 'string' && LGTM_HEADING_RE.test(body);
}

export function reviewBodyIsApproving(body) {
  return reviewHasLgtm(body) && reviewHasZeroFindings(body);
}

function parseArgv(argv) {
  const mode = String(argv[2] || '').trim();
  const opts = {};
  for (let index = 3; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || String(next).startsWith('--')) {
      opts[key] = 'true';
      continue;
    }
    opts[key] = String(next);
    index += 1;
  }
  return { mode, opts };
}

function parseReviewsJson(raw) {
  try {
    return JSON.parse(String(raw || '').trim() || '[]');
  } catch {
    return null;
  }
}

function writeGithubOutput(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

export function admissionCli(argv = process.argv, stdinText = '') {
  const { mode, opts } = parseArgv(argv);
  const reviews = parseReviewsJson(stdinText);
  if (mode === 'skip') {
    if (!reviews) {
      process.stderr.write('pr-review-admission: reviews JSON illeggibile → review piena.\n');
      writeGithubOutput('skip=false');
      return 0;
    }
    const bodyReReview = shouldAdmitBodyReReview({
      headSha: opts.head,
      reviews,
      bodyEditedAt: opts['body-edited-at'],
    });
    if (bodyReReview) {
      writeGithubOutput('skip=false');
      writeGithubOutput('body_rereview=true');
      process.stderr.write(`Verdetto non approvante sulla HEAD ${opts.head} e body modificato dopo l'ultima review → review minimal sul body.\n`);
      return 0;
    }
    const skip = shouldSkipModelReview({
      headSha: opts.head,
      reviews,
      eventAction: opts.event,
    });
    writeGithubOutput(`skip=${skip ? 'true' : 'false'}`);
    process.stderr.write(skip
      ? `Esiste già una review terminale sulla HEAD ${opts.head} → nessuna seconda review, anche dopo un evento edited.\n`
      : `Nessuna review terminale sulla HEAD ${opts.head} → review piena.\n`);
    return 0;
  }
  if (mode === 'fixer') {
    if (!reviews) {
      process.stderr.write('pr-review-admission: reviews JSON illeggibile → skip 🔴-fix.\n');
      writeGithubOutput('actionable=false');
      return 0;
    }
    const run = shouldRunRedflagFixer({
      reviews,
      headSha: opts.head,
      reviewId: opts['review-id'],
      reviewCommit: opts['review-commit'],
    });
    writeGithubOutput(`actionable=${run ? 'true' : 'false'}`);
    process.stderr.write(run
      ? `Prima review terminale 🔴 Important sulla HEAD ${opts.head} → 🔴-fix ammesso.\n`
      : `🔴-fix saltato: non è la prima review terminale Important sulla HEAD corrente.\n`);
    return 0;
  }
  process.stderr.write('uso: pr-review-admission.mjs skip|fixer --head <sha> [--event edited] [--body-edited-at iso] [--review-id id] [--review-commit sha]\n');
  return 2;
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exitCode = admissionCli(process.argv, readFileSync(0, 'utf8'));
}
