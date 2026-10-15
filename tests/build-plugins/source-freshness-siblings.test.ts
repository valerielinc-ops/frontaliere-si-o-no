// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderPage as renderMap } from '../../build-plugins/borderWaitMapPlugin';
import { __renderAgePageForTest, __renderEducationPageForTest } from '../../build-plugins/bfsSalaryLandingsPlugin';
import { __renderFaqHubPageForTest, __renderFaqEntryPageForTest } from '../../build-plugins/faqHubPlugin';
import { __renderPdfLandingPageForTest } from '../../build-plugins/pdfWhitepapersPlugin';
import { ALL_FAQ_HUB } from '../../data/faq-hub';
import { formatSourceDate } from '../../services/dataFreshness';
import { extractJsonLdBlocks, flattenSchemas } from '../post-build/seo-helpers';

const locales = ['it', 'en', 'de', 'fr'] as const;
const schema = (html: string, type: string) => flattenSchemas(extractJsonLdBlocks(html)).find((item) => item['@type'] === type);
const dateStamp = '2026-09-27';
const today = new Date('2026-09-27T10:00:00Z');
const generatedLabels = { it: 'Pagina generata', en: 'Page generated', de: 'Seite erstellt', fr: 'Page générée' };
const unknownReview = { it: 'Data di revisione non documentata', en: 'Review date not documented', de: 'Überprüfungsdatum nicht dokumentiert', fr: 'Date de révision non documentée' };

function crossingRow(html: string, slug: string): string {
  const row = html.match(new RegExp(`<li\\b[^>]*data-bw-crossing=(?:"${slug}"|${slug})[^>]*>[\\s\\S]*?</li>`))?.[0];
  expect(row).toBeDefined();
  return row!;
}

describe('border map observation freshness', () => {
  it.each(locales)('%s preserves the actual date and labels an expired reading', (locale) => {
    const observedAt = '2026-09-25T23:30:00.000Z';
    const html = renderMap({ locale, dateStamp, today, current: {
      updatedAt: observedAt,
      perCrossing: { 'chiasso-brogeda': { totalCrossingMinutes: 12, lastUpdate: observedAt } },
    } }).html;
    const row = crossingRow(html, 'chiasso-brogeda');
    expect(row).toContain('data-bw-data-state=stale');
    expect(row).toContain(`data-bw-observed-at=${Date.parse(observedAt)}`);
    expect(row).toContain(formatSourceDate(observedAt, locale, today));
    expect(schema(html, 'Map')?.dateModified).toBe(observedAt);
    expect(schema(html, 'Map')?.datePublished).toBeUndefined();
    expect(html).toContain(generatedLabels[locale]);
  });

  it.each([undefined, 'invalid', '2026-09-28T10:00:00Z'])('does not give a timestamp or live wait to an unverified reading (%s)', (lastUpdate) => {
    const html = renderMap({ locale: 'it', dateStamp, today, current: {
      updatedAt: null,
      perCrossing: { 'chiasso-brogeda': { totalCrossingMinutes: 12, lastUpdate } },
    } }).html;
    const row = crossingRow(html, 'chiasso-brogeda');
    expect(row).toContain('data-bw-data-state=unavailable');
    expect(row).toContain('Data osservazione non disponibile');
    expect(row).not.toContain('12 min');
    expect(row).not.toContain(dateStamp);
    expect(schema(html, 'Map')?.dateModified).toBeUndefined();
  });
});

describe('static document and source freshness', () => {
  const dataset = JSON.parse(readFileSync(resolve(__dirname, '../../data/seo/bfs-salary-by-age.json'), 'utf8'));
  it.each(locales)('%s BFS dates refer to the dataset and LSE wave', (locale) => {
    for (const result of [
      __renderAgePageForTest({ locale, age: 30, dateStamp }),
      __renderEducationPageForTest({ locale, eduId: 'universita', dateStamp }),
    ]) {
      expect(result.html).toContain(`${dataset.meta.waveYear} · ${generatedLabels[locale]}:`);
      expect(schema(result.html, 'WebPage')?.dateModified).toBe(new Date(dataset.meta.generatedAt).toISOString());
      expect(schema(result.html, 'WebPage')?.datePublished).toBeUndefined();
    }
  });

  it.each(locales)('%s FAQ hub and entries disclose that review dates are unknown', (locale) => {
    const entry = ALL_FAQ_HUB[0];
    for (const result of [
      __renderFaqHubPageForTest(locale, dateStamp),
      __renderFaqEntryPageForTest(entry, locale, dateStamp, new Set(), new Set(locales)),
    ]) {
      expect(result.html).toContain(unknownReview[locale]);
      expect(result.html).toContain(generatedLabels[locale]);
      expect(schema(result.html, 'WebPage')).toBeDefined();
      expect(schema(result.html, 'WebPage')?.dateModified).toBeUndefined();
      expect(schema(result.html, 'WebPage')?.datePublished).toBeUndefined();
    }
  });

  it('regenerating a PDF landing does not claim that the document was revised', () => {
    const guide = {
      filename: 'guida-completa-frontaliere-2026', title: 'Guida Completa Frontaliere 2026', subtitle: 'Guida per frontalieri',
      articleSlug: 'guida-completa-frontaliere', articleUrlSlug: 'guida-completa-diventare-frontaliere-svizzera', bodyText: 'Guida per frontalieri.',
    };
    for (const date of ['2026-09-26', '2026-09-27']) {
      const html = __renderPdfLandingPageForTest(guide, '100.0', date);
      expect(html).toContain('Data di revisione del documento non documentata');
      expect(html).toContain('Pagina generata:');
      expect(html).not.toContain('Aggiornato');
      expect(schema(html, 'DigitalDocument')).toBeDefined();
      expect(schema(html, 'DigitalDocument')?.dateModified).toBeUndefined();
      expect(schema(html, 'DigitalDocument')?.datePublished).toBeUndefined();
    }
  });
});
