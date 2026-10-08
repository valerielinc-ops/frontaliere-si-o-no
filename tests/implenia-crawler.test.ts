import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPLENIA_KEY,
  IMPLENIA_COMPANY_NAME,
  isImpleniaJob,
  isTrustedDomain,
  impleniaDetailText,
  buildImpleniaJobUrl,
  dedupeImpleniaJobsByStableId,
  impleniaJobMatchKey,
} from '../scripts/lib/implenia-job-parser.mjs';
import { decodeHtmlEntitiesOnce, mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { extractMicrodataDescription } from '../scripts/lib/jobposting-jsonld.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Implenia crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IMPLENIA_KEY).toBe('implenia');
    expect(IMPLENIA_COMPANY_NAME).toBe('Implenia');
  });

  // ── isCompanyJob ──
  describe('isImpleniaJob', () => {
    it('matches by companyKey', () => {
      expect(isImpleniaJob({ companyKey: 'implenia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isImpleniaJob({ company: 'Implenia' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isImpleniaJob({ url: 'https://implenia.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isImpleniaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isImpleniaJob(null)).toBe(false);
      expect(isImpleniaJob(undefined)).toBe(false);
      expect(isImpleniaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://implenia.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.implenia.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer implenia ch')).toBe('developer-implenia-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  describe('URL entity decoding and stable requisition merge', () => {
    const entityTitle = 'G%C3%A9rant-d&apos;immeubles-commerciaux-%28hfx%29%2C-Gen%C3%A8ve%2C-80-100';
    const cleanTitle = "G%C3%A9rant-d'immeubles-commerciaux-%28hfx%29%2C-Gen%C3%A8ve%2C-80-100";
    const cleanUrl = 'https://jobs.implenia.com/job/' + cleanTitle + '/13849-de_DE';
    const entityUrl = 'https://jobs.implenia.com/job/' + entityTitle + '/13849-de_DE';

    it('decodes named and numeric HTML entities exactly once without touching percent-encoding', () => {
      expect(buildImpleniaJobUrl(entityTitle, '13849')).toBe(cleanUrl);
      expect(decodeHtmlEntitiesOnce('https://jobs.implenia.com/job/x?x=1&amp;y=&#39;2&#39;&amp;z=&quot;3&quot;'))
        .toBe('https://jobs.implenia.com/job/x?x=1&y=' + String.fromCharCode(39) + '2' + String.fromCharCode(39) + '&z="3"');
      expect(decodeHtmlEntitiesOnce('https://jobs.implenia.com/job/x?literal=&amp;amp;encoded=%26%27'))
        .toBe('https://jobs.implenia.com/job/x?literal=&amp;encoded=%26%27');
      expect(buildImpleniaJobUrl("G%C3%A9rant-d'immeubles-%28hfx%29", '13849')).toBe(
        "https://jobs.implenia.com/job/G%C3%A9rant-d'immeubles-%28hfx%29/13849-de_DE",
      );
    });

    it('uses the same stable key for the real entity and clean URL variants', () => {
      expect(impleniaJobMatchKey(entityUrl)).toBe('req:jobs.implenia.com:13849');
      expect(impleniaJobMatchKey(entityUrl)).toBe(impleniaJobMatchKey(cleanUrl));
    });

    it('collapses stored duplicates while retaining history and translations for the next merge', () => {
      const descriptionFr = 'Description française historique suffisamment longue pour rester conservée.';
      const descriptionIt = 'Descrizione italiana storica sufficientemente lunga per restare conservata.';
      const duplicateId = 'implenia-97ac7c77942b';
      const existing = [
        {
          id: duplicateId,
          url: entityUrl,
          applyUrl: entityUrl,
          crawledAt: '2026-10-08T09:25:20.584Z',
          titleByLocale: { fr: "Gérant d'immeubles commerciaux" },
          descriptionByLocale: { fr: descriptionFr },
          slugByLocale: { fr: 'gerant-fr' },
          previousSlugs: ['slug-fr-old'],
          previousSlugsByLocale: { fr: ['slug-fr-old'] },
        },
        {
          id: duplicateId,
          url: cleanUrl,
          applyUrl: cleanUrl,
          firstSeenAt: '2026-10-02T21:26:30.966Z',
          crawledAt: '2026-10-07T09:31:39.279Z',
          titleByLocale: { it: 'Responsabile di immobili commerciali' },
          descriptionByLocale: { it: descriptionIt },
          slugByLocale: { it: 'responsabile-it' },
          previousSlugs: ['slug-it-old'],
          previousSlugsByLocale: { it: ['slug-it-old'] },
        },
      ];

      const prepared = dedupeImpleniaJobsByStableId(existing, { normalizeUrls: true });
      expect(prepared).toHaveLength(1);
      expect(prepared[0].url).toBe(cleanUrl);
      expect(prepared[0].id).toBe(duplicateId);
      expect(prepared[0].firstSeenAt).toBe('2026-10-02T21:26:30.966Z');
      expect(prepared[0].titleByLocale).toMatchObject({
        fr: "Gérant d'immeubles commerciaux",
        it: 'Responsabile di immobili commerciali',
      });
      expect(prepared[0].descriptionByLocale).toMatchObject({ fr: descriptionFr, it: descriptionIt });
      expect(prepared[0].slugByLocale).toEqual({ it: 'responsabile-it' });
      expect(prepared[0].previousSlugs).toEqual(expect.arrayContaining(['slug-it-old', 'slug-fr-old', 'gerant-fr']));
      expect(prepared[0].previousSlugsByLocale.it).toEqual(expect.arrayContaining(['slug-it-old']));
      expect(prepared[0].previousSlugsByLocale.fr).toEqual(expect.arrayContaining(['slug-fr-old', 'gerant-fr']));

      const fresh = {
        id: 'implenia-fresh-hash',
        url: cleanUrl,
        applyUrl: cleanUrl,
        slug: 'gerant-fr',
        slugByLocale: { fr: 'gerant-fr' },
        title: "Gérant d'immeubles commerciaux",
        titleByLocale: { fr: "Gérant d'immeubles commerciaux" },
        description: descriptionFr,
        descriptionByLocale: { fr: descriptionFr },
        sourceLang: 'fr',
        crawledAt: '2026-10-08T10:00:00.000Z',
      };
      const merged = mergePreserveLocaleData(prepared, [fresh], {
        nowMs: Date.parse('2026-10-08T10:00:00.000Z'),
      });
      expect(merged).toHaveLength(1);
      expect(merged[0].id).toBe(duplicateId);
      expect(merged[0].firstSeenAt).toBe('2026-10-02T21:26:30.966Z');
      expect(merged[0].titleByLocale.it).toBe('Responsabile di immobili commerciali');
      expect(merged[0].descriptionByLocale.it).toBe(descriptionIt);
      expect(merged[0].slugByLocale.it).toBe('responsabile-it');
      expect(merged[0].previousSlugs).toContain('slug-it-old');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'implenia-abc123',
      slug: 'test-position-implenia-ch',
      slugByLocale: { de: 'test-position-implenia-ch' },
      company: 'Implenia',
      companyKey: 'implenia',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://implenia.com/jobs/test',
      source: 'Implenia Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^implenia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

describe('Implenia detail body (issue 5253)', () => {
  // Minimised jobs2web detail page (contact redacted): the vacancy is three
  // sibling itemprop="description" spans — company intro, tasks/profile,
  // offer.
  const html = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'implenia', 'detail-gesamtplanungsleiter.html'),
    'utf8',
  );
  const text = impleniaDetailText(extractMicrodataDescription(html));

  it('publishes all three description spans, not the company intro alone', () => {
    expect(text).toMatch(/^Als führender Schweizer Bau- und Immobiliendienstleister/);
    expect(text).toContain('## Das bewegst du');
    expect(text).toContain('## Deshalb gelingt es dir');
    expect(text).toContain('## Das bieten wir dir');
    expect(text).toContain('• 5 Wochen Ferien und 9 bezahlte Brückentage');
  });

  it('keeps list items on their own lines instead of one flat paragraph', () => {
    expect(text.match(/^• /gm)?.length).toBeGreaterThanOrEqual(20);
  });
});
