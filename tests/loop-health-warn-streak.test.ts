/**
 * Loop-health tracker: a threshold warning must say how long it has been on (#1951).
 *
 * `📊 Loop health report (tracker)` is a permanent find-or-create issue — the
 * weekly snapshot lands there as a comment, and closing it just makes the next
 * run recreate it. Its `### ⚠️ Da investigare` section, though, had carried the
 * same two lines every week since 2026-06-05 (`issue-fix.yml` 34% → 55%,
 * `post-merge-followup.yml` 44%): a flag that never changes state stops being
 * read, so the escalation it represents went unnoticed for two months.
 *
 * The fix is NOT to move the threshold (AGENTS.md Non-Negotiable #1 — the
 * warning still fires at exactly the same point). It is to add the missing
 * dimension: "new this report" vs "above threshold for 9 consecutive reports",
 * derived from the tracker's own prior comments so there is no extra state file.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script, no type declarations
import {
  backlogTrendWarning,
  botReviewCount,
  classifyFixerJob,
  fixerJobStats,
  fetchTrackerComments,
  FIX_JOB_INSPECTION_LIMIT,
  labelStats,
  LABEL_LIST_LIMIT,
  MERGED_PR_LIST_LIMIT,
  mergedPrStats,
  PR_REPAIR_RUN_WARN,
  REPAIR_TO_ISSUE_RATIO_WARN,
  repairAllocation,
  repairEfficiencyWarnings,
  renderThresholdSection,
  runStats,
  summarizeRunStats,
  warnKey,
  warnStreaks,
  zombieStats,
  ZOMBIE_PR_CHECK_LIMIT,
} from '../scripts/ci/loop-health-report.mjs';

/** Reports are dated relative to now — never a calendar literal in a fixture. */
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function report(sinceDaysAgo: number, warnings: string[]): string {
  const head = `## Loop health — ultimi 7gg (dal ${daysAgoIso(sinceDaysAgo)})\n\n| Workflow |\n|---|\n`;
  const tail = warnings.length
    ? `\n### ⚠️ Da investigare\n${warnings.map((w) => `- ${w}`).join('\n')}\n`
    : '\n### ✅ Nessuna soglia superata\n';
  return head + tail;
}

function backlogReport(sinceDaysAgo: number, queued: number, warnings: string[] = []): string {
  return `${report(sinceDaysAgo, warnings)}\n**Backlog:** agent:fix zombie 0 · in coda ${queued} · fu-parked 0 · needs-human 0.\n`;
}

function runReportWithFakeGh() {
  const sandbox = mkdtempSync(join(tmpdir(), 'loop-health-report-'));
  const fakeGhPath = join(sandbox, 'gh');
  const logPath = join(sandbox, 'gh.log');
  const fakeGh = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + String.fromCharCode(10));
const writeJson = (value) => process.stdout.write(JSON.stringify(value));

if (args[0] === 'run' && args[1] === 'list') {
  const workflow = args[args.indexOf('--workflow') + 1];
  if (workflow === 'issue-fix.yml') {
    writeJson([
      { databaseId: 101, status: 'completed', conclusion: 'success' },
      { databaseId: 102, status: 'completed', conclusion: 'success' },
    ]);
  } else if (workflow === 'pr-redflag-fixer.yml') {
    writeJson([{ databaseId: 201, status: 'completed', conclusion: 'future_state' }]);
  } else {
    writeJson([]);
  }
  process.exit(0);
}

