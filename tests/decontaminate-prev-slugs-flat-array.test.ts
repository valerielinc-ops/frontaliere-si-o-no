import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stableSlugHash } from '../scripts/lib/dedicated-crawler-common.mjs';

// Reproduces the review finding on this PR: a slug present ONLY in a job's
// flat `previousSlugs` array (never mirrored into `previousSlugsByLocale`)
// that resolves to a different current job was being dropped by the flat-
// array filter instead of moved there — silent data loss, contradicting the
// script's own "never drop, only redirect" contract (see resolveRecoveryTarget
// in backfill-prev-slugs-from-loss-events.mjs).
describe('decontaminate-prev-slugs: flat previousSlugs redirect', () => {
  it('moves a redirected flat-array slug onto its real target job instead of dropping it', async () => {
    process.argv.push('--apply');
    const { processFile } = await import('../scripts/decontaminate-prev-slugs.mjs');

    const zurich = {
      id: 'company-telail',
      url: 'https://www.coopjobs.ch/offene-stellen/it/11111111-1111-1111-1111-111111111111',
    };
    const basel = {
      id: 'company-vn6yz4',
      url: 'https://www.coopjobs.ch/offene-stellen/it/22222222-2222-2222-2222-222222222222',
    };
    const baselSlug = `verkaufer-in-food-coop-basel-stadt-${stableSlugHash(basel)}`;
    zurich.previousSlugs = [baselSlug];
    basel.previousSlugs = [];

    const tmpFile = path.join(os.tmpdir(), `decontaminate-flat-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [zurich, basel] }));

    try {
      const result = processFile(tmpFile);
      expect(result?.moved).toBe(1);

      const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      const writtenZurich = written.jobs.find((job: { id: string }) => job.id === 'company-telail');
      const writtenBasel = written.jobs.find((job: { id: string }) => job.id === 'company-vn6yz4');

      expect(writtenZurich.previousSlugs).not.toContain(baselSlug);
      expect(writtenBasel.previousSlugs).toContain(baselSlug);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('prunes empty locale buckets while preserving route ownership and is idempotent', async () => {
    process.argv.push('--apply');
    const { processFile } = await import('../scripts/decontaminate-prev-slugs.mjs');

    const claimant = {
      id: 'company-claimant',
      url: 'https://jobs.example.com/posting/claimant',
      previousSlugsByLocale: { en: [] as string[], de: [] as string[], fr: ['route-fr-storica'] },
      previousSlugs: [] as string[],
    };
    const owner = {
      id: 'company-owner',
      url: 'https://jobs.example.com/posting/owner',
      previousSlugsByLocale: { it: [] as string[] },
      previousSlugs: [] as string[],
    };
    const ownerSlug = `owner-route-storica-${stableSlugHash(owner)}`;
    claimant.previousSlugsByLocale.en.push(ownerSlug);
    claimant.previousSlugs.push(ownerSlug);

    const tmpFile = path.join(os.tmpdir(), `decontaminate-idempotent-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [claimant, owner] }));

    try {
      expect(processFile(tmpFile)).toEqual({ moved: 2, emptyLocaleBucketsPruned: 3 });

      const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      const writtenClaimant = written.jobs.find((job: { id: string }) => job.id === claimant.id);
      const writtenOwner = written.jobs.find((job: { id: string }) => job.id === owner.id);

      expect(writtenClaimant.previousSlugsByLocale).toEqual({ fr: ['route-fr-storica'] });
      expect(writtenClaimant.previousSlugs).not.toContain(ownerSlug);
      expect(writtenOwner.previousSlugsByLocale).toEqual({ en: [ownerSlug] });
      expect(writtenOwner.previousSlugs).toEqual([ownerSlug]);
      expect(processFile(tmpFile)).toBeNull();
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('routes a uniquely-owned slug across crawler slice files', async () => {
    const { processFiles } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-cross-file-'));
    const claimantFile = path.join(tmpDir, 'claimant.json');
    const ownerFile = path.join(tmpDir, 'owner.json');
    const claimant = {
      id: 'claimant',
      url: 'https://claimant.example/jobs/claimant',
      previousSlugs: [] as string[],
      previousSlugsByLocale: { it: [] as string[] },
    };
    const owner = {
      id: 'owner',
      url: 'https://owner.example/jobs/owner',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `owner-route-${stableSlugHash(owner)}`;
    claimant.previousSlugs.push(ownerSlug);
    claimant.previousSlugsByLocale.it.push(ownerSlug);
    fs.writeFileSync(claimantFile, JSON.stringify({ jobs: [claimant] }));
    fs.writeFileSync(ownerFile, JSON.stringify({ jobs: [owner] }));

    try {
      const result = processFiles([claimantFile, ownerFile], { apply: true });
      expect(result.moved).toBe(2);

      const writtenClaimant = JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0];
      const writtenOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).jobs[0];
      expect(writtenClaimant.previousSlugs).toEqual([]);
      expect(writtenClaimant.previousSlugsByLocale).toBeUndefined();
      expect(writtenOwner.previousSlugs).toEqual([ownerSlug]);
      expect(writtenOwner.previousSlugsByLocale).toEqual({ it: [ownerSlug] });
      expect(processFiles([claimantFile, ownerFile], { apply: true }).affected).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses the canonical slice predicate for a complete active-directory pass', async () => {
    const { decontaminateSliceDirectory } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-directory-'));
    const claimantFile = path.join(tmpDir, 'claimant.json');
    const ownerFile = path.join(tmpDir, 'owner.json');
    const scratchFile = path.join(tmpDir, 'owner.json.cleanup-tmp.json');
    const claimant = {
      id: 'directory-claimant',
      url: 'https://claimant.example/jobs/directory-claimant',
      previousSlugs: [] as string[],
    };
    const owner = {
      id: 'directory-owner',
      url: 'https://owner.example/jobs/directory-owner',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `directory-owner-route-${stableSlugHash(owner)}`;
    claimant.previousSlugs.push(ownerSlug);
    fs.writeFileSync(claimantFile, JSON.stringify({ jobs: [claimant] }));
    fs.writeFileSync(ownerFile, JSON.stringify({ jobs: [owner] }));
    fs.writeFileSync(scratchFile, JSON.stringify({ jobs: [{ previousSlugs: ['not-read'] }] }));

    try {
      expect(decontaminateSliceDirectory(tmpDir, { apply: true })).toMatchObject({ moved: 1 });
      expect(JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0].previousSlugs).toEqual([]);
      expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).jobs[0].previousSlugs).toEqual([ownerSlug]);
      expect(JSON.parse(fs.readFileSync(scratchFile, 'utf8')).jobs[0].previousSlugs).toEqual(['not-read']);
      expect(decontaminateSliceDirectory(tmpDir, { apply: false }).affected).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scans expired raw-array slices without changing their on-disk shape', async () => {
    const { listCrawlerSlicePaths, processFiles } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-expired-array-'));
    const activeDir = path.join(tmpDir, 'active');
    const expiredDir = path.join(tmpDir, 'expired', 'by-crawler');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(expiredDir, { recursive: true });

    const activeFile = path.join(activeDir, 'claimant.json');
    const expiredFile = path.join(expiredDir, 'owner.json');
    const owner = {
      id: 'expired-owner',
      url: 'https://owner.example/jobs/expired-owner',
      previousSlugs: [] as string[],
    };
    const claimant = {
      id: 'active-claimant',
      url: 'https://claimant.example/jobs/active-claimant',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `expired-owner-route-${stableSlugHash(owner)}`;
    claimant.previousSlugs.push(ownerSlug);
    fs.writeFileSync(activeFile, JSON.stringify({ crawlerKey: 'claimant', jobs: [claimant] }));
    fs.writeFileSync(expiredFile, JSON.stringify([owner]));

    try {
      expect(listCrawlerSlicePaths([activeDir, expiredDir])).toEqual([activeFile, expiredFile].sort());
      expect(processFiles([activeFile, expiredFile], { apply: true }).moved).toBe(1);

      const activePayload = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      const expiredPayload = JSON.parse(fs.readFileSync(expiredFile, 'utf8'));
      expect(Array.isArray(expiredPayload)).toBe(true);
      expect(activePayload.jobs[0].previousSlugs).not.toContain(ownerSlug);
      expect(expiredPayload[0].previousSlugs).toContain(ownerSlug);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes a fresh writer payload to a unique owner already present in the fleet', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-writer-fleet-'));
    const claimantFile = path.join(tmpDir, 'a-claimant.json');
    const ownerFile = path.join(tmpDir, 'z-owner.json');
    const owner = {
      id: 'owner',
      url: 'https://owner.example/jobs/owner',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `owner-route-${stableSlugHash(owner)}`;
    const claimant = {
      id: 'claimant',
      url: 'https://claimant.example/jobs/claimant',
      previousSlugs: [ownerSlug],
    };
    const claimantEntry = { filePath: claimantFile, slice: { jobs: [claimant] } };
    const ownerEntry = { filePath: ownerFile, slice: { jobs: [owner] } };
    const writes: Array<{ filePath: string; phase: string }> = [];

    try {
      const result = decontaminateEntries([claimantEntry, ownerEntry], {
        sourceEntries: [claimantEntry],
        apply: true,
        writeSlice: (filePath: string, slice: unknown, context: { phase: string }) => {
          writes.push({ filePath, phase: context.phase });
          fs.writeFileSync(filePath, JSON.stringify(slice));
        },
      });

      expect(result.moved).toBe(1);
      expect(writes).toEqual([
        { filePath: ownerFile, phase: 'cross-file-target' },
        { filePath: claimantFile, phase: 'final' },
      ]);
      expect(JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0].previousSlugs)
        .toEqual([]);
      expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).jobs[0].previousSlugs)
        .toEqual([ownerSlug]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not recreate an active target as a self-canonical bridge', async () => {
    const { processFiles } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-active-target-'));
    const claimantFile = path.join(tmpDir, 'a-claimant.json');
    const ownerFile = path.join(tmpDir, 'z-owner.json');
    const owner = {
      id: 'owner',
      url: 'https://owner.example/jobs/owner',
      slug: '',
      slugByLocale: {},
      previousSlugs: [],
    };
    const ownerSlug = `owner-route-${stableSlugHash(owner)}`;
    owner.slug = ownerSlug;
    owner.slugByLocale.en = ownerSlug;
    owner.previousSlugs = [ownerSlug];
    owner.previousSlugsByLocale = { en: [ownerSlug] };
    const claimant = {
      id: 'claimant',
      url: 'https://claimant.example/jobs/claimant',
      previousSlugs: [ownerSlug],
      previousSlugsByLocale: { en: [ownerSlug] },
    };
    fs.writeFileSync(claimantFile, JSON.stringify({ jobs: [claimant] }));
    fs.writeFileSync(ownerFile, JSON.stringify({ jobs: [owner] }));

    try {
      const result = processFiles([claimantFile, ownerFile], { apply: true });
      expect(result.moved).toBe(2);

      const writtenClaimant = JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0];
      const writtenOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).jobs[0];
      expect(writtenClaimant.previousSlugs).toEqual([]);
      expect(writtenClaimant.previousSlugsByLocale).toBeUndefined();
      expect(writtenOwner.previousSlugs).toBeUndefined();
      expect(writtenOwner.previousSlugsByLocale).toBeUndefined();
      expect(processFiles([claimantFile, ownerFile], { apply: false }).affected).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips malformed jobs while building the fleet ownership index', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const validJob = {
      id: 'valid-job',
      url: 'https://jobs.example.com/posting/valid',
      previousSlugs: [] as string[],
    };
    const entry = {
      filePath: null,
      slice: { jobs: [null, 'malformed', validJob] as unknown[] },
    };

    const result = decontaminateEntries([entry], {
      sourceEntries: [entry],
      apply: false,
    });

    expect(result).toMatchObject({ moved: 0, emptyLocaleBucketsPruned: 0, affected: [] });
  });

  it('keeps the claimant route recoverable when a final write fails, then converges on retry', async () => {
    const { processFiles } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-retry-'));
    const claimantFile = path.join(tmpDir, 'a-claimant.json');
    const ownerFile = path.join(tmpDir, 'z-owner.json');
    const claimant = {
      id: 'claimant',
      url: 'https://claimant.example/jobs/retry-claimant',
      previousSlugs: [] as string[],
    };
    const owner = {
      id: 'owner',
      url: 'https://owner.example/jobs/retry-owner',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `retry-owner-route-${stableSlugHash(owner)}`;
    claimant.previousSlugs.push(ownerSlug);
    fs.writeFileSync(claimantFile, JSON.stringify({ jobs: [claimant] }));
    fs.writeFileSync(ownerFile, JSON.stringify({ jobs: [owner] }));

    const writeSlice = (filePath: string, slice: unknown, context: { phase: string }) => {
      if (context.phase === 'final') throw new Error('injected final write failure');
      fs.writeFileSync(filePath, JSON.stringify(slice));
    };

    try {
      expect(() => processFiles([claimantFile, ownerFile], { apply: true, writeSlice }))
        .toThrow('injected final write failure');
      expect(JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0].previousSlugs)
        .toContain(ownerSlug);
      expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).jobs[0].previousSlugs)
        .toContain(ownerSlug);

      expect(processFiles([claimantFile, ownerFile], { apply: true }).moved).toBe(1);
      expect(processFiles([claimantFile, ownerFile], { apply: false }).affected).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not guess a cross-file owner when the stable hash has multiple records', async () => {
    const { processFiles } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-ambiguous-owner-'));
    const claimantFile = path.join(tmpDir, 'claimant.json');
    const ownerAFile = path.join(tmpDir, 'owner-a.json');
    const ownerBFile = path.join(tmpDir, 'owner-b.json');
    const ownerUrl = 'https://owner.example/jobs/shared-owner';
    const ownerA = { id: 'owner-a', url: ownerUrl };
    const ownerB = { id: 'owner-b', url: ownerUrl };
    const ambiguousSlug = `ambiguous-owner-route-${stableSlugHash(ownerA)}`;
    fs.writeFileSync(claimantFile, JSON.stringify({
      jobs: [{ id: 'claimant', url: 'https://claimant.example/jobs/ambiguous', previousSlugs: [ambiguousSlug] }],
    }));
    fs.writeFileSync(ownerAFile, JSON.stringify({ jobs: [ownerA] }));
    fs.writeFileSync(ownerBFile, JSON.stringify({ jobs: [ownerB] }));

    try {
      expect(processFiles([claimantFile, ownerAFile, ownerBFile], { apply: true }).affected).toEqual([]);
      expect(JSON.parse(fs.readFileSync(claimantFile, 'utf8')).jobs[0].previousSlugs)
        .toEqual([ambiguousSlug]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not make a same-slice owner depend on job order when hashes collide', async () => {
    const { decontaminateJobs } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const ownerUrl = 'https://owner.example/jobs/same-slice-collision';
    const ambiguousSlug = `ambiguous-slice-route-${stableSlugHash({ url: ownerUrl })}`;

    const run = (reverse = false) => {
      const claimant = {
        id: 'claimant',
        url: 'https://claimant.example/jobs/same-slice-collision',
        previousSlugs: [ambiguousSlug],
      };
      const owners = [
        { id: 'owner-a', url: ownerUrl, previousSlugs: [] as string[] },
        { id: 'owner-b', url: ownerUrl, previousSlugs: [] as string[] },
      ];
      const jobs = reverse ? [claimant, owners[1], owners[0]] : [claimant, owners[0], owners[1]];
      return { jobs, result: decontaminateJobs(jobs) };
    };

    const normal = run();
    const reversed = run(true);
    expect(normal.result).toEqual({ moved: 0, emptyLocaleBucketsPruned: 0 });
    expect(reversed.result).toEqual({ moved: 0, emptyLocaleBucketsPruned: 0 });
    expect(normal.jobs[0].previousSlugs).toEqual([ambiguousSlug]);
    expect(reversed.jobs[0].previousSlugs).toEqual([ambiguousSlug]);
  });

  it('persists removal of an already-empty previousSlugsByLocale container', async () => {
    const { processFile } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpFile = path.join(os.tmpdir(), `decontaminate-empty-container-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      jobs: [{ id: 'empty-owner', url: 'https://jobs.example/empty-owner', previousSlugsByLocale: {} }],
    }));

    try {
      expect(processFile(tmpFile, { apply: true })).toEqual({ moved: 0, emptyLocaleBucketsPruned: 1 });
      expect(JSON.parse(fs.readFileSync(tmpFile, 'utf8')).jobs[0].previousSlugsByLocale).toBeUndefined();
      expect(processFile(tmpFile, { apply: true })).toBeNull();
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('redirects confirmed hash-tail contamination in the in-memory writer payload', async () => {
    const { decontaminateJobs } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const claimant = {
      id: 'company-claimant',
      url: 'https://jobs.example.com/posting/claimant',
      previousSlugs: [] as string[],
      previousSlugsByLocale: { en: [] as string[] },
    };
    const owner = {
      id: 'company-owner',
      url: 'https://jobs.example.com/posting/owner',
      previousSlugs: [] as string[],
    };
    const ownerSlug = `owner-route-${stableSlugHash(owner)}`;
    claimant.previousSlugs.push(ownerSlug);
    claimant.previousSlugs.push('legacy-campus');
    claimant.previousSlugsByLocale.en.push(ownerSlug);
    claimant.previousSlugsByLocale.en.push('legacy-campus');

    const result = decontaminateJobs([claimant, owner]);

    expect(result).toEqual({ moved: 2, emptyLocaleBucketsPruned: 0 });
    expect(claimant.previousSlugs).toEqual(['legacy-campus']);
    expect(claimant.previousSlugsByLocale).toEqual({ en: ['legacy-campus'] });
    expect(owner.previousSlugs).toEqual([ownerSlug]);
    expect(owner.previousSlugsByLocale).toEqual({ en: [ownerSlug] });
  });
});

// Issue 12467. A crawler's slice writer scans the whole fleet for stale
// claims, but it owns one file: its group siblings run next to it in the same
// checkout. From 2026-10-07 16:22Z the self-canonical cleanup marked every
// scanned slice of that shape for rewrite, and a sibling in its seed state
// (raw parser slug as master, the same slug still in its history) has that
// shape by construction. Read in that state and written back after the
// sibling had published, it reverted 2.835 master slugs on main in two crawl
// rounds.
describe('decontaminate-prev-slugs: a writer that owns one slice', () => {
  // The shape seedCrawlerSlicesFromDataJobs leaves on disk while a dedicated
  // crawler is still running: several distinct postings on one raw master slug.
  const seededSibling = (n: number) => ({
    id: `sibling-${n}`,
    url: `https://sibling.example/jobs/${n}`,
    slug: 'raw-parser-title-sibling',
    slugByLocale: {
      de: `raw-parser-title-sibling-town-${n}`,
      it: `titolo-tradotto-sibling-town-${n}`,
    },
    previousSlugs: ['raw-parser-title-sibling', `older-route-${n}`],
    previousSlugsByLocale: { it: ['raw-parser-title-sibling', `older-route-${n}`] },
  });
  const ownJob = () => ({
    id: 'own-1',
    url: 'https://own.example/jobs/1',
    slug: 'own-route',
    slugByLocale: { it: 'own-route' },
    previousSlugs: ['own-older-route'],
  });

  it('leaves a sibling in its seed state byte for byte', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [seededSibling(1), seededSibling(2)] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [ownJob()] } };
    const before = JSON.stringify(sibling.slice);
    const writes: string[] = [];

    const result = decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string) => { writes.push(filePath); },
    });

    expect(writes).toEqual([]);
    expect(JSON.stringify(sibling.slice)).toBe(before);
    expect(result.affected).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('still tidies its own slice', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [seededSibling(1)] } };
    const mine = { ...ownJob(), previousSlugs: ['own-route', 'own-older-route'] };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [mine] } };
    const writes: string[] = [];

    decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string) => { writes.push(filePath); },
    });

    expect(writes).toEqual(['/fleet/own.json']);
    expect(mine.previousSlugs).toEqual(['own-older-route']);
  });

  it('keeps tidying every scanned slice for a pass that owns the fleet', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [seededSibling(1)] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [ownJob()] } };
    const writes: string[] = [];

    decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      apply: true,
      writeSlice: (filePath: string) => { writes.push(filePath); },
    });

    expect(writes).toEqual(['/fleet/sibling.json']);
    expect(sibling.slice.jobs[0].previousSlugs).toEqual(['older-route-1']);
  });

  it('does not carry out a redirect between two slices it does not own', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const owner = { id: 'third-owner', url: 'https://third.example/jobs/owner', previousSlugs: [] as string[] };
    const ownerSlug = `third-route-${stableSlugHash(owner)}`;
    const claimant = { id: 'third-claimant', url: 'https://third.example/jobs/claimant', previousSlugs: [ownerSlug] };
    const claimantEntry = { filePath: '/fleet/a-claimant.json', slice: { jobs: [claimant] } };
    const ownerEntry = { filePath: '/fleet/z-owner.json', slice: { jobs: [owner] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [ownJob()] } };
    const writes: string[] = [];

    const result = decontaminateEntries([claimantEntry, ownerEntry, own], {
      sourceEntries: [claimantEntry, ownerEntry, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string) => { writes.push(filePath); },
    });

    expect(result.moved).toBe(0);
    expect(writes).toEqual([]);
    expect(claimant.previousSlugs).toEqual([ownerSlug]);
    expect(owner.previousSlugs).toEqual([]);
  });

  it('hands a route of its own slice to the sibling that owns it, target first', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const owner = { id: 'sibling-owner', url: 'https://sibling.example/jobs/owner', previousSlugs: [] as string[] };
    const ownerSlug = `sibling-route-${stableSlugHash(owner)}`;
    const mine = { ...ownJob(), previousSlugs: [ownerSlug, 'own-older-route'] };
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [owner] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [mine] } };
    const writes: Array<{ filePath: string; phase: string; owned: boolean }> = [];

    const result = decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string, _slice: unknown, context: { phase: string; owned: boolean }) => {
        writes.push({ filePath, phase: context.phase, owned: context.owned });
      },
    });

    expect(result.moved).toBe(1);
    expect(writes).toEqual([
      { filePath: '/fleet/sibling.json', phase: 'cross-file-target', owned: false },
      { filePath: '/fleet/own.json', phase: 'final', owned: true },
    ]);
    expect(mine.previousSlugs).toEqual(['own-older-route']);
    expect(owner.previousSlugs).toEqual([ownerSlug]);
  });

  it('takes back a route a sibling still claims when its owner arrives in this slice', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const mine = ownJob();
    const mineRoute = `own-earlier-route-${stableSlugHash(mine)}`;
    const claimant = { id: 'sibling-claimant', url: 'https://sibling.example/jobs/claimant', previousSlugs: [mineRoute, 'sibling-older-route'] };
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [claimant] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [mine] } };
    const writes: Array<{ filePath: string; phase: string; owned: boolean }> = [];

    const result = decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string, _slice: unknown, context: { phase: string; owned: boolean }) => {
        writes.push({ filePath, phase: context.phase, owned: context.owned });
      },
    });

    expect(result.moved).toBe(1);
    expect(writes).toEqual([
      { filePath: '/fleet/own.json', phase: 'cross-file-target', owned: true },
      { filePath: '/fleet/sibling.json', phase: 'final', owned: false },
    ]);
    expect(mine.previousSlugs).toEqual(['own-older-route', mineRoute]);
    expect(claimant.previousSlugs).toEqual(['sibling-older-route']);
  });

  it('keeps the route on its own slice when the sibling target refuses the write', async () => {
    const { decontaminateEntries } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const owner = { id: 'sibling-owner', url: 'https://sibling.example/jobs/owner', previousSlugs: [] as string[] };
    const ownerSlug = `sibling-route-${stableSlugHash(owner)}`;
    const mine = { ...ownJob(), previousSlugs: [ownerSlug, 'own-older-route'] };
    const sibling = { filePath: '/fleet/sibling.json', slice: { jobs: [owner] } };
    const own = { filePath: '/fleet/own.json', slice: { jobs: [mine] } };
    const writes: string[] = [];

    const result = decontaminateEntries([sibling, own], {
      sourceEntries: [sibling, own],
      ownedEntries: [own],
      apply: true,
      writeSlice: (filePath: string) => {
        if (filePath === '/fleet/sibling.json') return false;
        writes.push(filePath);
        return undefined;
      },
    });

    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual(['/fleet/sibling.json']);
    expect(result.affected).toEqual([]);
    expect(writes).toEqual([]);
    expect(mine.previousSlugs).toEqual([ownerSlug, 'own-older-route']);
  });

  it('refuses to write a sibling file its owner replaced after it was read', async () => {
    const { readFleetForSingleOwner } = await import('../scripts/decontaminate-prev-slugs.mjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decontaminate-single-owner-'));
    const ownPath = path.join(tmpDir, 'own.json');
    const siblingPath = path.join(tmpDir, 'sibling.json');
    const untouchedPath = path.join(tmpDir, 'untouched.json');
    const writeFile = (filePath: string, value: unknown) => {
      // Temp + rename, like every slice writer: the replacement is a new inode.
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, filePath);
    };
    writeFile(siblingPath, { jobs: [seededSibling(1)] });
    writeFile(untouchedPath, { jobs: [seededSibling(2)] });

    try {
      const fleet = readFleetForSingleOwner([ownPath, siblingPath, untouchedPath], {
        ownPath,
        readSlice: (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
        write: writeFile,
      });
      expect(fleet.entries.map((entry) => entry.filePath)).toEqual([siblingPath, untouchedPath]);

      // The sibling publishes its final slice while this writer still holds the seed.
      const published = { jobs: [{ ...seededSibling(1), slug: 'titolo-tradotto-sibling-town-1' }] };
      writeFile(siblingPath, published);

      expect(fleet.writeSlice(siblingPath, fleet.entries[0].slice)).toBe(false);
      expect(JSON.parse(fs.readFileSync(siblingPath, 'utf8'))).toEqual(published);
      expect(fleet.refused).toEqual([siblingPath]);

      // A file nobody touched is written, and can be written again in the same pass.
      expect(fleet.writeSlice(untouchedPath, { jobs: [] })).not.toBe(false);
      expect(fleet.writeSlice(untouchedPath, { jobs: [seededSibling(3)] })).not.toBe(false);
      expect(JSON.parse(fs.readFileSync(untouchedPath, 'utf8')).jobs[0].id).toBe('sibling-3');

      // Its own file is never subject to the check.
      expect(fleet.writeSlice(ownPath, { jobs: [ownJob()] })).not.toBe(false);
      expect(JSON.parse(fs.readFileSync(ownPath, 'utf8')).jobs[0].id).toBe('own-1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
