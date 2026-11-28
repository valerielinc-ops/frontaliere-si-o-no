import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flatOnlyPreviousSlugs,
  indexServedSlugCandidateClaims,
  servedSlugCandidates,
  servedSlugSliceWriter,
  syncItalianMasterSlug,
} from '../scripts/regenerate-slugs-by-locale.mjs';
import { getEvents, clear as clearSlugJournal } from '../scripts/lib/slug-history-journal.mjs';
import { jobDetailPathsFor } from '../scripts/lib/published-slug-stability.mjs';

const originalLedgerOverride = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
const tempRoots: string[] = [];

function jobFor(locale: string) {
  return {
    id: 'served-slug-job',
    slug: 'master-italian-slice-route',
    slugByLocale: {
      it: locale === 'it' ? 'old-italian-slice-route' : 'master-italian-slice-route',
      en: locale === 'en' ? 'old-english-slice-route' : 'old-english-slice-route',
      de: 'old-german-slice-route',
      fr: 'old-french-slice-route',
    },
    title: 'Senior Operator',
    titleByLocale: {
      it: 'Senior Operator',
      en: 'Senior Operator',
      de: 'Senior Operator',
      fr: 'Senior Operator',
    },
    sourceLang: 'it',
    company: 'Example AG',
    location: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
  };
}

function candidateFor(job: ReturnType<typeof jobFor>, locale: string) {
  const candidate = servedSlugCandidates(job, locale).find((entry) => entry.origin === 'title-derived');
  if (!candidate) throw new Error(`fixture has no title-derived candidate for ${locale}`);
  return candidate.slug;
}

function useLedger(entries: Record<string, string> | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'served-slug-writer-'));
  tempRoots.push(root);
  const ledgerPath = path.join(root, 'ledger.json');
  if (entries) fs.writeFileSync(ledgerPath, JSON.stringify(entries), 'utf8');
  process.env.URL_FIRST_SEEN_PATH_OVERRIDE = ledgerPath;
}

function ledgerFor(job: ReturnType<typeof jobFor>, locale: string, candidate: string) {
  return Object.fromEntries(jobDetailPathsFor(locale, candidate, job).map((route) => [route, '2026-11-01']));
}

function claimsFor(...jobs: ReturnType<typeof jobFor>[]) {
  const byLocale = new Map(['it', 'en', 'de', 'fr'].map((locale) => [locale, new Map()]));
  for (const job of jobs) indexServedSlugCandidateClaims(job, byLocale);
  return byLocale;
}

function snapshot(job: ReturnType<typeof jobFor>) {
  return JSON.parse(JSON.stringify(job));
}

beforeEach(() => clearSlugJournal());
afterEach(() => {
  clearSlugJournal();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalLedgerOverride === undefined) delete process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
  else process.env.URL_FIRST_SEEN_PATH_OVERRIDE = originalLedgerOverride;
});

describe('Italian master route synchronization', () => {
  it('preserves a replaced master route when the locale slot already has the old route', () => {
    const job = {
      slug: 'old-italian-route',
      slugByLocale: { it: 'old-italian-route' },
      previousSlugsByLocale: { it: ['old-italian-route'] },
    };

    expect(syncItalianMasterSlug(job, 'old-italian-route', 'pinned-italian-route')).toBe(true);
    expect(job.slug).toBe('pinned-italian-route');
    expect(job.previousSlugsByLocale.it).toEqual(['old-italian-route']);
  });

  it('preserves the fallback master route when a missing locale slot is pinned', () => {
    const job = {
      slug: 'fallback-master-route',
      slugByLocale: {},
    };

    expect(syncItalianMasterSlug(job, '', 'pinned-italian-route')).toBe(true);
    expect(job.slug).toBe('pinned-italian-route');
    expect(job.previousSlugsByLocale.it).toEqual(['fallback-master-route']);
  });

  it('promotes the master route when the Italian slot already equals the pin', () => {
    const job = {
      slug: 'fallback-master-route',
      slugByLocale: { it: 'pinned-italian-route' },
    };

    expect(syncItalianMasterSlug(job, 'pinned-italian-route', 'pinned-italian-route')).toBe(true);
    expect(job.slug).toBe('pinned-italian-route');
    expect(job.previousSlugsByLocale.it).toEqual(['fallback-master-route']);
  });
});

