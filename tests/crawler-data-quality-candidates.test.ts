import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCrawlerDataQualityReport,
  executeIssuePacket,
  GH_ACTION_TIMEOUT_MS,
  materializeIssuePacket,
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
    const cycle = `<!-- crawler-data-quality-cycle:${Math.floor(Date.parse(report.generatedAt) / (7 * 24 * 60 * 60 * 1000))} -->`;

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
});
