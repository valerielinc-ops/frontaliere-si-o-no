#!/usr/bin/env node
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
 * re-arm the red review/check after its normal cooldown. Any telemetry or
 * mutation failure is fail-open so a broken gate cannot freeze autonomous
 * repairs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPAIR_TO_ISSUE_RATIO_MAX = 7;
export const INITIAL_REPAIR_ALLOWANCE = REPAIR_TO_ISSUE_RATIO_MAX;
export const REPAIR_WORKFLOWS = Object.freeze([
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
]);
export const ISSUE_FIX_WORKFLOW = 'issue-fix.yml';

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/** Count runs using the same real-run proxy as loop-health-report.mjs. */
export function realRunCount(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.filter((run) => {
    const state = run?.conclusion || run?.status || 'unknown';
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
  maxRatio = REPAIR_TO_ISSUE_RATIO_MAX,
} = {}) {
  const repairs = nonNegativeInteger(repairRuns);
  const issueFix = nonNegativeInteger(issueFixRuns);
  const queued = nonNegativeInteger(queuedIssues);
  const ratio = Math.max(1, nonNegativeInteger(maxRatio, REPAIR_TO_ISSUE_RATIO_MAX));

  if (queued === 0) {
    return {
      admit: true,
      reason: 'issue-fix queue empty',
      requiredIssueFixRuns: 0,
      repairRuns: repairs,
      issueFixRuns: issueFix,
      queuedIssues: queued,
    };
  }

  if (repairs <= ratio) {
    return {
      admit: true,
      reason: `initial repair allowance (${repairs}/${ratio})`,
      requiredIssueFixRuns: 0,
      repairRuns: repairs,
      issueFixRuns: issueFix,
      queuedIssues: queued,
    };
  }

  const requiredIssueFixRuns = Math.ceil(repairs / ratio);
  const admit = issueFix >= requiredIssueFixRuns;
  return {
    admit,
    reason: admit
      ? `allocation frontier satisfied (${repairs}:${issueFix}, max ${ratio}:1)`
      : `issue-fix floor missing (${issueFix}/${requiredIssueFixRuns} for ${repairs} repair runs, max ${ratio}:1)`,
    requiredIssueFixRuns,
    repairRuns: repairs,
    issueFixRuns: issueFix,
    queuedIssues: queued,
  };
}

/** Return the fixer workflow filename represented by an Actions ref/name. */
export function repairWorkflowFromRef(value = '') {
  const text = String(value || '').toLowerCase();
  return REPAIR_WORKFLOWS.find((workflow) => text.includes(workflow)) || '';
}

function defaultRunJson(args) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
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

/**
 * Fetch the bounded inputs used by the pure decision. Kept injectable so the
 * accounting contract can be tested without GitHub.
 */
export function collectRepairQuotaStats({
  repo,
  since = sinceDate(),
  runJson = defaultRunJson,
} = {}) {
  if (!repo) return { ok: false, reason: 'repository missing' };
  try {
    const runArgs = (workflow) => [
      'run', 'list', '--repo', repo, '--workflow', workflow,
      '--created', `>${since}`, '--limit', '1000', '--json', 'conclusion,status',
    ];
    const repairCounts = REPAIR_WORKFLOWS
      .map((workflow) => realRunCount(runJson(runArgs(workflow))));
    if (repairCounts.some((count) => count === null)) throw new Error('repair run listing malformed');
    const repairRuns = repairCounts.reduce((sum, count) => sum + count, 0);
    const issueFixRuns = realRunCount(runJson(runArgs(ISSUE_FIX_WORKFLOW)));
    if (issueFixRuns === null) throw new Error('issue-fix run listing malformed');
    const queued = runJson([
      'issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'agent:fix-queued', '--json', 'number', '--limit', '300',
    ]);
    if (!Array.isArray(queued)) throw new Error('queue listing malformed');
    return {
      ok: true,
      since,
      repairRuns,
      issueFixRuns,
      queuedIssues: queued.length,
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
 * returns false on any mutation failure; callers then admit the repair rather
 * than leaving a provider attempt unaccounted for.
 */
function holdCurrentRound({
  repo,
  pr,
  workflow,
  round,
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
    const roundToken = `<!-- ${roundMarkerFor(workflow)}: ${roundNumber} -->`;
    const roundComment = roundNumber
      ? [...comments].reverse().find((comment) => String(comment.body || '').includes(roundToken))
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
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (result.held === true && env.GITHUB_ENV) {
    fs.appendFileSync(env.GITHUB_ENV, 'REPAIR_QUOTA_HELD=true\n');
  }
  return result;
}

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
  if (!repo || !pr) return emit({ admit: true, held: false, reason: 'PR context missing' }, env);

  const stats = collectRepairQuotaStats({ repo, since: sinceDate(now), runJson });
  if (!stats.ok) {
    console.warn(`::warning::repair quota admission fail-open: ${stats.reason}`);
    return emit({ admit: true, held: false, reason: stats.reason }, env);
  }

  const decision = repairQuotaDecision(stats);
  console.log(`repair quota admission: ${decision.admit ? 'ADMIT' : 'HOLD'} — ${decision.reason}`);
  if (decision.admit) return emit({ admit: true, held: false, reason: decision.reason }, env);

  const held = holdCurrentRound({
    repo,
    pr,
    workflow,
    round: env.FIX_ROUND,
    stats,
    decision,
    runJson,
    runCommand,
  });
  if (!held.held) {
    console.warn(`::warning::repair quota hold fail-open: ${held.reason}`);
    return emit({ admit: true, held: false, reason: `hold mutation failed: ${held.reason}` }, env);
  }
  return emit({ admit: false, held: true, reason: decision.reason }, env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    // TOTAL / PROCEED-SAFE: never convert a telemetry regression into a
    // frozen fixer. The provider runs normally when this gate itself breaks.
    console.warn(`::warning::repair quota admission crashed; fail-open: ${error?.message || String(error)}`);
    emit({ admit: true, held: false, reason: 'gate crashed; fail-open' });
  }
}
