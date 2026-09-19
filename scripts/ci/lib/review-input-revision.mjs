#!/usr/bin/env node

/**
 * Trusted identity of the PR metadata consumed by an automated review.
 *
 * The body is read by a trusted workflow step through the GitHub API.  The
 * resulting digest is then carried into the review marker and the gate; a
 * HEAD-only identity is not enough because a body edit changes the review
 * input without changing the contribution commit.
 *
 * WHAT IS HASHED, and why it has a trailing newline (2026-09-20).  The digest
 * covers the body AS THE WORKFLOWS SERIALIZE IT: `gh api --jq` writes the
 * string followed by a newline, and the producer of every marker in existence
 * — the corpus' `scripts/ci/review-test-policy.mjs`, together with the
 * `sha256sum "$BODY_FILE"` of its `tests.yml` — hashes that file. This module
 * used to hash the body WITHOUT the newline, so it produced a digest that
 * matched no marker ever emitted: every consumer here compared a value against
 * markers it could not equal. `scripts/ci/orphan-pr-custodian.mjs` had already
 * worked around it with a private copy of the correct formula; that copy is
 * now a re-export of this one, because two literal definitions of the same
 * digest are exactly the drift AGENTS.md #6 forbids.
 *
 * Changing the REPRESENTATION here would break the parity with `sha256sum`
 * that the corpus' shell depends on, so the alignment goes in this direction
 * and not the other one.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REVIEW_INPUT_REVISION_RE = /^body:[0-9a-f]{64}$/iu;
export const REVIEW_INPUT_MARKER_RE = /^<!-- REVIEW_INPUT_REVISION: (body:[0-9a-f]{64}) -->$/iu;

export function normalizeReviewInputRevision(value) {
  const revision = String(value ?? '').trim().toLowerCase();
  return REVIEW_INPUT_REVISION_RE.test(revision) ? revision : '';
}

/**
 * The `gh api --jq` serialization of a PR body: the string plus the newline
 * that jq writes after it. Exported so a test can pin the representation
 * itself, not only the hex it produces.
 *
 * @param {string} body
 * @returns {string}
 */
export function reviewInputSerialization(body) {
  return `${body}\n`;
}

export function reviewInputRevisionFromBody(body) {
  if (typeof body !== 'string') throw new TypeError('PR body must be a string');
  const digest = createHash('sha256')
    .update(reviewInputSerialization(body), 'utf8')
    .digest('hex');
  const revision = `body:${digest}`;
  if (!REVIEW_INPUT_REVISION_RE.test(revision)) {
    throw new Error('PR body revision digest is malformed');
  }
  return revision;
}

/** Validate the exact API shape before hashing; null is GitHub's empty body. */
export function reviewInputRevisionFromPullRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PR response is not an object');
  }
  if (!Object.hasOwn(value, 'body')) throw new Error('PR response has no body field');
  if (value.body !== null && typeof value.body !== 'string') {
    throw new TypeError('PR body is not a string or null');
  }
  return reviewInputRevisionFromBody(value.body ?? '');
}

export function reviewInputMarker(revision) {
  const normalized = normalizeReviewInputRevision(revision);
  if (!normalized) throw new Error('invalid review input revision');
  return `<!-- REVIEW_INPUT_REVISION: ${normalized} -->`;
}

/**
 * Extract logical marker lines.  Some GitHub clients have historically
 * serialized Markdown newlines as the two characters `\\n`; accepting that
 * representation here keeps the marker parser aligned with review-gate's
 * existing body normalizer while still requiring a complete marker line.
 */
export function reviewInputRevisions(body) {
  const logicalBody = String(body ?? '')
    .replace(/\\r\\n/gu, '\n')
    .replace(/\\n/gu, '\n');
  return logicalBody.split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ''))
    .map((line) => line.match(REVIEW_INPUT_MARKER_RE)?.[1]?.toLowerCase())
    .filter(Boolean);
}

export function reviewHasInputRevision(body, expectedRevision) {
  const expected = normalizeReviewInputRevision(expectedRevision);
  const revisions = reviewInputRevisions(body);
  return Boolean(expected) && revisions.length === 1 && revisions[0] === expected;
}

function readJsonFile(path) {
  if (!path || typeof path !== 'string') throw new Error('JSON file path missing');
  return JSON.parse(readFileSync(realpathSync(path), 'utf8'));
}

function cli(argv = process.argv) {
  const command = String(argv[2] || '');
  const path = String(argv[4] || '');
  if (!['hash-pr-json', 'marker'].includes(command)) {
    throw new Error('usage: review-input-revision.mjs hash-pr-json --file <json> | marker --revision <body:sha256>');
  }
  if (command === 'marker') {
    const revision = normalizeReviewInputRevision(path);
    if (!revision) throw new Error('invalid review input revision');
    process.stdout.write(`${reviewInputMarker(revision)}\n`);
    return;
  }
  if (argv[3] !== '--file') throw new Error('hash-pr-json requires --file');
  process.stdout.write(`${reviewInputRevisionFromPullRequest(readJsonFile(path))}\n`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    cli(process.argv);
  } catch (error) {
    console.error(`review-input-revision: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}
