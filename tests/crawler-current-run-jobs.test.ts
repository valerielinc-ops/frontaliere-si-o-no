import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #7706 item 3 — the proven-empty snapshot Artisa publishes was inert.
 *
 * The published slice on 2026-09-05 carried `authoritativeEmptySnapshot: true`
 * next to `total: 3`, with a diff that said `removedCount: 1` and nothing new,
 * updated or unchanged. `nextCrawlerState()` (check-crawler-health.mjs) only
 * honours the proof when `jobCount === 0`, so it dropped it: the per-run
 * evidence #7537 added to this bespoke runner never reached the monitor.
 *
 * The cause was not in the summary write. `repairLocalizedDescriptions()` ran
 * AFTER `mergeJobs()` and re-read through `readExistingCrawlerJobs()`, which
 * prefers the previous run's published slice whenever it is non-empty. On the
 * proven-empty branch that handed back the three retired jobs and wrote them
 * over the emptied working set — so they were archived as expired AND
 * republished as active, and `total` counted them.
 */

const STALE_PUBLISHED_JOBS = [
  {
    id: 'artisa-old-1',
    slug: 'architetto-lugano',
    title: 'Architetto',
    location: 'Lugano',
    company: 'Artisa Group',
    companyKey: 'artisa-group',
    url: 'https://artisagroup.com/carriera#architetto',
    descriptionByLocale: { it: 'x', en: 'x', de: 'x', fr: 'x' },
  },
];

const mocks = vi.hoisted(() => ({
  readExistingCrawlerJobs: vi.fn(() => []),
}));

vi.mock('../scripts/assemble-jobs-dataset.mjs', () => ({
  writeJobsCrawlerSlice: vi.fn(),
  writeSummaryCrawlerSlice: vi.fn(),
  registerCrawlerSummaryGuard: vi.fn(),
  assembleJobsDataset: vi.fn(async () => undefined),
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
}));

const DATA_JOBS = path.join(os.tmpdir(), 'frontaliere-jobs-scratch-artisa-group.json');
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;

function readScratch(): unknown[] {
  return JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
}

function cleanup() {
  for (const file of [DATA_JOBS, PUBLIC_JOBS]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

describe('artisa post-merge steps read this run, not the published slice', () => {
  beforeEach(() => {
    cleanup();
    mocks.readExistingCrawlerJobs.mockReset();
    mocks.readExistingCrawlerJobs.mockReturnValue(STALE_PUBLISHED_JOBS);
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  it('keeps the working set empty on the proven-empty branch instead of resurrecting the published slice', async () => {
    // What `mergeJobs([])` leaves behind on a proven zero.
    fs.writeFileSync(DATA_JOBS, JSON.stringify([]), 'utf-8');

    const { repairLocalizedDescriptions } = await import('../scripts/update-artisa-jobs.mjs');
    repairLocalizedDescriptions();

    expect(readScratch()).toEqual([]);
    // The previous run's slice must not be consulted at all once this run has
    // written its working set — that read IS the resurrection.
    expect(mocks.readExistingCrawlerJobs).not.toHaveBeenCalled();
  });

  it('preserves non-target rows and still fills missing locales for the jobs this run merged', async () => {
    fs.writeFileSync(
      DATA_JOBS,
      JSON.stringify([
        { id: 'other-crawler-1', company: 'Somebody Else', companyKey: 'somebody-else' },
        {
          id: 'artisa-new-1',
          slug: 'assistente-manno',
          title: 'Assistente di direzione',
          location: 'Manno',
          company: 'Artisa Group',
          companyKey: 'artisa-group',
          url: 'https://artisagroup.com/carriera#assistente',
          descriptionByLocale: { it: 'Descrizione reale' },
        },
      ]),
      'utf-8',
    );

    const { repairLocalizedDescriptions } = await import('../scripts/update-artisa-jobs.mjs');
    repairLocalizedDescriptions();

    const jobs = readScratch() as Array<Record<string, any>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].companyKey).toBe('somebody-else');
    const repaired = jobs[1];
    expect(repaired.descriptionByLocale.it).toBe('Descrizione reale');
    for (const locale of ['en', 'de', 'fr']) {
      expect(String(repaired.descriptionByLocale[locale] || '').trim()).not.toBe('');
    }
    expect(mocks.readExistingCrawlerJobs).not.toHaveBeenCalled();
  });

});

describe('readCurrentRunJobs', () => {
  const scratch = path.join(os.tmpdir(), 'frontaliere-jobs-scratch-run-jobs-test.json');

  afterEach(() => {
    if (fs.existsSync(scratch)) fs.rmSync(scratch);
  });

  it('returns the working set the run wrote', async () => {
    fs.writeFileSync(scratch, JSON.stringify([{ id: 'a' }, { id: 'b' }]), 'utf-8');
    const { readCurrentRunJobs } = await import('../scripts/lib/crawler-run-jobs.mjs');
    expect(readCurrentRunJobs(scratch)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('reports an empty working set — never the published slice — when the run wrote nothing', async () => {
    const { readCurrentRunJobs } = await import('../scripts/lib/crawler-run-jobs.mjs');
    expect(fs.existsSync(scratch)).toBe(false);
    expect(readCurrentRunJobs(scratch)).toEqual([]);
    expect(readCurrentRunJobs(undefined)).toEqual([]);
  });

  it('does not throw on a truncated or non-array scratch file', async () => {
    const { readCurrentRunJobs } = await import('../scripts/lib/crawler-run-jobs.mjs');
    fs.writeFileSync(scratch, '[{"id":"a"', 'utf-8');
    expect(readCurrentRunJobs(scratch)).toEqual([]);
    fs.writeFileSync(scratch, '{"jobs":[]}', 'utf-8');
    expect(readCurrentRunJobs(scratch)).toEqual([]);
  });
});

describe('sibling runners read the same working set (issue #7706 class sweep)', () => {
  it.each([
    ['scripts/update-skyguide-jobs.mjs', 'refreshLocalizedSlugs'],
    ['scripts/update-sunrise-jobs.mjs', 'alignItalianDescriptions'],
    ['scripts/update-artisa-jobs.mjs', 'repairLocalizedDescriptions'],
  ])('%s post-merge step %s does not re-read the published slice', (file, fn) => {
    const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8');
    const start = source.indexOf(`function ${fn}(`);
    expect(start).toBeGreaterThan(-1);
    const body = source
      .slice(start, source.indexOf('\n}', start))
      // Comments explain the fix and name the old helper; the assertion is
      // about the CALL, so drop them before matching.
      .replace(/^\s*\/\/.*$/gm, '');
    expect(body).toContain('readCurrentRunJobs(DATA_JOBS)');
    expect(body).not.toContain('readExistingCrawlerJobs(');
  });
});
