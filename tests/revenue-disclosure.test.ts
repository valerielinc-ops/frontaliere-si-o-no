// The funding section said AdSense only while /go/ links carried referral codes,
// and the contact page sent readers to unnamed "professionals". Every surface now
// states the funding model, and pages with partner links carry a visible note.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeJobsPhrase } from '../build-plugins/jobBoardSeoPure';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { CHI_SIAMO_COPY } from '../components/pages/chiSiamoCopy';
import { FUNDING_SECTION_ID, REVENUE_MODEL, renderRevenueNoteHtml, revenueNote } from '../services/revenueDisclosure';
import { SLUG_TABLES } from '../services/routeSlugs.data';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

describe('revenue model', () => {
  it.each(LOCALES)('%s funding section names ads and partner links', (locale) => {
    const text = CHI_SIAMO_COPY[locale].funding.bullets!.join(' ');
    expect(CHI_SIAMO_COPY[locale].funding.title).toBe(REVENUE_MODEL[locale].title);
    expect(text).toContain('AdSense');
    expect(text).toContain('/go/');
    expect(text).toContain('rel="sponsored"');
  });

  it.each(LOCALES)('%s note links the funding section of the about page', (locale) => {
    const prefix = locale === 'it' ? '' : `/${locale}`;
    expect(revenueNote(locale).href).toBe(`${prefix}/${SLUG_TABLES[locale].chiSiamo}/#${FUNDING_SECTION_ID}`);
    expect(renderRevenueNoteHtml(locale)).toContain(revenueNote(locale).text);
  });

  it('every static surface with partner links renders the note', () => {
    expect(read('build-plugins/salaryHubContent.ts')).toContain('renderRevenueNoteHtml(locale)');
    expect(read('build-plugins/exchangeRatePagesPlugin.ts')).toContain('renderRevenueNoteHtml(locale)');
    expect(read('build-plugins/staticPagesPlugin.ts')).toContain("'/compara-servizi/cambio-franco-euro'");
    expect(read('components/comparators/CurrencyExchange.tsx')).toContain('<RevenueNote />');
  });

  it('the static about pages carry the funding section', () => {
    expect(read('build-plugins/staticPagesPlugin.ts')).toContain("renderRevenueModelHtml('it')");
    for (const locale of ['en', 'de', 'fr'] as const) {
      expect(SECTION_EDITORIAL['/chi-siamo'][locale].join(' ')).toContain(`id="${FUNDING_SECTION_ID}"`);
    }
  });
});

describe('contact page', () => {
  it('no longer recommends an unnamed consulting service', () => {
    const contact = [
      ...['en', 'de', 'fr'].flatMap((locale) => SECTION_EDITORIAL['/contattaci'][locale]),
      read('build-plugins/staticPagesPlugin.ts'),
    ].join(' ');
    for (const claim of [/servizio di consulenza dedicato/, /dedicated consulting/, /Beratungsservice/, /service de consultation dédié/, /we partner with licensed/]) {
      expect(contact).not.toMatch(claim);
    }
  });
});

describe('active job count', () => {
  it('comes from the dataset and states no number without one', () => {
    expect(activeJobsPhrase('it', 988)).toBe('988 posizioni attive in Canton Ticino');
    for (const locale of LOCALES) expect(activeJobsPhrase(locale, 0)).not.toMatch(/\d/);
  });

  it('no hand-written total survives', () => {
    expect(read('build-plugins/staticPagesPlugin.ts')).not.toMatch(/oltre 1\.500 posizioni|over 1,500 active/);
  });
});
