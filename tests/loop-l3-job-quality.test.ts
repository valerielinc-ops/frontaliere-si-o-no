import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL3,
  validateJobSummaries,
} from '../scripts/ci/loop-l3-job-quality.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    slug: 'job-1',
    title: 'Operatore logistico',
    company: 'Example SA',
    companyKey: 'example-sa',
    source: 'Example crawler',
    country: 'CH',
    url: 'https://jobs.example.test/job-1',
    applyUrl: 'https://jobs.example.test/job-1/apply',
    crawledAt: NOW.toISOString(),
    firstSeenAt: NOW.toISOString(),
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    file: 'example.json',
    data: {
      key: 'example',
      generatedAt: NOW.toISOString(),
      total: 1,
      newCount: 1,
      updatedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      newJobs: [job()],
      updatedJobs: [],
      removedJobs: [],
      unchangedJobs: [],
      ...overrides,
    },
  };
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    eligibleJobSessions: 120,
    validHandoffs: 90,
    applications: 12,
    ...overrides,
  };
}

function tempSource(summaryValue: unknown, outcomeValue: unknown = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l3-test-'));
  const summaryDir = path.join(dir, 'summaries');
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, 'example.json'), `${JSON.stringify(summaryValue)}\n`);
  const outcomePath = path.join(dir, 'outcomes.json');
  if (outcomeValue !== null) fs.writeFileSync(outcomePath, `${JSON.stringify(outcomeValue)}\n`);
  return { dir, summaryDir, outcomePath };
}

describe('L3 Job Quality → Apply', () => {
  it('accepts complete summaries and keeps the handoff metric explicit', () => {
    const verdict = validateJobSummaries([summary()], { outcomes: outcomes(), now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.outcomes).toMatchObject({ eligibleJobSessions: 120, validHandoffs: 90 });
  });

  it('does not turn job counts or URLs into application outcomes', () => {
    const verdict = validateJobSummaries([summary()], { outcomes: null, now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.outcomes.eligibleJobSessions).toBeNull();
  });

  it('does not manufacture a zero handoff rate from an empty outcome cohort', async () => {
    const source = tempSource(summary().data, outcomes({ eligibleJobSessions: 0, validHandoffs: 0, applications: 0 }));
    const result = await runL3({
      now: NOW,
      summaryDir: source.summaryDir,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('quarantines a missing apply URL as a candidate', () => {
    const verdict = validateJobSummaries([summary({ newJobs: [job({ applyUrl: undefined })] })], { outcomes: outcomes(), now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.candidates[0]).toMatchObject({ actionClass: 'quarantine+pr', reversible: true });
    expect(verdict.candidates[0].issueCodes.join(' ')).toContain('applyUrl');
  });

  it('rejects inconsistent crawler counts and duplicate identities', () => {
    const first = summary({ newJobs: [job(), job({ id: 'job-2', slug: 'job-2' })], newCount: 1 });
    const second = summary({ file: 'other.json', data: { ...summary().data, key: 'other', newJobs: [], newCount: 0, updatedJobs: [job()] } });
    const verdict = validateJobSummaries([first, second], { outcomes: outcomes(), now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('does not match');
    expect(verdict.issues.join(' ')).toContain('duplicate identity');
  });

  it('rejects an inconsistent active total and never measures its outcome', async () => {
    const inconsistent = summary({
      total: 2,
      written: 1,
      newCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
    });
    const verdict = validateJobSummaries([inconsistent], { outcomes: outcomes(), now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.issues.join(' ')).toContain('total (2) does not match');
    const source = tempSource({ ...inconsistent.data }, outcomes());
    const result = await runL3({
      now: NOW,
      summaryDir: source.summaryDir,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    });
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('marks an all-stale source and never inverts the decision window for future outcomes', () => {
    const verdict = validateJobSummaries(
      [summary({ generatedAt: '2026-09-01T12:00:00.000Z' })],
      { outcomes: outcomes({ generatedAt: '2026-09-12T18:00:00.000Z' }), now: NOW, maxAgeHours: 36 },
    );
    expect(verdict.quality).toBe('stale');
    const source = tempSource({ ...summary().data, generatedAt: '2026-09-01T12:00:00.000Z' }, { ...outcomes(), generatedAt: '2026-09-12T18:00:00.000Z' });
    return runL3({
      now: NOW,
      summaryDir: source.summaryDir,
      outcomePath: source.outcomePath,
      logger: { log() {} },
    }).then((result) => {
      expect(result.decision.startedAt).toBe(NOW.toISOString());
      expect(Date.parse(result.decision.expiresAt)).toBeGreaterThan(Date.parse(result.decision.startedAt));
    });
  });

  it('writes reversible actions, quarantine and a separate persistence result', async () => {
    const source = tempSource({ ...summary().data, newJobs: [job({ applyUrl: 'javascript:alert(1)' })] }, null);
    const reportDir = path.join(source.dir, 'report');
    const issues: unknown[] = [];
    const result = await runL3({
      now: NOW,
      summaryDir: source.summaryDir,
      outcomePath: source.outcomePath,
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result.actionsWritten).toBe(true);
    expect(result.quarantineWritten).toBe(true);
    expect(result.issued).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l3-quarantine.json'), 'utf8')))
      .toMatchObject({ publishedSourceUntouched: true, records: [{ reversible: true }] });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l3-result.json'), 'utf8')))
      .toMatchObject({ ok: false, issued: true, actionsWritten: true, quarantineWritten: true });
    expect(issues).toHaveLength(1);
  });

  it('keeps a missing summary directory unmeasurable with null metrics', async () => {
    const result = await runL3({
      now: NOW,
      summaryDir: path.join(os.tmpdir(), 'loop-l3-no-such-directory'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('does not write a persisted result when issue creation fails', async () => {
    const source = tempSource(summary().data, null);
    const reportDir = path.join(source.dir, 'report');
    await expect(runL3({
      now: NOW,
      summaryDir: source.summaryDir,
      outcomePath: source.outcomePath,
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l3-result.json'))).toBe(false);
  });
});
