import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reconcileDuplicateIdJobs } from '../scripts/reconcile-duplicate-stable-id-jobs.mjs';

// translate-pending's scatter parity failed twice on 2026-10-16 on a
// duplicate id inside one slice (runs 38854975768: emmi.json, 38937686046:
// vista.json): two distinct postings, two URLs, one id. The writer now runs
// the reconciliation recover-prev-slugs.yml used to run after the fact.

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('writeJobsCrawlerSlice keeps one id per posting', () => {
  it('reconciles duplicate ids on the jobs it is about to write', () => {
    const src = read('scripts/assemble-jobs-dataset.mjs');
    const start = src.indexOf('export function writeJobsCrawlerSlice(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    const reconcile = body.indexOf('reconcileDuplicateIdJobs(finalJobs)');
    const hold = body.indexOf('applyTranslationHold(crawlerKey, finalJobs');
    expect(reconcile).toBeGreaterThan(0);
    // Before the hold and the write, so both see the reconciled jobs.
    expect(hold).toBeGreaterThan(reconcile);
    expect(body.indexOf('jobs: finalJobs', reconcile)).toBeGreaterThan(reconcile);
  });

  it('a failed reconciliation stops the write: no slice with duplicate ids (review of PR 13609)', () => {
    const src = read('scripts/assemble-jobs-dataset.mjs');
    const start = src.indexOf('export function writeJobsCrawlerSlice(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    const reconcile = body.indexOf('reconcileDuplicateIdJobs(finalJobs)');
    const rethrow = body.indexOf('throw new Error(`Duplicate-id reconciliation failed for ${crawlerKey}; slice not written', reconcile);
    const write = body.indexOf('writeJson(slicePath', reconcile);
    expect(rethrow).toBeGreaterThan(reconcile);
    expect(write).toBeGreaterThan(rethrow);
    expect(body.slice(reconcile, rethrow)).not.toContain('console.warn');
  });
});

describe('the Vista case: two postings, one id', () => {
  const token = '7dep13y4glk16fb1wl1y6sdwdh272d750gw0m8c6d1egjn340hykcxeh438li0ag';
  const posting = (role: string, firstSeenAt: string) => ({
    id: 'vista-b8fd444bb3ef',
    url: `https://link.ostendis.com/publication/${role}/${token}`,
    slug: `${role}-vista-basel`,
    firstSeenAt,
    crawledAt: '2026-10-16T09:00:00Z',
  });

  it('keeps the id on the posting seen first and gives the other its own', () => {
    const jobs = [
      posting('optometrist-in-mit-fachverantwortung-biometrie-sprechstunde', '2026-10-16T09:00:00Z'),
      posting('leiter-in-linsen-biometrie-sprechstunde', '2026-09-01T09:00:00Z'),
    ];
    const result = reconcileDuplicateIdJobs(jobs);
    expect(result.jobs).toHaveLength(2);
    const ids = result.jobs.map((job: { id: string }) => job.id);
    expect(new Set(ids).size).toBe(2);
    expect(result.jobs.find((job: { url: string }) => job.url.includes('leiter-in-linsen'))!.id).toBe('vista-b8fd444bb3ef');
  });

  it('is a fixed point: a second write changes nothing', () => {
    const jobs = [
      posting('optometrist-in-mit-fachverantwortung-biometrie-sprechstunde', '2026-10-16T09:00:00Z'),
      posting('leiter-in-linsen-biometrie-sprechstunde', '2026-09-01T09:00:00Z'),
    ];
    const once = reconcileDuplicateIdJobs(jobs).jobs.map((job: { id: string }) => job.id);
    const twice = reconcileDuplicateIdJobs(reconcileDuplicateIdJobs(jobs).jobs);
    expect(twice.groups).toBe(0);
    expect(twice.jobs.map((job: { id: string }) => job.id)).toEqual(once);
  });
});
