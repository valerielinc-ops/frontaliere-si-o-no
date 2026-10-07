#!/usr/bin/env node

/**
 * Observe every entry owned by loopClockDispatch.js, site and corpus. The
 * dispatcher and this script share the dependency-free table so a new cadence
 * cannot silently lose its watchdog. GitHub's native cron remains a safety net
 * for this workflow; the extra table entry makes the observer run on the
 * external clock.
 *
 * Only a run the clock itself dispatched proves the clock is alive: a
 * `workflow_dispatch` on main whose run-name carries the marker of the entry
 * (`[loop-clock <entry id>@<slot>]`). A manual dispatch, an event-driven run,
 * a native-cron run or this very heartbeat run would otherwise keep a dead
 * clock looking healthy for ever.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { createdFromFilter } from './lib/run-listing-window.mjs';
import {
  LOOP_CLOCK_CORPUS_REPOSITORY,
  LOOP_CLOCK_ENTRIES,
  loopClockRunMarker,
} from '../../functions/src/loopClockTable.js';

export const LOOP_CLOCK_HEALTH_ISSUE_PREFIX = 'Loop clock stale: ';
export const LOOP_CLOCK_DOWN_ISSUE_TITLE = 'Loop clock is not dispatching';
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
  if (!lastRunAt) return { stale: true, thresholdMinutes, ageMinutes: null, reason: 'no_marked_run_observed' };
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

function isLoopClockDispatch(run) {
  return run?.event === 'workflow_dispatch' && run?.headBranch === 'main';
}

/**
 * The newest run that is provably the clock's own dispatch of this entry.
 * Entries sharing a workflow (pending and sweep triage) are told apart by the
 * entry id inside the marker.
 */
export function selectLoopClockRun(runs, entry) {
  const marker = loopClockRunMarker(entry);
  let newest = null;
  let newestAt = -Infinity;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!isLoopClockDispatch(run)) continue;
    if (!String(run?.displayTitle ?? '').includes(marker)) continue;
    const createdAt = Date.parse(run?.createdAt ?? '');
    if (!Number.isFinite(createdAt) || createdAt <= newestAt) continue;
    newest = run;
    newestAt = createdAt;
  }
  return newest;
}

/**
 * When the oldest dispatch of any table entry found in these runs was created.
 * A marker naming an entry the table does not have (a hand-made probe of the
 * run-name, a retired entry) says nothing about the clock.
 */
function oldestClockDispatchAt(runs, markers) {
  let oldest = null;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!isLoopClockDispatch(run)) continue;
    const title = String(run?.displayTitle ?? '');
    if (!markers.some((marker) => title.includes(marker))) continue;
    const createdAt = Date.parse(run?.createdAt ?? '');
    if (Number.isFinite(createdAt) && (oldest === null || createdAt < oldest)) oldest = createdAt;
  }
  return oldest;
}

const RUN_LIST_MARGIN = 50;
const RUN_LIST_MAX = 1000;
const LOOP_CLOCK_RUN_WINDOW_MINUTES = Math.max(
  ...LOOP_CLOCK_ENTRIES.map((entry) => staleThresholdMinutes(entry.everyMinutes)),
);

/**
 * How many dispatches to read for a workflow: what the entries sharing it
 * produce inside the window, plus room for manual ones. Derived from the
 * table so a faster cadence cannot outgrow a fixed page.
 */
export function loopClockRunLimit(sharingEntries, windowMinutes) {
  const window = windowMinutes
    ?? Math.max(...sharingEntries.map((entry) => staleThresholdMinutes(entry.everyMinutes)));
  const expected = sharingEntries.reduce((sum, entry) => sum + Math.ceil(window / entry.everyMinutes), 0);
  return Math.min(RUN_LIST_MAX, expected + RUN_LIST_MARGIN);
}

