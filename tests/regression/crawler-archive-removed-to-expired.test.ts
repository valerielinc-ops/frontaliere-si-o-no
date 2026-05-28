/**
 * Regression: when a dedicated crawler refetches and a previously-known job
 * is no longer in the upstream ATS, the drop must be captured into
 * `data/jobs/expired/by-crawler/<crawler>.json` instead of being lost.
 *
 * Without this, `mergePreserveLocaleData` (iterates only freshJobs) silently
 * drops the entry, the next deploy stops emitting the static detail page,
 * and Google-indexed URLs (plus their previousSlugs bridges) return 404
 * instead of rendering JobExpiredView.
 *
 * The UPD crawler hit this on 2026-05-27 when job `upd-c1ad47e6563e`
 * (psychology-assistant) vanished from the Umantis source between runs —
 * `data/jobs/expired/by-crawler/upd.json` never existed because the
 * crawler-template pipeline lacked an archival step.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  archiveRemovedJobsToSlice,
  buildExpiredEntry,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs has no type declarations
} from '../../scripts/lib/expired-jobs-archive.mjs';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'expired-archive-'));
}

function readSlice(dir: string, crawlerKey: string): unknown[] {
  const p = path.join(dir, `${crawlerKey}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

const removedUpdJob = {
  id: 'upd-c1ad47e6563e',
  slug: 'assistente-psicologa-assistente-psicologo-o-psicologa-specializzata-psicologo-specializzato-universitare-psychiatrische',
  title: 'Assistenzpsychologin / Assistenzpsychologe oder Fachpsychologin / Fachpsychologe',
  titleByLocale: {
    it: 'Assistente Psicologa / Assistente Psicologo',
    en: 'Psychology Assistant / Specialized Psychologist',
    de: 'Assistenzpsychologin / Assistenzpsychologe',
    fr: 'Psychologue assistant·e',
  },
  company: 'Universitäre Psychiatrische Dienste Bern (UPD)',
  companyKey: 'upd',
  location: 'Bern',
  addressLocality: 'Bern',
  canton: 'BE',
  postalCode: '3000',
  slugByLocale: {
    it: 'assistente-psicologa-assistente-psicologo-o-psicologa-specializzata-psicologo-specializzato-universitare-psychiatrische',
    en: 'psychology-assistant-specialized-psychologist-assistant-universitare-psychiatrische-dienste-bern-upd-bern',
    de: 'assistenzpsychologin-assistenzpsychologe-oder-fachpsychologin-fachpsychologe-upd-bern',
    fr: 'psychologue-assistant-e-ou-psychologue-specialise-e-universitare-psychiatrische-dienste-bern-upd-bern',
  },
  descriptionByLocale: {
    it: 'Lorem ipsum '.repeat(40),
    en: 'Lorem ipsum '.repeat(40),
    de: 'Lorem ipsum '.repeat(40),
    fr: 'Lorem ipsum '.repeat(40),
  },
  previousSlugs: [
    'assistenzpsychologin-assistenzpsychologe-oder-fachpsychologin-fachpsychologe-upd-bern',
    'psicologo-a-assistente-o-a-psicologo-a-specializzato-a-universitare-psychiatrische-dienste-bern-upd-bern',
  ],
  previousSlugsByLocale: {
    en: ['assistant-psychologist-or-specialist-psychologist-universitare-psychiatrische-dienste-bern-upd-bern'],
  },
  sector: 'Sanità / Ospedali',
  salaryMin: 49500,
  salaryMax: 75000,
  currency: 'CHF',
};

describe('archiveRemovedJobsToSlice', () => {
  it('writes a new slice file when no prior archive exists', () => {
    const dir = makeTmpDir();
    const added = archiveRemovedJobsToSlice([removedUpdJob], 'upd', { dir });
    expect(added).toBe(1);

    const slice = readSlice(dir, 'upd') as Array<Record<string, unknown>>;
    expect(slice).toHaveLength(1);
    expect(slice[0].slug).toBe(removedUpdJob.slug);
    expect(slice[0].slugByLocale).toEqual(removedUpdJob.slugByLocale);
    expect(slice[0].previousSlugs).toEqual(removedUpdJob.previousSlugs);
    expect(slice[0].previousSlugsByLocale).toEqual(removedUpdJob.previousSlugsByLocale);
    expect(typeof slice[0].expiredAt).toBe('string');
  });

  it('merges with existing entries instead of overwriting', () => {
    const dir = makeTmpDir();
    // Seed: prior expired entry from a different upstream removal
    const prior = {
      slug: 'old-removed-job',
      title: 'Old Job',
      company: 'UPD',
      slugByLocale: { it: 'old-removed-job' },
      expiredAt: '2026-05-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'upd.json'), JSON.stringify([prior], null, 2) + '\n');

    archiveRemovedJobsToSlice([removedUpdJob], 'upd', { dir });
    const slice = readSlice(dir, 'upd') as Array<Record<string, unknown>>;
    expect(slice).toHaveLength(2);
    const slugs = slice.map((e) => e.slug).sort();
    expect(slugs).toContain('old-removed-job');
    expect(slugs).toContain(removedUpdJob.slug);
  });

  it('keeps the most-recently-expired entry when a slug is re-archived', () => {
    const dir = makeTmpDir();
    archiveRemovedJobsToSlice([removedUpdJob], 'upd', { dir });
    const first = readSlice(dir, 'upd') as Array<Record<string, unknown>>;
    const firstExpiredAt = first[0].expiredAt as string;

    // Pause a hair to guarantee a later ISO timestamp on the second archive
    const after = new Date(Date.now() + 5).toISOString();
    archiveRemovedJobsToSlice(
      [{ ...removedUpdJob, _bumpExpiredAt: after }],
      'upd',
      { dir },
    );
    const second = readSlice(dir, 'upd') as Array<Record<string, unknown>>;
    expect(second).toHaveLength(1);
    expect((second[0].expiredAt as string) >= firstExpiredAt).toBe(true);
  });

  it('skips jobs without a slug (no static page to land on)', () => {
    const dir = makeTmpDir();
    const noSlug = { ...removedUpdJob, slug: undefined };
    const added = archiveRemovedJobsToSlice([noSlug as never], 'upd', { dir });
    expect(added).toBe(0);
    expect(fs.existsSync(path.join(dir, 'upd.json'))).toBe(false);
  });

  it('is a no-op when removedJobs is empty', () => {
    const dir = makeTmpDir();
    expect(archiveRemovedJobsToSlice([], 'upd', { dir })).toBe(0);
    expect(fs.existsSync(path.join(dir, 'upd.json'))).toBe(false);
  });

  it('refuses to run without a crawlerKey', () => {
    const dir = makeTmpDir();
    expect(archiveRemovedJobsToSlice([removedUpdJob], '', { dir })).toBe(0);
  });

  it('sorts the on-disk archive by expiredAt descending', () => {
    const dir = makeTmpDir();
    const older = {
      ...removedUpdJob,
      slug: 'older-removed-job',
      slugByLocale: { it: 'older-removed-job' },
    };
    fs.writeFileSync(
      path.join(dir, 'upd.json'),
      JSON.stringify(
        [{ slug: 'older-removed-job', expiredAt: '2026-04-01T00:00:00.000Z' }],
        null,
        2,
      ) + '\n',
    );
    archiveRemovedJobsToSlice([removedUpdJob], 'upd', { dir });
    const slice = readSlice(dir, 'upd') as Array<Record<string, string>>;
    expect(slice[0].slug).toBe(removedUpdJob.slug); // newer first
    expect(slice[1].slug).toBe('older-removed-job');
  });
});

describe('buildExpiredEntry', () => {
  it('preserves locale-aware slug + previousSlugs for cross-locale bridges', () => {
    const entry = buildExpiredEntry(removedUpdJob);
    expect(entry.slug).toBe(removedUpdJob.slug);
    expect(entry.slugByLocale).toEqual(removedUpdJob.slugByLocale);
    expect(entry.previousSlugs).toEqual(removedUpdJob.previousSlugs);
    expect(entry.previousSlugsByLocale).toEqual(removedUpdJob.previousSlugsByLocale);
    expect(entry.descriptionByLocale).toEqual(removedUpdJob.descriptionByLocale);
    expect(entry.salaryMin).toBe(removedUpdJob.salaryMin);
    expect(entry.salaryMax).toBe(removedUpdJob.salaryMax);
    expect(typeof entry.expiredAt).toBe('string');
  });

  it('strips empty optional fields', () => {
    const entry = buildExpiredEntry({
      slug: 'x',
      title: 'X',
      company: 'X',
      location: 'X',
    });
    expect(entry).not.toHaveProperty('postalCode');
    expect(entry).not.toHaveProperty('streetAddress');
    expect(entry).not.toHaveProperty('salaryMin');
    expect(entry).not.toHaveProperty('salaryMax');
    expect(entry).not.toHaveProperty('dedupArchive');
  });
});
