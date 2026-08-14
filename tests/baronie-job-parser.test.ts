/**
 * Tests for scripts/lib/baronie-job-parser.mjs
 *
 * Regression: baronie.com's JobPosting JSON-LD is now wrapped in an
 * `@graph` array (alongside LocalBusiness/Organization/BreadcrumbList
 * nodes) and `jobLocation` is now an array of Place objects instead of a
 * single object. The old flat `ld['@type'] === 'JobPosting'` check and
 * `job.jobLocation?.address` access silently failed to extract
 * addressCountry/company for every job, causing isSwissJob() to always
 * fall back to (often-empty) location-text detection and report 0 jobs.
 */
import { describe, expect, it } from 'vitest';
import { parseBaronieDetailHtml, isSwissJob } from '../scripts/lib/baronie-job-parser.mjs';

function detailHtml({
  title = 'IT Infrastructure Engineer',
  articleBody = '<h3>Responsibilities</h3><ul><li>Task one</li><li>Task two</li></ul>',
  jsonLd,
}: { title?: string; articleBody?: string; jsonLd: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<article class="s-entry__content s-text-markup">
  <h1 class="s-text-medium-large">${title}</h1>
  <div class="s-text-markup">${articleBody}</div>
</article>
</body>
</html>`;
}

const GRAPH_JSON_LD_NON_SWISS = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'JobPosting',
      title: 'IT Infrastructure Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Baronie Belgium NV' },
      jobLocation: [
        {
          '@type': 'Place',
          address: { '@type': 'PostalAddress', addressCountry: 'BE', addressLocality: 'Bruges' },
        },
      ],
    },
    { '@type': 'LocalBusiness', name: 'Baronie Belgium N.V.' },
    { '@type': 'Organization' },
    { '@type': 'BreadcrumbList', name: 'Breadcrumbs' },
  ],
});

const GRAPH_JSON_LD_SWISS = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'JobPosting',
      title: 'Production Operator',
      hiringOrganization: { '@type': 'Organization', name: 'Chocolat Alprose SA' },
      jobLocation: [
        {
          '@type': 'Place',
          address: { '@type': 'PostalAddress', addressCountry: 'CH', addressLocality: 'Caslano' },
        },
      ],
    },
    { '@type': 'LocalBusiness', name: 'Chocolat Alprose SA' },
  ],
});

describe('baronie-job-parser / parseBaronieDetailHtml — @graph JSON-LD', () => {
  it('extracts company and addressCountry from a JobPosting nested in @graph', () => {
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: GRAPH_JSON_LD_NON_SWISS }));
    expect(result?.company).toBe('Baronie Belgium NV');
    expect(result?.addressCountry).toBe('BE');
    expect(result?.location).toBe('Bruges');
  });

  it('handles jobLocation as an array of Place objects', () => {
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: GRAPH_JSON_LD_SWISS }));
    expect(result?.location).toBe('Caslano');
    expect(result?.addressCountry).toBe('CH');
  });

  it('isSwissJob correctly excludes a non-Swiss @graph-wrapped posting', () => {
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: GRAPH_JSON_LD_NON_SWISS }));
    expect(isSwissJob(result)).toBe(false);
  });

  it('isSwissJob correctly includes a Swiss @graph-wrapped posting', () => {
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: GRAPH_JSON_LD_SWISS }));
    expect(isSwissJob(result)).toBe(true);
  });

  it('still supports the legacy flat JobPosting shape (no @graph)', () => {
    const flatJsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Sales Manager',
      hiringOrganization: { '@type': 'Organization', name: 'Chocolat Alprose SA' },
      jobLocation: { address: { addressCountry: 'CH', addressLocality: 'Caslano' } },
    });
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: flatJsonLd }));
    expect(result?.addressCountry).toBe('CH');
    expect(result?.location).toBe('Caslano');
    expect(isSwissJob(result)).toBe(true);
  });
});
