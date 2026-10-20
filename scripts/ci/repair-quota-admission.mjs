#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * repair-quota-admission.mjs — zero-Claude allocation floor for the two PR
 * repair workflows.
 *
 * The loop-health report (#8328) observes an unhealthy ratio, but observation
 * alone cannot stop the next redflag/redcheck invocation from spending a
 * provider attempt. This gate uses the same seven-day run window and the same
 * real-run definition as that report. While issue-fix work is queued, the
 * first seven repair runs are admitted; after that, repair runs are admitted
 * only when issue-fix has kept the rolling ratio at or below 7:1.
 *
 * A held round is zero-Claude and durable: the current round marker is
 * removed, the PR receives `stale-review`, and the existing stale rescuer can
 * re-arm the red review/check after its normal cooldown. The shared ledger
 * lease is released by the provider-neutral adapter on every terminal path;
 * an unreadable ledger or failed lease mutation is fail-closed so a broken
 * gate cannot spend an unaccounted provider attempt.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import {
  acquireQuotaFloorLease,
  quotaFloorLeaseDecision,
  quotaFloorLeaseExpiry,
  quotaFloorLeaseOwner,
  QUOTA_FLOOR_LEDGER_ISSUE,
  QUOTA_FLOOR_LEASE_TTL_SEC,
  readQuotaFloorLedger,
} from './quota-floor-lease.mjs';

export const REPAIR_TO_ISSUE_RATIO_MAX = 7;
export const INITIAL_REPAIR_ALLOWANCE = REPAIR_TO_ISSUE_RATIO_MAX;
export const REPAIR_WORKFLOWS = Object.freeze([
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
]);
export const ISSUE_FIX_WORKFLOW = 'issue-fix.yml';
export const GH_READ_TIMEOUT_MS = 45_000;
export const GH_READ_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/** Count runs using the same real-run proxy as loop-health-report.mjs. */
export function realRunCount(runs, { excludeActive = false } = {}) {
  if (!Array.isArray(runs)) return null;
  return runs.filter((run) => {
    const state = run?.conclusion || run?.status || 'unknown';
    if (excludeActive && !run?.conclusion
      && ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(run?.status)) {
      return false;
    }
    return state !== 'cancelled' && state !== 'skipped';
  }).length;
}

/**
 * Pure rolling allocation decision.
 *
 * The initial allowance avoids deadlocking a healthy system with no issue-fix
 * history. Once the allowance is spent, `ceil(repairs / ratio)` issue-fix runs
 * are required while the queue is non-empty. This admits exactly a 7:1
 * frontier and holds the next repair until the issue-fix side advances.
 */
export function repairQuotaDecision({
  repairRuns = 0,
  issueFixRuns = 0,
  queuedIssues = 0,
  activeRepairLeases = 0,
  activeIssueFixLeases = 0,
  maxRatio = REPAIR_TO_ISSUE_RATIO_MAX,
} = {}) {
  const repairs = nonNegativeInteger(repairRuns);
  const issueFix = nonNegativeInteger(issueFixRuns);
  const repairLeases = nonNegativeInteger(activeRepairLeases);
  const issueFixLeases = nonNegativeInteger(activeIssueFixLeases);
  const queued = nonNegativeInteger(queuedIssues);
  const ratio = Math.max(1, nonNegativeInteger(maxRatio, REPAIR_TO_ISSUE_RATIO_MAX));
  const effectiveRepairs = repairs + repairLeases;
  const effectiveIssueFix = issueFix + issueFixLeases;

  if (queued === 0) {
    return {
      admit: true,
      reason: 'issue-fix queue empty',
      requiredIssueFixRuns: 0,
      repairRuns: repairs,
      issueFixRuns: issueFix,
      activeRepairLeases: repairLeases,
      activeIssueFixLeases: issueFixLeases,
      effectiveRepairRuns: effectiveRepairs,
      effectiveIssueFixRuns: effectiveIssueFix,
      queuedIssues: queued,
    };
  }

  if (effectiveRepairs <= ratio) {
    return {
      admit: true,
      reason: `initial repair allowance (${effectiveRepairs}/${ratio})`,
      requiredIssueFixRuns: 0,
      repairRuns: repairs,
      issueFixRuns: issueFix,
      activeRepairLeases: repairLeases,
      activeIssueFixLeases: issueFixLeases,
      effectiveRepairRuns: effectiveRepairs,
      effectiveIssueFixRuns: effectiveIssueFix,
      queuedIssues: queued,
    };
  }

  const requiredIssueFixRuns = Math.ceil(effectiveRepairs / ratio);
  const admit = effectiveIssueFix >= requiredIssueFixRuns;
  return {
    admit,
    reason: admit
      ? `allocation frontier satisfied (${effectiveRepairs}:${effectiveIssueFix}, max ${ratio}:1)`
      : `issue-fix floor missing (${effectiveIssueFix}/${requiredIssueFixRuns} for ${effectiveRepairs} repair runs, max ${ratio}:1)`,
    requiredIssueFixRuns,
    repairRuns: repairs,
    issueFixRuns: issueFix,
    activeRepairLeases: repairLeases,
    activeIssueFixLeases: issueFixLeases,
    effectiveRepairRuns: effectiveRepairs,
    effectiveIssueFixRuns: effectiveIssueFix,
    queuedIssues: queued,
  };
}

/** Return the fixer workflow filename represented by an Actions ref/name. */
export function repairWorkflowFromRef(value = '') {
  const text = String(value || '').toLowerCase();
  return REPAIR_WORKFLOWS.find((workflow) => text.includes(workflow)) || '';
}

function transientReadFailure(error) {
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString('utf8')
    : String(error?.stderr || '');
  const detail = `${error?.message || ''}\n${stderr}`;
  const httpStatus = detail.match(/\bHTTP\s+(500|502|503|504)\b/i)?.[1];
  if (httpStatus) return `HTTP ${httpStatus}`;
  if ([error?.code, error?.errno, error?.error?.code].some((code) => code === 'ETIMEDOUT')
    || /\bETIMEDOUT\b|timed out|timeout expired/i.test(detail)) {
    return 'command timeout';
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN)\b|socket hang up|fetch failed/i.test(detail)) {
    return 'network error';
  }
  return '';
}

