import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonStreaming } from '../../scripts/seo/bing-site-explorer-report.mjs';

// Observer for the full-tree report artifact. Run 36996732377 died with
// `RangeError: Invalid string length` inside `JSON.stringify(summary, null, 2)`
// and, because the summary was written first, the issue body file was never
// created: the backlog issue got "_no details provided_". These tests fail if
// the summary is serialized as one string again or written before the body.

const BASE = 'https://frontaliereticino.ch';
const REPORT_SCRIPT = fileURLToPath(new URL('../../scripts/seo/bing-site-explorer-report.mjs', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bing-report-artifact-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function largeSummary(findingCount: number, urlCount: number) {
  const findings = Array.from({ length: findingCount }, (_, index) => ({
    code: index % 2 === 0 ? 'meta-description-too-short' : 'title-too-long',
    url: `${BASE}/en/find-jobs-ticino/job-${index}/`,
    root: '/en/',
    status: 200,
    detail: `lunghezza ${index % 120}`,
  }));
  return {
    schemaVersion: 1,
    checkedAt: '2026-10-02T10:40:00.000Z',
    baseUrl: BASE,
    coverageOk: false,
    coverageErrors: ['frontiera interna: partizione mancante: 3'],
    statusCounts: { 200: urlCount, 404: 0 },
    codeCounts: { 'meta-description-too-short': findingCount / 2, 'title-too-long': findingCount / 2 },
    folderStats: { '/en/': { checked: urlCount, statuses: { 200: urlCount }, findings: { 'title-too-long': 1 } } },
    findings,
    actionableFindings: findings,
    actionableCount: findings.length,
    discoveredOutOfSitemap: Array.from({ length: urlCount }, (_, index) => `${BASE}/de/jobs-im-tessin/stelle-${index}/`),
    discoveredOutOfSitemapCount: urlCount,
    unverifiedOutOfSitemap: [],
    unverifiedOutOfSitemapCount: 0,
    unverifiedOutOfSitemapByReason: {},
    excludedDiscoveryCounts: { 'query-string': 2 },
    excludedDiscoverySamples: { 'query-string': [`${BASE}/?a=1`, `${BASE}/?b=2`] },
    transientRescue: null,
    emptyObject: {},
  };
}

function mainSource(): string {
  const source = readFileSync(REPORT_SCRIPT, 'utf8');
  const start = source.indexOf('async function main()');
  const end = source.indexOf('const invokedDirectly', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Bing full-tree report artifact writer', () => {
  it('round-trips a small summary with the same keys and values', () => {
    const summary = largeSummary(4, 3);
    const file = join(tempDir(), 'nested', 'summary.json');
    writeJsonStreaming(file, summary);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(Object.keys(parsed)).toEqual(Object.keys(summary));
  });

  it('round-trips a summary with 25,000 findings and 120,000 out-of-sitemap URLs', () => {
    const summary = largeSummary(25_000, 120_000);
    const file = join(tempDir(), 'summary.json');
    writeJsonStreaming(file, summary);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.findings).toHaveLength(summary.findings.length);
    expect(parsed.discoveredOutOfSitemap).toHaveLength(summary.discoveredOutOfSitemap.length);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(summary)));
  });

  it('never hands the file system a piece larger than chunkChars plus one line', () => {
    const summary = largeSummary(25_000, 120_000);
    const file = join(tempDir(), 'summary.json');
    const chunkChars = 50_000;
    const chunks: number[] = [];
    writeJsonStreaming(file, summary, { chunkChars, onChunk: (length: number) => chunks.push(length) });
    const written = readFileSync(file, 'utf8');
    const longestLine = Math.max(...written.split('\n').map((line) => line.length));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((sum, length) => sum + length, 0)).toBe(written.length);
    // "+ 2" covers the separator (",\n") that precedes each line.
    expect(Math.max(...chunks)).toBeLessThanOrEqual(chunkChars + longestLine + 2);
    expect(written.length).toBeGreaterThan(chunkChars * 10);
  });

  it('writes the issue body before the summary and the summary without one big string (source contract)', () => {
    const main = mainSource();
    const issueBodyAt = main.indexOf('writeFileSync(resolve(issueBodyPath)');
    const summaryAt = main.indexOf('writeJsonStreaming(output');
    expect(issueBodyAt).toBeGreaterThanOrEqual(0);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(issueBodyAt).toBeLessThan(summaryAt);
    expect(main).not.toContain('writeJson(output');
    expect(main).not.toMatch(/JSON\.stringify\(summary\b/);
  });

  it('keeps the issue body when the summary cannot be written (CLI)', () => {
    const dir = tempDir();
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir);
    writeFileSync(join(reportsDir, 'partition-0.json'), JSON.stringify({
      schemaVersion: 1,
      baseUrl: BASE,
      manifestCount: 1,
      partition: 0,
      partitions: 1,
      partitionTotal: 1,
      checkedCount: 1,
      codeCounts: { 'title-too-long': 1 },
      statusCounts: { 200: 1 },
      folderStats: { '/': { checked: 1, statuses: { 200: 1 }, findings: { 'title-too-long': 1 } } },
      findings: [{ code: 'title-too-long', url: `${BASE}/`, root: '/', status: 200, detail: 'titolo lungo' }],
      discoveredOutOfSitemap: [`${BASE}/fuori-sitemap/`],
    }));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifestCount: 1, sitemapCount: 1, baseUrl: BASE, urls: [`${BASE}/`] }));
    // An existing directory as --out makes the summary write fail, standing in
    // for the RangeError seen in production.
    const blockedOut = join(dir, 'summary-is-a-directory');
    mkdirSync(blockedOut);
    const issueBody = join(dir, 'issue.md');
    const result = spawnSync(process.execPath, [
      REPORT_SCRIPT,
      '--reports-dir', reportsDir,
      '--manifest', join(dir, 'manifest.json'),
      '--out', blockedOut,
      '--issue-body', issueBody,
    ], { encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '' } });
    expect(result.status).not.toBe(0);
    expect(existsSync(issueBody)).toBe(true);
    const body = readFileSync(issueBody, 'utf8');
    expect(body).toContain('## Bing-compatible full-tree crawl');
    expect(body).toContain('title-too-long');

    const okOut = join(dir, 'summary.json');
    const ok = spawnSync(process.execPath, [
      REPORT_SCRIPT,
      '--reports-dir', reportsDir,
      '--manifest', join(dir, 'manifest.json'),
      '--out', okOut,
      '--issue-body', issueBody,
    ], { encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '' } });
    // Exit code 1 is the workflow's "findings present" signal and must survive.
    expect(ok.status).toBe(1);
    const summary = JSON.parse(readFileSync(okOut, 'utf8'));
    expect(summary.actionableCount).toBe(summary.actionableFindings.length);
    expect(summary.discoveredOutOfSitemap).toEqual([`${BASE}/fuori-sitemap/`]);
  });
});
