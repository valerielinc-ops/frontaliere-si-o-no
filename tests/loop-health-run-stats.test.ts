/**
 * Loop health report (issue 1951): the fixer failure rate must be measurable
 * and the closing stage of the loop visible.
 *
 * From mid-September the report read each workflow with ONE
 * `gh run list --created >since --limit 1000`. Two thirds of the issue-fix
 * runs are `skipped` (702 of 1000 on 2026-10-03), so the cap was always hit
 * and the failure rate of issue-fix, redflag-fixer and redcheck-fixer stayed
 * `n/d` for 9, 7 and 12+ consecutive reports. The fix reads one UTC day at a
 * time; truncation is declared only when ONE day reaches the cap.
 *
 * The report also counted the entry of the loop (queue, zombies) and not its
 * exit: open `maybe-resolved` issues were invisible.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI script, no type declarations
import {
  CLOSING_STALE_HOURS,
  closingOwner,
  closingStageStats,
  reconcileKillSwitch,
  renderClosingStage,
  RUN_LIST_LIMIT,
  runListWindow,
  runStats,
  verifyLabelAppliedAt,
  warnStreaks,
} from '../scripts/ci/loop-health-report.mjs';

type Run = { databaseId: number; status: string; conclusion: string | null; createdAt: string };

/** Dates relative to now — never a calendar literal in a fixture. */
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const since = daysAgoIso(7);

/** A fake `gh run list` that answers per `--created <day>` from a fixture map. */
function fakeRunList(byDay: Map<string, Run[]>) {
  const calls: string[][] = [];
  const runGh = (args: string[]) => {
    calls.push(args);
    const day = args[args.indexOf('--created') + 1];
    return byDay.get(day) ?? [];
  };
  return { runGh, calls };
}

function windowDays(): string[] {
  return runListWindow(since, new Date()).days;
}

function run(id: number, day: string, conclusion: string): Run {
  return { databaseId: id, status: 'completed', conclusion, createdAt: `${day}T00:30:00Z` };
}

