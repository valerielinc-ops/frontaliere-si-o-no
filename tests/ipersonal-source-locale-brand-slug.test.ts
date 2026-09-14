import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildSlug, slugNeedsBrandRefresh } from '../scripts/lib/regenerate-slugs-helpers.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const SLICE_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');

type Job = {
  id: string;
  company?: string;
  location?: string;
  addressLocality?: string;
  sourceLang?: string;
  slug?: string;
  slugDisambiguator?: string;
  titleByLocale?: Record<string, string>;
  slugByLocale?: Record<string, string>;
  previousSlugsByLocale?: Record<string, string[]>;
};

function readSlice(key: string): Job[] {
  const file = path.join(SLICE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

/** Brand della chiave crawler precedente, non della company rietichettata. */
const STALE_BRAND_BY_KEY: Record<string, RegExp> = {
  ipersonal: /(^|-)ipersonal(?:-ch)?(?:-|$)/,
  'med-ipersonal': /(^|-)med-?ipersonal(?:-ch)?(?:-|$)/,
};

describe('#7722 source-locale brand refresh', () => {
  it('refreshes a stale source slug and preserves the old route as a bridge', () => {
    const sourceTitle = 'Techniker Elektronik 100%';
    const oldSlug = 'techniker-elektronik-100-med-ipersonal-ch';
    const location = 'Nottwil, Luzern';
    const company = 'iPersonal AG';
    const canonical = buildSlug(sourceTitle, company, location);

    expect(slugNeedsBrandRefresh({
      isBrandRelabelledKey: true,
      currentSlug: oldSlug,
      title: sourceTitle,
      company,
      location,
    })).toBe(true);
    expect(canonical).toContain('ipersonal-ag');
    expect(canonical).not.toContain('med-ipersonal');

    const previousSlugsByLocale = { de: [oldSlug] };
    expect(previousSlugsByLocale.de).toContain(oldSlug);
  });

  it('mantiene le due slice mono-datore e presenti', () => {
    for (const key of Object.keys(STALE_BRAND_BY_KEY)) {
      const jobs = readSlice(key);
      expect(jobs.length, `${key} vuota`).toBeGreaterThan(0);
      expect(new Set(jobs.map((job) => job.company)).size, `${key} non mono-datore`).toBe(1);
    }
  });

  it('rende canonico lo slug del source-locale includendo la company dichiarata', () => {
    for (const key of Object.keys(STALE_BRAND_BY_KEY)) {
      for (const job of readSlice(key)) {
        const locale = job.sourceLang || 'it';
        const expected = buildSlug(
          job.titleByLocale?.[locale],
          job.company,
          job.location || job.addressLocality || '',
          job.slugDisambiguator || '',
        );
        expect(job.slugByLocale?.[locale], `${key}/${job.id}`).toBe(expected);
      }
    }
  });

  it('non lascia il brand della chiave precedente in nessuno slug attivo', () => {
    for (const [key, staleBrand] of Object.entries(STALE_BRAND_BY_KEY)) {
      for (const job of readSlice(key)) {
        const active = [job.slug, ...LOCALES.map((locale) => job.slugByLocale?.[locale])]
          .filter(Boolean)
          .map(String);
        expect(active.filter((slug) => staleBrand.test(slug)), `${key}/${job.id}`).toEqual([]);
      }
    }
  });

  it('conserva nel bridge ogni source slug sostituito', () => {
    for (const key of Object.keys(STALE_BRAND_BY_KEY)) {
      for (const job of readSlice(key)) {
        const locale = job.sourceLang || 'it';
        const active = job.slugByLocale?.[locale] || '';
        const previous = job.previousSlugsByLocale?.[locale] || [];
        expect(previous.filter((slug) => slug !== active), `${key}/${job.id}`).not.toEqual([]);
      }
    }
  });
});
