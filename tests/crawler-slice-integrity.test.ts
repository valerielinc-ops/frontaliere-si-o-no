// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertCrawlerSliceWriteSafe,
  isProvenCrossCrawlerDedupPrune,
  isProvenHousekeepingPrune,
  isSafeBuehlerForeignPruneJobs,
  isSafeSourceGeographyPrune,
  isSafeSwissReForeignPrune,
  isSafeSwissReForeignPruneJobs,
} from '../scripts/lib/crawler-slice-integrity.mjs';
import { CRAWLER_GRACE_PERIOD_MAX_MISSES } from '../scripts/lib/crawler-grace-policy.mjs';
import { writeJsonAtomic } from '../scripts/lib/atomic-write-json.mjs';

function sha256(raw: string) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function swissReJob(url: string, location: string, description: string) {
  return {
    url,
    companyKey: 'swiss-re',
    location,
    description,
  };
}

function buehlerJob(url: string, location: string, crawlerMissStreak?: number, description = 'x'.repeat(700_000)) {
  return {
    url,
    companyKey: 'buehler',
    company: 'Bühler Group',
    source: 'Bühler Group Dedicated Parser (Prospective medium 1008005)',
    location,
    canton: 'SG',
    addressRegion: 'SG',
    country: 'CH',
    addressCountry: 'CH',
    ...(crawlerMissStreak === undefined ? {} : { crawlerMissStreak }),
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

  it('allows the observed legacy Swiss Re HQ-fallback rows during the source-geography migration', () => {
    const legacyMetadata = {
      companyKey: 'swiss-re',
      source: 'Swiss Re Dedicated Parser',
      addressCountry: 'CH',
      country: 'CH',
      canton: 'ZH',
      addressRegion: 'ZH',
    };
    const previous = [
      {
        ...swissReJob('https://jobs.swissre.com/zurich-legacy', 'Zürich', 'x'.repeat(700_000)),
        ...legacyMetadata,
      },
      {
        ...swissReJob('https://jobs.swissre.com/washington-legacy', 'Washington D', 'y'.repeat(700_000)),
        ...legacyMetadata,
      },
      swissReJob('https://jobs.swissre.com/bratislava', 'Bratislava, SK', 'z'.repeat(700_000)),
    ];
    const nextJobs = [swissReJob('https://jobs.swissre.com/zurich', 'Zurich, CH', 'x'.repeat(100_000))];
    const next = json(nextJobs);

    expect(isSafeSwissReForeignPruneJobs('data/jobs/by-crawler/swiss-re.json', previous, nextJobs)).toBe(true);
    expect(isSafeSwissReForeignPrune('data/jobs/by-crawler/swiss-re.json', json(previous), next)).toBe(true);
    expect(assertCrawlerSliceWriteSafe('data/jobs/by-crawler/swiss-re.json', json(previous), next).reason)
      .toBe('swiss-re-foreign-prune');
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

  it('proves the Bühler source-geography migration after legacy miss grace', () => {
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/foreign-1', 'Plymouth', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/foreign-2', 'Wuxi', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil-expired', 'Uzwil', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil', undefined, 'Swiss job'),
      ],
    });
    const next = json({
      crawlerKey: 'buehler',
      jobs: [buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil', undefined, 'Swiss job')],
    });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(true);
    expect(isSafeSourceGeographyPrune('data/jobs/by-crawler/buehler.json', previous, next)).toBe(true);
    expect(assertCrawlerSliceWriteSafe('data/jobs/by-crawler/buehler.json', previous, next).reason)
      .toBe('buehler-foreign-prune');
  });

  it('rejects an unknown legacy locality instead of treating it as foreign', () => {
    const retained = buehlerJob(
      'https://jobs.buhlergroup.com/job-vacancies/uzwil',
      'Uzwil',
      undefined,
      'y'.repeat(100_000),
    );
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob(
          'https://jobs.buhlergroup.com/job-vacancies/unknown-swiss-locality',
          'Nuova località svizzera',
          CRAWLER_GRACE_PERIOD_MAX_MISSES,
          'x'.repeat(1_400_000),
        ),
        retained,
      ],
    });
    const next = json({
      crawlerKey: 'buehler',
      jobs: [retained],
    });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/buehler.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
  });

  it('accepts an explicit non-CH country code as positive foreign evidence', () => {
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/munich', 'Munich, DE', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil'),
      ],
    });
    const next = json({
      crawlerKey: 'buehler',
      jobs: [buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil')],
    });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(true);
  });

  it('rejects a removed legacy Bühler row with a non-integer miss streak', () => {
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob(
          'https://jobs.buhlergroup.com/job-vacancies/foreign-fractional',
          'Plymouth',
          CRAWLER_GRACE_PERIOD_MAX_MISSES + 0.5,
        ),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil'),
      ],
    });
    const next = json({
      crawlerKey: 'buehler',
      jobs: [buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil')],
    });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(false);
  });

  it('rejects a retained Swiss Bühler row without source provenance', () => {
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/foreign', 'Plymouth', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil'),
      ],
    });
    const sourceLessNextJob = buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil');
    Reflect.deleteProperty(sourceLessNextJob, 'source');
    const next = json({ crawlerKey: 'buehler', jobs: [sourceLessNextJob] });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(false);
  });

  it('keeps the Bühler shrink guarded when the migration proof is incomplete', () => {
    const previous = json({
      crawlerKey: 'buehler',
      jobs: [
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/foreign', 'Plymouth', CRAWLER_GRACE_PERIOD_MAX_MISSES - 1),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil-old', 'Uzwil', CRAWLER_GRACE_PERIOD_MAX_MISSES),
        buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil', undefined, 'Swiss job'),
      ],
    });
    const next = json({
      crawlerKey: 'buehler',
      jobs: [buehlerJob('https://jobs.buhlergroup.com/job-vacancies/uzwil', 'Uzwil', undefined, 'Swiss job')],
    });

    expect(isSafeBuehlerForeignPruneJobs(
      'data/jobs/by-crawler/buehler.json',
      JSON.parse(previous).jobs,
      JSON.parse(next).jobs,
    )).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe('data/jobs/by-crawler/buehler.json', previous, next))
      .toThrow(/catastrophic truncation avoided/);
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

  it('allows a large shrink only when every removed job has definitive housekeeping evidence', () => {
    const removedA = dedupJob('https://convit.example/a', 'Closed A', 'x'.repeat(700_000));
    const removedB = dedupJob('https://convit.example/b', 'Closed B', 'y'.repeat(700_000));
    const retained = dedupJob('https://convit.example/retained', 'Open position', 'z'.repeat(100_000));
    const previous = json({ crawlerKey: 'convit-holding', jobs: [removedA, removedB, retained] });
    const next = json({ crawlerKey: 'convit-holding', jobs: [retained] });
    const proof = [
      { job: removedA, definitive: true, reason: 'http-404' },
      { job: removedB, definitive: true, reason: 'redirect-to-generic-listing' },
    ];

    expect(isProvenHousekeepingPrune('data/jobs/by-crawler/convit-holding.json', previous, next, proof)).toBe(true);
    expect(() => assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
    )).toThrow(/catastrophic truncation avoided/);
    expect(assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      { housekeepingProof: proof },
    ).reason).toBe('proven-housekeeping-prune');

    const root = mkdtempSync(join(tmpdir(), 'crawler-slice-housekeeping-'));
    const filePath = join(root, 'data/jobs/by-crawler/convit-holding.json');
    try {
      writeJsonAtomic(filePath, JSON.parse(previous));
      expect(() => writeJsonAtomic(filePath, JSON.parse(next), { housekeepingProof: proof })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a housekeeping shrink guarded when any removal is non-definitive', () => {
    const removed = dedupJob('https://convit.example/ambiguous', 'Ambiguous position', 'x'.repeat(1_400_000));
    const retained = dedupJob('https://convit.example/retained', 'Open position', 'y'.repeat(100_000));
    const previous = json({ crawlerKey: 'convit-holding', jobs: [removed, retained] });
    const next = json({ crawlerKey: 'convit-holding', jobs: [retained] });

    expect(isProvenHousekeepingPrune(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      [{ job: removed, definitive: false, reason: 'network-error' }],
    )).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      { housekeepingProof: [{ job: removed, definitive: false }] },
    )).toThrow(/catastrophic truncation avoided/);
  });

  it('rejects an ID-only housekeeping proof without URL evidence', () => {
    const previous = json({ crawlerKey: 'convit-holding', jobs: [{ id: 'a', description: 'x'.repeat(1_400_000) }] });
    const next = json({ crawlerKey: 'convit-holding', jobs: [] });
    const proof = [{ job: { id: 'a' }, definitive: true }];

    expect(isProvenHousekeepingPrune(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      proof,
    )).toBe(false);
    expect(() => assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      { housekeepingProof: proof },
    )).toThrow(/catastrophic truncation avoided/);
  });

  it.each([{}, 404])('rejects non-string housekeeping URL evidence: %j', (url) => {
    const previous = json({ crawlerKey: 'convit-holding', jobs: [{ id: 'malformed', url, description: 'x'.repeat(1_400_000) }] });
    const next = json({ crawlerKey: 'convit-holding', jobs: [] });
    const proof = [{ job: { id: 'malformed', url }, definitive: true }];

    expect(isProvenHousekeepingPrune(
      'data/jobs/by-crawler/convit-holding.json',
      previous,
      next,
      proof,
    )).toBe(false);
  });

  it('loads only a path-bound housekeeping proof at the commit-helper CLI boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'crawler-slice-proof-cli-'));
    const removed = dedupJob('https://convit.example/cli-removed', 'Closed CLI', 'x'.repeat(1_400_000));
    const retained = dedupJob('https://convit.example/cli-retained', 'Open CLI', 'y'.repeat(100_000));
    const previous = json({ crawlerKey: 'convit-holding', jobs: [removed, retained] });
    const next = json({ crawlerKey: 'convit-holding', jobs: [retained] });
    const filePath = 'data/jobs/by-crawler/convit-holding.json';
    const previousPath = join(root, 'previous.json');
    const nextPath = join(root, 'next.json');
    const proofPath = join(root, 'proof.json');
    const basePath = join(root, 'base.json');
    const candidatePath = join(root, 'candidate.json');
    const cliPath = resolve(import.meta.dirname, '../scripts/lib/crawler-slice-integrity.mjs');
    try {
      writeFileSync(previousPath, previous);
      writeFileSync(nextPath, next);
      writeFileSync(basePath, previous);
      writeFileSync(candidatePath, next);
      writeFileSync(proofPath, `${JSON.stringify({
        schemaVersion: 2,
        path: filePath,
        baseDigest: sha256(previous),
        candidateDigest: sha256(next),
        baseSha: 'proof-base-sha',
        runId: 'proof-cli-run',
        runAttempt: '1',
        entries: [{ job: removed, definitive: true, reason: 'http-404' }],
      })}\n`);

      const output = execFileSync(process.execPath, [
        cliPath,
        filePath,
        previousPath,
        nextPath,
        proofPath,
        basePath,
        candidatePath,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_RUN_ID: 'proof-cli-run',
          GITHUB_RUN_ATTEMPT: '1',
          HOUSEKEEPING_BASE_SHA: 'proof-base-sha',
        },
      });
      expect(output).toContain('allowed proven-housekeeping-prune');

      writeFileSync(basePath, json({
        crawlerKey: 'convit-holding',
        jobs: [removed, { ...retained, title: 'new snapshot' }],
      }));
      const stale = spawnSync(process.execPath, [
        cliPath,
        filePath,
        previousPath,
        nextPath,
        proofPath,
        basePath,
        candidatePath,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_RUN_ID: 'proof-cli-run',
          GITHUB_RUN_ATTEMPT: '1',
          HOUSEKEEPING_BASE_SHA: 'proof-base-sha',
        },
      });
      expect(stale.status).toBe(1);
      expect(`${stale.stdout}${stale.stderr}`).toContain('stale housekeeping proof');
      expect(stale.stdout).not.toContain('allowed proven-housekeeping-prune');

      // Restore the valid base snapshot so the following case isolates the
      // missing sidecar metadata rather than failing on an unrelated digest.
      writeFileSync(basePath, previous);
      writeFileSync(proofPath, `${JSON.stringify({
        schemaVersion: 2,
        path: filePath,
        baseDigest: sha256(previous),
        candidateDigest: sha256(next),
        baseSha: null,
        runId: null,
        runAttempt: null,
        entries: [{ job: removed, definitive: true, reason: 'http-404' }],
      })}\n`);
      const missingMetadata = spawnSync(process.execPath, [
        cliPath,
        filePath,
        previousPath,
        nextPath,
        proofPath,
        basePath,
        candidatePath,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_RUN_ID: 'proof-cli-run',
          GITHUB_RUN_ATTEMPT: '1',
          HOUSEKEEPING_BASE_SHA: 'proof-base-sha',
        },
      });
      expect(missingMetadata.status).toBe(1);
      expect(`${missingMetadata.stdout}${missingMetadata.stderr}`).toContain(
        'missing required run metadata',
      );
      expect(missingMetadata.stdout).not.toContain('allowed proven-housekeeping-prune');

      writeFileSync(proofPath, `${JSON.stringify({
        schemaVersion: 2,
        path: 'data/jobs/by-crawler/other.json',
        baseDigest: sha256(previous),
        candidateDigest: sha256(next),
        entries: [{ job: removed, definitive: true, reason: 'http-404' }],
      })}\n`);
      expect(() => execFileSync(process.execPath, [
        cliPath,
        filePath,
        previousPath,
        nextPath,
        proofPath,
        basePath,
        candidatePath,
      ], { encoding: 'utf8' })).toThrow(/path-mismatched housekeeping proof/);
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

  it('allows a fully pruned slice when every removed job is proven duplicated elsewhere', () => {
    const duplicate = dedupJob('https://buehler.example/duplicate', 'Engineer', 'x'.repeat(1_400_000));
    const previous = json({ crawlerKey: 'buehler', jobs: [duplicate] });
    const next = json({ crawlerKey: 'buehler', jobs: [] });
    const reference = [
      dedupJob('https://other-crawler.example/engineer', 'Engineer', 'kept elsewhere'),
    ];

    expect(isProvenCrossCrawlerDedupPrune('data/jobs/by-crawler/buehler.json', previous, next, reference)).toBe(true);
    expect(assertCrawlerSliceWriteSafe(
      'data/jobs/by-crawler/buehler.json',
      previous,
      next,
      { dedupReferenceJobs: reference },
    ).reason).toBe('proven-cross-crawler-dedup');
  });
});
