import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CANDIDATES,
  runL2,
  validateDemandSnapshot,
} from '../scripts/ci/loop-l2-demand-utility.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function cluster(overrides: Record<string, unknown> = {}) {
  return {
    clusterId: 'it-lavoro-ticino',
    locale: 'it',
    canonicalQuery: 'offerte lavoro ticino',
    canonicalSlug: 'offerte-lavoro-ticino',
    totalImpressions: 1200,
    totalClicks: 120,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    clusters: [cluster()],
    outcomes: { eligibleLandingSessions: 1200, usefulActions: 180 },
    ...overrides,
  };
}

function tempFile(value: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l2-test-'));
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return { dir, file };
}

describe('L2 Demand → Utility', () => {
  it('accepts explicit outcome data and keeps the landing path canonical', () => {
    const verdict = validateDemandSnapshot(snapshot(), { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.candidates[0].landingPath).toBe('/offerte-lavoro-ticino/');
    expect(verdict.snapshot.outcomes).toEqual({ eligibleLandingSessions: 1200, usefulActions: 180 });
  });

  it('does not turn GSC clicks into useful actions when outcomes are absent', () => {
    const verdict = validateDemandSnapshot(snapshot({ outcomes: undefined }), { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.outcomes).toBeNull();
  });

  it('rejects a cluster whose clicks exceed impressions', () => {
    const verdict = validateDemandSnapshot(snapshot({ clusters: [cluster({ totalClicks: 1201 })] }), { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('exceeds');
  });

  it('marks a stale source without losing candidate evidence', () => {
    const verdict = validateDemandSnapshot(snapshot({ generatedAt: '2026-09-01T12:00:00.000Z' }), { now: NOW });
    expect(verdict.quality).toBe('stale');
    expect(verdict.candidates).toHaveLength(1);
  });

  it('keeps a future timestamp from inverting the decision window', async () => {
    const input = tempFile(snapshot({ generatedAt: '2026-09-12T18:00:00.000Z' }));
    const result = await runL2({ now: NOW, sourcePath: input.file, logger: { log() {} } });
    expect(result.verdict.quality).toBe('stale');
    expect(result.decision.startedAt).toBe(NOW.toISOString());
    expect(Date.parse(result.decision.expiresAt)).toBeGreaterThan(Date.parse(result.decision.startedAt));
  });

  it('sorts and caps candidates deterministically', () => {
    const clusters = Array.from({ length: MAX_CANDIDATES + 4 }, (_, index) => cluster({
      clusterId: `cluster-${index}`,
      canonicalSlug: `query-${index}`,
      totalImpressions: 1000 + MAX_CANDIDATES + 4 - index,
    }));
    const verdict = validateDemandSnapshot(snapshot({ clusters }), { now: NOW });
    expect(verdict.candidates).toHaveLength(MAX_CANDIDATES);
    expect(verdict.candidates[0].totalImpressions).toBe(1000 + MAX_CANDIDATES + 4);
  });

  it('writes a reversible candidate artifact and an issue for an unmeasurable join', async () => {
    const input = tempFile(snapshot({ outcomes: undefined }));
    const reportDir = path.join(input.dir, 'report');
    const issues: unknown[] = [];
    const result = await runL2({
      now: NOW,
      sourcePath: input.file,
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { issues.push(payload); },
      logger: { log() {} },
    });
    expect(result.candidatesWritten).toBe(true);
    expect(result.issued).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l2-candidates.json'), 'utf8')))
      .toMatchObject({ reversible: true, candidates: [{ landingPath: '/offerte-lavoro-ticino/' }] });
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l2-result.json'), 'utf8'))).toMatchObject({
      ok: false,
      issued: true,
      candidatesWritten: true,
    });
    expect(issues).toHaveLength(1);
  });

  it('keeps a missing source unmeasurable with null metrics', async () => {
    const result = await runL2({
      now: NOW,
      sourcePath: path.join(os.tmpdir(), 'loop-l2-does-not-exist.json'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('does not write a persisted result when issue creation fails', async () => {
    const input = tempFile(snapshot({ outcomes: undefined }));
    const reportDir = path.join(input.dir, 'report');
    await expect(runL2({
      now: NOW,
      sourcePath: input.file,
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l2-result.json'))).toBe(false);
  });
});
