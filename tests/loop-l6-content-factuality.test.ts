import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runL6,
  validateContentFactuality,
  validateQualityHistory,
} from '../scripts/ci/loop-l6-content-factuality.mjs';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: NOW.toISOString(),
    id: 'B.6.external-source-mismatch',
    severity: 'P1',
    message: 'Article claim needs independent verification',
    evidence: {
      articleId: 'example-article',
      locale: 'it',
      sourceUrl: 'https://source.example.test/fact',
    },
    ...overrides,
  };
}

function historyText(...rows: unknown[]) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function outcomes(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    reviewedArticles: 120,
    confirmedDefects: 12,
    externallyVerifiedDefects: 12,
    reopenedDefects: 1,
    ...overrides,
  };
}

function tempFiles({ history = historyText(historyRow()), outcome = outcomes() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l6-test-'));
  const historyPath = path.join(dir, 'history.jsonl');
  const outcomePath = path.join(dir, 'outcomes.json');
  const reportDir = path.join(dir, 'report');
  fs.writeFileSync(historyPath, history);
  if (outcome !== null) fs.writeFileSync(outcomePath, `${JSON.stringify(outcome)}\n`);
  return { dir, historyPath, outcomePath, reportDir };
}

describe('L6 Content Learning & Factuality', () => {
  it('accepts a fresh history and independent source verdict', () => {
    const verdict = validateContentFactuality({
      historyText: historyText(historyRow()),
      outcomes: outcomes(),
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: true, quality: 'observed' });
    expect(verdict.snapshot.outcomes).toMatchObject({ reviewedArticles: 120, confirmedDefects: 12 });
  });

  it('rejects malformed history records instead of silently dropping them', () => {
    const verdict = validateQualityHistory(`${JSON.stringify(historyRow())}\nnot-json\n`, { now: NOW });
    expect(verdict.quality).toBe('partial');
    expect(verdict.invalidRecords).toHaveLength(1);
    expect(verdict.issues[0]).toContain('invalid JSON');
  });

  it('keeps metrics null when the independent outcome export is missing', () => {
    const verdict = validateContentFactuality({
      historyText: historyText(historyRow()),
      outcomes: null,
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.snapshot.outcomes.reviewedArticles).toBeNull();
  });

  it('does not treat a zero reviewed cohort as a measurable zero rate', async () => {
    const files = tempFiles({ outcome: outcomes({ reviewedArticles: 0, confirmedDefects: 0, externallyVerifiedDefects: 0, reopenedDefects: 0 }) });
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('zero');
    expect(result.observation.numerator).toBeNull();
    expect(result.observation.denominator).toBeNull();
  });

  it('classifies future outcome timestamps as stale and starts observation at now', async () => {
    const files = tempFiles({ outcome: outcomes({ generatedAt: '2026-09-13T12:00:00.000Z' }) });
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      logger: { log() {} },
    });
    expect(result.verdict.quality).toBe('stale');
    expect(result.observation.observationWindow.start).toBe(NOW.toISOString());
  });

  it('writes only reversible runner-local actions and quarantine evidence', async () => {
    const files = tempFiles({ history: `${JSON.stringify(historyRow())}\nnot-json\n`, outcome: null });
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      apply: true,
      logger: { log() {} },
    });
    expect(result.actionsWritten).toBe(true);
    expect(result.quarantineWritten).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l6-actions.json'), 'utf8'))).toMatchObject({
      appliesToPublishedContent: false,
    });
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l6-quarantine.json'), 'utf8')).publishedContentUntouched).toBe(true);
  });

  it('derives candidate autonomy from the loop registry', async () => {
    const files = tempFiles({ outcome: null });
    const registryPath = path.join(files.dir, 'loop-registry.json');
    const registry = JSON.parse(fs.readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
    registry.actionAutonomy.candidate = 'A2';
    fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      registryPath,
      reportDir: files.reportDir,
      apply: true,
      logger: { log() {} },
    });
    expect(result.verdict.snapshot.registry).toMatchObject({ requiredAutonomy: 'A2' });
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l6-actions.json'), 'utf8')).actions[0]).toMatchObject({
      actionClass: 'candidate',
      autonomy: 'A2',
    });
  });

  it('fails closed when the registry disallows the emitted composite action', async () => {
    const files = tempFiles({ outcome: null });
    const registryPath = path.join(files.dir, 'loop-registry.json');
    const registry = JSON.parse(fs.readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
    const l6 = registry.loops.find((loop: { loopId: string }) => loop.loopId === 'L6');
    l6.actionClasses = l6.actionClasses.filter((actionClass: string) => actionClass !== 'quarantine');
    fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      registryPath,
      reportDir: files.reportDir,
      apply: true,
      logger: { log() {} },
    });
    expect(result.verdict).toMatchObject({ ok: false, quality: 'unmeasurable' });
    expect(result.actionsWritten).toBe(false);
    expect(result.verdict.reason).toContain('quarantine');
  });

  it('persists a separate result after issue creation succeeds', async () => {
    const files = tempFiles({ outcome: null });
    const result = await runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => ({ persisted: true }),
      logger: { log() {} },
    });
    expect(result.issued).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(files.reportDir, 'l6-result.json'), 'utf8'))).toMatchObject({
      loopId: 'L6',
      issued: true,
      actionsWritten: false,
    });
  });

  it('does not claim persistence when the issue writer returns persisted false', async () => {
    const files = tempFiles({ outcome: null });
    await expect(runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => ({ persisted: false }),
      logger: { log() {} },
    })).rejects.toThrow('issue persistence failed');
    expect(fs.existsSync(path.join(files.reportDir, 'l6-result.json'))).toBe(false);
  });

  it('does not claim persistence when issue creation fails', async () => {
    const files = tempFiles({ outcome: null });
    await expect(runL6({
      now: NOW,
      historyPath: files.historyPath,
      outcomePath: files.outcomePath,
      reportDir: files.reportDir,
      issue: true,
      createIssueImpl: async () => { throw new Error('issue API unavailable'); },
      logger: { log() {} },
    })).rejects.toThrow('issue API unavailable');
    expect(fs.existsSync(path.join(files.reportDir, 'l6-result.json'))).toBe(false);
  });

  it('rejects inconsistent external verification counts', () => {
    const verdict = validateContentFactuality({
      historyText: historyText(historyRow()),
      outcomes: outcomes({ externallyVerifiedDefects: 13 }),
    }, { now: NOW });
    expect(verdict).toMatchObject({ ok: false, quality: 'partial' });
    expect(verdict.reason).toContain('externallyVerifiedDefects exceeds confirmedDefects');
  });
});
