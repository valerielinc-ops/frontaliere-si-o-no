#!/usr/bin/env node

/**
 * Durable, zero-Claude claims for the PR repair/review consumers.
 *
 * A workflow_run/review rerun is not a new contribution by itself. The PR
 * thread is the durable store shared by GitHub runners: every claim records
 * the exact PR + HEAD + event + verdict, and the stable PR + HEAD + verdict
 * identity coalesces a retried event with the same signal. A new HEAD or a new
 * failed-check/finding verdict gets a new identity. Claims are append-only so
 * a failed runner cannot erase the evidence that it was attempted.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';
import {
  normalizeReviewInputRevision,
  reviewHasInputRevision,
  acceptedReviewInputRevisionsFromPullRequest,
  reviewInputRevisionFromPullRequest,
} from './lib/review-input-revision.mjs';
import { parseReviewsJson } from './lib/pr-review-admission.mjs';
import { positiveIntFromEnv } from '../lib/int-from-env.mjs';

export const PR_FIX_CLAIM_MARKER = '<!-- PR_FIX_CLAIM:';
export const PR_FIX_CLAIM_STATES = Object.freeze([
  'active',
  'completed',
  'failed-terminal',
  'failed-transient',
  'released',
]);

const CLAIM_STATE_SET = new Set(PR_FIX_CLAIM_STATES);
const CLAIM_KIND_SET = new Set(['redflag', 'redcheck', 'review']);
const CLAIM_MARKER_RE = /<!-- PR_FIX_CLAIM:\s*(\{[\s\S]*?\})\s*-->/;
const CLAIM_ACTOR_RE = /^(?:github-actions\[bot\]|frontaliere-automation\[bot\]|claude\[bot\]|nanakokyobashi-rgb|valerielinc-ops)$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const PR_RE = /^[1-9][0-9]*$/;

function normalized(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

export function normalizedSignal(value) {
  const signal = normalized(value);
  if (!signal.startsWith('failed-checks:')) return signal;
  const payload = signal.slice('failed-checks:'.length).trim();
  try {
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      const checks = [...new Set(parsed.map((check) => normalized(check)).filter(Boolean))].sort();
      return `failed-checks:${JSON.stringify(checks)}`;
    }
  } catch {
    // Legacy scalar signals are retained verbatim: commas can be part of a
    // check name, so splitting them would make distinct verdicts collide.
  }
  return `failed-checks:${payload}`;
}

function validContext({ workflow, prNumber, headSha, eventKey, verdictKey } = {}) {
  return CLAIM_KIND_SET.has(String(workflow || ''))
    && PR_RE.test(String(prNumber || ''))
    && SHA_RE.test(String(headSha || ''))
    && (normalized(eventKey) !== '' || normalized(verdictKey) !== '');
}

function validReviewRevision(workflow, reviewRevision) {
  return workflow !== 'redflag'
    || Boolean(normalizeReviewInputRevision(reviewRevision));
}

/**
 * Exact event identity. The event is retained even when a stable verdict is
 * available so a review/rerun remains auditable; the verdict is the stable
 * coalescing identity used by `prFixClaimDecision`.
 */
export function prFixClaimKey({ workflow, prNumber, headSha, eventKey, verdictKey, reviewRevision } = {}) {
  if (!validContext({ workflow, prNumber, headSha, eventKey, verdictKey })
      || !validReviewRevision(workflow, reviewRevision)) return '';
  const event = normalizedSignal(eventKey) || 'none';
  const verdict = normalizedSignal(verdictKey) || 'none';
  const revision = normalizeReviewInputRevision(reviewRevision) || 'none';
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
    `body:${revision}`,
    `workflow:${String(workflow)}`,
    `event:${event}`,
    `verdict:${verdict}`,
  ].join('|');
}

/**
 * Stable identity for retries. It deliberately excludes the event id: a new
 * event that carries the same verdict on the same HEAD is still the same work.
 */
