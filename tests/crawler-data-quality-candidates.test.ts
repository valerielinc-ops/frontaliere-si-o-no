import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditCycle,
  buildCrawlerDataQualityReport,
  executeIssuePacket,
  GH_ACTION_TIMEOUT_MS,
  loadOpenIssues,
  materializeIssuePacket,
  OPEN_ISSUES_LIMIT,
  planIssueActions,
} from '../scripts/ci/crawler-data-quality-candidates.mjs';

function worstCaseReport() {
  return buildCrawlerDataQualityReport({
    generatedAt: '2026-09-01T00:00:00.000Z',
    windowDays: 15,
    runUrl: 'https://github.com/acme/site/actions/runs/12345',
    fileCount: 5,
    jobCount: 10,
    commitCount: 7,
    contamination: {
      moved: 2,
      affected: [{ file: 'a.json', moved: 2 }],
    },
    duplicates: [{
      file: 'b.json',
      stableId: 'num:123456',
      count: 2,
      slugs: ['first', 'second'],
    }],
    translation: {
      baselineCommit: 'abc123',
      baselineCount: 100,
      currentCount: 140,
      delta: 40,
    },
    housekeeping: {
      emptyLocaleBuckets: [{ file: 'c.json', id: 'job-c', locale: 'fr' }],
      staleActive: [{ file: 'd.json', id: 'job-d', crawledAt: '2026-01-01T00:00:00.000Z' }],
    },
  });
}

