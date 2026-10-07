#!/usr/bin/env node

/**
 * Observe the site entries owned by loopClockDispatch.js. The dispatcher and
 * this script share the dependency-free table so a new cadence cannot silently
 * lose its watchdog. GitHub's native cron remains a safety net for this
 * workflow; the extra table entry makes the observer run on the external clock.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { LOOP_CLOCK_ENTRIES } from '../../functions/src/loopClockTable.js';

export const LOOP_CLOCK_HEALTH_ISSUE_PREFIX = 'Loop clock stale: ';
export const LOOP_CLOCK_HEALTH_WORKFLOW = 'loop-clock-health';

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

export function staleThresholdMinutes(everyMinutes) {
  const cadence = Number(everyMinutes);
  if (!Number.isFinite(cadence) || cadence <= 0) throw new TypeError('everyMinutes must be positive');
  return Math.max(60, cadence * 3);
}

export function assessLoopClockFreshness({ now = new Date(), lastRunAt, everyMinutes } = {}) {
  const checkedAt = validDate(now, 'now');
  const thresholdMinutes = staleThresholdMinutes(everyMinutes);
  if (!lastRunAt) return { stale: true, thresholdMinutes, ageMinutes: null, reason: 'no_run_observed' };
  const last = new Date(lastRunAt);
  if (!Number.isFinite(last.getTime())) {
    return { stale: true, thresholdMinutes, ageMinutes: null, reason: 'last_run_unreadable' };
  }
  const ageMinutes = (checkedAt.getTime() - last.getTime()) / 60_000;
  return {
    stale: ageMinutes > thresholdMinutes,
    thresholdMinutes,
    ageMinutes,
    reason: ageMinutes > thresholdMinutes ? 'run_older_than_threshold' : 'run_within_threshold',
  };
}

function trustedGhBin() {
  const configured = String(process.env.TRUSTED_GH_BIN || '').trim();
  if (!configured) return 'gh';
  if (!configured.startsWith('/') || configured.includes('\0')) throw new Error('trusted gh bin invalid');
  return configured;
}

function gh(args) {
  return execFileSync(trustedGhBin(), args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repositoryFromEnv() {
  const repository = String(process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '').trim();
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GH_REPO/GITHUB_REPOSITORY invalid');
  return repository;
}

function latestRun(repository, workflow) {
  const output = gh([
    'run', 'list', '--repo', repository, '--workflow', workflow, '--limit', '1',
    '--json', 'createdAt,databaseId,status,conclusion,url,event',
  ]);
  const rows = JSON.parse(output || '[]');
  if (!Array.isArray(rows)) throw new Error('workflow run response invalid');
  return rows[0] || null;
}

function untriagedIssueCount(repository) {
  const query = `repo:${repository} is:issue is:open -label:agent:triaged`;
  const output = gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '--jq', '.total_count']);
  const count = Number(output);
  if (!Number.isFinite(count)) throw new Error('issue search response invalid');
  return count;
}

function issueTitle(entry) {
  return `${LOOP_CLOCK_HEALTH_ISSUE_PREFIX}${entry.id}`;
}

function issueDescription({ entry, freshness, run, repository, conditionState }) {
  const lines = [
    `**Repository:** ${repository}`,
    `**Workflow:** ${entry.workflow}`,
    `**Cadenza attesa:** ${entry.everyMinutes} minuti`,
    `**Soglia:** ${freshness.thresholdMinutes} minuti`,
    `**Motivo:** \`${freshness.reason}\``,
  ];
  if (run?.createdAt) lines.push(`**Ultima run:** ${run.createdAt}`);
  if (run?.url) lines.push(`**Run:** ${run.url}`);
  if (conditionState) lines.push(`**Condizione:** \`${conditionState}\``);
  lines.push('', 'Il dispatcher del loop clock dovrebbe avviare workflow_dispatch con la cadenza dichiarata; il cron nativo resta una rete di sicurezza indipendente.');
  return lines.join('\n');
}

export async function runLoopClockHealth({
  now = new Date(),
  entries = LOOP_CLOCK_ENTRIES,
  repository,
  latestRunImpl = latestRun,
  untriagedIssueCountImpl = untriagedIssueCount,
  createIssueImpl = createGithubIssue,
  resolveIssueImpl = resolveGithubIssue,
} = {}) {
  const checkedAt = validDate(now, 'now');
  const resolvedRepository = repository || repositoryFromEnv();
  const siteEntries = entries.filter((entry) => entry.repo === 'site');
  const runs = new Map();
  const conditionCounts = new Map();
  const results = [];
  let errors = 0;

  for (const entry of siteEntries) {
    let conditionState = null;
    if (entry.condition === 'untriaged-issues') {
      try {
        const count = conditionCounts.has(resolvedRepository)
          ? conditionCounts.get(resolvedRepository)
          : await untriagedIssueCountImpl(resolvedRepository);
        conditionCounts.set(resolvedRepository, count);
        if (count === 0) conditionState = 'no_untriaged_issues';
      } catch {
        conditionState = 'lookup_failed';
      }
      if (conditionState === 'no_untriaged_issues') {
        try { await resolveIssueImpl(issueTitle(entry), { workflow: LOOP_CLOCK_HEALTH_WORKFLOW }); } catch { errors += 1; }
        results.push({ id: entry.id, state: 'not_due', reason: conditionState });
        continue;
      }
    }

    try {
      if (!runs.has(entry.workflow)) runs.set(entry.workflow, await latestRunImpl(resolvedRepository, entry.workflow));
      const run = runs.get(entry.workflow);
      const freshness = assessLoopClockFreshness({
        now: checkedAt,
        lastRunAt: run?.createdAt,
        everyMinutes: entry.everyMinutes,
      });
      const title = issueTitle(entry);
      if (freshness.stale) {
        await createIssueImpl({
          title,
          description: issueDescription({ entry, freshness, run, repository: resolvedRepository, conditionState }),
          priority: 2,
          labels: ['Bug', 'workflow-watchdog'],
          workflow: LOOP_CLOCK_HEALTH_WORKFLOW,
        });
      } else {
        await resolveIssueImpl(title, { workflow: LOOP_CLOCK_HEALTH_WORKFLOW, runUrl: run?.url });
      }
      results.push({ id: entry.id, state: freshness.stale ? 'stale' : 'healthy', ...freshness });
    } catch {
      errors += 1;
      results.push({ id: entry.id, state: 'inconclusive', reason: 'actions_api_unavailable' });
    }
  }

  return { checkedAt: checkedAt.toISOString(), results, errors };
}

async function main() {
  const report = await runLoopClockHealth();
  console.log(JSON.stringify(report));
  if (report.errors > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch(() => {
    console.error('[loop-clock-health] observer failed');
    process.exitCode = 1;
  });
}