describe('served slug slice writer', () => {
  it('archives a replaced URL in its own locale and journals the source-backed replacement', () => {
    const job = jobFor('en');
    const candidate = candidateFor(job, 'en');
    useLedger(ledgerFor(job, 'en', candidate));
    const claims = claimsFor(job);

    const result = servedSlugSliceWriter(job, 'en', {
      usedSlugs: new Map([['old-english-slice-route', job.id], [candidate, job.id]]),
      candidateClaims: claims.get('en'),
      source: 'test/FU-007',
    });

    expect(result).toMatchObject({ changed: true, locale: 'en', previousSlug: 'old-english-slice-route', nextSlug: candidate });
    expect(job.slugByLocale.en).toBe(candidate);
    expect(job.previousSlugsByLocale.en).toContain('old-english-slice-route');
    expect(job.previousSlugsByLocale.it || []).not.toContain('old-english-slice-route');
    expect(getEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: 'en', slug: 'old-english-slice-route', action: 'capture', source: 'dedicated-crawler-common.test/FU-007' }),
      expect.objectContaining({ locale: 'en', slug: candidate, action: 'sync', source: 'dedicated-crawler-common.test/FU-007' }),
    ]));
  });

  it('keeps the Italian master route synchronized with the replaced Italian slot', () => {
    const job = jobFor('it');
    const candidate = candidateFor(job, 'it');
    useLedger(ledgerFor(job, 'it', candidate));
    const claims = claimsFor(job);

    const result = servedSlugSliceWriter(job, 'it', {
      usedSlugs: new Map([['old-italian-slice-route', job.id], [candidate, job.id]]),
      candidateClaims: claims.get('it'),
      source: 'test/FU-007',
    });

    expect(result.changed).toBe(true);
    expect(job.slugByLocale.it).toBe(candidate);
    expect(job.slug).toBe(candidate);
    expect(job.previousSlugsByLocale.it).toContain('old-italian-slice-route');
    expect(getEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: 'it', slug: candidate, action: 'sync', source: 'dedicated-crawler-common.test/FU-007' }),
    ]));
  });

  it('fails closed when the served ledger is absent', () => {
    const job = jobFor('en');
    useLedger(null);
    const before = snapshot(job);

    const result = servedSlugSliceWriter(job, 'en', { source: 'test/FU-007' });

    expect(result).toMatchObject({ changed: false, reason: 'missing-ledger' });
    expect(job).toEqual(before);
  });

  it('fails closed when another job owns the served candidate as its active slug', () => {
    const job = jobFor('en');
    const candidate = candidateFor(job, 'en');
    useLedger(ledgerFor(job, 'en', candidate));
    const before = snapshot(job);

    const result = servedSlugSliceWriter(job, 'en', {
      usedSlugs: new Map([[candidate, 'different-active-owner']]),
      candidateClaims: claimsFor(job).get('en'),
      source: 'test/FU-007',
    });

    expect(result).toMatchObject({ changed: false, reason: 'active-owner-conflict' });
    expect(job).toEqual(before);
  });

  it('fails closed when historical claims make the served candidate ambiguous', () => {
    const job = jobFor('en');
    const other = { ...jobFor('en'), id: 'other-served-slug-job' };
    const candidate = candidateFor(job, 'en');
    useLedger(ledgerFor(job, 'en', candidate));
    const before = snapshot(job);

    const result = servedSlugSliceWriter(job, 'en', {
      usedSlugs: new Map([[candidate, job.id]]),
      candidateClaims: claimsFor(job, other).get('en'),
      source: 'test/FU-007',
    });

    expect(result).toMatchObject({ changed: false, reason: 'ambiguous-history' });
    expect(job).toEqual(before);
  });

  it('fails closed when the source-backed candidate was never served', () => {
    const job = jobFor('en');
    useLedger({});
    const before = snapshot(job);

    const result = servedSlugSliceWriter(job, 'en', {
      candidateClaims: claimsFor(job).get('en'),
      source: 'test/FU-007',
    });

    expect(result).toMatchObject({ changed: false, reason: 'no-served-candidate' });
    expect(job).toEqual(before);
  });
});

describe('flatOnlyPreviousSlugs', () => {
  it('does not count a bucket for an unsupported locale as attribution', () => {
    expect(flatOnlyPreviousSlugs({
      previousSlugs: ['ruolo-storico', 'ruolo-attribuito'],
      previousSlugsByLocale: { es: ['ruolo-storico'], en: ['ruolo-attribuito'] },
    })).toEqual(['ruolo-storico']);
  });
});
