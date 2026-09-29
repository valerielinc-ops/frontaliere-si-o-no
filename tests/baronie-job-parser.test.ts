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
import { buildBaronieLocalizedContent, parseBaronieDetailHtml, isSwissJob } from '../scripts/lib/baronie-job-parser.mjs';
import { dropBaronieFabricatedText } from '../scripts/update-baronie-jobs.mjs';

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

  it('finds the CH entry when jobLocation lists a non-Swiss office first', () => {
    const multiLocationJsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'JobPosting',
          title: 'Regional Sales Manager',
          hiringOrganization: { '@type': 'Organization', name: 'Baronie Group' },
          jobLocation: [
            {
              '@type': 'Place',
              address: { '@type': 'PostalAddress', addressCountry: 'BE', addressLocality: 'Bruges' },
            },
            {
              '@type': 'Place',
              address: { '@type': 'PostalAddress', addressCountry: 'CH', addressLocality: 'Caslano' },
            },
          ],
        },
      ],
    });
    const result = parseBaronieDetailHtml(detailHtml({ jsonLd: multiLocationJsonLd }));
    expect(result?.addressCountry).toBe('CH');
    expect(result?.location).toBe('Caslano');
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

// Issue 5253: the builder keyed the detail text as `it` whatever its
// language, and replaced a text of 100 characters or less with a paragraph
// about Baronie that it wrote. Now a text under the shared 50-word floor
// gives no description (thin-source path). Text: the opening of the live
// "Plant Manager" posting (baronie.com/en/jobs/plant-manager-caslano,
// 2026-09-29).
describe('buildBaronieLocalizedContent — the posting text only, in its own slot', () => {
  const SHORT_TEXT = 'As the Plant Manager of Chocolat Alprose, you oversee and coordinate the daily operations.';
  const LONG_TEXT = 'As the Plant Manager of Chocolat Alprose, you oversee and coordinate the daily operations of our production site in Caslano. With strong leadership skills and guided by our code of conduct, you act as a role model and motivate your team to achieve the production and quality targets of the company. You empower people to excel, ensuring that all safety measures are followed.';

  it('keeps an English text from 50 words up as it is, under `en`', () => {
    const content = buildBaronieLocalizedContent({ title: 'Plant Manager', location: 'Caslano', detailMarkdown: LONG_TEXT, sourceLang: 'en' });
    expect(content.description).toBe(LONG_TEXT);
    expect(content.descriptionByLocale).toEqual({ en: LONG_TEXT });
  });

  it('gives a text under 50 words no indexable text, not the old paragraph', () => {
    const content = buildBaronieLocalizedContent({ title: 'Plant Manager', location: 'Caslano', detailMarkdown: SHORT_TEXT, sourceLang: 'en' });
    expect(content.description).toBe('');
    expect(content.descriptionByLocale).toEqual({});
  });

  it('gives a posting without text no description', () => {
    const content = buildBaronieLocalizedContent({ title: 'Plant Manager', location: 'Caslano', detailMarkdown: '', sourceLang: 'en' });
    expect(content.description).toBe('');
    expect(content.descriptionByLocale).toEqual({});
  });
});

// Stored records of the former fallback paragraph (issue 5253): dropped
// before the merge with the translations made from it.
describe('dropBaronieFabricatedText', () => {
  const INVENTED = 'Chocolat Alprose SA, azienda svizzera del gruppo Baronie specializzata nella produzione di cioccolato premium, cerca un profilo Plant Manager per la sede di Caslano. Candidati tramite il portale ufficiale.';

  it('leaves no invented entry in a stored job', () => {
    const job: any = { sourceLang: 'it', description: INVENTED, descriptionByLocale: { it: INVENTED, en: 'Chocolat Alprose SA, a Swiss company of the Baronie group…' } };
    expect(dropBaronieFabricatedText(job)).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
  });

  it('leaves a stored job with the posting text alone', () => {
    const job: any = { sourceLang: 'en', description: 'As the Plant Manager…', descriptionByLocale: { en: 'As the Plant Manager…', it: 'Come Responsabile…' } };
    expect(dropBaronieFabricatedText(job)).toBe(false);
  });
});