export function prFixClaimDedupeKey({ workflow, prNumber, headSha, eventKey, verdictKey, reviewRevision } = {}) {
  if (!validContext({ workflow, prNumber, headSha, eventKey, verdictKey })
      || !validReviewRevision(workflow, reviewRevision)) return '';
  const signal = normalizedSignal(verdictKey) || normalizedSignal(eventKey);
  const revision = normalizeReviewInputRevision(reviewRevision) || 'none';
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
    `body:${revision}`,
    `workflow:${String(workflow)}`,
    `signal:${signal}`,
  ].join('|');
}

/** Stable fingerprint of the real Important findings in a review body. */
export function redflagFindingsFingerprint(body) {
  const findings = String(body || '')
    .split(/\r?\n/u)
    .filter((line) => {
      REDFLAG_IMPORTANT_RE.lastIndex = 0;
      return REDFLAG_IMPORTANT_RE.test(line);
    })
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .sort();
  if (findings.length === 0) return '';
  return createHash('sha256').update(findings.join('\n')).digest('hex');
}

function claimKeyFromEvent(event) {
  return prFixClaimKey({
    workflow: event?.workflow,
    prNumber: event?.prNumber,
    headSha: event?.headSha,
    eventKey: event?.eventKey,
    verdictKey: event?.verdictKey,
    reviewRevision: event?.reviewRevision,
  });
}

function dedupeKeyFromEvent(event) {
  return prFixClaimDedupeKey({
    workflow: event?.workflow,
    prNumber: event?.prNumber,
    headSha: event?.headSha,
    eventKey: event?.eventKey,
    verdictKey: event?.verdictKey,
    reviewRevision: event?.reviewRevision,
  });
}

export function parsePrFixClaim(body) {
  const match = String(body || '').match(CLAIM_MARKER_RE);
  if (!match) return null;
  let event;
  try {
    event = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!event || event.version !== 1
      || typeof event.token !== 'string' || !event.token
      || typeof event.workflow !== 'string' || !CLAIM_KIND_SET.has(event.workflow)
      || !PR_RE.test(String(event.prNumber || ''))
      || !SHA_RE.test(String(event.headSha || ''))
      || typeof event.eventKey !== 'string'
      || typeof event.verdictKey !== 'string'
      || !CLAIM_STATE_SET.has(event.state)
      || !Number.isFinite(Number(event.issuedAt))
      || !Number.isFinite(Number(event.expiresAt))) return null;
  const hasReviewRevision = Object.hasOwn(event, 'reviewRevision');
  const reviewRevision = normalizeReviewInputRevision(event.reviewRevision);
  // Claims written before body-revision binding remain historical comments.
  // Parse them so one stale marker cannot make every future claim unavailable,
  // but leave them without a current key: acquire/finalize filters by the new
  // PR+HEAD+body+review identity and therefore cannot reuse this legacy state.
  const legacyRedflag = event.workflow === 'redflag' && !hasReviewRevision;
  if (event.workflow === 'redflag' && !reviewRevision && !legacyRedflag) return null;

  const normalizedEvent = {
    ...event,
    workflow: String(event.workflow),
    prNumber: String(event.prNumber),
    headSha: String(event.headSha).toLowerCase(),
    eventKey: normalizedSignal(event.eventKey),
    verdictKey: normalizedSignal(event.verdictKey),
    reviewRevision,
    legacyRedflag,
    issuedAt: Number(event.issuedAt),
    expiresAt: Number(event.expiresAt),
  };
  if (!normalizedEvent.eventKey && !normalizedEvent.verdictKey) return null;
  if (legacyRedflag) return normalizedEvent;
  if (normalizedEvent.key !== claimKeyFromEvent(normalizedEvent)) return null;
  if (normalizedEvent.dedupeKey !== dedupeKeyFromEvent(normalizedEvent)) return null;
  return normalizedEvent;
}

function eventRank(event) {
  return [
    Number(event?.commentAt) || 0,
    Number(event?.commentId) || 0,
    Number(event?.commentOrder) || 0,
  ];
}

function laterEvent(a, b) {
  const left = eventRank(a);
  const right = eventRank(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? a : b;
  }
  return b;
}

/**
 * Parse the append-only comment ledger, keeping only the latest state for each
 * claim token. Unknown marker authors are ignored by this pure helper; the
 * network path below rejects such a marker instead of risking a duplicate.
 */