function sleepSync(delayMs) {
  if (delayMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

/**
 * Run a read-only GitHub CLI query with a per-attempt deadline and bounded
 * retries for transient service/network failures. Auth, permission, malformed
 * JSON, and exhausted telemetry failures remain fail-closed.
 */
export function runGhJsonBounded(args, {
  execute = execFileSync,
  sleep = sleepSync,
  warn = console.warn,
  timeoutMs = GH_READ_TIMEOUT_MS,
  retryDelaysMs = GH_READ_RETRY_DELAYS_MS,
} = {}) {
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = execute('gh', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return JSON.parse(output);
    } catch (error) {
      const failure = transientReadFailure(error);
      const delayMs = retryDelaysMs[attempt - 1];
      if (!failure || delayMs === undefined) {
        if (failure) {
          throw new Error(`GitHub CLI read failed after ${attempt} attempts (${failure})`, { cause: error });
        }
        throw error;
      }
      warn(`::warning::GitHub telemetry read failed (${failure}); retry ${attempt}/${retryDelaysMs.length} after ${delayMs}ms.`);
      sleep(delayMs);
    }
  }
  throw new Error('GitHub CLI read retry loop exhausted unexpectedly');
}

function defaultRunJson(args) {
  return runGhJsonBounded(args);
}

function defaultRunCommand(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sinceDate(now = Date.now()) {
  return new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
}

function activeQuotaCounts(floor) {
  if (!floor.ok || !('activeCounts' in floor) || !floor.activeCounts) {
    throw new Error(floor.reason || 'quota floor active counts missing');
  }
  return floor.activeCounts;
}

/**
 * Fetch the bounded inputs used by the pure decision. Kept injectable so the
 * accounting contract can be tested without GitHub.
 * @param {{repo?: string, since?: string, nowSec?: number, ledgerIssue?: string, runJson?: (args: string[]) => any}} [options]
 */
export function collectRepairQuotaStats({
  repo,
  since = sinceDate(),
  nowSec = Math.floor(Date.now() / 1000),
  ledgerIssue = QUOTA_FLOOR_LEDGER_ISSUE,
  runJson = defaultRunJson,
} = {}) {
  if (!repo) return { ok: false, reason: 'repository missing' };
  try {
    const runArgs = (workflow) => [
      'run', 'list', '--repo', repo, '--workflow', workflow,
      '--created', `>${since}`, '--limit', '1000', '--json', 'conclusion,status',
    ];
    const repairCounts = REPAIR_WORKFLOWS
      // In-flight runs are accounted for by the shared lease, not twice by
      // the Actions listing plus the ledger reservation.
      .map((workflow) => realRunCount(runJson(runArgs(workflow)), { excludeActive: true }));
    if (repairCounts.some((count) => count === null)) throw new Error('repair run listing malformed');
    const repairRuns = repairCounts.reduce((sum, count) => sum + count, 0);
    const issueFixRuns = realRunCount(runJson(runArgs(ISSUE_FIX_WORKFLOW)), { excludeActive: true });
    if (issueFixRuns === null) throw new Error('issue-fix run listing malformed');
    const queued = runJson([
      'issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'agent:fix-queued', '--json', 'number', '--limit', '300',
    ]);
    if (!Array.isArray(queued)) throw new Error('queue listing malformed');
    if (queued.length >= 300) throw new Error('queue listing reached the 300-item cap');
    const floor = readQuotaFloorLedger({
      repo,
      ledgerIssue,
      nowSec,
      runJson,
    });
    if (!floor.ok) throw new Error(floor.reason);
    const activeCounts = activeQuotaCounts(floor);
    return {
      ok: true,
      since,
      repairRuns,
      issueFixRuns,
      queuedIssues: queued.length,
      activeRepairLeases: activeCounts.repair,
      activeIssueFixLeases: activeCounts['issue-fix'],
      floor,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `GitHub telemetry unavailable: ${error?.message || String(error)}`,
    };
  }
}

function jsonComments(raw) {
  if (!Array.isArray(raw)) return null;
  const comments = raw.flat(Infinity);
  return comments.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment))
    ? comments
    : null;
}

