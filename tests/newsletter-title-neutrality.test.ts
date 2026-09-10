import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildNewsletter } from '@/services/newsletter-template.mjs';
import { getSeasonalUtilityContent } from '@/services/newsletter-seasonal.mjs';

const ROOT = resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const HTML_TITLES = {
  it: 'Il briefing della settimana',
  en: 'Your weekly briefing',
  de: 'Dein Wochenbrief',
  fr: 'Le briefing de la semaine',
};
const TITLE_KEYS = [
  'newsletter.weeklyTitle',
  'weeklyDigest.title',
  'weeklyDigest.preview.title',
  'weeklyDigest.preview.article1',
  'weeklyDigest.preview.article2',
];
const AUDIENCE_LABEL = /frontaliere|frontalier|grenzg[aä]nger|cross[- ]border/i;

const baseNewsletter = {
  exchangeRate: { rate: 0.94, previousRate: 0.95 },
  matchedJobs: [],
  totalJobs: 0,
  weeklyFact: { text: 'Un dato utile.', source: 'Test' },
  unsubscribeUrl: 'https://frontaliereticino.ch/u/test',
};

describe('newsletter titles stay audience-neutral', () => {
  it.each(LOCALES)('renders a localized neutral HTML title for %s', (locale) => {
    const html = buildNewsletter({ ...baseNewsletter, locale });
    expect(html).toContain(`<title>${HTML_TITLES[locale]}</title>`);
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).not.toMatch(AUDIENCE_LABEL);
  });

  it('keeps all localized signup and digest title keys audience-neutral', () => {
    for (const locale of LOCALES) {
      const source = readFileSync(resolve(ROOT, `services/locales/${locale}-core.ts`), 'utf8');
      for (const key of TITLE_KEYS) {
        const line = source.split('\n').find((candidate) => candidate.includes(`'${key}':`));
        expect(line, `${locale} missing ${key}`).toBeDefined();
        expect(line, `${locale}/${key} uses an audience label`).not.toMatch(AUDIENCE_LABEL);
      }
    }
  });

  it('keeps the legacy template tag neutral while it remains importable', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/newsletter-template.mjs'), 'utf8');
    const tagLines = source.split('\n').filter((line) => line.includes('weeklyTag:'));
    expect(tagLines).toHaveLength(4);
    for (const line of tagLines) expect(line).not.toMatch(AUDIENCE_LABEL);
  });

  it('keeps seasonal and preview article titles focused on the topic', () => {
    for (const locale of LOCALES) {
      for (let month = 0; month < 12; month++) {
        expect(getSeasonalUtilityContent(new Date(2026, month, 15), locale).title)
          .not.toMatch(AUDIENCE_LABEL);
      }
    }

    for (const file of ['services/newsletterPreview.ts', 'scripts/newsletter-qa.mjs']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      const titleLine = source.split('\n').find((line) => line.includes('Votazioni cantonali Ticino 2026:'));
      expect(titleLine, `${file} missing preview article title`).toBeDefined();
      expect(titleLine, `${file} uses an audience label`).not.toMatch(AUDIENCE_LABEL);
    }
  });
});