export function latestPrFixClaims(comments = [], { key = '', dedupeKey = '' } = {}) {
  const latest = new Map();
  for (const [index, comment] of (comments || []).entries()) {
    const login = String(comment?.user?.login || comment?.author?.login || '');
    if (login && !CLAIM_ACTOR_RE.test(login)) continue;
    const event = parsePrFixClaim(comment?.body);
    if (!event || (key && event.key !== key) || (dedupeKey && event.dedupeKey !== dedupeKey)) continue;
    const createdAt = Date.parse(comment?.created_at ?? comment?.createdAt ?? '');
    const candidate = {
      ...event,
      commentId: Number(comment?.id) || index,
      commentAt: Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : event.issuedAt,
      commentOrder: index,
    };
    const previous = latest.get(event.token);
    latest.set(event.token, previous ? laterEvent(previous, candidate) : candidate);
  }
  return [...latest.values()];
}

export function runIsFinished(state) {
  if (!state || typeof state !== 'object') return false;
  // A successful runner may have posted its verdict but not yet finalized the
  // claim because the comments API was eventually consistent. Releasing that
  // claim merely because the runner is completed would permit a duplicate.
  // Only outcomes that prove an interrupted/unsuccessful attempt are
  // retryable; an unreadable or successful state remains fail-closed until TTL.
  return ['cancelled', 'failure', 'startup_failure', 'timed_out', 'action_required', 'skipped'].includes(state.conclusion);
}

/**
 * Build the append-only release for a claim that lost post-write arbitration.
 * The local event is the fallback when the just-posted active marker is not
 * visible yet through the comments API.
 */
export function releaseClaimEvent({ ownClaim, localClaim, issuedAt } = {}) {
  const claim = ownClaim || localClaim;
  if (!claim || typeof claim !== 'object' || claim.state !== 'active') return null;
  return { ...claim, state: 'released', issuedAt: Number(issuedAt) };
}

/**
 * Pick only claims that can still win the post-write arbitration. A runner
 * that already ended with a retryable infrastructure outcome must not keep
 * the slot reserved until its TTL while the retry it just admitted is posted.
 */
export function activeClaimsForArbitration(claims = [], { nowSec = Math.floor(Date.now() / 1000), activeRunStates = {} } = {}) {
  return (claims || []).filter((claim) => {
    if (claim?.state !== 'active' || Number(claim.expiresAt) <= Number(nowSec)) return false;
    const runId = String(claim.runId || '');
    if (!runId) return true;
    return !runIsFinished(activeRunStates?.[runId]);
  });
}

/**
 * Decide without GitHub calls. An active claim only becomes retryable after
 * expiry or after its runner is known to have finished without finalizing it.
 * An unreadable runner state is an error, not permission to spend Claude.
 */
export function prFixClaimDecision({ key, dedupeKey, claims = [], nowSec = Math.floor(Date.now() / 1000), activeRunStates = {} } = {}) {
  if (!key || !dedupeKey) return { allowed: false, error: true, reason: 'claim-key-missing' };
  const related = (claims || []).filter((claim) => claim?.dedupeKey === dedupeKey);
  if (related.some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal')) {
    return { allowed: false, exists: true, reason: 'same-pr-head-terminal-claim' };
  }

  for (const claim of related.filter((item) => item.state === 'active')) {
    if (Number(claim.expiresAt) <= Number(nowSec)) continue;
    const runId = String(claim.runId || '');
    const state = runId ? activeRunStates?.[runId] : undefined;
    if (!state) {
      return { allowed: false, exists: true, error: true, reason: 'active-run-state-unreadable' };
    }
    if (!runIsFinished(state)) {
      return { allowed: false, exists: true, reason: 'same-pr-head-claim-active' };
    }
  }
  return {
    allowed: true,
    exists: related.length > 0,
    reason: 'same-pr-head-claim-retryable',
  };
}

/**
 * Map an action outcome to the persisted state. A structured 429/5xx or a
 * cancellation is retryable; an ordinary action failure is terminal. A
 * successful action is consumed even when its work was an empty/diagnostic
 * terminal path, because the round cap and the review/check gate remain the
 * owners of that outcome.
 */