/** A full page that ends inside the threshold window cannot prove absence. */
function windowTruncated({ rows, limit, now, thresholdMinutes }) {
  if (rows.length < limit) return false;
  const windowStart = now.getTime() - thresholdMinutes * 60_000;
  const oldest = Math.min(...rows.map((run) => Date.parse(run?.createdAt ?? '')).filter(Number.isFinite));
  return oldest > windowStart;
}

function listDispatchRuns(repository, workflow, limit, windowMinutes = LOOP_CLOCK_RUN_WINDOW_MINUTES) {
  const output = gh([
    'run', 'list', '--repo', repository, '--workflow', workflow,
    '--event', 'workflow_dispatch', '--branch', 'main',
    '--created', createdFromFilter(Date.now() - windowMinutes * 60_000),
    '--limit', String(limit),
    '--json', 'createdAt,databaseId,url,event,headBranch,displayTitle',
  ]);
  const rows = JSON.parse(output || '[]');
  if (!Array.isArray(rows)) throw new Error('workflow run response invalid');
  return rows;
}

/** Count of the untriaged issues and the creation time of the oldest one. */
function untriagedIssues(repository) {
  const query = `repo:${repository} is:issue is:open -label:agent:triaged`;
  const output = gh([
    'api', '-X', 'GET', 'search/issues', '-f', `q=${query}`,
    '-f', 'sort=created', '-f', 'order=asc', '-f', 'per_page=1',
    '--jq', '{count: .total_count, oldestCreatedAt: (.items[0].created_at // null)}',
  ]);
  const parsed = JSON.parse(output || 'null');
  const count = Number(parsed?.count);
  if (!Number.isFinite(count)) throw new Error('issue search response invalid');
  return { count, oldestCreatedAt: parsed.oldestCreatedAt ?? null };
}

function issueTitle(entry) {
  return `${LOOP_CLOCK_HEALTH_ISSUE_PREFIX}${entry.id}`;
}

const MARKER_NOTE = 'Conta solo una run `workflow_dispatch` su `main` il cui nome porta il marcatore dell\'orologio: una run manuale, da evento o del cron nativo non prova che l\'orologio stia inviando.';

function issueDescription({ entry, freshness, run, repository, conditionState }) {
  const lines = [
    `**Repository:** ${repository}`,
    `**Workflow:** ${entry.workflow}`,
    `**Cadenza attesa:** ${entry.everyMinutes} minuti`,
    `**Soglia:** ${freshness.thresholdMinutes} minuti`,
    `**Motivo:** \`${freshness.reason}\``,
    `**Marcatore atteso:** \`${loopClockRunMarker(entry)}<slot>]\``,
  ];
  if (run?.createdAt) lines.push(`**Ultimo dispatch dell'orologio:** ${run.createdAt}`);
  if (run?.url) lines.push(`**Run:** ${run.url}`);
  if (conditionState) lines.push(`**Condizione:** \`${conditionState}\``);
  lines.push(
    '',
    MARKER_NOTE,
    'Il dispatcher del loop clock dovrebbe avviare workflow_dispatch con la cadenza dichiarata; il cron nativo resta una rete di sicurezza indipendente.',
  );
  return lines.join('\n');
}

function clockDownDescription({ stale, clockSeenSince }) {
  return [
    'L\'orologio esterno non sta inviando: nessuna voce della tabella ha un proprio dispatch dentro la sua soglia.',
    '',
    clockSeenSince === null
      ? '**Primo dispatch osservato:** nessuno. La function `dispatchLoopClock` non ha mai inviato (deploy mancante o fallito) oppure i suoi dispatch vengono rifiutati.'
      : `**Dispatch più vecchio ancora leggibile:** ${new Date(clockSeenSince).toISOString()}`,
    '',
    '**Voci ferme:**',
    ...stale.map(({ entry, repository, run }) => (
      `- \`${entry.id}\` → ${repository} / ${entry.workflow} (ogni ${entry.everyMinutes} minuti; ultimo dispatch: ${run?.createdAt ?? 'mai'})`
    )),
    '',
    MARKER_NOTE,
    'Si chiude da sola quando una voce torna ad avere un dispatch dentro la sua soglia.',
  ].join('\n');
}