if (args[0] === 'api' && args[1] && args[1].includes('/actions/runs/101/jobs')) {
  writeJson({ jobs: [{ name: 'fix', status: 'completed', conclusion: 'success', started_at: '2026-09-19T10:00:00Z' }] });
  process.exit(0);
}
if (args[0] === 'api' && args[1] && args[1].includes('/actions/runs/102/jobs')) {
  writeJson({ jobs: [{ name: 'fix', status: 'queued', conclusion: null, started_at: null }] });
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  writeJson([]);
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'list') {
  const searchIndex = args.indexOf('--search');
  if (searchIndex >= 0 && args[searchIndex + 1].includes('in:title')) process.exit(2);
  writeJson([]);
  process.exit(0);
}
if (args[0] === 'label' || (args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment'))) {
  process.exit(0);
}
writeJson([]);
`;
  writeFileSync(fakeGhPath, fakeGh);
  chmodSync(fakeGhPath, 0o755);
  const reportScript = fileURLToPath(new URL('../scripts/ci/loop-health-report.mjs', import.meta.url));
  try {
    const stdout = execFileSync(process.execPath, [reportScript, '--days', '7'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_REPO: '',
        GITHUB_REPOSITORY: 'owner/repo',
        PATH: `${sandbox}:${process.env.PATH || ''}`,
        FAKE_GH_LOG: logPath,
      },
    });
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { stdout, calls };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe('warnKey — a streak survives the numbers moving', () => {
  it('keys a failure-rate warning on the workflow, not on the percentage', () => {
    expect(warnKey('failure-rate 34% su issue-fix.yml (48/141 run reali)'))
      .toBe(warnKey('failure-rate 55% su issue-fix.yml (60/109 run reali)'));
    expect(warnKey('failure-rate 55% su issue-fix.yml (60/109 run reali)'))
      .toBe('failure-rate:issue-fix.yml');
  });

  it('keeps distinct workflows apart', () => {
    expect(warnKey('failure-rate 44% su post-merge-followup.yml (21/48 run reali)'))
      .not.toBe(warnKey('failure-rate 55% su issue-fix.yml (60/109 run reali)'));
  });

  it('keys the non-workflow warnings too', () => {
    expect(warnKey('PR con una sola review del bot 42% (<50%)')).toBe('single-bot-review-rate');
    expect(warnKey('first-shot LGTM rate 42% (<50%)')).toBe('single-bot-review-rate');
    expect(warnKey('3 issue agent:fix zombie (>24h, nessuna PR aperta)')).toBe('zombie');
    expect(warnKey('PR repair volume 401 run workflow (> 400)')).toBe('pr-repair-volume');
    expect(warnKey('rapporto riparazione PR:issue-fix 598:24 (> 7:1)')).toBe('repair-to-issue-ratio');
    expect(warnKey('coda agent:fix-queued in crescita: 10 → 20 → 30 per 3 report consecutivi'))
      .toBe('queued-growth');
  });
});

describe('repairEfficiencyWarnings — allarmi di allocazione senza nuove chiamate API', () => {
  it('segnala volume e rapporto oltre i target misurati', () => {
    const warnings = repairEfficiencyWarnings({
      repairRuns: PR_REPAIR_RUN_WARN + 1,
      issueFixRuns: 50,
    });
    expect(warnings).toEqual([
      'PR repair volume 401 run workflow (> 400)',
      'rapporto riparazione PR:issue-fix 401:50 (> 7:1)',
    ]);
  });

  it('non segnala un periodo sotto i target o con denominatore nullo', () => {
    expect(repairEfficiencyWarnings({ repairRuns: PR_REPAIR_RUN_WARN, issueFixRuns: 58 })).toEqual([]);
    expect(repairEfficiencyWarnings({ repairRuns: 10, issueFixRuns: 0 })).toEqual([]);
    expect(REPAIR_TO_ISSUE_RATIO_WARN).toBe(7);
  });

  it('segnala la coda solo dopo due aumenti consecutivi', () => {
    const prior = [backlogReport(14, 10), backlogReport(7, 20)];
    expect(backlogTrendWarning(30, prior))
      .toBe('coda agent:fix-queued in crescita: 10 → 20 → 30 per 3 report consecutivi');
    expect(repairEfficiencyWarnings({ queued: 30, priorComments: prior })).toContain(
      'coda agent:fix-queued in crescita: 10 → 20 → 30 per 3 report consecutivi',
    );
    expect(backlogTrendWarning(20, [backlogReport(7, 10)])).toBe('');
    expect(backlogTrendWarning(15, prior)).toBe('');
  });

  it('non unisce due report separati da un backlog illeggibile', () => {
    const prior = [backlogReport(21, 10), report(14, []), backlogReport(7, 20)];
    expect(backlogTrendWarning(30, prior)).toBe('');
  });
});

describe('workflow outcome e fixer job — segnali distinti e bounded', () => {
  it('esclude i run in corso dal denominatore e separa cancelled/skipped', () => {
    const stats = summarizeRunStats([
      { databaseId: 1, status: 'in_progress', conclusion: null },
      { databaseId: 2, status: 'completed', conclusion: 'success' },
      { databaseId: 3, status: 'completed', conclusion: 'failure' },
      { databaseId: 4, status: 'completed', conclusion: 'cancelled' },
      { databaseId: 5, status: 'completed', conclusion: 'skipped' },
    ]);

    expect(stats).toMatchObject({
      measured: true,
      total: 5,
      completed: 4,
      eligible: 2,
      running: 1,
      unknown: 0,
      ok: 1,
      fail: 1,
      cancelled: 1,
      skipped: 1,
      rate: 0.5,
      truncated: false,
    });
  });

  it('rende n/d un errore della lista run invece di un falso zero', () => {
    const stats = runStats('issue-fix.yml', daysAgoIso(7), () => {
      throw new Error('HTTP 429');
    });

    expect(stats).toMatchObject({ measured: false, total: null, eligible: null, rate: null });
  });

  it('non mette una conclusion sconosciuta nel denominatore della failure-rate', () => {
    const stats = summarizeRunStats([
      { databaseId: 1, status: 'completed', conclusion: 'future_state' },
      { databaseId: 2, status: 'completed', conclusion: 'success' },
      { databaseId: 3, status: 'completed', conclusion: 'failure' },
    ]);

    expect(stats).toMatchObject({
      measured: true,
      completed: 2,
      eligible: 2,
      unknown: 1,
      fail: 1,
      rate: null,
    });
  });

  it('rende n/d anche backlog e zombie quando le rispettive API falliscono', () => {
    expect(labelStats('agent:fix-queued', () => { throw new Error('HTTP 500'); }))
      .toEqual({ measured: false, value: null, truncated: false });
    expect(labelStats('agent:fix-queued', () => [{}]))
      .toEqual({ measured: false, value: null, truncated: false });
    expect(labelStats('agent:fix-queued', () => [{ number: 42 }]))
      .toEqual({ measured: true, value: 1, truncated: false });
    expect(zombieStats(() => { throw new Error('HTTP 500'); }))
      .toEqual({ measured: false, value: null, candidates: null, inspected: 0, truncated: false });
    expect(LABEL_LIST_LIMIT).toBe(200);
    expect(ZOMBIE_PR_CHECK_LIMIT).toBe(40);
  });

  it('non confonde risk_policy success + fix skipped con un fixer avviato', () => {
    expect(classifyFixerJob([
      { name: 'risk_policy', status: 'completed', conclusion: 'success' },
      { name: 'fix', status: 'completed', conclusion: 'skipped', started_at: null },
    ])).toEqual({ state: 'skipped', outcome: 'skipped' });
    expect(classifyFixerJob([
      { name: 'risk_policy', status: 'completed', conclusion: 'success' },
      { name: 'fix', status: 'completed', conclusion: 'success', started_at: '2026-09-19T10:00:00Z' },
    ])).toEqual({ state: 'started', outcome: 'success' });
  });

  it('separa job pending da un job davvero avviato', () => {
    expect(classifyFixerJob([
      { name: 'fix', status: 'queued', conclusion: null },
    ])).toEqual({ state: 'pending', outcome: 'queued' });
    expect(classifyFixerJob([
      { name: 'fix', status: 'waiting', conclusion: null },
    ])).toEqual({ state: 'pending', outcome: 'waiting' });
    expect(classifyFixerJob([
      { name: 'fix', status: 'in_progress', conclusion: null, started_at: '2026-09-19T10:00:00Z' },
    ])).toEqual({ state: 'started', outcome: 'in_progress' });
    expect(classifyFixerJob([
      { name: 'fix', status: 'queued', started_at: '2026-09-19T10:00:00Z', conclusion: null },
    ])).toEqual({ state: 'started', outcome: 'queued' });
  });

  it('usa la shape REST e non inferisce un avvio da un cancelled senza started_at', () => {
    expect(classifyFixerJob([
      { name: 'fix', status: 'completed', conclusion: 'cancelled', started_at: null },
    ])).toEqual({ state: 'unknown', outcome: null });
    expect(classifyFixerJob([
      { name: 'fix', status: 'completed', conclusion: 'completed', started_at: '2026-09-19T10:00:00Z' },
    ])).toEqual({ state: 'unknown', outcome: null });
  });

  it('rispetta il cap di 40 chiamate jobs e segnala il troncamento', () => {
    const calls: string[][] = [];
    const runs = Array.from({ length: FIX_JOB_INSPECTION_LIMIT + 5 }, (_, i) => ({ databaseId: i + 1 }));
    const stats = fixerJobStats(runs, (args: string[]) => {
      calls.push(args);
      return { jobs: [{ name: 'fix', status: 'completed', conclusion: 'skipped' }] };
    }, { repo: 'owner/repo' });

    expect(calls).toHaveLength(FIX_JOB_INSPECTION_LIMIT);
    expect(stats).toMatchObject({
      measured: true,
      total: FIX_JOB_INSPECTION_LIMIT + 5,
      inspected: FIX_JOB_INSPECTION_LIMIT,
      skipped: FIX_JOB_INSPECTION_LIMIT,
      started: 0,
      truncated: true,
    });
  });

  it('rende non misurabile un jobs response incompleto', () => {
    const stats = fixerJobStats([{ databaseId: 1 }], () => ({ jobs: [] }), { repo: 'owner/repo' });
    expect(stats).toMatchObject({ measured: false, started: 0, skipped: 0, unknown: 1 });
  });

  it('mantiene l allocazione n/d se una fonte non è misurabile', () => {
    expect(repairAllocation({
      prRepairRuns: 4,
      issueFixRuns: 3,
    })).toEqual({ repairRuns: 4, issueFixRuns: 3, ratio: '1.3:1' });
    expect(repairAllocation({
      prRepairRuns: 4,
      issueFixRuns: null,
    })).toEqual({ repairRuns: 4, issueFixRuns: null, ratio: 'n/d' });
  });

  it('non stampa una soglia verde rassicurante con dati incompleti', () => {
    expect(renderThresholdSection([], true)).toContain('Dati incompleti');
    expect(renderThresholdSection([], true)).not.toContain('Nessuna soglia superata');
    expect(renderThresholdSection([], false)).toBe('### ✅ Nessuna soglia superata');
  });

  it('legge gli ultimi 14 commenti via GraphQL e ne conserva lordine', () => {
    const calls: string[][] = [];
    const result = fetchTrackerComments(1951, (args: string[]) => {
      calls.push(args);
      return {
        data: {
          repository: {
            issue: {
              comments: { nodes: [{ body: 'older' }, { body: 'newer' }] },
            },
          },
        },
      };
    }, { repo: 'owner/repo' });

    expect(result).toEqual({ measured: true, comments: ['older', 'newer'] });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('api');
    expect(calls[0][1]).toBe('graphql');
    expect(calls[0].join(' ')).toContain('comments(last:14)');
    expect(calls[0]).toContain('-F');
    expect(calls[0]).toContain('number=1951');
  });

  it('main mantiene n/d su allocation unknown e non crea tracker dopo lookup fallito', () => {
    const { stdout, calls } = runReportWithFakeGh();

    expect(stdout).toContain('job avviati 1, pending 1');
    expect(stdout).toContain('Allocazione workflow:** riparazione PR n/d run eleggibili · issue-fix 2 · rapporto n/d');
    expect(stdout).toContain('tracker loop health non misurabile');
    expect(calls.some((args) => args[0] === 'label' && args[1] === 'create')).toBe(false);
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'comment')).toBe(false);
  });
});

describe('warnStreaks — counts CONSECUTIVE prior reports', () => {
  const ISSUE_FIX = 'failure-rate:issue-fix.yml';

  it('reports no streak when the tracker does not exist yet', () => {
    expect(warnStreaks(null, () => [])).toEqual(new Map());
  });

  it('counts a warning present in every prior report, and dates it to the oldest', () => {
    const comments = [
      report(28, ['failure-rate 34% su issue-fix.yml (48/141 run reali)']),
      report(21, ['failure-rate 38% su issue-fix.yml (45/119 run reali)']),
      report(14, ['failure-rate 46% su issue-fix.yml (69/149 run reali)']),
      report(7, ['failure-rate 55% su issue-fix.yml (60/109 run reali)']),
    ];
    const streaks = warnStreaks(1951, () => comments);
    expect(streaks.get(ISSUE_FIX)).toEqual({ count: 4, since: daysAgoIso(28), capped: true });
  });

  it('breaks the streak at the first prior report that did NOT warn', () => {
    const comments = [
      report(28, ['failure-rate 34% su issue-fix.yml (48/141 run reali)']),
      report(21, []), // recovered — everything before this is a different episode
      report(14, ['failure-rate 46% su issue-fix.yml (69/149 run reali)']),
      report(7, ['failure-rate 55% su issue-fix.yml (60/109 run reali)']),
    ];
    const streaks = warnStreaks(1951, () => comments);
    expect(streaks.get(ISSUE_FIX)).toEqual({ count: 2, since: daysAgoIso(14), capped: false });
  });

  it('tracks each warning independently', () => {
    const comments = [
      report(21, ['failure-rate 34% su issue-fix.yml (48/141 run reali)']),
      report(14, [
        'failure-rate 46% su issue-fix.yml (69/149 run reali)',
        'failure-rate 46% su post-merge-followup.yml (22/48 run reali)',
      ]),
      report(7, [
        'failure-rate 55% su issue-fix.yml (60/109 run reali)',
        'failure-rate 44% su post-merge-followup.yml (21/48 run reali)',
        'PR con una sola review del bot 42% (<50%)',
      ]),
    ];
    const streaks = warnStreaks(1951, () => comments);
    expect(streaks.get(ISSUE_FIX)!.count).toBe(3);
    expect(streaks.get('failure-rate:post-merge-followup.yml')!.count).toBe(2);
    expect(streaks.get('single-bot-review-rate')!.count).toBe(1);
  });

  it('ignores comments that are not loop-health reports', () => {
    const comments = [
      'Nota a mano di un umano sul tracker, senza tabelle.',
      report(7, ['failure-rate 55% su issue-fix.yml (60/109 run reali)']),
    ];
    expect(warnStreaks(1951, () => comments).get(ISSUE_FIX)!.count).toBe(1);
  });

  it('marks a streak that reaches the end of the read window as a LOWER bound', () => {
    // Every report read carries the warning, so the real streak may be longer
    // than the window — reported as "≥N", never as an exact count.
    const comments = [
      report(14, ['failure-rate 46% su issue-fix.yml (69/149 run reali)']),
      report(7, ['failure-rate 55% su issue-fix.yml (60/109 run reali)']),
    ];
    expect(warnStreaks(1951, () => comments).get(ISSUE_FIX)!.capped).toBe(true);
  });

  it('does NOT mark a streak that a clean report already bounded', () => {
    const comments = [
      report(14, []),
      report(7, ['failure-rate 55% su issue-fix.yml (60/109 run reali)']),
    ];
    expect(warnStreaks(1951, () => comments).get(ISSUE_FIX)!.capped).toBe(false);
  });

  it('degrades to no streak when the tracker cannot be read', () => {
    expect(warnStreaks(1951, () => []).size).toBe(0);
  });
});

describe('mergedPrStats — review identity and list completeness', () => {
  it('counts both human-style and bot-suffixed automation logins', () => {
    const reviews = [
      { author: { login: 'claude' } },
      { author: { login: 'claude[bot]' } },
      { author: { login: 'frontaliere-automation' } },
      { author: { login: 'frontaliere-automation[bot]' } },
      { author: { login: 'someone-else' } },
    ];

    expect(botReviewCount({ reviews })).toBe(4);
  });

  it('raises an observable truncation flag when the GitHub list reaches its limit', () => {
    const calls: string[][] = [];
    const runGh = (args: string[]) => {
      calls.push(args);
      return Array.from({ length: MERGED_PR_LIST_LIMIT }, (_, number) => ({
        number: number + 1,
        reviews: [],
      }));
    };

    const stats = mergedPrStats(
      new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
      runGh,
    );

    expect(calls[0]).toContain('--limit');
    expect(calls[0]).toContain(String(MERGED_PR_LIST_LIMIT));
    expect(stats).toMatchObject({
      measured: true,
      merged: MERGED_PR_LIST_LIMIT,
      limit: MERGED_PR_LIST_LIMIT,
      truncated: true,
    });
  });

  it('non trasforma un record PR senza reviews in uno zero misurato', () => {
    const stats = mergedPrStats('2026-09-12', () => [{}]);
    expect(stats).toMatchObject({
      measured: false,
      merged: null,
      singleReview: null,
      zeroReview: null,
      totalReviews: null,
    });
  });

  it('non trasforma un updatedAt invalido in zero zombie misurato', () => {
    const stats = zombieStats(() => [{ updatedAt: 'invalid' }]);
    expect(stats).toMatchObject({ measured: false, value: null, candidates: null });
  });
});