export function claimStatusFromOutcome({ proceed, actionOutcome = '', claudeOutcome = actionOutcome, executionText = '' } = {}) {
  const outcome = actionOutcome || claudeOutcome;
  if (proceed !== true && proceed !== 'true') return 'released';
  const text = String(executionText || '');
  const transientStatus = /(?:api[_-]?error[_-]?status|status[_-]?code|http[_-]?status|status)["']?\s*[:=]\s*["']?(?:429|5\d{2})\b/iu.test(text);
  const transientText = /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(?:429|5\d{2})\b|\b(?:overloaded|server_error|internal server error)\b/iu.test(text);
  const transient = transientStatus || transientText;
  // An empty/skipped action means an earlier setup step stopped the provider
  // path after the claim was acquired. It is not a verdict and must not make
  // the same contribution permanently consumed.
  if (transient || outcome === 'cancelled' || outcome === '' || outcome === 'skipped') {
    return 'failed-transient';
  }
  if (outcome === 'failure') return 'failed-terminal';
  return 'completed';
}

function trustedGhBin() {
  const value = String(process.env.TRUSTED_GH_BIN || '').trim();
  if (!value || !value.startsWith('/') || value.includes('\0')) {
    throw new Error('TRUSTED_GH_BIN mancante o non assoluto');
  }
  return value;
}

function gh(args) {
  return execFileSync(trustedGhBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readComments(repo, prNumber) {
  const raw = gh([
    'api', '--paginate', '--slurp', `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
  ]);
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`commenti PR: JSON non valido (${error.message})`);
  }
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    throw new Error('commenti PR: risposta non e\' un array di pagine');
  }
  const comments = pages.flat();
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
      throw new Error('commenti PR: pagina malformata');
    }
    if (String(comment.body || '').includes(PR_FIX_CLAIM_MARKER)) {
      const login = String(comment.user?.login || comment.author?.login || '');
      if (!CLAIM_ACTOR_RE.test(login) || !parsePrFixClaim(comment.body)) {
        throw new Error('commenti PR: marker claim non verificabile');
      }
    }
  }
  return comments;
}

function claimBody(event) {
  const verdict = event.verdictKey || 'event-only';
  return `${PR_FIX_CLAIM_MARKER} ${JSON.stringify(event)} -->\n`
    + `_PR ${event.workflow} claim ${event.state} · PR #${event.prNumber} · HEAD ${event.headSha.slice(0, 12)} · `
    + `${verdict} · scade ${new Date(event.expiresAt * 1000).toISOString()}._`;
}

function postClaim(repo, prNumber, event) {
  gh(['pr', 'comment', String(prNumber), '--repo', repo, '--body', claimBody(event)]);
}

function output(result) {
  const values = {
    claim_allowed: result.allowed === true,
    claim_acquired: result.acquired === true,
    claim_exists: result.exists === true,
    claim_error: result.error === true,
    claim_token: result.token || '',
    claim_key: result.key || '',
    claim_dedupe_key: result.dedupeKey || '',
    claim_state: result.state || '',
    claim_reason: result.reason || '',
    claim_valid: result.valid === true,
  };
  const lines = Object.entries(values)
    .map(([name, value]) => `${name}=${String(value).replace(/[\r\n]/gu, ' ')}`);
  console.log(lines.join(' '));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return { ...result, ...values };
}

function token() {
  const run = String(process.env.GITHUB_RUN_ID || process.pid || 'local')
    .replace(/[^A-Za-z0-9._-]/gu, '-');
  return `pr-fix-${run}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function contextFromEnv() {
  const workflow = String(process.env.CLAIM_KIND || process.env.WORKFLOW || '').trim();
  const prNumber = String(process.env.PR_NUMBER || '').trim();
  const headSha = String(process.env.HEAD_SHA || '').trim().toLowerCase();
  const reviewRevision = normalizeReviewInputRevision(process.env.REVIEW_REVISION || '');
  const eventKey = normalizedSignal(process.env.EVENT_KEY || '');
  let verdictKey = normalizedSignal(process.env.VERDICT_KEY || '');
  if (!verdictKey && workflow === 'redcheck') {
    const failureKey = normalizedSignal(process.env.CHECK_FAILURE_KEY || '');
    if (failureKey) verdictKey = `failed-checks:${failureKey}`;
  }
  if (!verdictKey && workflow === 'redflag') {
    const fingerprint = redflagFindingsFingerprint(process.env.REVIEW_BODY || '');
    if (fingerprint) verdictKey = `findings:${fingerprint}`;
  }
  const key = prFixClaimKey({ workflow, prNumber, headSha, eventKey, verdictKey, reviewRevision });
  const dedupeKey = prFixClaimDedupeKey({ workflow, prNumber, headSha, eventKey, verdictKey, reviewRevision });
  return { workflow, prNumber, headSha, eventKey, verdictKey, reviewRevision, key, dedupeKey };
}

function activeRunStates(repo, claims, nowSec) {
  const states = {};
  for (const claim of claims) {
    if (claim.state !== 'active' || Number(claim.expiresAt) <= nowSec) continue;
    const runId = String(claim.runId || '');
    if (!runId) continue;
    let parsed;
    try {
      parsed = JSON.parse(gh(['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion']));
    } catch (error) {
      throw new Error(`run claim #${runId} non leggibile (${error.message})`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`run claim #${runId} malformata`);
    states[runId] = parsed;
  }
  return states;
}

function latestForDedupe(comments, dedupeKey) {
  return latestPrFixClaims(comments, { dedupeKey })
    .sort((a, b) => {
      const ar = eventRank(a);
      const br = eventRank(b);
      for (let i = 0; i < ar.length; i += 1) {
        if (ar[i] !== br[i]) return ar[i] - br[i];
      }
      return 0;
    });
}

function dryComment(event, order) {
  return {
    id: order,
    created_at: new Date(event.issuedAt * 1000).toISOString(),
    user: { login: 'github-actions[bot]' },
    body: claimBody(event),
  };
}

function flattenReviewPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

/**
 * Final, read-only CAS-style admission immediately before the model. The
 * append-only comment claim prevents duplicate runners; this second snapshot
 * prevents a body edit or a review replacement between admission and model
 * startup from spending a turn against stale input. There is no optimistic
 * mutation primitive in GitHub's comments API, so the check is intentionally
 * bounded and fail-closed rather than pretending to provide exactly-once.
 */
export function validateRedflagClaimSnapshot({ pr, reviews, claim } = {}) {
  const deny = (reason) => ({ valid: false, reason });
  if (!claim || claim.workflow !== 'redflag') return deny('claim redflag mancante');
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return deny('PR metadata mancante');
  if (String(pr.state || '').toLowerCase() !== 'open') return deny('PR non più aperta');
  const head = String(pr.head?.sha || pr.headRefOid || '').toLowerCase();
  if (!SHA_RE.test(head) || head !== String(claim.headSha || '').toLowerCase()) {
    return deny('HEAD cambiata dopo il claim');
  }
  let currentRevision;
  try {
    currentRevision = reviewInputRevisionFromPullRequest(pr);
  } catch {
    return deny('body PR non verificabile dopo il claim');
  }
  if (!currentRevision || currentRevision !== claim.reviewRevision) {
    return deny('body revision cambiata dopo il claim');
  }
  const eventMatch = String(claim.eventKey || '').match(/^review:([1-9][0-9]*)$/u);
  if (!eventMatch) return deny('review id del claim non verificabile');
  const current = flattenReviewPages(reviews).find((review) => String(review?.id || '') === eventMatch[1]);
  if (!current) return deny('review del claim non più presente');
  if (current.user?.type !== 'Bot' || !CLAIM_ACTOR_RE.test(String(current.user.login || ''))) {
    return deny('review del claim non è del reviewer bot autorizzato');
  }
  if (String(current.commit_id || '').toLowerCase() !== head) {
    return deny('review del claim non più sulla HEAD corrente');
  }
  if (!['APPROVED', 'COMMENTED'].includes(String(current.state || '').toUpperCase())) {
    return deny('review del claim non terminale');
  }
  // Il confronto sopra e' revision-contro-revision, entrambe calcolate qui:
  // resta identita' stretta. Questo invece e' marker-contro-body, e il marker
  // l'ha scritto un altro checkout: accetta anche gli schemi ritirati (vedi
  // `lib/review-input-revision.mjs`, incidente del 2026-09-19).
  if (!reviewHasInputRevision(current.body, acceptedReviewInputRevisionsFromPullRequest(pr))) {
    return deny('review del claim senza marker body revision corrente');
  }
  const fingerprint = redflagFindingsFingerprint(current.body);
  if (!fingerprint || claim.verdictKey !== `findings:${fingerprint}`) {
    return deny('verdetto review cambiato dopo il claim');
  }
  return { valid: true, reason: 'claim redflag confermato su PR+HEAD+body revision+review id' };
}

function readReviewPages(repo, prNumber) {
  const raw = gh([
    'api', '--paginate', '--slurp', `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  ]);
  const parsed = parseReviewsJson(raw);
  if (!parsed || !parsed.every((page) => Array.isArray(page))) {
    throw new Error('reviews PR: JSON/pagine/entry malformate');
  }
  return parsed;
}

function readPullRequest(repo, prNumber) {
  const raw = gh(['api', `repos/${repo}/pulls/${prNumber}`]);
  try {
    const pr = JSON.parse(raw);
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('PR non è un oggetto');
    return pr;
  } catch (error) {
    throw new Error(`PR metadata: JSON non valido (${error.message})`);
  }
}

function verifyClaim(base, repo) {
  const tokenValue = String(process.env.CLAIM_TOKEN || '');
  if (!tokenValue) return output({ ...base, allowed: false, error: true, reason: 'verify-token-missing' });
  const comments = readComments(repo, base.prNumber);
  const related = latestPrFixClaims(comments, { dedupeKey: base.dedupeKey });
  const current = related.find((claim) => claim.key === base.key && claim.token === tokenValue);
  if (!current || current.state !== 'active') {
    return output({ ...base, allowed: false, error: true, reason: 'claim-active-state-unverifiable' });
  }
  if (related.some((claim) => claim.token !== tokenValue
      && (claim.state === 'active' || claim.state === 'completed' || claim.state === 'failed-terminal'))) {
    return output({ ...base, allowed: false, error: true, reason: 'claim-contended-or-terminalized' });
  }
  const verdict = validateRedflagClaimSnapshot({
    pr: readPullRequest(repo, base.prNumber),
    reviews: readReviewPages(repo, base.prNumber),
    claim: current,
  });
  return output({
    ...base,
    allowed: verdict.valid,
    valid: verdict.valid,
    error: !verdict.valid,
    token: tokenValue,
    state: current.state,
    reason: verdict.reason,
  });
}

function acquireClaim(base, repo) {
  const nowSec = Math.floor(Date.now() / 1000);
  const comments = readComments(repo, base.prNumber);
  const claims = latestPrFixClaims(comments, { dedupeKey: base.dedupeKey });
  const decision = prFixClaimDecision({
    key: base.key,
    dedupeKey: base.dedupeKey,
    claims,
    nowSec,
    activeRunStates: activeRunStates(repo, claims, nowSec),
  });
  if (!decision.allowed || decision.error) return output({ ...base, ...decision });

  const ttlSec = positiveIntFromEnv('CLAIM_TTL_SEC', 2 * 60 * 60);
  const claimToken = process.env.CLAIM_TOKEN || token();
  const event = {
    version: 1,
    token: claimToken,
    ...base,
    state: 'active',
    issuedAt: nowSec,
    expiresAt: nowSec + ttlSec,
    runId: String(process.env.GITHUB_RUN_ID || ''),
  };
  if (process.env.DRY_RUN !== '1') postClaim(repo, base.prNumber, event);
  const after = process.env.DRY_RUN === '1'
    ? [...comments, dryComment(event, comments.length + 1)]
    : readComments(repo, base.prNumber);
  const afterClaims = latestForDedupe(after, base.dedupeKey);
  const active = activeClaimsForArbitration(afterClaims, {
    nowSec,
    activeRunStates: activeRunStates(repo, afterClaims, nowSec),
  });
  const terminal = afterClaims
    .some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal');
  const own = latestPrFixClaims(after, { key: base.key }).find((claim) => claim.token === claimToken);
  const winner = active[0];
  if (!own || own.state !== 'active' || terminal || (winner && winner.token !== claimToken)) {
    const release = releaseClaimEvent({ ownClaim: own, localClaim: event, issuedAt: nowSec });
    if (release && process.env.DRY_RUN !== '1') {
      try { postClaim(repo, base.prNumber, release); } catch { /* safe loser cleanup */ }
    }
    if (terminal) return output({ ...base, allowed: false, exists: true, reason: 'same-pr-head-terminal-claim' });
    if (winner && winner.token !== claimToken) return output({ ...base, allowed: false, exists: true, reason: 'same-pr-head-claim-contended' });
    throw new Error('claim non verificabile');
  }
  return output({ ...base, allowed: true, acquired: true, exists: false, token: claimToken, state: 'active', reason: 'pr-head-claim-acquired' });
}

function finalizeClaim(base, repo) {
  const tokenValue = String(process.env.CLAIM_TOKEN || '');
  if (!tokenValue) return output({ ...base, allowed: false, error: true, reason: 'finalize-token-missing' });
  const comments = readComments(repo, base.prNumber);
  const current = latestPrFixClaims(comments, { key: base.key }).find((claim) => claim.token === tokenValue);
  if (!current) throw new Error('claim token non trovato');
  const executionText = process.env.EXEC_FILE && fs.existsSync(process.env.EXEC_FILE)
    ? fs.readFileSync(process.env.EXEC_FILE, 'utf8')
    : '';
  const state = PR_FIX_CLAIM_STATES.includes(process.env.CLAIM_STATUS)
    ? process.env.CLAIM_STATUS
    : claimStatusFromOutcome({
      proceed: process.env.PROCEED,
      actionOutcome: process.env.ACTION_OUTCOME || process.env.CLAUDE_OUTCOME || '',
      executionText,
    });
  if (current.state === state) return output({ ...base, allowed: true, token: tokenValue, state, reason: 'claim-already-finalized' });
  if (current.state === 'completed' || current.state === 'failed-terminal') {
    throw new Error(`claim gia' terminale (${current.state})`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const finalEvent = {
    ...current,
    state,
    issuedAt: nowSec,
    expiresAt: Math.max(nowSec, Number(current.expiresAt)),
    runId: String(process.env.GITHUB_RUN_ID || current.runId || ''),
  };
  if (process.env.DRY_RUN !== '1') postClaim(repo, base.prNumber, finalEvent);
  const after = process.env.DRY_RUN === '1'
    ? [...comments, dryComment(finalEvent, comments.length + 1)]
    : readComments(repo, base.prNumber);
  const verified = latestPrFixClaims(after, { key: base.key }).find((claim) => claim.token === tokenValue);
  if (!verified || verified.state !== state) throw new Error('finalizzazione claim non verificabile');
  return output({ ...base, allowed: true, token: tokenValue, state, reason: 'pr-head-claim-finalized' });
}

function claimMain() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const base = contextFromEnv();
  try {
    if (!repo || !base.key || !base.dedupeKey || !CLAIM_KIND_SET.has(base.workflow)) {
      return output({ ...base, allowed: false, error: true, reason: 'invalid-claim-context' });
    }
    if ((process.env.CLAIM_ACTION || 'acquire') === 'acquire') return acquireClaim(base, repo);
    if ((process.env.CLAIM_ACTION || '') === 'verify') return verifyClaim(base, repo);
    if ((process.env.CLAIM_ACTION || '') === 'finalize') return finalizeClaim(base, repo);
    return output({ ...base, allowed: false, error: true, reason: 'invalid-claim-action' });
  } catch (error) {
    console.log(`::error::PR fixer claim fail-closed: ${String(error?.message || error).slice(0, 240)}`);
    return output({ ...base, allowed: false, error: true, reason: 'claim-api-or-parse-error' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--claim')) claimMain();
}
