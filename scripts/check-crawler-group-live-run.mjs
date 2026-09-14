#!/usr/bin/env node

// Guard against #7091: the disabled workflow_dispatch file and the live
// workflow_call sibling are separate entry points, and the latter is invoked
// from the corpus repository. Their runner processes cannot share the
// in-memory HOST_DELAY_MS pacing used by the Gardenia transport, so starting
// both at once would double the request rate against the same host.
//
// A concurrency group cannot cover this boundary: GitHub scopes concurrency
// groups to one repository. Each entry point therefore acquires the same
// Firestore transaction lease before checking the other repository's Actions
// API and keeps it until the grouped crawlers and finalizer have completed.
//
// PROCEED-SAFE: the GitHub API probe is an additional early warning. A missing
// probe token/API response must not turn the guard into a new outage; the
// acquired Firestore lease still serializes both entry points. If Firestore
// credentials are unavailable, the script logs the explicit fail-open path and
// retains the API probe fallback.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  acquireLease,
  releaseLease,
} from './lib/global-data-pipeline-lease.mjs';

const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
export const LIVE_RUN_QUERY_TIMEOUT_MS = 30_000;
// The longest grouped job is capped at 340 minutes. A six-hour lease gives a
// crashed runner a bounded takeover window while covering the full job plus
// finalization/release, and normal runs delete it immediately on completion.
export const CRAWLER_GROUP_LIVE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;
export const CRAWLER_GROUP_LIVE_LEASE_WAIT_MS = 0;
export const CRAWLER_GROUP_LIVE_LEASE_OWNED_ENV = 'CRAWLER_GROUP_LIVE_LEASE_OWNED';
export const CRAWLER_GROUP_LIVE_LEASE_DOC_ENV = 'CRAWLER_GROUP_LIVE_LEASE_DOC';

function warning(logger, message) {
  (logger?.warn || console.warn)(`::warning::${message}`);
}

function info(logger, message) {
  (logger?.log || console.log)(message);
}

function error(logger, message) {
  (logger?.error || console.error)(`::error::${message}`);
}

export function crawlerGroupLeaseDoc(groupFile) {
  const match = /^crawler-group-(\d{2})\.yml$/u.exec(String(groupFile || ''));
  if (!match) throw new Error(`invalid crawler group file for lease: ${JSON.stringify(groupFile)}`);
  return `ci_leases/crawler-group-live-${match[1]}`;
}

export function parseArgs(argv) {
  const [groupFile, ...rest] = argv;
  const opts = {
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    tokenEnv: 'GITHUB_PAT_NANAKO',
    action: 'acquire',
  };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--repo' && rest[index + 1]) opts.repo = rest[++index];
    else if (rest[index] === '--token-env' && rest[index + 1]) opts.tokenEnv = rest[++index];
    else if (rest[index] === '--release') opts.action = 'release';
  }
  return { groupFile, ...opts };
}

function isTimeoutError(errorValue) {
  return errorValue?.code === 'ETIMEDOUT'
    || errorValue?.timedOut === true
    || (errorValue?.killed === true && errorValue?.signal === 'SIGTERM');
}

function runsFromPages(parsed, logger, groupFile) {
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const runs = [];
  let recognizedPage = false;
  for (const page of pages) {
    if (Array.isArray(page)) {
      recognizedPage = true;
      runs.push(...page);
    } else if (Array.isArray(page?.workflow_runs)) {
      recognizedPage = true;
      runs.push(...page.workflow_runs);
    } else if (typeof page?.status === 'string') {
      // Keep the parser tolerant of the small `{status}` fixture shape used
      // by local callers while production uses `gh api --paginate --slurp`.
      recognizedPage = true;
      runs.push(page);
    }
  }
  if (!recognizedPage) {
    warning(logger, `cross-entry live-run probe returned an unrecognized response for ${groupFile}; proceeding fail-open`);
  }
  return runs;
}

export function hasLiveRun(groupFile, {
  repo,
  token,
  gh = execFileSync,
  logger = console,
  timeoutMs = LIVE_RUN_QUERY_TIMEOUT_MS,
} = {}) {
  if (!groupFile || !repo || !token) return false;

  let raw;
  try {
    raw = gh('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/workflows/${encodeURIComponent(groupFile)}/runs?per_page=100`,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      env: { ...process.env, GH_TOKEN: token },
    });
  } catch (errorValue) {
    const reason = isTimeoutError(errorValue)
      ? `timed out after ${timeoutMs}ms`
      : `failed (${errorValue?.message || String(errorValue)})`;
    warning(logger, `cross-entry live-run probe for ${groupFile} ${reason}; proceeding fail-open`);
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (errorValue) {
    warning(logger, `cross-entry live-run probe returned malformed JSON for ${groupFile} (${errorValue?.message || String(errorValue)}); proceeding fail-open`);
    return false;
  }
  const runs = runsFromPages(parsed, logger, groupFile);
  return runs.some((run) => LIVE_STATUSES.has(run?.status));
}

