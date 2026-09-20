#!/usr/bin/env node

/**
 * Deterministic post-model marker admission.
 *
 * The reviewer prompt asks for REVIEW_INPUT_REVISION, but a prompt is not an
 * integrity mechanism. This helper validates the API payload after the model
 * or the tests-only writer and before the review gate. Missing, malformed,
 * duplicate, or stale markers stop the required job; there is deliberately no
 * model retry and no green fallback.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  normalizeReviewInputRevision,
  reviewHasInputRevision,
  reviewInputMarker,
  reviewInputRevisions,
} from './lib/review-input-revision.mjs';
import {
  CODEX_FALLBACK_REVIEW_MARKER,
  isKnownReviewState,
} from './lib/pr-review-admission.mjs';

const SHA_RE = /^[0-9a-f]{40}$/iu;
const TERMINAL_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
const MANAGED_LOGIN_RE = /^(?:claude(?:\[bot\])?|frontaliere-automation\[bot\]|github-actions\[bot\])$/iu;
const CODEX_REPAIRABLE_LOGIN_RE = /^(?:frontaliere-automation|github-actions)\[bot\]$/iu;

export function flattenReviewPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

export function parseReviewPages(raw) {
  let pages;
  try {
    pages = JSON.parse(String(raw || '').trim() || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    for (const review of page) {
      if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
      if (!Number.isSafeInteger(Number(review.id)) || Number(review.id) <= 0) return null;
      if (!review.user || typeof review.user !== 'object'
          || typeof review.user.login !== 'string' || !review.user.login.trim()
          || typeof review.user.type !== 'string' || !review.user.type.trim()) return null;
      if (typeof review.commit_id !== 'string' || !review.commit_id) return null;
      // GitHub keeps historical PENDING/DISMISSED reviews in the paginated
      // response. They are valid entries but not terminal review input; only
      // an absent/blank state makes the API shape unverifiable.
      if (!isKnownReviewState(review.state)) return null;
      if (review.body !== null && typeof review.body !== 'string') return null;
    }
  }
  return pages;
}

function latestReview(entries) {
  return [...entries].sort((left, right) => {
    const leftAt = Date.parse(left.submitted_at || left.submittedAt || left.updated_at || '') || 0;
    const rightAt = Date.parse(right.submitted_at || right.submittedAt || right.updated_at || '') || 0;
    return leftAt - rightAt || Number(left.id) - Number(right.id);
  }).at(-1);
}

export function reviewMarkerDecision({ reviews, headSha, reviewRevision } = {}) {
  const deny = (reason) => ({ ok: false, reason });
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (!SHA_RE.test(String(headSha || '')) || !revision) return deny('HEAD o body revision non verificabile');
  if (!Array.isArray(reviews)) return deny('reviews API non verificabile');
  const entries = flattenReviewPages(reviews);
  const managed = entries.filter((review) => review?.commit_id === headSha
    && review?.user?.type === 'Bot'
    && MANAGED_LOGIN_RE.test(review.user.login || '')
    && TERMINAL_STATES.has(String(review.state).trim().toUpperCase()));
  if (managed.length === 0) return deny('nessuna review bot terminale sulla HEAD corrente');
  const ids = new Set();
  for (const review of managed) {
    const id = String(review.id);
    if (ids.has(id)) return deny(`review ${id}: entry duplicata nella risposta paginata`);
    ids.add(id);
  }
  const latest = latestReview(managed);
  const markers = reviewInputRevisions(latest.body);
  if (markers.length !== 1) {
    return deny(`review ${latest.id}: marker body revision mancante, malformato o duplicato`);
  }
  if (!reviewHasInputRevision(latest.body, revision)) {
    return deny(`review ${latest.id}: marker body revision stale o diversa dalla PR corrente`);
  }
  return { ok: true, reason: `marker REVIEW_INPUT_REVISION verificato sulla review bot ${latest.id}` };
}

/**
 * Decide whether a trusted publisher may preserve a Codex review and add the
 * missing input marker. The publisher never repairs stale, duplicate, or
 * non-Codex bodies: those remain unavailable review input and fail closed.
 * The returned body is a copy of the model body with exactly one deterministic
 * marker prepended; callers may publish it as a new review without changing
 * the model's verdict text.
 */