/**
 * Verdict per entry:
 *  - `healthy` / `stale`: the entry has, or lacks, its own marked dispatch
 *    inside its threshold;
 *  - `not_due`: a conditional entry whose condition is false;
 *  - `too_early`: nothing was owed yet, because the clock itself is younger
 *    than the threshold of the entry (first hours after a deploy: an entry
 *    every 240 minutes cannot have run yet) or because the oldest untriaged
 *    issue is. Neither opens nor resolves an issue;
 *  - `inconclusive`: the evidence could not be read to the start of the window.
 *
 * One fault, one issue: when no entry at all has a dispatch inside its
 * threshold the clock itself is down (or was never deployed) and a single
 * issue says so; a per-entry issue is for an entry that stays silent while
 * the clock demonstrably dispatches the others.
 */
export async function runLoopClockHealth({
  now = new Date(),
  entries = LOOP_CLOCK_ENTRIES,
  repository,
  listRunsImpl = listDispatchRuns,
  untriagedIssuesImpl = untriagedIssues,
  createIssueImpl = createGithubIssue,
  resolveIssueImpl = resolveGithubIssue,
} = {}) {
  const checkedAt = validDate(now, 'now');
  const resolvedRepository = repository || repositoryFromEnv();
  const repositoryOf = (entry) => (entry.repo === 'corpus' ? LOOP_CLOCK_CORPUS_REPOSITORY : resolvedRepository);
  const listKeyOf = (entry) => `${repositoryOf(entry)}\n${entry.workflow}`;
  const ageMinutes = (timestamp) => (checkedAt.getTime() - timestamp) / 60_000;
  const results = [];
  let errors = 0;

  // 1. Conditional entries: is anything owed at all?
  const conditions = new Map();
  const owed = [];
  for (const entry of entries) {
    if (entry.condition !== 'untriaged-issues') {
      owed.push({ entry, conditionState: null });
      continue;
    }
    const entryRepository = repositoryOf(entry);
    if (!conditions.has(entryRepository)) {
      try { conditions.set(entryRepository, await untriagedIssuesImpl(entryRepository)); } catch { conditions.set(entryRepository, null); }
    }
    const condition = conditions.get(entryRepository);
    if (!condition) {
      errors += 1;
      results.push({ id: entry.id, state: 'inconclusive', reason: 'condition_lookup_failed' });
      continue;
    }
    if (condition.count === 0) {
      try { await resolveIssueImpl(issueTitle(entry), { workflow: LOOP_CLOCK_HEALTH_WORKFLOW }); } catch { errors += 1; }
      results.push({ id: entry.id, state: 'not_due', reason: 'no_untriaged_issues' });
      continue;
    }
    // The clock only owes a dispatch once an issue has waited a whole
    // threshold: one opened a minute ago has not met a tick yet.
    const oldestAt = Date.parse(condition.oldestCreatedAt ?? '');
    if (Number.isFinite(oldestAt) && ageMinutes(oldestAt) < staleThresholdMinutes(entry.everyMinutes)) {
      results.push({ id: entry.id, state: 'too_early', reason: 'untriaged_issues_newer_than_threshold' });
      continue;
    }
    owed.push({ entry, conditionState: 'untriaged_issues' });
  }

  // 2. One read per workflow, wide enough for the longest threshold of the
  // table: the same pages also date the clock itself (step 3).
  const widestThreshold = Math.max(0, ...entries.map((entry) => staleThresholdMinutes(entry.everyMinutes)));
  const runLists = new Map();
  for (const { entry } of owed) {
    const listKey = listKeyOf(entry);
    if (runLists.has(listKey)) continue;
    const limit = loopClockRunLimit(entries.filter((other) => listKeyOf(other) === listKey), widestThreshold);
    try {
      const rows = await listRunsImpl(repositoryOf(entry), entry.workflow, limit, widestThreshold);
      if (!Array.isArray(rows)) throw new Error('workflow run response invalid');
      runLists.set(listKey, { limit, rows });
    } catch {
      runLists.set(listKey, null);
    }
  }

  // 3. Since when has the clock been dispatching? Without this an entry that
  // simply has not had its first slot yet would be reported as dead.
  const tableMarkers = entries.map((entry) => loopClockRunMarker(entry));
  let clockSeenSince = null;
  for (const list of runLists.values()) {
    const oldest = oldestClockDispatchAt(list?.rows, tableMarkers);
    if (oldest !== null && (clockSeenSince === null || oldest < clockSeenSince)) clockSeenSince = oldest;
  }

  // 4. Verdicts, before any issue is touched: whether a stale entry gets its
  // own issue depends on what the other entries show.
  const judged = [];
  for (const { entry, conditionState } of owed) {
    const list = runLists.get(listKeyOf(entry));
    if (!list) {
      errors += 1;
      results.push({ id: entry.id, state: 'inconclusive', reason: 'actions_api_unavailable' });
      continue;
    }
    const run = selectLoopClockRun(list.rows, entry);
    const freshness = assessLoopClockFreshness({
      now: checkedAt,
      lastRunAt: run?.createdAt,
      everyMinutes: entry.everyMinutes,
    });
    if (!run) {
      if (windowTruncated({ rows: list.rows, limit: list.limit, now: checkedAt, thresholdMinutes: freshness.thresholdMinutes })) {
        // No verdict on a window we did not read to its start.
        errors += 1;
        results.push({ id: entry.id, state: 'inconclusive', reason: 'run_window_truncated' });
        continue;
      }
      if (clockSeenSince !== null && ageMinutes(clockSeenSince) < freshness.thresholdMinutes) {
        results.push({ id: entry.id, state: 'too_early', reason: 'clock_younger_than_threshold' });
        continue;
      }
      if (clockSeenSince === null) freshness.reason = 'clock_never_dispatched';
    }
    judged.push({ entry, repository: repositoryOf(entry), run, freshness, conditionState });
  }

  // 5. Issues.
  const stale = judged.filter((verdict) => verdict.freshness.stale);
  const healthy = judged.filter((verdict) => !verdict.freshness.stale);
  const clockDown = stale.length > 0 && healthy.length === 0;

  for (const verdict of judged) {
    const { entry, run, freshness } = verdict;
    try {
      if (!freshness.stale) {
        await resolveIssueImpl(issueTitle(entry), { workflow: LOOP_CLOCK_HEALTH_WORKFLOW, runUrl: run?.url });
      } else if (!clockDown) {
        await createIssueImpl({
          title: issueTitle(entry),
          description: issueDescription(verdict),
          priority: 2,
          labels: ['Bug', 'workflow-watchdog'],
          workflow: LOOP_CLOCK_HEALTH_WORKFLOW,
        });
      }
      results.push({ id: entry.id, state: freshness.stale ? 'stale' : 'healthy', ...freshness });
    } catch {
      errors += 1;
      results.push({ id: entry.id, state: 'inconclusive', reason: 'issue_api_unavailable' });
    }
  }

  try {
    if (clockDown) {
      await createIssueImpl({
        title: LOOP_CLOCK_DOWN_ISSUE_TITLE,
        description: clockDownDescription({ stale, clockSeenSince }),
        priority: 2,
        labels: ['Bug', 'workflow-watchdog'],
        workflow: LOOP_CLOCK_HEALTH_WORKFLOW,
      });
    } else if (healthy.length > 0) {
      await resolveIssueImpl(LOOP_CLOCK_DOWN_ISSUE_TITLE, { workflow: LOOP_CLOCK_HEALTH_WORKFLOW });
    }
  } catch {
    errors += 1;
  }

  return {
    checkedAt: checkedAt.toISOString(),
    clockSeenSince: clockSeenSince === null ? null : new Date(clockSeenSince).toISOString(),
    clockDown,
    results,
    errors,
  };
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
