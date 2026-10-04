import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { mergeAndDeduplicate, mergePreserveLocaleData, pickMergedPostedDate } from '../scripts/lib/dedicated-crawler-common.mjs';
import { mergePemsaJobRecord } from '../scripts/lib/pemsa-job-parser.mjs';
import { extractJsonLd, extractMicrodata, extractDetailFields } from '../scripts/lib/prospector/extract.mjs';
import { __testables } from '../scripts/lib/shared-jobs-crawler.mjs';
import { buildZambonJob, mergeZambonJobs } from '../scripts/update-zambon-jobs.mjs';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const description = 'The successful candidate will work with the procurement department to manage suppliers and review contracts. The role requires experience with purchasing processes and strong communication skills. Our team provides training and supports professional development. Please submit your application with details of your qualifications and previous work experience for this position.';
const base = { id: 'publication-123456', title: 'Procurement Specialist', company: 'Zambon', url: 'https://zambon.test/jobs/123456', sourceLang: 'en', description, descriptionByLocale: { en: description }, slug: 'procurement-specialist-zambon', crawledAt: new Date().toISOString() };

describe('source publication dates', () => {
  let temporaryRegistry = '';
  const previousOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  beforeAll(() => {
    temporaryRegistry = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-date-test-'));
    const registry = path.join(temporaryRegistry, 'slug-registry.json');
    fs.writeFileSync(registry, '{}');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registry;
  });
  afterAll(() => {
    if (previousOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousOverride;
    fs.rmSync(temporaryRegistry, { recursive: true, force: true });
  });

  it('keeps unknown publication dates empty through full duplicate merging', () => {
    const previous = { ...base, location: 'Lugano', postedDate: daysAgo(7) };
    const fresh = { ...previous, ...sourcePostingDateFields('') };
    const [merged] = mergeAndDeduplicate([previous], [fresh], {}).merged;
    expect(merged.postingDateSource).toBe('unknown');
    expect(merged.postedDate).toBe('');
    expect(merged.datePosted).toBe('');
    expect(merged.crawledAt).toBeTruthy();
  });

  it.each(['', 'invalid', '2025-02-30', '30 Feb 2025', daysAgo(-2), undefined])('keeps missing or invalid employer date unknown: %s', value => {
    expect(sourcePostingDateFields(value)).toEqual({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });

  it('preserves genuine ISO dates and source human dates without a clock fallback', () => {
    const date = daysAgo(3);
    expect(sourcePostingDateFields(date)).toEqual({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    const human = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    expect(sourcePostingDateFields(human).datePosted).toBe(date);
  });

  it('does not promote an older unmarked legacy clock over new employer evidence', () => {
    const fresh = sourcePostingDateFields(daysAgo(2));
    expect(mergeSourcePostingDates({ postedDate: daysAgo(9) }, fresh)).toEqual(fresh);
    expect(mergeSourcePostingDates({ postedDate: daysAgo(9) }, sourcePostingDateFields('')).postingDateSource).toBe('unknown');
  });

  it('carries genuine evidence through missing-source recrawls in both merge paths', () => {
    const previous = { ...base, ...sourcePostingDateFields(daysAgo(5)) };
    const fresh = { ...base, ...sourcePostingDateFields('') };
    for (const merged of [mergePemsaJobRecord(previous, fresh), mergePreserveLocaleData([previous], [fresh])[0]]) {
      expect(merged.postingDateSource).toBe('reported');
      expect(merged.datePosted).toBe(daysAgo(5));
      expect(merged.postedDate).toBe(daysAgo(5));
    }
  });

  it('does not resurrect fabricated legacy dates in either merge path', () => {
    const previous = { ...base, postedDate: daysAgo(5), datePosted: daysAgo(5) };
    const fresh = { ...base, ...sourcePostingDateFields('') };
    for (const merged of [mergePemsaJobRecord(previous, fresh), mergePreserveLocaleData([previous], [fresh])[0]]) {
      expect(merged.postingDateSource).toBe('unknown');
      expect(merged.datePosted).toBe('');
      expect(merged.postedDate).toBe('');
    }
    expect(pickMergedPostedDate(previous, fresh)).toBe('');
  });

  it('carries actual JobPosting dates through JSON-LD, microdata and detail extraction', () => {
    const date = daysAgo(2);
    const node = { '@type': 'JobPosting', title: base.title, description, datePosted: date, url: base.url };
    const json = `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
    const micro = `<div itemscope itemtype="https://schema.org/JobPosting"><span itemprop="title">${base.title}</span><time itemprop="datePosted" datetime="${date}">${date}</time><div itemprop="description">${description}</div></div>`;
    for (const job of [extractJsonLd(json, base.url)[0], extractMicrodata(micro, base.url)[0], extractDetailFields(json, base.url)]) {
      expect(job.postingDateSource).toBe('reported');
      expect(job.postedDate).toBe(date);
    }
  });

  it('prefers a real JSON-LD date over unknown adapter metadata', () => {
    const date = daysAgo(3);
    const node = { '@type': 'JobPosting', title: base.title, description, datePosted: date,
      jobLocation: { address: { addressLocality: 'Lugano', addressRegion: 'TI', addressCountry: 'CH' } } };
    const result = __testables.toJobFromJsonLd(node, 'Zambon', base.url, {
      seedMeta: { location: 'Lugano', canton: 'TI', postedDate: daysAgo(1), postingDateSource: 'unknown' },
    });
    expect(result.job).toMatchObject({ postingDateSource: 'reported', postedDate: date, datePosted: date });
    const unknown = __testables.toJobFromJsonLd({ ...node, datePosted: undefined }, 'Zambon', base.url, {
      seedMeta: { location: 'Lugano', canton: 'TI', postedDate: daysAgo(1) },
    });
    expect(unknown.job).toMatchObject({ postingDateSource: 'unknown', postedDate: '', datePosted: '' });
  });

  it('keeps Zambon listings without opening dates unknown through builder and merge', () => {
    const fresh = buildZambonJob(base, description);
    expect(fresh.postingDateSource).toBe('unknown');
    expect(fresh.datePosted).toBe('');
    const [merged] = mergeZambonJobs([{ ...fresh, postingDateSource: undefined, datePosted: daysAgo(4) }], [fresh]);
    expect(merged.datePosted).toBe('');
    expect(merged.postingDateSource).toBe('unknown');
  });
});
