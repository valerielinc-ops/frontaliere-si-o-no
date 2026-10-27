import { describe, expect, it } from 'vitest';
import {
  classifyLiveJobCandidate,
  crawlIsAfterBuild,
  extractRichResultsIssues,
  isLikelyJobDetailUrl,
  inspectLiveJobPostingHtml,
} from '../../scripts/verify-post-deploy-seo.mjs';

const completeJobPosting = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Addetto alla logistica',
  description: 'Descrizione completa del ruolo con responsabilità, requisiti e condizioni di lavoro dettagliate.',
  datePosted: '2026-10-20T08:00:00.000Z',
  validThrough: '2026-12-20T08:00:00.000Z',
  hiringOrganization: { name: 'Test AG' },
  jobLocation: {
    address: {
      addressLocality: 'Bellinzona',
      addressRegion: 'TI',
      addressCountry: 'CH',
      streetAddress: 'Via Test 1',
      postalCode: '6500',
    },
  },
  employmentType: 'FULL_TIME',
  baseSalary: {
    currency: 'CHF',
    value: { minValue: 60000, unitText: 'YEAR' },
  },
};

function jsonLd(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

describe('post-deploy SEO verification', () => {
  it('classifies a live JobPosting from its JSON-LD contract', () => {
    const result = inspectLiveJobPostingHtml(jsonLd(completeJobPosting));

    expect(result.isJobPage).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not classify a BreadcrumbList-only landing page as a job page', () => {
    const result = inspectLiveJobPostingHtml(jsonLd({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [],
    }));

    expect(result.isJobPage).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('classifies CollectionPage and ItemList JSON-LD as a listing landing', () => {
    const result = inspectLiveJobPostingHtml(jsonLd([
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: [],
      },
    ]));

    expect(result.isJobPage).toBe(false);
    expect(result.isListingPage).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps a detail candidate observable when its JobPosting JSON-LD disappears', () => {
    const pageUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/job-slug/';
    const live = inspectLiveJobPostingHtml(jsonLd({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [],
    }));
    const classification = classifyLiveJobCandidate(pageUrl, live, new Map());

    expect(isLikelyJobDetailUrl(pageUrl, new Map())).toBe(true);
    expect(classification).toMatchObject({
      detailPageSignal: true,
      shouldInspect: true,
      issue: 'missing-jobposting',
      skipped: false,
    });
  });

  it('preserves the detail signal when the live fetch is unavailable', () => {
    const pageUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/job-slug/';
    const classification = classifyLiveJobCandidate(
      pageUrl,
      { error: 'request timed out' },
      new Map(),
    );

    expect(classification).toMatchObject({
      detailPageSignal: true,
      shouldInspect: true,
      issue: null,
      skipped: false,
    });
  });

  it('uses a live sitemap signal to keep a known landing out of missing-schema alerts', () => {
    const pageUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermieri-in-ticino/';
    const signals = new Map([[pageUrl, false]]);

    expect(isLikelyJobDetailUrl(pageUrl, signals)).toBe(false);
    expect(classifyLiveJobCandidate(pageUrl, {
      isJobPage: false,
      errors: [],
    }, signals)).toMatchObject({
      shouldInspect: false,
      issue: null,
      skipped: true,
    });
  });

  it('does not use the conservative detail fallback for a semantic listing page', () => {
    const pageUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermieri/';

    expect(classifyLiveJobCandidate(pageUrl, {
      isJobPage: false,
      isListingPage: true,
      errors: [],
    }, new Map())).toMatchObject({
      shouldInspect: false,
      issue: null,
      skipped: true,
    });
  });

  it('preserves the detail signal when live HTML is unavailable', () => {
    const pageUrl = 'https://frontaliereticino.ch/cerca-lavoro-ticino/job-slug/';

    expect(classifyLiveJobCandidate(pageUrl, { error: 'timeout' }, new Map())).toMatchObject({
      detailPageSignal: true,
      shouldInspect: true,
      issue: null,
      skipped: false,
    });
  });

  it('reports missing fields from the live shared contract', () => {
    const incomplete: Record<string, unknown> = { ...completeJobPosting };
    delete incomplete.baseSalary;
    const result = inspectLiveJobPostingHtml(jsonLd(incomplete));

    expect(result.errors.map(({ field }) => field)).toContain('baseSalary');
  });

  it('keeps only JobPosting field issues from URL Inspection', () => {
    const issues = extractRichResultsIssues({
      richResultsResult: {
        detectedItems: [
          {
            richResultType: 'Breadcrumbs',
            items: [{ issues: [{ issueMessage: 'ignore this' }] }],
          },
          {
            richResultType: 'Job Postings',
            items: [{
              issues: [{ issueMessage: "Missing field 'baseSalary'", severity: 'ERROR' }],
            }],
          },
        ],
      },
    });

    expect(issues).toEqual([{
      type: 'Job Postings',
      severity: 'ERROR',
      message: "Missing field 'baseSalary'",
    }]);
  });

  it('does not treat a pre-deploy GSC crawl as evidence about the live build', () => {
    const build = Date.parse('2026-10-27T01:00:00.000Z');

    expect(crawlIsAfterBuild('2026-10-27T02:00:00.000Z', build)).toBe(true);
    expect(crawlIsAfterBuild('2026-10-27T00:59:59.000Z', build)).toBe(false);
    expect(crawlIsAfterBuild(null, build)).toBe(false);
    expect(crawlIsAfterBuild(null, null)).toBe(true);
  });
});
