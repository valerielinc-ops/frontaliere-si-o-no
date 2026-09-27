// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertCrawlerSliceWriteSafe,
  isSafeSwissReForeignPrune,
} from '../scripts/lib/crawler-slice-integrity.mjs';
import { writeJsonAtomic } from '../scripts/lib/atomic-write-json.mjs';

function swissReJob(url: string, location: string, description: string) {
  return {
    url,
    companyKey: 'swiss-re',
    location,
    description,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('crawler slice integrity guard', () => {
  it('proves the Swiss Re foreign-listing prune without weakening other paths', () => {
    const previous = json([
      swissReJob('https://jobs.swissre.com/bratislava', 'Bratislava, SK', 'x'.repeat(700_000)),
      swissReJob('https://jobs.swissre.com/mexico-city', 'Mexico City, MX', 'x'.repeat(700_000)),
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(true);
    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/other.json', previous, next)).toBe(false);
    expect(assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next).reason)
      .toBe('swiss-re-foreign-prune');
  });

  it('keeps a same-source Swiss job loss fail-closed', () => {
    const previous = json([
      swissReJob('https://jobs.swissre.com/zurich-1', 'Zurich, CH', 'x'.repeat(700_000)),
      swissReJob('https://jobs.swissre.com/zurich-2', 'Zurich, CH', 'x'.repeat(700_000)),
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich-1', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
  });

  it('keeps an ambiguous Swiss locality fail-closed like the incident payload', () => {
    const previous = json([
      swissReJob('https://jobs.swissre.com/bratislava', 'Bratislava, SK', 'x'.repeat(700_000)),
      {
        ...swissReJob('https://jobs.swissre.com/zurich-old', 'Zürich', 'x'.repeat(700_000)),
        country: 'CH',
        addressCountry: 'CH',
        canton: 'ZH',
      },
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
  });

  it('blocks the destructive write before the atomic rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'crawler-slice-integrity-'));
    const filePath = join(root, 'data/jobs/by-crawler/swiss-re.json');
    const previous = [
      swissReJob('https://jobs.swissre.com/zurich-1', 'Zurich, CH', 'x'.repeat(700_000)),
      swissReJob('https://jobs.swissre.com/zurich-2', 'Zurich, CH', 'x'.repeat(700_000)),
    ];
    try {
      writeJsonAtomic(filePath, { crawlerKey: 'swiss-re', jobs: previous });
      expect(() => writeJsonAtomic(filePath, {
        crawlerKey: 'swiss-re',
        jobs: [swissReJob('https://jobs.swissre.com/zurich-1', 'Zurich, CH', 'x'.repeat(100_000))],
      })).toThrow(/catastrophic truncation avoided/);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).jobs).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