describe('runStats — una lettura per giorno UTC, troncata solo se UN giorno tocca il cap', () => {
  it('la finestra è esattamente quella di `--created >since`: dal giorno dopo fino a oggi', () => {
    const window = runListWindow(since, new Date());
    expect(window.days[0]).toBe(daysAgoIso(6));
    expect(window.days.at(-1)).toBe(daysAgoIso(0));
    expect(window.start).toBe(Date.parse(`${daysAgoIso(6)}T00:00:00Z`));
    expect(runListWindow('not-a-date', new Date())).toBeNull();
  });

  it('1.500 run in 7 giorni, 1.000 skipped → non troncata, rate sulle sole eleggibili', () => {
    const days = windowDays();
    const byDay = new Map<string, Run[]>(days.map((day) => [day, []]));
    const skipped = 1000;
    const failed = 100;
    const succeeded = 400;
    const conclusions = [
      ...Array(skipped).fill('skipped'),
      ...Array(failed).fill('failure'),
      ...Array(succeeded).fill('success'),
    ];
    conclusions.forEach((conclusion, index) => {
      const day = days[index % days.length];
      byDay.get(day)!.push(run(index + 1, day, conclusion));
    });
    const { runGh, calls } = fakeRunList(byDay);

    const stats = runStats('issue-fix.yml', since, runGh);

    expect(stats.truncated).toBe(false);
    expect(stats.total).toBe(conclusions.length);
    expect(stats.skipped).toBe(skipped);
    expect(stats.eligible).toBe(failed + succeeded);
    expect(stats.rate).toBeCloseTo(failed / (failed + succeeded));
    // One read per day of the window, each a date-only `--created <day>`.
    expect(calls).toHaveLength(days.length);
    expect(calls.map((args) => args[args.indexOf('--created') + 1])).toEqual(days);
    for (const args of calls) {
      expect(args[args.indexOf('--limit') + 1]).toBe(String(RUN_LIST_LIMIT));
    }
  });

  it('un giorno con esattamente il limite di righe → troncata, rate n/d', () => {
    const days = windowDays();
    const full = days[2];
    const byDay = new Map<string, Run[]>([
      [full, Array.from({ length: RUN_LIST_LIMIT }, (_, i) => run(i + 1, full, i % 2 ? 'success' : 'skipped'))],
      [days[3], [run(RUN_LIST_LIMIT + 1, days[3], 'failure')]],
    ]);
    const { runGh } = fakeRunList(byDay);

    const stats = runStats('issue-fix.yml', since, runGh);

    expect(stats.truncated).toBe(true);
    expect(stats.rate).toBeNull();
  });

  it('la stessa run restituita da due giorni contigui è contata una volta', () => {
    const days = windowDays();
    const shared = run(42, days[1], 'failure');
    const byDay = new Map<string, Run[]>([
      [days[0], [shared, run(1, days[0], 'success')]],
      [days[1], [shared, run(2, days[1], 'success')]],
    ]);
    const { runGh } = fakeRunList(byDay);

    const stats = runStats('issue-fix.yml', since, runGh);

    expect(stats.total).toBe(3);
    expect(stats.fail).toBe(1);
    expect(stats.records.filter((r: Run) => r.databaseId === 42)).toHaveLength(1);
  });

  it('una run del primo giorno creata prima dell inizio della finestra NON è contata', () => {
    const days = windowDays();
    const early = { databaseId: 7, status: 'completed', conclusion: 'failure', createdAt: `${since}T12:00:00Z` };
    const byDay = new Map<string, Run[]>([
      [days[0], [early, run(8, days[0], 'success')]],
    ]);
    const { runGh } = fakeRunList(byDay);

    const stats = runStats('issue-fix.yml', since, runGh);

    expect(stats.total).toBe(1);
    expect(stats.fail).toBe(0);
    expect(stats.rate).toBe(0);
  });

  it('ordina i record dal più recente: l ispezione dei job resta sulle run più nuove', () => {
    const days = windowDays();
    const byDay = new Map<string, Run[]>(days.map((day, i) => [day, [run(i + 1, day, 'success')]]));
    const { runGh } = fakeRunList(byDay);

    const stats = runStats('issue-fix.yml', since, runGh);

    expect(stats.records[0].createdAt.slice(0, 10)).toBe(days.at(-1));
    expect(stats.records.at(-1).createdAt.slice(0, 10)).toBe(days[0]);
  });

  it('un errore di UNA lettura giornaliera rende n/d il workflow, non un falso parziale', () => {
    let n = 0;
    const stats = runStats('issue-fix.yml', since, () => {
      n += 1;
      if (n === 3) throw new Error('HTTP 502');
      return [];
    });
    expect(stats).toMatchObject({ measured: false, rate: null, total: null });
    expect(runStats('issue-fix.yml', since, () => ({ not: 'an array' })))
      .toMatchObject({ measured: false, reason: 'invalid-github-response' });
  });
});

type Issue = { number: number; title: string; labels: { name: string }[]; createdAt: string };

function issue(number: number, title: string, labels: string[], createdHoursAgo: number): Issue {
  return {
    number,
    title,
    labels: [...labels, 'maybe-resolved'].map((name) => ({ name })),
    createdAt: hoursAgoIso(createdHoursAgo),
  };
}

/** Fake gh for the closing stage: issue list + per-issue REST events (--jq lines). */
function fakeClosingGh(issues: Issue[], labelAgeHours: Map<number, number[] | Error>, variable?: string | Error) {
  const calls: string[][] = [];
  const runGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return issues;
    if (args[0] === 'api') {
      const number = Number(args.find((a) => a.includes('/events'))!.match(/issues\/(\d+)\/events/)![1]);
      const ages = labelAgeHours.get(number);
      if (ages instanceof Error) throw ages;
      return (ages ?? []).map((h) => hoursAgoIso(h)).join('\n');
    }
    if (args[0] === 'variable') {
      if (variable instanceof Error) throw variable;
      return variable ?? '';
    }
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { runGh, calls };
}

