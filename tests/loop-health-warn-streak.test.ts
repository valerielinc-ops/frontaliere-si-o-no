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
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script, no type declarations
import {
  backlogTrendWarning,
  claudeAllocation,
  claudeReviewRunStats,
  claudeReviewCount,
  claudeUsageStepRan,
  MERGED_PR_LIST_LIMIT,
  mergedPrStats,
  PR_REPAIR_RUN_WARN,
  REPAIR_TO_ISSUE_RATIO_WARN,
  repairEfficiencyWarnings,
  warnKey,
  warnStreaks,
} from '../scripts/ci/loop-health-report.mjs';

/** Reports are dated relative to now — never a calendar literal in a fixture. */
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function report(sinceDaysAgo: number, warnings: string[]): string {
  const head = `## Loop health — ultimi 7gg (dal ${daysAgoIso(sinceDaysAgo)})\n\n| Workflow Claude |\n|---|\n`;
  const tail = warnings.length
    ? `\n### ⚠️ Da investigare\n${warnings.map((w) => `- ${w}`).join('\n')}\n`
    : '\n### ✅ Nessuna soglia superata\n';
  return head + tail;
}

function backlogReport(sinceDaysAgo: number, queued: number, warnings: string[] = []): string {
  return `${report(sinceDaysAgo, warnings)}\n**Backlog:** agent:fix zombie 0 · in coda ${queued} · fu-parked 0 · needs-human 0.\n`;
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
    expect(warnKey('first-shot LGTM rate 42% (<50%)')).toBe('first-shot-lgtm');
    expect(warnKey('3 issue agent:fix zombie (>24h, nessuna PR aperta)')).toBe('zombie');
    expect(warnKey('PR repair volume 401 run reali (> 400)')).toBe('pr-repair-volume');
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
      'PR repair volume 401 run reali (> 400)',
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

describe('tests.yml — segnale Claude incorporato e allocazione', () => {
  it('conta solo il passo persistito del fallback realmente usato', () => {
    expect(claudeUsageStepRan([{
      steps: [
        { name: 'Run Claude review', status: 'completed', conclusion: 'success' },
        { name: 'Claude usage metrics', status: 'completed', conclusion: 'skipped' },
      ],
    }])).toBe(false); // Codex-primary o tests-only
    expect(claudeUsageStepRan([{
      steps: [
        { name: 'Run Claude review', status: 'completed', conclusion: 'success' },
        { name: 'Claude usage metrics', status: 'completed', conclusion: 'success' },
      ],
    }])).toBe(true);
    expect(claudeUsageStepRan([{
      steps: [{ name: 'Claude usage metrics', status: 'in_progress', conclusion: '' }],
    }])).toBe(false);
  });

  it('rende esplicita una lettura GitHub incompleta e non la trasforma in zero', () => {
    const calls: string[][] = [];
    const stats = claudeReviewRunStats('2026-09-01', (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run') return [{ databaseId: 1 }, { databaseId: 2 }];
      if (args.some((arg) => arg.includes('/runs/1/'))) {
        return { jobs: [{ steps: [{ name: 'Claude usage metrics', status: 'completed', conclusion: 'success' }] }] };
      }
      throw new Error('HTTP 429');
    });

    expect(stats).toEqual({ total: 2, claudeRuns: 1, measured: false, truncated: false });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(expect.arrayContaining(['--event', 'pull_request', '--status', 'completed']));
  });

  it('include il reviewer incorporato nel rapporto riparazione PR:issue-fix', () => {
    expect(claudeAllocation({
      prRepairRuns: 4,
      embeddedReviewRuns: 2,
      issueFixRuns: 3,
    })).toEqual({ repairRuns: 6, issueFixRuns: 3, ratio: '2.0:1' });
    expect(claudeAllocation({
      prRepairRuns: 4,
      embeddedReviewRuns: 2,
      embeddedMeasured: false,
      issueFixRuns: 3,
    })).toEqual({ repairRuns: null, issueFixRuns: 3, ratio: 'n/d' });
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
        'first-shot LGTM rate 42% (<50%)',
      ]),
    ];
    const streaks = warnStreaks(1951, () => comments);
    expect(streaks.get(ISSUE_FIX)!.count).toBe(3);
    expect(streaks.get('failure-rate:post-merge-followup.yml')!.count).toBe(2);
    expect(streaks.get('first-shot-lgtm')!.count).toBe(1);
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

    expect(claudeReviewCount({ reviews })).toBe(4);
  });

  it('raises an observable truncation flag when the GitHub list reaches its limit', () => {
    const calls: string[][] = [];
    const runGh = (args: string[]) => {
      calls.push(args);
      return Array.from({ length: MERGED_PR_LIST_LIMIT }, (_, number) => ({
        number,
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
      merged: MERGED_PR_LIST_LIMIT,
      limit: MERGED_PR_LIST_LIMIT,
      truncated: true,
    });
  });
});
