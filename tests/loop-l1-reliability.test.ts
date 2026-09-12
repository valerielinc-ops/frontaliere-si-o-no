import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MINIMUM_SAMPLE,
  runL1,
  validateTelemetry,
} from '../scripts/ci/loop-l1-reliability.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function tempFile(value: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l1-test-'));
  const file = path.join(dir, 'telemetry.json');
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return { dir, file };
}

describe('L1 Reliability & UX', () => {
  it('accepts a fresh complete useful-session cohort', () => {
    const verdict = validateTelemetry({
      generatedAt: NOW.toISOString(),
      usefulSessions: 200,
      errorFreeUsefulSessions: 194,
    }, { now: NOW });
    expect(verdict.ok).toBe(true);
    expect(verdict.quality).toBe('observed');
    expect(verdict.snapshot.errorFreeUsefulSessions).toBe(194);
  });

  it('does not infer error-free sessions from an event-only baseline', () => {
    const verdict = validateTelemetry({
      _meta: { generatedAt: NOW.toISOString() },
      totals30d: { app_error: { n: 3 } },
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.quality).toBe('partial');
    expect(verdict.snapshot.usefulSessions).toBeNull();
  });

  it('marks an old complete export stale and excludes its ratio', () => {
    const verdict = validateTelemetry({
      generatedAt: '2026-09-01T12:00:00.000Z',
      usefulSessions: 200,
      errorFreeUsefulSessions: 194,
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.quality).toBe('stale');
    expect(verdict.issues.join(' ')).toContain('old');
  });

  it('keeps a future timestamp from inverting the decision window', async () => {
    const input = tempFile({
      generatedAt: '2026-09-12T18:00:00.000Z',
      usefulSessions: 200,
      errorFreeUsefulSessions: 194,
    });
    const result = await runL1({ now: NOW, sourcePath: input.file, logger: { log() {} } });
    expect(result.verdict.quality).toBe('stale');
    expect(result.decision.startedAt).toBe(NOW.toISOString());
    expect(Date.parse(result.decision.expiresAt)).toBeGreaterThan(Date.parse(result.decision.startedAt));
  });

  it('requires the configured minimum sample', () => {
    const verdict = validateTelemetry({
      generatedAt: NOW.toISOString(),
      usefulSessions: MINIMUM_SAMPLE - 1,
      errorFreeUsefulSessions: MINIMUM_SAMPLE - 1,
    }, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.ok).toBe(false);
  });

  it('rejects a numerator larger than its denominator', () => {
    const verdict = validateTelemetry({
      generatedAt: NOW.toISOString(),
      usefulSessions: 100,
      errorFreeUsefulSessions: 101,
    }, { now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('exceeds');
  });

  it('applies a runner-local hold and can issue a deduplicated finding', async () => {
    const input = tempFile({ generatedAt: NOW.toISOString() });
    const reportDir = path.join(input.dir, 'report');
    const calls: unknown[] = [];
    const result = await runL1({
      now: NOW,
      sourcePath: input.file,
      reportDir,
      apply: true,
      issue: true,
      createIssueImpl: async (payload) => { calls.push(payload); },
      logger: { log() {} },
    });
    expect(result.held).toBe(true);
    expect(result.issued).toBe(true);
    expect(fs.existsSync(path.join(reportDir, 'l1-canary-hold.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, 'l1-result.json'), 'utf8'))).toMatchObject({
      ok: false,
      issued: true,
      held: true,
    });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { title: string }).title).toContain('L1 Reliability');
  });

  it('keeps missing-source metrics null in the shared contract', async () => {
    const result = await runL1({
      now: NOW,
      sourcePath: path.join(os.tmpdir(), 'loop-l1-does-not-exist.json'),
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('unmeasurable');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('does not write a persisted result when issue creation fails', async () => {
    const input = tempFile({ generatedAt: NOW.toISOString() });
    const reportDir = path.join(input.dir, 'report');
    await expect(runL1({
      now: NOW,
      sourcePath: input.file,
      reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue service unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue service unavailable');
    expect(fs.existsSync(path.join(reportDir, 'l1-result.json'))).toBe(false);
  });
});
