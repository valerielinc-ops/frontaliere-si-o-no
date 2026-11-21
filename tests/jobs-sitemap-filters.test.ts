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
 *
 * Run: npx vitest run tests/jobs-sitemap-filters.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
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
});
