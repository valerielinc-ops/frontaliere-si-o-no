// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertCrawlerSliceWriteSafe,
  isProvenCrossCrawlerDedupPrune,
  isSafeSwissReForeignPrune,
} from '../scripts/lib/crawler-slice-integrity.mjs';
import { CRAWLER_GRACE_PERIOD_MAX_MISSES } from '../scripts/lib/crawler-grace-policy.mjs';
import { writeJsonAtomic } from '../scripts/lib/atomic-write-json.mjs';

function swissReJob(url: string, location: string, description: string) {
  return {
    url,
    companyKey: 'swiss-re',
    location,
    description,
  };
}

function dedupJob(url: string, title: string, description: string) {
  return {
    url,
    title,
    company: 'Bühler Group',
    location: 'Uzwil, SG',
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

  it('allows grace-exhausted legacy locations in the Swiss Re migration', () => {
    const previous = json([
      {
        ...swissReJob('https://jobs.swissre.com/legacy-zurich', 'Zürich', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES,
      },
      {
        ...swissReJob('https://jobs.swissre.com/legacy-washington', 'Washington D', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES,
      },
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(true);
    expect(assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next).reason)
      .toBe('swiss-re-foreign-prune');
  });

  it('allows a mixed-streak Swiss Re prune while retaining the survivor in grace', () => {
    const previous = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zürich, CH', 'x'.repeat(100_000)),
      {
        ...swissReJob('https://jobs.swissre.com/legacy-drop', 'Zürich-HQ', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES,
      },
      {
        ...swissReJob('https://jobs.swissre.com/legacy-keep', 'Zürich-HQ', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES - 1,
      },
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zürich, CH', 'x'.repeat(100_000)),
      {
        ...swissReJob('https://jobs.swissre.com/legacy-keep', 'Zürich-HQ', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES,
      },
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(true);
  });

  it('does not waive the guard for an explicit Swiss record even after grace', () => {
    const previous = json([
      {
        ...swissReJob('https://jobs.swissre.com/zurich-old', 'Zurich, CH', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES,
      },
      swissReJob('https://jobs.swissre.com/bratislava', 'Bratislava, SK', 'x'.repeat(700_000)),
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
  });

  it('keeps an ambiguous legacy location guarded before grace is exhausted', () => {
    const previous = json([
      {
        ...swissReJob('https://jobs.swissre.com/legacy-zurich', 'Zürich', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES - 1,
      },
      {
        ...swissReJob('https://jobs.swissre.com/legacy-washington', 'Washington D', 'x'.repeat(700_000)),
        crawlerMissStreak: CRAWLER_GRACE_PERIOD_MAX_MISSES - 1,
      },
    ]);
    const next = json([
      swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000)),
    ]);

    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', previous, next)).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
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
        ...swissReJob('https://jobs.swissre.com/zurich-old', 'Zürich, ZH', 'x'.repeat(700_000)),
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

  it('allows a large shrink only when the assembled reference proves cross-crawler duplicates', () => {
    const duplicateA = dedupJob('https://buehler.example/a', 'Engineer', 'x'.repeat(700_000));
    const duplicateB = dedupJob('https://buehler.example/b', 'Engineer', 'y'.repeat(700_000));
    const retained = dedupJob('https://buehler.example/retained', 'Designer', 'z'.repeat(100_000));
    const previous = json({ crawlerKey: 'buehler', jobs: [duplicateA, duplicateB, retained] });
    const next = json({ crawlerKey: 'buehler', jobs: [retained] });
    const reference = [
      dedupJob('https://other-crawler.example/engineer', 'Engineer', 'kept elsewhere'),
      retained,
    ];

    expect(isProvenCrossCrawlerDedupPrune('data/jobs/by-crawler/buehler.json', previous, next, reference)).toBe(true);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/buehler.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
    expect(assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/buehler.json',
      previous,
      next,
      { dedupReferenceJobs: reference },
    ).reason).toBe('proven-cross-crawler-dedup');

    const root = mkdtempSync(join(tmpdir(), 'crawler-slice-dedup-'));
    const filePath = join(root, 'data/jobs/by-crawler/buehler.json');
    try {
      writeJsonAtomic(filePath, JSON.parse(previous));
      expect(() => writeJsonAtomic(filePath, JSON.parse(next), { dedupReferenceJobs: reference })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an unreferenced large removal fail-closed', () => {
    const removed = dedupJob('https://buehler.example/lost', 'Unique position', 'x'.repeat(1_400_000));
    const retained = dedupJob('https://buehler.example/kept', 'Kept position', 'y'.repeat(100_000));
    const previous = json({ crawlerKey: 'buehler', jobs: [removed, retained] });
    const next = json({ crawlerKey: 'buehler', jobs: [retained] });
    expect(isProvenCrossCrawlerDedupPrune(
      'data/jobs/by-crawler/buehler.json',
      previous,
      next,
      [retained],
    )).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/buehler.json',
      previous,
      next,
      { dedupReferenceJobs: [retained] },
    )).toThrow(/catastrophic truncation avoided/);
  });
});
