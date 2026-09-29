/**
 * A run that finds no job keeps the stored slice. The text a crawler once
 * wrote into its stored jobs is removed in the merge, so without this cleanup
 * at the zero-job exit it would survive for as long as the source stays empty
 * (#5253, lot L 3). `rewritePreparedStoredJobs` rewrites the slice only when
 * the cleanup changed something, and nothing else.
 *
 * Fixture: minimized stored rows of the main slices (2026-09-29), shared with
 * tests/pdf-backed-description-source-only-runners.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { rewritePreparedStoredJobs } from '../scripts/lib/stored-jobs-soft-exit.mjs';
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';
import { FART_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/fart-job-parser.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/crawler-fabricated-descriptions/pdf-backed-runner-crawlers.json'),
  'utf8',
));

function storedFartJob(index = 0) {
  const row = FIXTURE.fart;
  return {
    id: `fart-${index}`,
    slug: `fart-concorso-${index}`,
    url: `https://www.fartiamo.ch/concorsi/${index}/`,
    companyKey: 'fart',
    sourceLang: row.sourceLang,
    postedDate: POSTED,
    description: row.source,
    descriptionByLocale: { [row.sourceLang]: row.source, ...(row.translation || {}) },
  };
}

const POSTED = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

const prepare = (jobs: object[]) => dropFabricatedDescriptions(jobs, FART_FABRICATED_DESCRIPTION_RE, 'FART');

describe('rewritePreparedStoredJobs (zero-job soft exit)', () => {
  it('rewrites the slice with the stored jobs cleaned, and nothing else', async () => {
    const write = vi.fn();
    const stored = [storedFartJob()];
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: stored, companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [jobs] = write.mock.calls[0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'fart-0',
      slug: 'fart-concorso-0',
      url: 'https://www.fartiamo.ch/concorsi/0/',
      postedDate: POSTED,
      description: '',
      descriptionByLocale: {},
      needsRetranslation: true,
    });
  });

  it('writes nothing when the stored jobs carry no text of the crawler', async () => {
    const write = vi.fn();
    const job = { ...storedFartJob(), description: 'CONCORSO PUBBLICO', descriptionByLocale: { it: 'CONCORSO PUBBLICO' } };
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: [job], companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing without a cleanup or without stored jobs', async () => {
    const write = vi.fn();
    expect(await rewritePreparedStoredJobs({
      storedJobs: [storedFartJob()], companyKey: 'fart', companyLabel: 'FART', write,
    })).toBe(false);
    expect(await rewritePreparedStoredJobs({
      prepare, storedJobs: [], companyKey: 'fart', companyLabel: 'FART', write,
    })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the prior slice when the rewrite would trip the systemic boilerplate guard', async () => {
    const write = vi.fn();
    const stored = Array.from({ length: 10 }, (_, i) => storedFartJob(i));
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: stored, companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('stays soft when the write fails', async () => {
    const write = vi.fn(() => { throw new Error('shrink guard'); });
    await expect(rewritePreparedStoredJobs({
      prepare, storedJobs: [storedFartJob()], companyKey: 'fart', companyLabel: 'FART', write,
    })).resolves.toBe(false);
  });
});

// Runners with their own merge: the zero-job exit runs the same cleanup as
// the merge (same pattern) and writes with the runner's slice writer.
describe('own-runner crawlers clean their stored jobs at the zero-job exit', () => {
  const RUNNERS = [
    'update-cerbios-pharma-jobs.mjs',
    'update-citta-di-bellinzona-jobs.mjs',
    'update-citta-di-locarno-jobs.mjs',
    'update-citta-di-lugano-jobs.mjs',
    'update-fart-jobs.mjs',
    'update-mendrisio-jobs.mjs',
    'update-oscam-jobs.mjs',
  ];

  for (const runner of RUNNERS) {
    it(runner, () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', runner), 'utf8');
      const mergePattern = source.match(/dropFabricatedDescriptions\(\s*\n\s*[^\n]+\n\s*([A-Z_]+_FABRICATED_DESCRIPTION_RE),/)?.[1];
      expect(mergePattern).toBeTruthy();
      const exit = source.slice(source.indexOf('await rewritePreparedStoredJobs({'));
      expect(exit.length).toBeGreaterThan(0);
      const call = exit.slice(0, exit.indexOf('});') + 3);
      expect(call).toContain(`prepare: (jobs) => dropFabricatedDescriptions(jobs, ${mergePattern},`);
      expect(call).toMatch(/write: \(jobs\) => writeJobsCrawlerSlice\([A-Z_]+, jobs\)/);
      // The call sits in the zero-job exit, before its `return`.
      expect(exit.slice(call.length).trimStart()).toMatch(/^(return;|const _cdResult = logStats)/);
    });
  }
});
