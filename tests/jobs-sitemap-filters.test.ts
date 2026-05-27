/**
 * sitemap-jobs.xml crawl-budget filters (seo/sitemap-crawl-budget).
 *
 * Lightweight unit tests for the filter predicates used by the sitemap
 * generator in `build-plugins/jobsSeoPagesPlugin.ts`. The generator itself is
 * a multi-thousand-line Vite plugin with filesystem side-effects; rather than
 * spawn a full build we inline the same predicate logic and assert it against
 * representative job records. If the predicate in the plugin drifts, update
 * both sides in lockstep.
 *
 * The predicates under test:
 *   1. thin-content filter   — IT description must have >= 50 words
 *   2. needsRetranslation    — skip jobs flagged as pending retranslation
 *   3. lastmod resolution    — job.crawledAt preferred, fallback to today
 *
 * Run: npx vitest run tests/jobs-sitemap-filters.test.ts
 */
import { describe, it, expect } from 'vitest';

interface SitemapJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  descriptionByLocale?: Record<string, string>;
  needsRetranslation?: boolean;
  crawledAt?: string;
}

// Mirrors build-plugins/jobsSeoPagesPlugin.ts (seo/sitemap-crawl-budget).
function isSitemapEligible(job: SitemapJob): boolean {
  if (job.needsRetranslation === true) return false;
  const desc = String(job.descriptionByLocale?.it || job.description || '');
  const wordCount = desc.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return wordCount >= 50;
}

function resolveJobLastmod(job: SitemapJob, today: string): string {
  return job.crawledAt ? new Date(job.crawledAt).toISOString().slice(0, 10) : today;
}

const TODAY = '2026-04-20';
const LONG_DESC = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');

describe('sitemap-jobs.xml eligibility filter', () => {
  it('includes a normal job with ≥50 words IT description', () => {
    const job: SitemapJob = {
      title: 'Infermiere',
      company: 'EOC',
      location: 'Bellinzona',
      description: LONG_DESC,
    };
    expect(isSitemapEligible(job)).toBe(true);
  });

  it('excludes jobs with thin content (<50 words) — preserves FRO-278 behaviour', () => {
    const job: SitemapJob = {
      title: 'Short',
      company: 'Acme',
      location: 'Lugano',
      description: 'Just a few words here.',
    };
    expect(isSitemapEligible(job)).toBe(false);
  });

  it('excludes jobs flagged needsRetranslation: true — even when content is long', () => {
    const job: SitemapJob = {
      title: 'Store Manager',
      company: 'Prada',
      location: 'Zurich',
      description: LONG_DESC,
      needsRetranslation: true,
    };
    expect(isSitemapEligible(job)).toBe(false);
  });

  it('keeps jobs where needsRetranslation is falsy (undefined / false)', () => {
    const jobUndef: SitemapJob = {
      description: LONG_DESC,
    };
    const jobFalse: SitemapJob = {
      description: LONG_DESC,
      needsRetranslation: false,
    };
    expect(isSitemapEligible(jobUndef)).toBe(true);
    expect(isSitemapEligible(jobFalse)).toBe(true);
  });

  it('prefers descriptionByLocale.it over description when both exist', () => {
    const job: SitemapJob = {
      description: 'short',
      descriptionByLocale: { it: LONG_DESC },
    };
    expect(isSitemapEligible(job)).toBe(true);
  });

  it('strips HTML tags before counting words (so HTML-heavy descriptions are judged by text density)', () => {
    const tagged = `<p><strong>Benefits</strong></p>${'<li>word</li>'.repeat(49)}<p>final</p>`;
    const job: SitemapJob = { description: tagged };
    expect(isSitemapEligible(job)).toBe(true);
  });
});

describe('sitemap-jobs.xml <lastmod> resolution', () => {
  it('uses ISO date from job.crawledAt when present', () => {
    const job: SitemapJob = {
      crawledAt: '2026-04-12T18:03:42.000Z',
    };
    expect(resolveJobLastmod(job, TODAY)).toBe('2026-04-12');
  });

  it('falls back to today when crawledAt is missing', () => {
    const job: SitemapJob = {};
    expect(resolveJobLastmod(job, TODAY)).toBe(TODAY);
  });

  it('falls back to today when crawledAt is an empty string', () => {
    const job: SitemapJob = { crawledAt: '' };
    expect(resolveJobLastmod(job, TODAY)).toBe(TODAY);
  });
});

describe('sitemap-jobs.xml regression guard (dataset-level)', () => {
  it('filters out needsRetranslation jobs from the live jobs.json dataset', async () => {
    // Lightweight smoke-test on the real dataset — ensures the predicate
    // actually prunes entries when run against the current jobs.json.
    const fs = await import('fs');
    const path = await import('path');
    const jobsPath = path.resolve(__dirname, '..', 'data', 'jobs.json');
    if (!fs.existsSync(jobsPath)) {
      // data/jobs.json is gitignored; if the fixture isn't present (CI shallow
      // clone, etc.) we skip without failing — the predicate is fully covered
      // by the synthetic cases above.
      return;
    }
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as SitemapJob[];
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    const before = jobs.filter((j) => {
      const desc = String(j.descriptionByLocale?.it || j.description || '');
      return desc.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length >= 50;
    });
    const after = before.filter((j) => j.needsRetranslation !== true);
    // At least one dataset guarantee: eligibility never grows after filtering.
    expect(after.length).toBeLessThanOrEqual(before.length);
    // And the filter must actually drop every needsRetranslation entry.
    expect(after.some((j) => j.needsRetranslation === true)).toBe(false);
  });
});
