/**
 * sitemap-jobs.xml crawl-budget filters (seo/sitemap-crawl-budget).
 *
 * Lightweight unit tests for the shared filter predicate used by the sitemap
 * generator in `build-plugins/jobsSeoPagesPlugin.ts`. The generator itself is
 * a multi-thousand-line Vite plugin with filesystem side-effects, so these
 * fixtures exercise its eligibility contract without spawning a full build.
 *
 * The predicates under test:
 *   1. thin-content filter   — IT description must have >= 50 words
 *   2. needsRetranslation    — keep the source-locale IT canonical, skip jobs
 *                              whose IT copy is still pending translation
 *   3. locale indexability   — sitemap and HTML robots use the same localized
 *                              source-content and self-canonical decision
 *
 * Run: npx vitest run tests/jobs-sitemap-filters.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isActiveJobLocaleIndexable,
  isActiveJobLocaleSitemapEligible,
  isActiveJobSitemapEligible,
  type ActiveJobSitemapCandidate,
} from '../build-plugins/shared/activeJobSitemapEligibility';

interface SitemapJob extends ActiveJobSitemapCandidate {
  title?: string;
  company?: string;
  location?: string;
}

const descriptionWithWords = (count: number): string =>
  Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

const INDEXABLE_DESC = descriptionWithWords(50);
const CANONICAL_URL = 'https://frontaliereticino.ch/en/find-jobs-zurich/example/';
const selfCanonicalDecision = {
  canonicalUrl: CANONICAL_URL,
  effectiveCanonicalUrl: CANONICAL_URL,
  hasIndexableRenderedBody: true,
  sourceDetailWordCount: 50,
};

describe('sitemap-jobs.xml eligibility filter', () => {
  it('includes a normal job with ≥50 words IT description', () => {
    const job: SitemapJob = {
      title: 'Infermiere',
      company: 'EOC',
      location: 'Bellinzona',
      description: INDEXABLE_DESC,
    };
    expect(isActiveJobSitemapEligible(job)).toBe(true);
  });

  it('excludes jobs with thin content (<50 words) — preserves FRO-278 behaviour', () => {
    const job: SitemapJob = {
      title: 'Short',
      company: 'Acme',
      location: 'Lugano',
      description: descriptionWithWords(49),
    };
    expect(isActiveJobSitemapEligible(job)).toBe(false);
  });

  it('excludes non-IT source jobs whose IT translation is still pending', () => {
    const job: SitemapJob = {
      title: 'Store Manager',
      company: 'Prada',
      location: 'Zurich',
      description: INDEXABLE_DESC,
      needsRetranslation: true,
      sourceLang: 'en',
    };
    expect(isActiveJobSitemapEligible(job)).toBe(false);
  });

  it('keeps an IT-source job when only its foreign-locale translations are pending', () => {
    const job: SitemapJob = {
      description: INDEXABLE_DESC,
      needsRetranslation: true,
      sourceLang: 'it',
    };
    expect(isActiveJobSitemapEligible(job)).toBe(true);
  });

  it('defaults a missing source language to IT while translations are pending', () => {
    const job: SitemapJob = {
      description: INDEXABLE_DESC,
      needsRetranslation: true,
    };
    expect(isActiveJobSitemapEligible(job)).toBe(true);
  });

  it('keeps jobs where needsRetranslation is falsy (undefined / false)', () => {
    const jobUndef: SitemapJob = {
      description: INDEXABLE_DESC,
    };
    const jobFalse: SitemapJob = {
      description: INDEXABLE_DESC,
      needsRetranslation: false,
    };
    expect(isActiveJobSitemapEligible(jobUndef)).toBe(true);
    expect(isActiveJobSitemapEligible(jobFalse)).toBe(true);
  });

  it('prefers descriptionByLocale.it over description when both exist', () => {
    const job: SitemapJob = {
      description: 'short',
      descriptionByLocale: { it: INDEXABLE_DESC },
    };
    expect(isActiveJobSitemapEligible(job)).toBe(true);
  });

  it('strips HTML tags before counting words (so HTML-heavy descriptions are judged by text density)', () => {
    const tagged = `<p><strong>Benefits</strong></p>${'<li>word</li>'.repeat(49)}<p>final</p>`;
    const job: SitemapJob = { description: tagged };
    expect(isActiveJobSitemapEligible(job)).toBe(true);
  });

  it('excludes a locale that the renderer classifies as noindex even when the Italian group is eligible', () => {
    const job: SitemapJob = {
      descriptionByLocale: {
        it: INDEXABLE_DESC,
      },
    };

    expect(isActiveJobSitemapEligible(job)).toBe(true);
    expect(isActiveJobLocaleIndexable(job, 'en', {
      ...selfCanonicalDecision,
      hasIndexableRenderedBody: false,
      sourceDetailWordCount: 49,
    })).toBe(false);
  });

  it('preserves the renderer body branch when localized content is indexable', () => {
    const job: SitemapJob = {
      descriptionByLocale: { it: INDEXABLE_DESC },
    };

    expect(isActiveJobLocaleIndexable(job, 'en', {
      ...selfCanonicalDecision,
      hasIndexableRenderedBody: true,
      sourceDetailWordCount: 1,
    })).toBe(true);
  });

  it('preserves indexability from complete aggregated canonical source content', () => {
    const job: SitemapJob = {
      descriptionByLocale: { it: INDEXABLE_DESC },
    };

    expect(isActiveJobLocaleIndexable(job, 'fr', {
      ...selfCanonicalDecision,
      hasIndexableRenderedBody: false,
      sourceDetailWordCount: 50,
    })).toBe(true);
  });

  it('keeps a fallback-only renderer page indexable without advertising an unproven locale', () => {
    const job: SitemapJob = {
      descriptionByLocale: { it: INDEXABLE_DESC },
    };
    const sourceBackedPrepass = {
      ...selfCanonicalDecision,
      hasIndexableRenderedBody: false,
      sourceDetailWordCount: 49,
    };
    const renderedFallbackDecision = {
      ...sourceBackedPrepass,
      sourceDetailWordCount: 50,
    };

    expect(isActiveJobLocaleSitemapEligible(job, 'de', sourceBackedPrepass)).toBe(false);
    expect(isActiveJobLocaleIndexable(job, 'de', renderedFallbackDecision)).toBe(true);
  });

  it('excludes a locale whose emitted detail canonical points elsewhere', () => {
    const job: SitemapJob = {
      descriptionByLocale: { it: INDEXABLE_DESC, en: INDEXABLE_DESC },
    };

    expect(isActiveJobLocaleIndexable(job, 'en', {
      canonicalUrl: CANONICAL_URL,
      effectiveCanonicalUrl: 'https://frontaliereticino.ch/en/companies/example/',
      hasIndexableRenderedBody: true,
      sourceDetailWordCount: 50,
    })).toBe(false);
  });

  it('keeps the existing IT-source pending-translation policy for indexable locale pages', () => {
    const job: SitemapJob = {
      descriptionByLocale: {
        it: INDEXABLE_DESC,
        en: INDEXABLE_DESC,
      },
      needsRetranslation: true,
      sourceLang: 'it',
    };

    expect(isActiveJobLocaleIndexable(job, 'it', {
      ...selfCanonicalDecision,
    })).toBe(true);
    expect(isActiveJobLocaleIndexable(job, 'en', selfCanonicalDecision)).toBe(true);
  });

  it('keeps locale robots indexable when the separate Italian sitemap group is below threshold', () => {
    const job: SitemapJob = {
      descriptionByLocale: {
        it: descriptionWithWords(49),
        en: INDEXABLE_DESC,
      },
    };

    expect(isActiveJobLocaleIndexable(job, 'en', selfCanonicalDecision)).toBe(true);
    expect(isActiveJobLocaleSitemapEligible(job, 'en', selfCanonicalDecision)).toBe(false);
  });

  it('keeps locale robots independent when the Italian sitemap translation is pending', () => {
    const job: SitemapJob = {
      descriptionByLocale: {
        it: INDEXABLE_DESC,
        de: INDEXABLE_DESC,
      },
      needsRetranslation: true,
      sourceLang: 'de',
    };

    expect(isActiveJobLocaleIndexable(job, 'de', selfCanonicalDecision)).toBe(true);
    expect(isActiveJobLocaleSitemapEligible(job, 'de', selfCanonicalDecision)).toBe(false);
  });

  it('does not treat a keywords-only canonical record as prepass source evidence', () => {
    const source = readFileSync(
      new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('const resolveSourceBackedLocaleIndexabilitySignals =');
    const end = source.indexOf('const canonicalFallbackKeyForJobLocale =', start);
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain('const canonicalLocale = canonicalLocaleHasSignal(canonicalLocaleRaw)');
    expect(resolver).toContain('cleanItems(canonicalLocale?.keywords, 8)');
    expect(resolver).not.toContain('cleanItems(canonicalLocaleRaw?.keywords, 8)');
  });
});
