#!/usr/bin/env node
/**
 * Shared, zero-provider coordination for the repair/issue-fix quota floor.
 *
 * GitHub Actions has no cross-workflow step mutex.  The parent quota issue is
 * therefore used as a small append-only ledger: a lease reserves one slot,
 * a release marker frees it, and an expiry makes a crashed run recoverable.
 * The parser is deliberately strict.  A ledger that cannot be read or parsed
 * is not an empty ledger; callers must stop before starting a provider.
 */
import { execFileSync } from 'node:child_process';

/** @typedef {(args: string[]) => any} QuotaFloorCommand */
/** @typedef {(args: string[]) => any} QuotaFloorJsonReader */

export const QUOTA_FLOOR_LEDGER_ISSUE = '8306';
export const QUOTA_FLOOR_LEASE_TTL_SEC = 6 * 60 * 60;
export const QUOTA_FLOOR_LEASE_KINDS = Object.freeze(['repair', 'issue-fix']);

const LEASE_PREFIX = '<!-- QUOTA_FLOOR_LEASE';
const RELEASE_PREFIX = '<!-- QUOTA_FLOOR_RELEASE';
const LEASE_RE = /^<!--\s*QUOTA_FLOOR_LEASE\s+v1\s+kind=(repair|issue-fix)\s+subject=([A-Za-z0-9._:/#-]+)\s+owner=([A-Za-z0-9._:/#-]+)\s+expires=(\d+)\s*-->$/;
const RELEASE_RE = /^<!--\s*QUOTA_FLOOR_RELEASE\s+v1\s+owner=([A-Za-z0-9._:/#-]+)\s*-->$/;

function token(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/.test(text)) {
    throw new Error(`${name} must be a non-empty safe token`);
  }
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function flattenComments(raw) {
  if (!Array.isArray(raw)) return null;
  const comments = raw.flat(Infinity);
  return comments.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment))
    ? comments
    : null;
}

/** @param {string[]} args */
function defaultRunJson(args) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

/** @param {string[]} args */
function defaultRunCommand(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * @param {{repo?: string, ledgerIssue?: string}} [options]
 * @returns {string[]}
 */
export function quotaFloorLedgerArgs({ repo, ledgerIssue = QUOTA_FLOOR_LEDGER_ISSUE } = {}) {
  return ['api', `repos/${token(repo, 'repo')}/issues/${token(ledgerIssue, 'ledgerIssue')}/comments`, '--paginate', '--slurp'];
}

/**
 * @param {{kind?: string, subject?: string, owner?: string, expiresAt?: number}} [options]
 * @returns {string}
 */
export function quotaFloorLeaseMarker({ kind, subject, owner, expiresAt } = {}) {
  const normalizedKind = token(kind, 'kind');
  if (!QUOTA_FLOOR_LEASE_KINDS.includes(normalizedKind)) {
    throw new Error(`unsupported quota floor lease kind: ${normalizedKind}`);
  }
  return `<!-- QUOTA_FLOOR_LEASE v1 kind=${normalizedKind} subject=${token(subject, 'subject')} owner=${token(owner, 'owner')} expires=${positiveInteger(expiresAt, 'expiresAt')} -->`;
}

/** @param {string} owner */
export function quotaFloorReleaseMarker(owner) {
  return `<!-- QUOTA_FLOOR_RELEASE v1 owner=${token(owner, 'owner')} -->`;
}

/**
 * @param {{kind?: string, subject?: string, runId?: string, attempt?: string}} [options]
 * @returns {string}
 */
export function quotaFloorLeaseOwner({ kind, subject, runId = 'manual', attempt = '0' } = {}) {
  return `${token(kind, 'kind')}:${token(subject, 'subject')}:${token(runId, 'runId')}:${token(attempt, 'attempt')}`;
}

/**
 * @param {number} [nowSec]
 * @param {number} [ttlSec]
 * @returns {number}
 */
export function quotaFloorLeaseExpiry(nowSec = Math.floor(Date.now() / 1000), ttlSec = QUOTA_FLOOR_LEASE_TTL_SEC) {
  return positiveInteger(nowSec, 'nowSec') + positiveInteger(ttlSec, 'ttlSec');
}

/**
 * Parse the append-only ledger.  Expired leases are intentionally returned in
 * `leases` for audit, but only unexpired/unreleased entries are `activeLeases`.
 * @param {any} raw
 * @param {{nowSec?: number}} [options]
 */
export function parseQuotaFloorLedger(raw, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const comments = flattenComments(raw);
  if (!comments) return { ok: false, reason: 'quota floor ledger malformed', leases: [], activeLeases: [] };
  const now = Number(nowSec);
  if (!Number.isSafeInteger(now) || now <= 0) {
    return { ok: false, reason: 'quota floor clock malformed', leases: [], activeLeases: [] };
  }

  const released = new Set();
  const byOwner = new Map();
  let malformed = false;
  for (const comment of comments) {
    const body = String(comment.body || '').trim();
    if (body.startsWith(LEASE_PREFIX)) {
      const match = LEASE_RE.exec(body);
      if (!match) {
        malformed = true;
        continue;
      }
      const [, kind, subject, owner, expires] = match;
      const expiresAt = Number(expires);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || byOwner.has(owner)) {
        malformed = true;
        continue;
      }
      byOwner.set(owner, {
        kind,
        subject,
        owner,
        expiresAt,
        released: released.has(owner),
        commentId: comment.id ?? null,
      });
      continue;
    }
    if (body.startsWith(RELEASE_PREFIX)) {
      const match = RELEASE_RE.exec(body);
      if (!match) {
        malformed = true;
        continue;
      }
      const owner = match[1];
      released.add(owner);
      const current = byOwner.get(owner);
      if (current) current.released = true;
    }
  }

  const leases = [...byOwner.values()];
  const activeLeases = leases.filter((lease) => !lease.released && lease.expiresAt > now);
  if (malformed) {
    return { ok: false, reason: 'quota floor ledger contains an invalid marker', leases, activeLeases: [] };
  }
  return {
    ok: true,
    leases,
    activeLeases,
    activeCounts: {
      repair: activeLeases.filter((lease) => lease.kind === 'repair').length,
      'issue-fix': activeLeases.filter((lease) => lease.kind === 'issue-fix').length,
    },
  };
}

/**
 * @param {{repo?: string, ledgerIssue?: string, nowSec?: number, runJson?: QuotaFloorJsonReader}} [options]
 */
export function readQuotaFloorLedger({ repo, ledgerIssue = QUOTA_FLOOR_LEDGER_ISSUE, nowSec, runJson = defaultRunJson } = {}) {
  if (!repo) return { ok: false, reason: 'quota floor repository missing', leases: [], activeLeases: [] };
  try {
    return {
      ...parseQuotaFloorLedger(runJson(quotaFloorLedgerArgs({ repo, ledgerIssue })), { nowSec }),
      ledgerIssue: String(ledgerIssue),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `quota floor ledger unavailable: ${error?.message || String(error)}`,
      leases: [],
      activeLeases: [],
    };
  }
}

/**
 * @param {any} ledger
 * @param {{kind?: string, subject?: string}} [options]
 */
export function quotaFloorLeaseForSubject(ledger, { kind, subject } = {}) {
  const wantedKind = String(kind || '');
  const wantedSubject = String(subject || '');
  return (ledger?.activeLeases || []).filter((lease) =>
    lease.kind === wantedKind && lease.subject === wantedSubject);
}

/**
 * Decide whether a caller may use the shared floor ledger.  An existing lease
 * for the same subject is reusable: this is what connects drainer promotion to
 * the issue-fix preflight without minting a second reservation.
 * @param {any} ledger
 * @param {{kind?: string, subject?: string, fairnessHold?: boolean}} [options]
 */
export function quotaFloorLeaseDecision(ledger, { kind, subject, fairnessHold = false } = {}) {
  if (!ledger || ledger.ok !== true || !Array.isArray(ledger.activeLeases)) {
    return { admit: false, reason: 'quota floor telemetry unavailable', existing: null };
  }
  if (fairnessHold && kind === 'repair') {
    return { admit: false, reason: 'quota floor held for peer fairness', existing: null };
  }
  const matches = quotaFloorLeaseForSubject(ledger, { kind, subject });
  if (matches.length > 1) {
    return { admit: false, reason: 'multiple active quota floor leases for subject', existing: null };
  }
  return matches.length === 1
    ? { admit: true, reason: 'existing subject lease reused', existing: matches[0] }
    : { admit: true, reason: 'new quota floor lease required', existing: null };
}

/**
 * @param {{repo?: string, ledgerIssue?: string, kind?: string, subject?: string, owner?: string, expiresAt?: number, runCommand?: QuotaFloorCommand}} [options]
 */
export function acquireQuotaFloorLease({ repo, ledgerIssue = QUOTA_FLOOR_LEDGER_ISSUE, kind, subject, owner, expiresAt, runCommand = defaultRunCommand } = {}) {
  const marker = quotaFloorLeaseMarker({ kind, subject, owner, expiresAt });
  try {
    runCommand(['issue', 'comment', token(ledgerIssue, 'ledgerIssue'), '--repo', token(repo, 'repo'), '--body', marker]);
    return { ok: true, marker, owner: token(owner, 'owner'), subject: token(subject, 'subject') };
  } catch (error) {
    return { ok: false, reason: `quota floor lease acquisition failed: ${error?.message || String(error)}` };
  }
}

/**
 * @param {{repo?: string, ledgerIssue?: string, owner?: string, runCommand?: QuotaFloorCommand}} [options]
 */
export function releaseQuotaFloorLease({ repo, ledgerIssue = QUOTA_FLOOR_LEDGER_ISSUE, owner, runCommand = defaultRunCommand } = {}) {
  const marker = quotaFloorReleaseMarker(owner);
  try {
    runCommand(['issue', 'comment', token(ledgerIssue, 'ledgerIssue'), '--repo', token(repo, 'repo'), '--body', marker]);
    return { ok: true, marker, owner: token(owner, 'owner') };
  } catch (error) {
    return { ok: false, reason: `quota floor lease release failed: ${error?.message || String(error)}` };
  }
}

/**
 * Fairness is pure so peer reservation cannot drift between the drainer and tests.
 * @param {{nowHour?: number, reservedHours?: string, peerQueue?: number, peerQueueMin?: number}} [options]
 */
export function quotaFloorFairnessDecision({ nowHour, reservedHours = '', peerQueue, peerQueueMin = 10 } = {}) {
  const hour = Number(nowHour);
  const queue = peerQueue === null || peerQueue === undefined || peerQueue === '' ? NaN : Number(peerQueue);
  const minimum = peerQueueMin === null || peerQueueMin === undefined || peerQueueMin === '' ? NaN : Number(peerQueueMin);
  const rawHours = String(reservedHours ?? '').trim();
  const hourTokens = rawHours ? rawHours.split(',').map((value) => value.trim()) : [];
  const hours = hourTokens.map((value) => Number(value));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isSafeInteger(queue) || queue < 0
    || !Number.isSafeInteger(minimum) || minimum < 1
    || hourTokens.some((value, index) => !/^\d+$/.test(value)
      || !Number.isSafeInteger(hours[index]) || hours[index] < 0 || hours[index] > 23)) {
    return { ok: false, hold: true, reason: 'fairness telemetry malformed' };
  }
  const hold = hours.includes(hour) && queue >= minimum;
  return {
    ok: true,
    hold,
    reason: hold ? `peer queue ${queue} reaches fairness floor ${minimum}` : 'peer fairness window not active',
    hour,
    peerQueue: queue,
    peerQueueMin: minimum,
  };
}
