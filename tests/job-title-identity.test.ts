import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dedupeAdjacentTitleWords,
  jobDisplayTitle,
  localeTitleDropsSourceWords,
  originalJobTitle,
} from '../scripts/lib/job-title-identity.mjs';
import { buildSlimSeed } from '../build-plugins/shared/slimJobIndex';
import { buildJobListEntry } from '../build-plugins/shared/jobListEntry';

// Cases observed live on 2026-10-23 (SEO plan, «Job tradotti male»): the
// language variants showed a machine translation of the employer's title.
const PEMSA = {
  id: 'pemsa-m1-m2-lugano',
  sourceLang: 'it',
  title: 'Macchinista M1, M2,M3',
  titleByLocale: { it: 'Macchinista M1, M2,M3', en: 'M1, M2', de: 'M1, M2', fr: 'M1, M2' },
  slugByLocale: { it: 'macchinista-m1-m2-pemsa-lugano', de: 'm1-m2-pemsa-lugano' },
  company: 'PEMSA',
  location: 'Lugano',
};
const FIELMANN = {
  sourceLang: 'de',
  title: 'Optometrist/Augenoptikermeister (w/m/d)',
  titleByLocale: {
    de: 'Optometrist/Augenoptikermeister (w/m/d)',
    it: 'Optometristo/Augenoptikermeister (m/f/d)',
    en: 'Optometrist/eye optic master (m/f/d)',
    fr: 'Maître Optométriste/Oeil optique (h/f/d)',
  },
};
const SPONTANEOUS = {
  sourceLang: 'de',
  title: 'Spontanbewerbung Dipl. Pflegefachfrau HF',
  titleByLocale: { de: 'Spontanbewerbung Dipl. Pflegefachfrau HF', it: 'Applicazione spontanea Dipl. Infermiera HF' },
};
const TRAINING = {
  sourceLang: 'de',
  title: 'Ausbildung dipl. Pflegefachperson HF',
  titleByLocale: { de: 'Ausbildung dipl. Pflegefachperson HF', it: 'Allenamento per dipl. Carriera HF' },
};

describe('jobDisplayTitle — the employer title survives every locale variant', () => {
  it.each([
    ['PEMSA «M1, M2» (trade dropped by the translation)', PEMSA, 'Macchinista M1, M2,M3'],
    ['Fielmann «Optometristo»', FIELMANN, 'Optometrist/Augenoptikermeister (w/m/d)'],
    ['«Applicazione spontanea Dipl. Infermiera HF»', SPONTANEOUS, 'Spontanbewerbung Dipl. Pflegefachfrau HF'],
    ['«Allenamento per dipl. Carriera HF»', TRAINING, 'Ausbildung dipl. Pflegefachperson HF'],
  ])('%s', (_label, job, expected) => {
    expect(jobDisplayTitle(job)).toBe(expected);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      // The slim index / seed is what the SPA paints and re-heads with.
      expect(buildSlimSeed(job, locale).title).toBe(expected);
      expect(buildJobListEntry(job, { locale, url: 'https://frontaliereticino.ch/x/', baseUrl: 'https://frontaliereticino.ch' })?.name).toBe(expected);
    }
  });

  it('collapses a word repeated back-to-back («Legale Legale Servizio Legale…»)', () => {
    expect(dedupeAdjacentTitleWords('Legale Legale Servizio Legale')).toBe('Legale Servizio Legale');
    expect(jobDisplayTitle({ title: 'Legale  legale Servizio Legale (80-100%)' })).toBe('Legale Servizio Legale (80-100%)');
    // Trailing punctuation of the dropped twin is kept.
    expect(dedupeAdjacentTitleWords('Giurista Giurista, Servizio legale')).toBe('Giurista, Servizio legale');
  });

  it('leaves intentional repeats alone', () => {
    expect(dedupeAdjacentTitleWords('Legale, Legale e Compliance')).toBe('Legale, Legale e Compliance');
    expect(dedupeAdjacentTitleWords('Baden-Baden Hotel')).toBe('Baden-Baden Hotel');
    expect(dedupeAdjacentTitleWords('Mitarbeiter/in Verkauf 80 80%')).toBe('Mitarbeiter/in Verkauf 80 80%');
  });

  it('falls back to the source-locale slot only when the record has no title', () => {
    expect(originalJobTitle({ sourceLang: 'de', titleByLocale: { it: 'Infermiera', de: 'Pflegefachfrau' } })).toBe('Pflegefachfrau');
    expect(originalJobTitle({ titleByLocale: { en: 'Nurse' } })).toBe('Nurse');
    expect(originalJobTitle(null)).toBe('');
  });
});

describe('localeTitleDropsSourceWords — a truncation is not a translation', () => {
  it('detects the trade dropped from the PEMSA title', () => {
    expect(localeTitleDropsSourceWords('M1, M2', 'Macchinista M1, M2,M3')).toBe(true);
  });
  it('does not flag a dropped gender code, a copy, or a real translation', () => {
    expect(localeTitleDropsSourceWords('Software Engineer', 'Software Engineer (m/w/d)')).toBe(false);
    expect(localeTitleDropsSourceWords('Macchinista M1, M2,M3', 'Macchinista M1, M2,M3')).toBe(false);
    expect(localeTitleDropsSourceWords('Optometrist/eye optic master', 'Optometrist/Augenoptikermeister')).toBe(false);
    expect(localeTitleDropsSourceWords('', 'Macchinista')).toBe(false);
  });
});

// Observer: the display sites of a job title must read the shared helper. A
// new `titleByLocale?.[locale] … .title` display expression in these files
// would bring the machine-translated title back on the job pages. The
// remaining occurrences are SEARCH / SLUG inputs (allowlisted with the reason)
// and are pinned by count so a new one has to be classified here.
const ROOT = resolve(__dirname, '..');
const LOCALE_TITLE_RE = /titleByLocale\?\.\[(?:locale|entry\.locale)\]/g;
const ALLOWED_LOCALE_TITLE_READS: Record<string, { count: number; why: string }> = {
  'build-plugins/jobsSeoPagesPlugin.ts': { count: 1, why: 'localizedSlug() last-resort slug fallback' },
  'components/community/JobBoard.tsx': { count: 5, why: 'search haystack, related-article matching, slug fallback, query suggestions (x2)' },
  'components/community/JobBridgeView.tsx': { count: 0, why: '' },
  'components/community/JobExpiredView.tsx': { count: 0, why: '' },
  'components/jobs/EmployerBrandHub.tsx': { count: 0, why: '' },
  'build-plugins/shared/jobListEntry.ts': { count: 0, why: '' },
  'services/seoService.ts': { count: 0, why: '' },
};

describe('job title display sites use jobDisplayTitle', () => {
  it.each(Object.entries(ALLOWED_LOCALE_TITLE_READS))('%s', (file, { count }) => {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    expect(source.match(LOCALE_TITLE_RE)?.length ?? 0).toBe(count);
  });
});