function roundMarkerFor(workflow) {
  return workflow === 'pr-redcheck-fixer.yml' ? 'REDCHECK_FIX_ROUND' : 'REDFLAG_FIX_ROUND';
}

function commentArgs(repo, pr) {
  return ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp'];
}

function headSha(repo, pr, runJson) {
  const value = runJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
  return typeof value?.headRefOid === 'string' ? value.headRefOid : '';
}

/**
 * Refund the round only after a durable re-arm path is in place. The helper
 * returns false on any mutation failure; callers keep the provider blocked
 * rather than leaving a provider attempt unaccounted for.
 */
function holdCurrentRound({
  repo,
  pr,
  workflow,
  round,
  reviewRevision,
  stats,
  decision,
  runJson,
  runCommand,
}) {
  try {
    const sha = headSha(repo, pr, runJson);
    if (!sha) throw new Error('PR head SHA missing');
    const comments = jsonComments(runJson(commentArgs(repo, pr)));
    if (!comments) throw new Error('PR comments listing malformed');

    const holdMarker = `<!-- REPAIR_QUOTA_HOLD: ${workflow}:${sha} -->`;
    const roundNumber = String(round || '').trim();
    const marker = roundMarkerFor(workflow);
    const candidates = comments.map((comment) => ({
      comment,
      line: String(comment.body || '').split(/\r?\n/u, 1)[0],
    }));
    // Both fixer producers scope rounds by HEAD and, now, body revision.
    // Never refund an older unscoped marker when this round has a scoped one.
    const hasScopedMarker = candidates.some(({ line }) => line.startsWith(`<!-- ${marker}: ${roundNumber} HEAD:`));
    const scopedPattern = new RegExp(`^<!-- ${marker}: ([1-9]\\d*) HEAD: ([0-9a-f]{40})(?: BODY: (body:[0-9a-f]{64}))? -->$`, 'i');
    const roundComment = /^[1-9]\d*$/u.test(roundNumber)
      ? [...candidates].reverse().find(({ comment, line }) => {
        if (!hasScopedMarker) return line === `<!-- ${marker}: ${roundNumber} -->`;
        const parsed = line.match(scopedPattern);
        return parsed?.[1] === roundNumber
          && parsed[2].toLowerCase() === sha.toLowerCase()
          && (!parsed[3] || parsed[3].toLowerCase() === String(reviewRevision || '').toLowerCase())
          && comment.user?.login === 'github-actions[bot]'
          && comment.user?.type === 'Bot';
      })?.comment
      : null;
    if (!roundComment?.id) {
      throw new Error('current round marker missing; refuse an untracked hold');
    }

    // The label is the durable wake-up path used by stale-pr-rescuer.yml.
    runCommand(['pr', 'edit', String(pr), '--repo', repo, '--add-label', 'stale-review']);

    const body = [
      holdMarker,
      '⏸️ **Repair quota admission (zero-Claude)**',
      `Il fixer ${workflow} sospende questo round sulla HEAD ${sha.slice(0, 12)}:`,
      `${decision.reason}. Finestra dal ${stats.since}: ${stats.repairRuns} run di riparazione PR, ${stats.issueFixRuns} run issue-fix, ${stats.queuedIssues} issue in coda.`,
      '',
      'La label `stale-review` lascia al rescuer esistente il compito di riattivare la PR dopo il cooldown; nessun lavoro viene chiuso o perso.',
    ].join('\n');
    // This comment is posted before deleting the round marker. If the DELETE
    // fails, the marker and its explanatory trace remain together and the
    // caller fails open instead of silently losing accounting.
    runCommand(['pr', 'comment', String(pr), '--repo', repo, '--body', body]);

    if (roundComment?.id) {
      runCommand(['api', '--method', 'DELETE', `repos/${repo}/issues/comments/${roundComment.id}`]);
    }
    const refund = [
      `<!-- REPAIR_QUOTA_REFUND: ${workflow}:${sha}:${roundNumber} -->`,
      `✅ **Repair quota round rimborsato**: marker ${roundMarkerFor(workflow)}:${roundNumber} rimosso senza invocare Codex/Claude.`,
      'La label `stale-review` conserva il percorso di riattivazione quando il floor issue-fix torna disponibile.',
    ].join('\n');
    // The outer fixer classifies a no-push round as legitimate only when the
    // comment count advances. Hold + refund - deleted round marker therefore
    // intentionally leaves one net comment in the PR history.
    runCommand(['pr', 'comment', String(pr), '--repo', repo, '--body', refund]);
    return { held: true, sha };
  } catch (error) {
    return { held: false, reason: error?.message || String(error) };
  }
}