describe('bounded weekly crawler data-quality candidates (#6787)', () => {
  it('caps the complete worst case at five evidence-backed findings', () => {
    const report = worstCaseReport();

    expect(report.findings).toHaveLength(5);
    expect(report.findings.map((finding) => finding.key)).toEqual([
      'previous-slug-cross-job-contamination',
      'duplicate-stable-id-divergent-slugs',
      'needs-retranslation-backlog-growth',
      'empty-previous-slug-locale-buckets',
      'active-records-stale-over-60-days',
    ]);
    expect(report.cap).toBe(5);
  });

  it('plans exactly one deterministic create/comment action per finding', () => {
    const report = worstCaseReport();
    const first = report.findings[0];
    const second = report.findings[1];
    const openIssues = [
      { number: 91, title: 'different', body: `<!-- crawler-data-quality:${first.key} -->` },
      { number: 92, title: second.title, body: 'legacy issue without marker' },
    ];

    const actions = planIssueActions(report, openIssues);

    expect(actions).toHaveLength(5);
    expect(actions.map((action) => action.kind)).toEqual([
      'comment', 'comment', 'create', 'create', 'create',
    ]);
    expect(actions[0]).toMatchObject({ issueNumber: 91, bodyFile: '/tmp/crawler-data-quality-issue-1.md' });
    expect(actions[1]).toMatchObject({ issueNumber: 92, bodyFile: '/tmp/crawler-data-quality-issue-2.md' });
    expect(planIssueActions(report, openIssues)).toEqual(actions);
  });

  it('materializes five unique multiline bodies idempotently without slot editing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-packet-'));
    const outputPath = path.join(root, 'packet.json');
    const report = worstCaseReport();
    const openIssues = [{
      number: 91,
      title: 'different',
      body: `<!-- crawler-data-quality:${report.findings[0].key} -->`,
    }];

    const first = materializeIssuePacket(report, openIssues, { outputPath, bodyDir: root });
    const snapshot = fs.readdirSync(root).sort().map((file) => [
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
    ]);
    const second = materializeIssuePacket(report, openIssues, { outputPath, bodyDir: root });
    const rerun = fs.readdirSync(root).sort().map((file) => [
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
    ]);

    expect(second).toEqual(first);
    expect(rerun).toEqual(snapshot);
    expect(first.actions).toHaveLength(5);
    for (let index = 1; index <= 5; index += 1) {
      const body = fs.readFileSync(path.join(root, `crawler-data-quality-issue-${index}.md`), 'utf8');
      expect(body).toContain(`<!-- crawler-data-quality:${report.findings[index - 1].key} -->`);
      expect(body).toContain('\n## Evidenza deterministica\n');
      expect(body).toContain('https://github.com/acme/site/actions/runs/12345');
    }
  });

  it('performs zero issue mutations and writes no body when there are no findings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-empty-'));
    const outputPath = path.join(root, 'packet.json');
    const report = { ...worstCaseReport(), findings: [] };

    const packet = materializeIssuePacket(report, [], { outputPath, bodyDir: root });

    expect(packet.actions).toEqual([]);
    expect(packet.scheduling).toEqual({
      totalFindings: 0,
      actionCursor: 0,
      alreadyHandledThisCycle: 0,
      deferredFindings: 0,
    });
    expect(fs.readdirSync(root).sort()).toEqual(['packet.json']);
  });

  it('rotates more than five findings deterministically so none starves', () => {
    const base = worstCaseReport();
    const findings = Array.from({ length: 7 }, (_, index) => ({
      ...base.findings[index % base.findings.length],
      key: `finding-${index + 1}`,
      title: `[data-quality] test: finding ${index + 1}`,
    }));
    const firstWeek = { ...base, generatedAt: '2026-09-01T00:00:00.000Z', findings };
    const first = planIssueActions(firstWeek, []);
    const repeat = planIssueActions(firstWeek, []);
    const weeklyActions = Array.from({ length: 7 }, (_, week) => planIssueActions({
      ...firstWeek,
      generatedAt: new Date(Date.parse(firstWeek.generatedAt) + (week * 7 * 24 * 60 * 60 * 1000))
        .toISOString(),
    }, []));

    expect(first).toHaveLength(5);
    expect(repeat).toEqual(first);
    expect(weeklyActions.every((actions) => actions.length === 5)).toBe(true);
    expect(new Set(weeklyActions.flat().map((action) => action.key))).toEqual(
      new Set(findings.map((finding) => finding.key)),
    );
  });

  it('makes same-week create/comment retries idempotent after partial failure', () => {
    const report = worstCaseReport();
    const first = report.findings[0];
    const marker = `<!-- crawler-data-quality:${first.key} -->`;
    const cycle = `<!-- crawler-data-quality-cycle:${auditCycle(report.generatedAt).key} -->`;

    const createdInThisRun = planIssueActions(report, [{
      number: 101,
      title: first.title,
      body: `${marker}\n${cycle}\nRun: ${report.runUrl}`,
      comments: [],
    }]);
    const commentedInThisRun = planIssueActions(report, [{
      number: 101,
      title: first.title,
      body: marker,
      comments: [{ body: `${marker}\n${cycle}\n🔁 Run: ${report.runUrl}` }],
    }]);

    expect(createdInThisRun.map((action) => action.key)).not.toContain(first.key);
    expect(commentedInThisRun.map((action) => action.key)).not.toContain(first.key);
    expect(createdInThisRun).toHaveLength(4);
    expect(commentedInThisRun).toHaveLength(4);

    const nextWeek = planIssueActions({
      ...report,
      generatedAt: new Date(Date.parse(report.generatedAt) + (7 * 24 * 60 * 60 * 1000)).toISOString(),
    }, [{ number: 101, title: first.title, body: `${marker}\n${cycle}`, comments: [] }]);
    expect(nextWeek.find((action) => action.key === first.key)?.kind).toBe('comment');
  });

  it('uses the same Monday-UTC ISO week for dedup markers and rotation cursors', () => {
    const base = worstCaseReport();
    const findings = Array.from({ length: 7 }, (_, index) => ({
      ...base.findings[index % base.findings.length],
      key: `iso-finding-${index + 1}`,
      title: `[data-quality] test: ISO finding ${index + 1}`,
    }));
    const sunday = { ...base, generatedAt: '2026-09-06T23:59:59.999Z', findings };
    const monday = { ...base, generatedAt: '2026-09-07T00:00:00.000Z', findings };
    const sundayCycle = auditCycle(sunday.generatedAt);
    const mondayCycle = auditCycle(monday.generatedAt);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-iso-week-'));
    const sundayPacket = materializeIssuePacket(sunday, [], {
      outputPath: path.join(root, 'sunday.json'),
      bodyDir: root,
    });
    const sundayBody = fs.readFileSync(sundayPacket.actions[0].bodyFile, 'utf8');
    const mondayBodyDir = path.join(root, 'monday');
    const mondayPacket = materializeIssuePacket(monday, [], {
      outputPath: path.join(root, 'monday.json'),
      bodyDir: mondayBodyDir,
    });
    const mondayBody = fs.readFileSync(mondayPacket.actions[0].bodyFile, 'utf8');
    const mondayCursor = mondayCycle.ordinal % findings.length;

    expect(sundayCycle.key).toBe('2026-W36');
    expect(Number.isSafeInteger(sundayCycle.ordinal)).toBe(true);
    expect(mondayCycle.key).toBe('2026-W37');
    expect(mondayCycle.ordinal).toBe(sundayCycle.ordinal + 1);
    expect(sundayBody).toContain(`<!-- crawler-data-quality-cycle:${sundayCycle.key} -->`);
    expect(sundayPacket.scheduling.actionCursor).toBe(sundayCycle.ordinal % findings.length);
    expect(mondayBody).toContain(`<!-- crawler-data-quality-cycle:${mondayCycle.key} -->`);
    expect(mondayPacket.scheduling.actionCursor).toBe(mondayCursor);
    expect(planIssueActions(monday, [
      {
        number: 101,
        title: findings[mondayCursor].title,
        body: `<!-- crawler-data-quality:${findings[mondayCursor].key} -->\n`
          + `<!-- crawler-data-quality-cycle:${sundayCycle.key} -->`,
        comments: [],
      },
    ])[0]).toMatchObject({ key: findings[mondayCursor].key, kind: 'comment' });
  });

  it('keeps ISO week identity stable across the calendar-year boundary', () => {
    expect(auditCycle('2026-12-31T23:59:59.999Z').key).toBe('2026-W53');
    expect(auditCycle('2027-01-01T00:00:00.000Z').key).toBe('2026-W53');
    expect(auditCycle('2027-01-04T00:00:00.000Z').key).toBe('2027-W01');
  });

  it('fails closed before mutations when the open-issue inventory reaches its cap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-inventory-'));
    const inventoryPath = (count: number) => {
      const file = path.join(root, `open-${count}.json`);
      fs.writeFileSync(file, JSON.stringify(Array.from({ length: count }, (_, index) => ({
        number: index + 1,
        title: `issue ${index + 1}`,
        body: '',
        comments: [],
      }))));
      return file;
    };

    expect(OPEN_ISSUES_LIMIT).toBe(100);
    expect(loadOpenIssues(inventoryPath(99), OPEN_ISSUES_LIMIT)).toHaveLength(99);
    for (const count of [100, 101]) {
      let mutations = 0;
      expect(() => {
        const packet = materializeIssuePacket(
          worstCaseReport(),
          loadOpenIssues(inventoryPath(count), OPEN_ISSUES_LIMIT),
          { outputPath: path.join(root, `packet-${count}.json`), bodyDir: root },
        );
        executeIssuePacket(packet, () => {
          mutations += 1;
          return { status: 0, stdout: '', stderr: '' };
        });
      }).toThrow(`reached its fetch cap (${count}/${OPEN_ISSUES_LIMIT})`);
      expect(mutations).toBe(0);
      expect(fs.existsSync(path.join(root, `packet-${count}.json`))).toBe(false);
    }
  });

  it('executes serially and stops before later gh mutations after the first failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-executor-'));
    const report = worstCaseReport();
    const packet = materializeIssuePacket(report, [], {
      outputPath: path.join(root, 'packet.json'),
      bodyDir: root,
    });
    const calls: string[][] = [];
    const runner = (_command: string, args: string[]) => {
      calls.push(args);
      return calls.length === 2
        ? { status: 1, stderr: 'simulated gh failure', stdout: '' }
        : { status: 0, stderr: '', stdout: 'ok' };
    };

    expect(() => executeIssuePacket(packet, runner)).toThrow(/gh action 2 failed/);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 2)).toEqual(['issue', 'create']);
  });

  it('executes an empty packet without invoking gh', () => {
    let calls = 0;
    const result = executeIssuePacket({ actions: [] }, () => {
      calls += 1;
      return { status: 0, stderr: '', stdout: '' };
    });

    expect(result).toEqual({ attempted: 0, created: 0, commented: 0 });
    expect(calls).toBe(0);
  });

  it('treats a timed-out killed gh process as terminal and redacts its output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-quality-timeout-'));
    const packet = materializeIssuePacket(worstCaseReport(), [], {
      outputPath: path.join(root, 'packet.json'),
      bodyDir: root,
    });
    let calls = 0;
    let message = '';
    try {
      executeIssuePacket(packet, () => {
        calls += 1;
        const fakeCredential = ['ghp', 'do_not_leak_this_token'].join('_');
        return {
          status: null,
          signal: 'SIGTERM',
          error: new Error(`ETIMEDOUT ${fakeCredential}`),
          stderr: 'Bearer do-not-leak',
          stdout: '',
        };
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(GH_ACTION_TIMEOUT_MS).toBe(120_000);
    const executorSource = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/ci/crawler-data-quality-candidates.mjs'),
      'utf8',
    );
    expect(executorSource).toContain('timeout: GH_ACTION_TIMEOUT_MS');
    expect(executorSource).toContain("killSignal: 'SIGTERM'");
    expect(calls).toBe(1);
    expect(message).toContain('status=null, signal=SIGTERM');
    expect(message).toContain('[redacted-token]');
    expect(message).not.toContain('do_not_leak_this_token');
    expect(message).not.toContain('do-not-leak');
  });

  it('does not flag normal translation drift below max(25, 5% baseline)', () => {
    const report = buildCrawlerDataQualityReport({
      generatedAt: '2026-09-01T00:00:00.000Z',
      windowDays: 15,
      runUrl: 'https://github.com/acme/site/actions/runs/12345',
      fileCount: 1,
      jobCount: 1,
      commitCount: 1,
      contamination: { moved: 0, affected: [] },
      duplicates: [],
      translation: { baselineCommit: 'abc123', baselineCount: 1_000, currentCount: 1_049, delta: 49 },
      housekeeping: { emptyLocaleBuckets: [], staleActive: [] },
    });

    expect(report.findings).toEqual([]);
  });

  it('degrades gracefully when no baseline commit is found (shallow checkout), instead of throwing', () => {
    const report = buildCrawlerDataQualityReport({
      generatedAt: '2026-09-01T00:00:00.000Z',
      windowDays: 15,
      runUrl: 'https://github.com/acme/site/actions/runs/12345',
      fileCount: 5,
      jobCount: 10,
      commitCount: 7,
      contamination: { moved: 2, affected: [{ file: 'a.json', moved: 2 }] },
      duplicates: [],
      translation: null,
      housekeeping: { emptyLocaleBuckets: [], staleActive: [] },
    });

    expect(report.findings.map((finding) => finding.key)).toEqual([
      'previous-slug-cross-job-contamination',
    ]);
    expect(report.metrics.needsRetranslationBaseline).toBeNull();
    expect(report.metrics.needsRetranslationCurrent).toBeNull();
    expect(report.metrics.needsRetranslationDelta).toBeNull();
    expect(report.metrics.needsRetranslationBaselineUnavailable).toBe(true);
  });
});
