import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIstDescriptionFields, dropIstFabricatedText, isIstDetailJob, parseCountryCode } from '@/scripts/update-ist-jobs.mjs';

describe('IST country-code parsing', () => {
  it('keeps Swiss canton codes Swiss when they are the final location component', () => {
    expect(parseCountryCode('St. Gallen, SG')).toBe('CH');
    expect(parseCountryCode('Fribourg, FR')).toBe('CH');
  });

  it('retains a genuinely foreign final country code', () => {
    expect(parseCountryCode('Como, IT')).toBe('IT');
    expect(parseCountryCode('Zurich, FR')).toBe('FR');
  });
});

describe('IST detail tenant identity', () => {
  it('accepts the exact hyphenated IST tenant slug without a city allowlist', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      sourceUrl: 'https://jobs.inspirededu.com/job/international-school-of-ticino/12345/',
      location: 'Zürich, CH',
    })).toBe(true);
  });

  it('accepts an exact structured IST company name without relying on the portal host', () => {
    expect(isIstDetailJob({
      company: 'International School of Ticino',
      sourceUrl: 'https://jobs.inspirededu.com/job/campus-role/12345/',
      location: 'Lugano, CH',
    })).toBe(true);
  });

  it('accepts a generic city URL when the detail payload carries a verified facility field', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      facility: 'International School of Ticino — Lugano campus',
      sourceUrl: 'https://jobs.inspirededu.com/job/Lugano-Teacher/12345/',
      location: 'Lugano, CH',
    })).toBe(true);
  });

  it('rejects a generic city URL when the facility belongs to another Inspired school', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      facility: 'Sevenoaks School',
      sourceUrl: 'https://jobs.inspirededu.com/job/Zurich-Teacher/12345/',
      location: 'Zürich, CH',
    })).toBe(false);
  });

  it('accepts a generic city URL when the detail payload carries an exact tenant field', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      tenant: 'International School of Ticino',
      sourceUrl: 'https://jobs.inspirededu.com/job/Lugano-Teacher/12345/',
      location: 'Lugano, CH',
    })).toBe(true);
  });

  it('accepts a generic city URL when the detail body contains the official hiring sentence', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      sourceUrl: 'https://jobs.inspirededu.com/job/Lugano-Part-Time-Music-Teacher/12345/',
      description: 'The International School of Ticino is seeking an enthusiastic Music Teacher. About the School.',
      location: 'Lugano, CH',
    })).toBe(true);
  });

  it('rejects another Inspired tenant even when its description mentions IST', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      sourceUrl: 'https://jobs.inspirededu.com/job/seven-oaks-school/67890/',
      description: 'An opportunity to work with the International School of Ticino team.',
      location: 'Zürich, CH',
    })).toBe(false);
  });
});

// Fixture: the start of a live jobs.inspirededu.com posting text (2026-09-29).
describe('IST description fields', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'ist', 'inspired-description-cover-teacher.txt'), 'utf8').trim();

  it('publishes the posting text alone, keyed by its language', () => {
    const fields = buildIstDescriptionFields('Primary Cover Teacher', text, 'Lugano', 'TI');
    expect(fields.description).toBe(text);
    expect(fields.descriptionByLocale).toEqual({ en: text });
    expect(fields.description).not.toContain('The International School of Ticino (IST) is part of the Inspired Education Group');
  });

  it('removes the Italian blurb and the translations of the blurb-appended source from a stored job', () => {
    const job: any = {
      sourceLang: 'en',
      descriptionByLocale: {
        en: `${text}\n\nThe International School of Ticino (IST) is part of the Inspired Education Group, one of the world's leading premium school groups.`,
        it: 'Posizione aperta presso la International School of Ticino a Lugano.\nRuolo: Primary Cover Teacher.\n\nLa International School of Ticino (IST) fa parte di Inspired Education Group.',
      },
    };
    expect(dropIstFabricatedText(job)).toBe(true);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
    expect(job.needsRetranslation).toBe(true);
  });
});
