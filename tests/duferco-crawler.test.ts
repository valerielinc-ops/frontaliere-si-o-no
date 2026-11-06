import { describe, it, expect } from 'vitest';
import {
  DUFERCO_KEY,
  DUFERCO_COMPANY_NAME,
  isDufercoJob,
  isTrustedDomain,
  dufercoMatchKey,
} from '../scripts/lib/duferco-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('Duferco crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DUFERCO_KEY).toBe('duferco');
    expect(DUFERCO_COMPANY_NAME).toBe('Duferco');
  });

  // ── isCompanyJob ──
  describe('isDufercoJob', () => {
    it('matches by companyKey', () => {
      expect(isDufercoJob({ companyKey: 'duferco' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDufercoJob({ company: 'Duferco' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDufercoJob({ url: 'https://duferco.talentics.ai/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDufercoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDufercoJob(null)).toBe(false);
      expect(isDufercoJob(undefined)).toBe(false);
      expect(isDufercoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://duferco.talentics.ai/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.duferco.talentics.ai/job/456')).toBe(true);
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
      expect(slugify('Developer duferco ch')).toBe('developer-duferco-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'duferco-abc123',
      slug: 'test-position-duferco-ch',
      slugByLocale: { en: 'test-position-duferco-ch' },
      company: 'Duferco',
      companyKey: 'duferco',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://duferco.talentics.ai/jobs/test',
      source: 'Duferco Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^duferco-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Slug-stability bridge across a Talentics title edit (#1707 item 2) ──
  //
  // The public detail URL is `…/job/{jobId}` — the id never encodes the title,
  // so a title edit (which regenerates `slug = slugify(title duferco city)`)
  // must still merge old↔fresh by stable id and capture the old slug into
  // `previousSlugs`. Without that bridge the previously-indexed URL 404s →
  // de-index. This re-confirms the mechanism end-to-end for THIS parser, the
  // open question left by the #1699 adversarial review.
  describe('dufercoMatchKey — stable-id merge key', () => {
    it('extracts the /job/{id} token', () => {
      expect(dufercoMatchKey({ url: 'https://duferco.talentics.ai/job/12345' })).toBe('12345');
      expect(dufercoMatchKey({ url: 'https://duferco.talentics.ai/job/abc123' })).toBe('abc123');
    });

    it('stays stable under a future lang prefix or tracking query', () => {
      // Robustness the bare full-URL fallback lacks: a short non-numeric id
      // (< 6 digits) makes the default extractStableJobId fall back to the full
      // URL, which a `/it/` prefix or `?utm=…` would fragment. The explicit key
      // ignores everything but the `/job/{id}` token.
      const base = dufercoMatchKey({ url: 'https://duferco.talentics.ai/job/12345' });
      expect(dufercoMatchKey({ url: 'https://duferco.talentics.ai/it/job/12345' })).toBe(base);
      expect(dufercoMatchKey({ url: 'https://duferco.talentics.ai/job/12345?utm=x' })).toBe(base);
    });

    it('handles missing/empty url gracefully', () => {
      expect(dufercoMatchKey({})).toBe('');
      expect(dufercoMatchKey(null as unknown as { url?: string })).toBe('');
    });
  });

  describe('title-edit preserves id and bridges the old slug', () => {
    const baseFields = {
      company: 'Duferco',
      companyKey: 'duferco',
      companyDomain: 'duferco.talentics.ai',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      url: 'https://duferco.talentics.ai/job/12345',
      source: 'Duferco Dedicated Parser',
      sourceLang: 'en',
    };

    it('keeps stable id and captures the previous slug when Talentics edits the title', () => {
      const existing = {
        ...baseFields,
        id: 'duferco-12345',
        slug: 'software-engineer-duferco-lugano',
        slugByLocale: { en: 'software-engineer-duferco-lugano' },
        title: 'Software Engineer',
        titleByLocale: { en: 'Software Engineer' },
        description: 'Engineering role at Duferco in Lugano.',
        descriptionByLocale: { en: 'Engineering role at Duferco in Lugano.' },
      };
      // Fresh crawl: same jobId (→ same url + id), genuinely different title.
      const fresh = {
        ...baseFields,
        id: 'duferco-12345',
        slug: 'lead-platform-architect-duferco-lugano',
        slugByLocale: { en: 'lead-platform-architect-duferco-lugano' },
        title: 'Lead Platform Architect',
        titleByLocale: { en: 'Lead Platform Architect' },
        description: 'Architecture role at Duferco in Lugano.',
        descriptionByLocale: { en: 'Architecture role at Duferco in Lugano.' },
      };

      const merged = mergePreserveLocaleData([existing], [fresh], { matchKey: dufercoMatchKey });

      expect(merged).toHaveLength(1);
      const job = merged[0];
      // Stable id preserved — the merge matched old↔fresh despite the new slug.
      expect(job.id).toBe('duferco-12345');
      // Active slug is the new one…
      expect(job.slug).toBe('lead-platform-architect-duferco-lugano');
      // …and the old slug is captured as a redirect bridge (no 404 → no de-index).
      const bridged = [
        ...(job.previousSlugs || []),
        ...(job.previousSlugsByLocale?.en || []),
        ...(job.previousSlugsByLocale?.it || []),
      ];
      expect(bridged).toContain('software-engineer-duferco-lugano');
    });

    it('does NOT churn the slug for a token-extension wording change (stays stable)', () => {
      const existing = {
        ...baseFields,
        id: 'duferco-67890',
        url: 'https://duferco.talentics.ai/job/67890',
        slug: 'software-engineer-duferco-lugano',
        slugByLocale: { en: 'software-engineer-duferco-lugano' },
        title: 'Software Engineer',
        titleByLocale: { en: 'Software Engineer' },
        description: 'Engineering role.',
        descriptionByLocale: { en: 'Engineering role.' },
      };
      // Talentics prepends "Senior" — the old slug's tokens are all still present
      // (containment), so isSlugStable holds the slug instead of churning it.
      const fresh = {
        ...baseFields,
        id: 'duferco-67890',
        url: 'https://duferco.talentics.ai/job/67890',
        slug: 'senior-software-engineer-duferco-lugano',
        slugByLocale: { en: 'senior-software-engineer-duferco-lugano' },
        title: 'Senior Software Engineer',
        titleByLocale: { en: 'Senior Software Engineer' },
        description: 'Engineering role.',
        descriptionByLocale: { en: 'Engineering role.' },
      };

      const merged = mergePreserveLocaleData([existing], [fresh], { matchKey: dufercoMatchKey });
      expect(merged).toHaveLength(1);
      // Minor rewording → slug held stable, no spurious previousSlugs churn.
      expect(merged[0].slug).toBe('software-engineer-duferco-lugano');
    });
  });
});
