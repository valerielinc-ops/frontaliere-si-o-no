// @vitest-environment node
/**
 * Coverage for the crawler-discovery gap fixed in issue #3797:
 * `listCrawlerSlugs()` used to read only `data/jobs/by-crawler/*.json`, and
 * `inspectCrawler()` returned null (causing the caller to skip the crawler
 * entirely) whenever that shard file was missing. A crawler that only ever
 * writes the summary slice (`data/jobs-crawler-summaries/by-crawler/*.json`
 * — e.g. every run exits early with `earlyExit: true`, never producing an
 * active-jobs shard) was therefore invisible to the health monitor even
 * though the "safety net" is exactly meant to catch persistent failures
 * like this.
 *
 * `node:fs`'s `promises.readdir`/`readFile`/`stat` are mocked so the tests
 * don't depend on real repo data (same technique as
 * tests/error-issue-sync.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const readdir = vi.fn();
const readFile = vi.fn();
const stat = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: (...args: unknown[]) => readdir(...args),
      readFile: (...args: unknown[]) => readFile(...args),
      stat: (...args: unknown[]) => stat(...args),
    },
  };
});

const { listCrawlerSlugs, inspectCrawler } = await import(
  '../../scripts/check-crawler-health.mjs'
);

function enoent() {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

const isSummaryDir = (dir: unknown) =>
  String(dir).includes('jobs-crawler-summaries');
const isByCrawlerDir = (dir: unknown) =>
  String(dir).includes('by-crawler') && !isSummaryDir(dir);

beforeEach(() => {
  readdir.mockReset();
  readFile.mockReset();
  stat.mockReset();
});

describe('listCrawlerSlugs', () => {
  it('discovers a slug that only exists in the summaries dir, not by-crawler', async () => {
    readdir.mockImplementation(async (dir: string) => {
      if (isSummaryDir(dir)) return ['omega.json', 'gavi.json'];
      if (isByCrawlerDir(dir)) return ['gavi.json'];
      throw enoent();
    });

    const slugs = await listCrawlerSlugs();

    // 'omega' never produced a by-crawler shard, but IS discovered via the
    // summaries dir. 'gavi' exists in both and is deduped, not doubled.
    expect(slugs).toContain('omega');
    expect(slugs.filter((s: string) => s === 'gavi')).toHaveLength(1);
  });

  it('still works when the by-crawler dir cannot be read at all', async () => {
    readdir.mockImplementation(async (dir: string) => {
      if (isSummaryDir(dir)) return ['omega.json'];
      throw enoent();
    });

    const slugs = await listCrawlerSlugs();
    expect(slugs).toEqual(['omega']);
  });
});

describe('inspectCrawler', () => {
  it('tracks a crawler via the summary alone when the by-crawler shard was never written', async () => {
    readFile.mockImplementation(async (file: string) => {
      if (isSummaryDir(file)) {
        return JSON.stringify({
          generatedAt: '2026-07-08T04:00:00.000Z',
          total: 0,
          earlyExit: true,
          exitCode: 0,
        });
      }
      throw enoent(); // by-crawler shard: never produced
    });
    stat.mockRejectedValue(enoent());

    const observation = await inspectCrawler('omega');

    // Before the fix this returned null and the caller skipped the crawler
    // entirely (`if (!observation) continue;`).
    expect(observation).not.toBeNull();
    expect(observation.slug).toBe('omega');
    expect(observation.freshnessSource).toBe('summary');
    expect(observation.freshnessAt).toBe('2026-07-08T04:00:00.000Z');
    expect(observation.jobCount).toBe(0);
    expect(observation.activeJobCount).toBe(0);
  });
});
