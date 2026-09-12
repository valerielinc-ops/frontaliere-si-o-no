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

function normalizedSignal(value) {
  const signal = normalized(value);
  if (!signal.startsWith('failed-checks:')) return signal;
  const checks = signal.slice('failed-checks:'.length)
    .split(',')
    .map((check) => normalized(check))
    .filter(Boolean)
    .sort();
  return `failed-checks:${checks.join(',')}`;
}

function validContext({ workflow, prNumber, headSha, eventKey, verdictKey } = {}) {
  return CLAIM_KIND_SET.has(String(workflow || ''))
    && PR_RE.test(String(prNumber || ''))
    && SHA_RE.test(String(headSha || ''))
    && (normalized(eventKey) !== '' || normalized(verdictKey) !== '');
}

/**
 * Exact event identity. The event is retained even when a stable verdict is
 * available so a review/rerun remains auditable; the verdict is the stable
 * coalescing identity used by `prFixClaimDecision`.
 */
export function prFixClaimKey({ workflow, prNumber, headSha, eventKey, verdictKey } = {}) {
  if (!validContext({ workflow, prNumber, headSha, eventKey, verdictKey })) return '';
  const event = normalizedSignal(eventKey) || 'none';
  const verdict = normalizedSignal(verdictKey) || 'none';
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
    `workflow:${String(workflow)}`,
    `event:${event}`,
    `verdict:${verdict}`,
  ].join('|');
}

/**
 * Stable identity for retries. It deliberately excludes the event id: a new
 * event that carries the same verdict on the same HEAD is still the same work.
 */
export function prFixClaimDedupeKey({ workflow, prNumber, headSha, eventKey, verdictKey } = {}) {
  if (!validContext({ workflow, prNumber, headSha, eventKey, verdictKey })) return '';
  const signal = normalizedSignal(verdictKey) || normalizedSignal(eventKey);
  return [
    `pr:${String(prNumber)}`,
    `head:${String(headSha).toLowerCase()}`,
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
  });
}

function dedupeKeyFromEvent(event) {
  return prFixClaimDedupeKey({
    workflow: event?.workflow,
    prNumber: event?.prNumber,
    headSha: event?.headSha,
    eventKey: event?.eventKey,
    verdictKey: event?.verdictKey,
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

  const normalizedEvent = {
    ...event,
    workflow: String(event.workflow),
    prNumber: String(event.prNumber),
    headSha: String(event.headSha).toLowerCase(),
    eventKey: normalizedSignal(event.eventKey),
    verdictKey: normalizedSignal(event.verdictKey),
    issuedAt: Number(event.issuedAt),
    expiresAt: Number(event.expiresAt),
  };
  if (!normalizedEvent.eventKey && !normalizedEvent.verdictKey) return null;
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

function runIsFinished(state) {
  if (!state || typeof state !== 'object') return false;
  // A successful runner may have posted its verdict but not yet finalized the
  // claim because the comments API was eventually consistent. Releasing that
  // claim merely because the runner is completed would permit a duplicate.
  // Only outcomes that prove an interrupted/unsuccessful attempt are
  // retryable; an unreadable or successful state remains fail-closed until TTL.
  return ['cancelled', 'failure', 'timed_out', 'action_required', 'skipped'].includes(state.conclusion);
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
export function claimStatusFromOutcome({ proceed, claudeOutcome = '', executionText = '' } = {}) {
  if (proceed !== true && proceed !== 'true') return 'released';
  const text = String(executionText || '');
  const transient = /(?:api_error_status|status_code|http_status|status)"?\s*:\s*"?429\b|\bHTTP\s*429\b|\b(?:overloaded|server_error|internal server error)\b/iu.test(text);
  // An empty/skipped action means an earlier setup step stopped the Claude
  // path after the claim was acquired. It is not a verdict and must not make
  // the same contribution permanently consumed.
  if (transient || claudeOutcome === 'cancelled' || claudeOutcome === '' || claudeOutcome === 'skipped') {
    return 'failed-transient';
  }
  if (claudeOutcome === 'failure') return 'failed-terminal';
  return 'completed';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const key = prFixClaimKey({ workflow, prNumber, headSha, eventKey, verdictKey });
  const dedupeKey = prFixClaimDedupeKey({ workflow, prNumber, headSha, eventKey, verdictKey });
  return { workflow, prNumber, headSha, eventKey, verdictKey, key, dedupeKey };
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
  const active = latestForDedupe(after, base.dedupeKey)
    .filter((claim) => claim.state === 'active' && Number(claim.expiresAt) > nowSec);
  const terminal = latestForDedupe(after, base.dedupeKey)
    .some((claim) => claim.state === 'completed' || claim.state === 'failed-terminal');
  const own = latestPrFixClaims(after, { key: base.key }).find((claim) => claim.token === claimToken);
  const winner = active[0];
  if (!own || own.state !== 'active' || terminal || (winner && winner.token !== claimToken)) {
    if (own?.state === 'active' && process.env.DRY_RUN !== '1') {
      try { postClaim(repo, base.prNumber, { ...own, state: 'released', issuedAt: nowSec }); } catch { /* safe loser cleanup */ }
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
      claudeOutcome: process.env.CLAUDE_OUTCOME || '',
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