export function persistLeaseOwnership(leaseDoc, envPath = process.env.GITHUB_ENV) {
  if (!envPath) return false;
  fs.appendFileSync(envPath, [
    `${CRAWLER_GROUP_LIVE_LEASE_OWNED_ENV}=1`,
    `${CRAWLER_GROUP_LIVE_LEASE_DOC_ENV}=${leaseDoc}`,
  ].join('\n') + '\n', 'utf8');
  return true;
}

async function releaseOwnedLease(leaseDoc, { release = releaseLease, logger = console } = {}) {
  try {
    const result = await release({
      leaseDoc,
      ttlMs: CRAWLER_GROUP_LIVE_LEASE_TTL_MS,
    });
    if (result?.notOwner) {
      warning(logger, `cross-entry crawler lease ${leaseDoc} was not owned by this run; left it untouched`);
    }
    return result;
  } catch (errorValue) {
    warning(logger, `could not release cross-entry crawler lease ${leaseDoc}: ${errorValue?.message || String(errorValue)}; the bounded TTL remains the recovery path`);
    return null;
  }
}

/**
 * Acquire the cross-entry lease before probing and persist ownership for the
 * final `always()` release step. The API probe remains fail-open because the
 * lease, when available, is the coordination primitive rather than the probe.
 */
export async function runGuard({
  groupFile,
  repo,
  token,
  acquire = acquireLease,
  release = releaseLease,
  probe = hasLiveRun,
  persist = persistLeaseOwnership,
  logger = console,
} = {}) {
  const leaseDoc = crawlerGroupLeaseDoc(groupFile);
  let leaseOwned = false;

  try {
    const result = await acquire({
      leaseDoc,
      ttlMs: CRAWLER_GROUP_LIVE_LEASE_TTL_MS,
      waitMs: CRAWLER_GROUP_LIVE_LEASE_WAIT_MS,
    });
    if (result?.busy) {
      error(logger, `${groupFile} is already protected by a live cross-entry crawler lease (${leaseDoc}); refusing to launch a concurrent run. Retry once it finishes.`);
      return { proceed: false, reason: 'lease-busy', leaseDoc, leaseOwned: false };
    }
    leaseOwned = result?.acquired === true;
    if (!leaseOwned) {
      warning(logger, `cross-entry crawler lease ${leaseDoc} was not acquired; proceeding with the bounded API probe fallback`);
    }
  } catch (errorValue) {
    warning(logger, `cross-entry crawler lease ${leaseDoc} is unavailable (${errorValue?.message || String(errorValue)}); proceeding with the bounded API probe fallback`);
  }

  const live = token
    ? await probe(groupFile, { repo, token, logger })
    : false;
  if (!token) {
    info(logger, `ℹ️ no cross-entry probe token is configured — lease/API guard probe skipped for ${groupFile}.`);
  }
  if (live) {
    if (leaseOwned) await releaseOwnedLease(leaseDoc, { release, logger });
    error(logger, `${groupFile} already has a live/queued run in ${repo} — refusing to start a second one (issue #7091: uncoordinated cross-process rate limiting). Re-run once it finishes.`);
    return { proceed: false, reason: 'live-run', leaseDoc, leaseOwned: false };
  }

  if (leaseOwned) {
    try {
      if (persist(leaseDoc)) {
        info(logger, `✅ Cross-entry crawler lease ${leaseDoc} acquired — holding it until the final always-run release step.`);
        return { proceed: true, reason: 'lease-held', leaseDoc, leaseOwned: true };
      }
      await releaseOwnedLease(leaseDoc, { release, logger });
      info(logger, `✅ No live run of ${groupFile} found in ${repo} — local invocation released ${leaseDoc} and is proceeding.`);
    } catch (errorValue) {
      await releaseOwnedLease(leaseDoc, { release, logger });
      error(logger, `could not persist ownership of cross-entry crawler lease ${leaseDoc}: ${errorValue?.message || String(errorValue)}`);
      return { proceed: false, reason: 'lease-marker-failed', leaseDoc, leaseOwned: false };
    }
  } else {
    info(logger, `✅ No live run of ${groupFile} found in ${repo} — proceeding with the explicit fail-open fallback.`);
  }
  return { proceed: true, reason: 'no-live-run', leaseDoc, leaseOwned: false };
}

export async function releaseGuard({ groupFile, release = releaseLease, logger = console } = {}) {
  const leaseDoc = crawlerGroupLeaseDoc(groupFile);
  const result = await releaseOwnedLease(leaseDoc, { release, logger });
  if (result?.released) info(logger, `✅ Cross-entry crawler lease ${leaseDoc} released.`);
  return result;
}

async function main() {
  const { groupFile, repo, tokenEnv, action } = parseArgs(process.argv.slice(2));
  if (!groupFile) {
    console.error('usage: check-crawler-group-live-run.mjs <group-file.yml> [--repo owner/repo] [--token-env VAR] [--release]');
    return;
  }

  if (action === 'release') {
    await releaseGuard({ groupFile });
    return;
  }

  const token = process.env[tokenEnv] || '';
  const result = await runGuard({ groupFile, repo, token });
  if (!result.proceed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((errorValue) => {
    console.error(`::error::cross-entry crawler guard failed: ${errorValue?.message || String(errorValue)}`);
    process.exitCode = 1;
  });
}