function emit(result, env = process.env) {
  const lines = [
    `admit=${result.admit === true}`,
    `held=${result.held === true}`,
    `reason=${String(result.reason || '').replace(/[\r\n]/gu, ' ')}`,
    `lease_acquired=${result.leaseAcquired === true}`,
    `lease_owner=${String(result.leaseOwner || '').replace(/[\r\n]/gu, ' ')}`,
    `lease_subject=${String(result.leaseSubject || '').replace(/[\r\n]/gu, ' ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (result.held === true && env.GITHUB_ENV) {
    fs.appendFileSync(env.GITHUB_ENV, 'REPAIR_QUOTA_HELD=true\n');
  }
  return result;
}

/**
 * @param {{env?: Record<string, string | undefined>, runJson?: (args: string[]) => any, runCommand?: (args: string[]) => any, now?: number | string | Date}} [options]
 */
export function main({
  env = process.env,
  runJson = defaultRunJson,
  runCommand = defaultRunCommand,
  now = Date.now(),
} = {}) {
  const workflow = repairWorkflowFromRef(`${env.GITHUB_WORKFLOW_REF || ''} ${env.GITHUB_WORKFLOW || ''}`);
  if (!workflow) return emit({ admit: true, held: false, reason: 'not a PR repair workflow' }, env);

  const repo = env.GITHUB_REPOSITORY || env.GH_REPO || '';
  const pr = env.PR_NUMBER || '';
  if (!repo || !/^\d+$/.test(String(pr))) {
    return emit({ admit: false, held: false, reason: 'PR context missing; fail-closed' }, env);
  }

  const nowMs = new Date(now).getTime();
  const nowSec = Math.floor(nowMs / 1000);
  const ledgerIssue = env.QUOTA_FLOOR_LEDGER_ISSUE || QUOTA_FLOOR_LEDGER_ISSUE;
  const stats = collectRepairQuotaStats({
    repo,
    since: sinceDate(nowMs),
    nowSec,
    ledgerIssue,
    runJson,
  });
  if (!stats.ok) {
    console.warn(`::error::repair quota admission fail-closed: ${stats.reason}`);
    return emit({ admit: false, held: false, reason: stats.reason }, env);
  }

  const decision = repairQuotaDecision(stats);
  console.log(`repair quota admission: ${decision.admit ? 'ADMIT' : 'HOLD'} — ${decision.reason}`);
  if (decision.admit) {
    const leaseSubject = `pr-${pr}`;
    const leaseDecision = quotaFloorLeaseDecision(stats.floor, {
      kind: 'repair',
      subject: leaseSubject,
    });
    if (!leaseDecision.admit) {
      console.warn(`::error::repair quota lease admission fail-closed: ${leaseDecision.reason}`);
      return emit({ admit: false, held: false, reason: leaseDecision.reason }, env);
    }

    const candidateLeaseOwner = quotaFloorLeaseOwner({
      kind: 'repair',
      subject: leaseSubject,
      runId: env.GITHUB_RUN_ID || `pr-${pr}`,
      attempt: env.GITHUB_RUN_ATTEMPT || '1',
    });
    if (leaseDecision.existing && leaseDecision.existing.owner !== candidateLeaseOwner) {
      const reason = `repair lease already owned by ${leaseDecision.existing.owner}`;
      console.warn(`::error::repair quota lease admission fail-closed: ${reason}`);
      return emit({ admit: false, held: false, reason }, env);
    }
    const leaseOwner = leaseDecision.existing?.owner || candidateLeaseOwner;
    if (!leaseDecision.existing) {
      const lease = acquireQuotaFloorLease({
        repo,
        ledgerIssue,
        kind: 'repair',
        subject: leaseSubject,
        owner: leaseOwner,
        expiresAt: quotaFloorLeaseExpiry(nowSec, Number(env.QUOTA_FLOOR_LEASE_TTL_SEC || QUOTA_FLOOR_LEASE_TTL_SEC)),
        runCommand,
      });
      if (!lease.ok) {
        console.warn(`::error::${lease.reason}`);
        return emit({ admit: false, held: false, reason: lease.reason }, env);
      }
    }
    return emit({
      admit: true,
      held: false,
      reason: leaseDecision.existing ? `${decision.reason}; existing lease reused` : decision.reason,
      leaseAcquired: true,
      leaseOwner,
      leaseSubject,
    }, env);
  }

  const held = holdCurrentRound({
    repo,
    pr,
    workflow,
    round: env.FIX_ROUND,
    reviewRevision: env.PR_BODY_EXPECTED_REVISION,
    stats,
    decision,
    runJson,
    runCommand,
  });
  if (!held.held) {
    console.warn(`::error::repair quota hold fail-closed: ${held.reason}`);
    return emit({ admit: false, held: false, reason: `hold mutation failed: ${held.reason}` }, env);
  }
  return emit({ admit: false, held: true, reason: decision.reason }, env);
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try {
    main();
  } catch (error) {
    // TOTAL / FAIL-CLOSED: an unreadable gate must never spend a provider
    // attempt. The lease expires if the runner dies before its release step.
    console.warn(`::error::repair quota admission crashed; fail-closed: ${error?.message || String(error)}`);
    emit({ admit: false, held: false, reason: 'gate crashed; fail-closed' });
  }
}
