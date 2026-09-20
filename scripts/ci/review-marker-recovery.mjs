#!/usr/bin/env node

/**
 * Deterministic post-model marker admission.
 *
 * The reviewer prompt asks for REVIEW_INPUT_REVISION, but a prompt is not an
 * integrity mechanism. This helper validates the API payload after the model
 * or the tests-only writer and before the review gate. Missing, malformed,
 * duplicate, or stale markers stop the required job. A narrowly-scoped
 * `repair` command can add the Codex marker to one otherwise-valid, approving
 * App review on the exact HEAD; it never retries the model or accepts a
 * finding-bearing/stale review.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  normalizeReviewInputRevision,
  reviewHasInputRevision,
  reviewInputRevisions,
} from './lib/review-input-revision.mjs';
import {
  CODEX_FALLBACK_REVIEW_MARKER,
  isKnownReviewState,
  reviewBodyIsApproving,
} from './lib/pr-review-admission.mjs';

const SHA_RE = /^[0-9a-f]{40}$/iu;
const TERMINAL_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
const MANAGED_LOGIN_RE = /^(?:claude(?:\[bot\])?|frontaliere-automation\[bot\]|github-actions\[bot\])$/iu;
const CODEX_REPAIR_LOGIN_RE = /^frontaliere-automation\[bot\]$/iu;

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
  const latest = [...managed].sort((left, right) => {
    const leftAt = Date.parse(left.submitted_at || left.submittedAt || left.updated_at || '') || 0;
    const rightAt = Date.parse(right.submitted_at || right.submittedAt || right.updated_at || '') || 0;
    return leftAt - rightAt || Number(left.id) - Number(right.id);
  }).at(-1);
  const markers = reviewInputRevisions(latest.body);
  if (markers.length !== 1) {
    return deny(`review ${latest.id}: marker body revision mancante, malformato o duplicato`);
  }
  if (!reviewHasInputRevision(latest.body, revision)) {
    return deny(`review ${latest.id}: marker body revision stale o diversa dalla PR corrente`);
  }
  return { ok: true, reason: `marker REVIEW_INPUT_REVISION verificato sulla review bot ${latest.id}` };
}

function sortedManagedReviews(reviews, headSha) {
  return flattenReviewPages(reviews)
    .filter((review) => review?.commit_id === headSha
      && review?.user?.type === 'Bot'
      && MANAGED_LOGIN_RE.test(review.user.login || '')
      && TERMINAL_STATES.has(String(review.state).trim().toUpperCase()))
    .sort((left, right) => {
      const leftAt = Date.parse(left.submitted_at || left.submittedAt || left.updated_at || '') || 0;
      const rightAt = Date.parse(right.submitted_at || right.submittedAt || right.updated_at || '') || 0;
      return leftAt - rightAt || Number(left.id) - Number(right.id);
    });
}

/**
 * Return a deterministic, zero-agent marker repair only for the exact shape
 * observed in #9346: the trusted App already posted a clean LGTM on this HEAD
 * and body revision, but omitted the Codex provenance marker. Any ambiguity is
 * a hard failure, so a malformed or red review can never be copied forward.
 */
export function reviewMarkerRepair({ reviews, headSha, reviewRevision } = {}) {
  const deny = (reason) => ({ ok: false, reason });
  const revision = normalizeReviewInputRevision(reviewRevision);
  if (!SHA_RE.test(String(headSha || '')) || !revision) return deny('HEAD o body revision non verificabile');
  if (!Array.isArray(reviews)) return deny('reviews API non verificabile');
  const entries = flattenReviewPages(reviews);
  const managed = sortedManagedReviews(entries, headSha);
  if (managed.length === 0) return deny('nessuna review bot terminale sulla HEAD corrente');
  const ids = new Set();
  for (const review of managed) {
    const id = String(review.id);
    if (ids.has(id)) return deny(`review ${id}: entry duplicata nella risposta paginata`);
    ids.add(id);
  }
  const latest = managed.at(-1);
  const body = String(latest.body || '');
  if (body.includes(CODEX_FALLBACK_REVIEW_MARKER)) {
    return { ok: true, action: 'noop', reason: `review ${latest.id} ha già il marker Codex` };
  }
  if (!CODEX_REPAIR_LOGIN_RE.test(String(latest.user?.login || ''))) {
    return deny(`review ${latest.id}: autore non riparabile senza marker`);
  }
  const markers = reviewInputRevisions(body);
  if (markers.length !== 1 || !reviewHasInputRevision(body, revision)) {
    return deny(`review ${latest.id}: marker body revision mancante, duplicato o stale`);
  }
  // Reuse the same fail-closed classifier as the authoritative review gate.
  // A local regex would drift from the gate's structural handling of quoted
  // markers, prose counts, and the valid LGTM shape without a Findings count.
  if (!reviewBodyIsApproving(body)) {
    return deny(`review ${latest.id}: non è un LGTM pulito senza Important`);
  }
  return {
    ok: true,
    action: 'repair',
    reviewId: Number(latest.id),
    body: `${CODEX_FALLBACK_REVIEW_MARKER}\n${body.replace(/^\s+/u, '')}`,
    reason: `review ${latest.id} riparabile: LGTM pulito sulla HEAD e body revision correnti`,
  };
}

export function markerCli(argv = process.argv, stdinText = '') {
  if (!['validate', 'repair'].includes(argv[2])) {
    process.stderr.write('uso: review-marker-recovery.mjs <validate|repair> --head <sha> --revision body:<sha256>\n');
    return 2;
  }
  const opts = {};
  for (let index = 3; index < argv.length; index += 1) {
    if (!String(argv[index]).startsWith('--')) continue;
    opts[String(argv[index]).slice(2)] = String(argv[index + 1] || '');
    index += 1;
  }
  const parsed = parseReviewPages(stdinText);
  if (argv[2] === 'repair') {
    const result = parsed
      ? reviewMarkerRepair({ reviews: parsed, headSha: opts.head, reviewRevision: opts.revision })
      : { ok: false, reason: 'reviews API JSON/pagine/entry malformate' };
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const result = parsed
    ? reviewMarkerDecision({ reviews: parsed, headSha: opts.head, reviewRevision: opts.revision })
    : { ok: false, reason: 'reviews API JSON/pagine/entry malformate' };
  process.stdout.write(`${result.ok ? 'marker_valid=true' : 'marker_valid=false'}\n`);
  process.stderr.write(`${result.reason}\n`);
  return result.ok ? 0 : 1;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isDirectRun) process.exitCode = markerCli(process.argv, readFileSync(0, 'utf8'));