export function reviewMarkerRepairDecision({ reviews, headSha, reviewRevision } = {}) {
  const deny = (reason) => ({ ok: false, repaired: false, reason });
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (!SHA_RE.test(String(headSha || '')) || !revision) {
    return deny('HEAD o body revision non verificabile');
  }
  if (!Array.isArray(reviews)) return deny('reviews API non verificabile');
  const managed = flattenReviewPages(reviews).filter((review) => review?.commit_id === headSha
    && review?.user?.type === 'Bot'
    && MANAGED_LOGIN_RE.test(review.user.login || '')
    && TERMINAL_STATES.has(String(review.state).trim().toUpperCase()));
  if (managed.length === 0) {
    return { ok: true, repaired: false, reason: 'nessuna review bot terminale sulla HEAD corrente' };
  }
  const ids = new Set();
  for (const review of managed) {
    const id = String(review.id);
    if (ids.has(id)) return deny(`review ${id}: entry duplicata nella risposta paginata`);
    ids.add(id);
  }
  const latest = latestReview(managed);
  const markers = reviewInputRevisions(latest.body);
  if (markers.length === 1 && markers[0] === revision) {
    return { ok: true, repaired: false, reason: `review ${latest.id}: marker già valido` };
  }
  if (markers.length > 0) {
    return deny(`review ${latest.id}: marker body revision stale, malformato o duplicato`);
  }
  if (!CODEX_REPAIRABLE_LOGIN_RE.test(latest.user?.login || '')
      || !String(latest.body || '').includes(CODEX_FALLBACK_REVIEW_MARKER)) {
    return {
      ok: true,
      repaired: false,
      reason: `review ${latest.id}: non è una review Codex fallback riparabile`,
    };
  }
  const body = `${reviewInputMarker(revision)}\n${String(latest.body || '')}`;
  return {
    ok: true,
    repaired: true,
    reviewId: String(latest.id),
    body,
    reason: `review ${latest.id}: marker aggiunto dal publisher trusted`,
  };
}

export function markerCli(argv = process.argv, stdinText = '') {
  const mode = argv[2];
  if (mode !== 'validate' && mode !== 'repair') {
    process.stderr.write('uso: review-marker-recovery.mjs validate|repair --head <sha> --revision body:<sha256> [--output <file>]\n');
    return 2;
  }
  const opts = {};
  for (let index = 3; index < argv.length; index += 1) {
    if (!String(argv[index]).startsWith('--')) continue;
    opts[String(argv[index]).slice(2)] = String(argv[index + 1] || '');
    index += 1;
  }
  const parsed = parseReviewPages(stdinText);
  const result = parsed
    ? (mode === 'validate'
      ? reviewMarkerDecision({ reviews: parsed, headSha: opts.head, reviewRevision: opts.revision })
      : reviewMarkerRepairDecision({ reviews: parsed, headSha: opts.head, reviewRevision: opts.revision }))
    : { ok: false, reason: 'reviews API JSON/pagine/entry malformate' };
  if (mode === 'repair' && result.ok && result.repaired) {
    if (!opts.output) {
      process.stderr.write('repair richiede --output <file> per non esporre il body nei log\n');
      return 2;
    }
    writeFileSync(opts.output, JSON.stringify({ review_id: result.reviewId, body: result.body }), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  process.stdout.write(`${mode === 'validate'
    ? (result.ok ? 'marker_valid=true' : 'marker_valid=false')
    : (result.ok && result.repaired ? 'marker_repair=true' : 'marker_repair=false')}\n`);
  process.stderr.write(`${result.reason}\n`);
  return result.ok ? 0 : 1;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isDirectRun) process.exitCode = markerCli(process.argv, readFileSync(0, 'utf8'));