describe('stadio di chiusura — maybe-resolved visibili, allarme solo senza chiuditore', () => {
  const stale = CLOSING_STALE_HOURS + 28;
  const issues = [
    issue(101, 'Workflow Failure: something nobody owns', [], 400),
    issue(102, 'Fresh verification request', [], 300),
    issue(103, 'follow-up(daily): items', ['follow-up'], 300),
    issue(104, 'CWV Regression (CLS): /cerca-lavoro-ticino/', ['cwv-regression'], 500),
  ];
  const ages = new Map<number, number[] | Error>([
    [101, [stale]],
    [102, [CLOSING_STALE_HOURS - 62]],
    [103, [stale]],
    [104, [CLOSING_STALE_HOURS * 3]],
  ]);

  it('avvisa solo sulla issue oltre 72 h senza chiuditore; follow-up e monitor a parte', () => {
    const { runGh } = fakeClosingGh(issues, ages);
    const stats = closingStageStats(runGh, { env: { LOOP_HEALTH_VARS_FROM_WORKFLOW: '1' } });
    const out = renderClosingStage(stats);
    const text = out.lines.join('\n');

    expect(out.warnings).toEqual([
      `1 issue maybe-resolved oltre ${CLOSING_STALE_HOURS} h senza un chiuditore dichiarato: verifica da fare`,
    ]);
    expect(out.incomplete).toBe(false);
    expect(text).toContain(`maybe-resolved aperte da più di ${CLOSING_STALE_HOURS} h: 3`);
    expect(text).toMatch(/senza un chiuditore dichiarato 1 \(#101 /);
    const followUpLine = text.split('\n').find((line) => line.includes('followup-reconcile.yml'))!;
    expect(followUpLine).toContain('cron 06:00Z');
    expect(followUpLine).toContain('`vars.RECONCILE_NO_AUTOCLOSE` non impostata');
    expect(followUpLine).toContain('#103');
    const monitorLine = text.split('\n').find((line) => line.includes('monitor proprietario'))!;
    expect(monitorLine).toContain('#104');
    expect(monitorLine).not.toContain('#101');
    // The oldest label first in the "oldest" line.
    expect(text).toMatch(/più vecchia:\*\* #104/);
  });

  it('non chiama mai «da chiudere» una maybe-resolved e non produce bullet', () => {
    const { runGh } = fakeClosingGh(issues, ages);
    const out = renderClosingStage(closingStageStats(runGh, { env: { LOOP_HEALTH_VARS_FROM_WORKFLOW: '1' } }));
    const text = out.lines.join('\n');
    expect(text).not.toMatch(/da chiudere/i);
    // warnStreaks reads every `- ` bullet after `### ⚠️ Da investigare`: the
    // section must not add bullets of its own.
    expect(out.lines.some((line: string) => /^-\s/.test(line))).toBe(false);
    const prior = `## Loop health — ultimi 7gg (dal ${daysAgoIso(7)})\n\n${text}\n\n### ✅ Nessuna soglia superata\n`;
    expect(warnStreaks(1951, () => [prior]).size).toBe(0);
  });

  it('l età è quella dell ULTIMA applicazione della label, letta dagli eventi REST', () => {
    const { runGh, calls } = fakeClosingGh([], new Map([[7, [stale * 2, 5]]]));
    const appliedAt = verifyLabelAppliedAt(7, runGh, { repo: 'owner/repo' });
    expect(Date.now() - appliedAt).toBeLessThan(6 * 3_600_000);
    expect(calls[0]).toContain('--paginate');
    expect(calls[0]).toContain('repos/owner/repo/issues/7/events?per_page=100');
  });

  it('un età illeggibile resta n/d e marca il report incompleto, senza allarme inventato', () => {
    const { runGh } = fakeClosingGh([issue(201, 'Something', [], 400)], new Map([[201, new Error('HTTP 502')]]));
    const out = renderClosingStage(closingStageStats(runGh));
    expect(out.incomplete).toBe(true);
    expect(out.warnings).toEqual(['età della label maybe-resolved non misurata su 1/1 issue']);
    expect(out.lines.join('\n')).toContain('maybe-resolved aperte da più di 72 h: 0');
  });

  it('le issue saltate per il cap non passano per errori di lettura', () => {
    const capped = fakeClosingGh(
      [issue(301, 'Older', [], 400), issue(302, 'Newer', [], 300)],
      new Map([[301, [stale]], [302, [stale]]]),
    );
    const out = renderClosingStage(closingStageStats(capped.runGh, { inspectionLimit: 1, env: {} }));
    expect(out.incomplete).toBe(true);
    expect(out.warnings.some((w: string) => w.includes('non misurata'))).toBe(false);
    expect(out.warnings).toContain('età della label maybe-resolved letta solo sulle prime 1/2 issue (limite di ispezione)');
    expect(capped.calls.filter((args) => args[0] === 'api')).toHaveLength(1);
  });

  it('una lista illeggibile non diventa uno zero misurato', () => {
    const out = renderClosingStage(closingStageStats(() => { throw new Error('HTTP 500'); }));
    expect(out.incomplete).toBe(true);
    expect(out.lines.join('\n')).toContain('n/d');
  });

  it('legge il kill switch solo quando ci sono follow-up, senza mai supporne il valore', () => {
    const noFollowUp = fakeClosingGh([issues[0]], new Map([[101, [stale]]]));
    closingStageStats(noFollowUp.runGh, { env: {} });
    expect(noFollowUp.calls.some((args) => args[0] === 'variable')).toBe(false);

    expect(reconcileKillSwitch(() => '1\n', { env: {} })).toEqual({ measured: true, value: '1' });
    expect(reconcileKillSwitch(() => { throw new Error('variable RECONCILE_NO_AUTOCLOSE was not found'); }, { env: {} }))
      .toEqual({ measured: true, value: null });
    expect(reconcileKillSwitch(() => { throw new Error('HTTP 403: Resource not accessible by integration'); }, { env: {} }))
      .toEqual({ measured: false, value: null });
    expect(reconcileKillSwitch(() => { throw new Error('must not be called'); }, {
      env: { LOOP_HEALTH_VARS_FROM_WORKFLOW: '1', RECONCILE_NO_AUTOCLOSE: '1' },
    })).toEqual({ measured: true, value: '1' });

    const unreadable = fakeClosingGh([issues[2]], new Map([[103, [stale]]]), new Error('HTTP 403'));
    const text = renderClosingStage(closingStageStats(unreadable.runGh, { env: {} })).lines.join('\n');
    expect(text).toContain('`vars.RECONCILE_NO_AUTOCLOSE` non misurato');
  });

  it('classifica i chiuditori dichiarati', () => {
    expect(closingOwner(issue(1, 'x', ['keep-open', 'follow-up'], 1))).toBe('pin');
    expect(closingOwner(issue(1, 'x', ['agent:no-age-out'], 1))).toBe('pin');
    expect(closingOwner(issue(1, 'x', ['follow-up'], 1))).toBe('follow-up');
    expect(closingOwner(issue(1, '[crawler-health] kone: crawler unhealthy', [], 1))).toBe('monitor');
    expect(closingOwner(issue(1, 'CF 5xx: spike', [], 1))).toBe('monitor');
    expect(closingOwner(issue(1, 'App Error: error_boundary', [], 1))).toBe('monitor');
    expect(closingOwner(issue(1, 'whatever', ['loop-l2'], 1))).toBe('monitor');
    expect(closingOwner(issue(1, 'CI Failure: Deploy', ['ci-failure'], 1))).toBeNull();
  });
});
