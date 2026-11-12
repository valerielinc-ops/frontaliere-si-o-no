import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dedupeAdjacentTitleWords,
  jobDisplayTitle,
  jobSearchTitleText,
  localeTitleDropsSourceWords,
  localizedJobDisplayTitle,
  localizedJobTitleResolution,
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

describe('jobDisplayTitle — the identity title is the employer original', () => {
  it.each([
    ['PEMSA', PEMSA, 'Macchinista M1, M2,M3'],
    ['Fielmann', FIELMANN, 'Optometrist/Augenoptikermeister (w/m/d)'],
    ['Spontanbewerbung', SPONTANEOUS, 'Spontanbewerbung Dipl. Pflegefachfrau HF'],
    ['Ausbildung', TRAINING, 'Ausbildung dipl. Pflegefachperson HF'],
  ])('%s', (_label, job, expected) => {
    // Identity (dedup, matching, slug repair) never changes with the locale.
    expect(jobDisplayTitle(job)).toBe(expected);
    expect(originalJobTitle(job)).toBe(expected);
  });
});

// Owner decision 2026-11-10 (supersedes 2026-10-23): a page shows the title
// in its own language; the original only when the locale has no usable
// translation.
describe('localizedJobDisplayTitle — the page shows the title in its language', () => {
  const opts = (locale: string) => ({ locale, url: 'https://frontaliereticino.ch/x/', baseUrl: 'https://frontaliereticino.ch' });

  it('uses the translated slot of every locale that has one', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const expected = FIELMANN.titleByLocale[locale];
      expect(localizedJobDisplayTitle(FIELMANN, locale)).toBe(expected);
      expect(localizedJobTitleResolution(FIELMANN, locale)).toEqual({ title: expected, source: 'translation', reason: 'translated' });
      // The slim index / seed is what the SPA paints and re-heads with.
      expect(buildSlimSeed(FIELMANN, locale).title).toBe(expected);
      expect(buildJobListEntry(FIELMANN, opts(locale))?.name).toBe(expected);
    }
  });

  it('falls back to the original when the locale slot is missing', () => {
    expect(localizedJobTitleResolution(SPONTANEOUS, 'fr')).toEqual({
      title: 'Spontanbewerbung Dipl. Pflegefachfrau HF', source: 'original', reason: 'missing',
    });
    expect(buildSlimSeed(SPONTANEOUS, 'en').title).toBe('Spontanbewerbung Dipl. Pflegefachfrau HF');
    expect(localizedJobDisplayTitle(SPONTANEOUS, 'it')).toBe('Applicazione spontanea Dipl. Infermiera HF');
  });

  it('falls back to the original when the slot is a truncation, like the slug writers', () => {
    for (const locale of ['en', 'de', 'fr']) {
      expect(localizedJobTitleResolution(PEMSA, locale)).toEqual({
        title: 'Macchinista M1, M2,M3', source: 'original', reason: 'truncated',
      });
      expect(buildJobListEntry(PEMSA, opts(locale))?.name).toBe('Macchinista M1, M2,M3');
    }
  });

  it('accepts a regional locale tag and drops a translation-only closing period', () => {
    const job = {
      title: 'Schreiner/in für Service- und Unterhaltsarbeiten',
      titleByLocale: { it: 'Carpentiere per lavori di assistenza e manutenzione.', de: 'Schreiner/in für Service- und Unterhaltsarbeiten' },
    };
    expect(localizedJobDisplayTitle(job, 'it-CH')).toBe('Carpentiere per lavori di assistenza e manutenzione');
    // An abbreviation, or a period the employer's own title ends with, is kept.
    expect(localizedJobDisplayTitle({ title: 'Pflegefachperson HF', titleByLocale: { it: 'Infermiere Dipl.' } }, 'it')).toBe('Infermiere Dipl.');
    expect(localizedJobDisplayTitle({ title: 'Leiter Verkauf.', titleByLocale: { it: 'Responsabile vendite.' } }, 'it')).toBe('Responsabile vendite.');
  });

  it('keeps long and compound abbreviations the source writes with a period', () => {
    expect(localizedJobDisplayTitle({ title: 'Sachbearbeiter Kaufm. Abteilung', titleByLocale: { it: 'Impiegato Kaufm.' } }, 'it')).toBe('Impiegato Kaufm.');
    expect(localizedJobDisplayTitle({ title: 'Ingenieur Maschinenbau', titleByLocale: { it: 'Ingegnere Dipl.-Ing.' } }, 'it')).toBe('Ingegnere Dipl.-Ing.');
  });

  it('classifies a raw record with no translated slot as missing, never as flattened', () => {
    // The build tally reads raw dataset records: an empty `titleByLocale` is a
    // missing translation; only a record WITHOUT the field is a flattened one.
    expect(localizedJobTitleResolution({ title: 'Pfleger', titleByLocale: {} }, 'it').reason).toBe('missing');
    expect(buildSlimSeed({ id: 'raw', title: 'Pfleger' }, 'it').title).toBe('Pfleger');
  });

  it('full and flattened records of the same offer resolve to the same title (SPA share, head, card)', () => {
    for (const job of [PEMSA, FIELMANN, SPONTANEOUS, TRAINING]) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const seed = buildSlimSeed(job, locale);
        expect(localizedJobDisplayTitle(seed, locale)).toBe(localizedJobDisplayTitle(job, locale));
        // The SPA merges the slim record with its per-job detail (titleByLocale).
        expect(localizedJobDisplayTitle({ ...seed, titleByLocale: job.titleByLocale }, locale)).toBe(localizedJobDisplayTitle(job, locale));
      }
    }
  });

  it('returns the title of a locale-flattened record as is', () => {
    expect(localizedJobTitleResolution({ title: 'Infermiere' }, 'it')).toEqual({ title: 'Infermiere', source: 'translation', reason: 'flattened' });
    expect(localizedJobDisplayTitle(null, 'it')).toBe('');
  });

});

describe('job title helpers', () => {
  it('collapses a word repeated back-to-back («Legale Legale Servizio Legale…»)', () => {
    expect(dedupeAdjacentTitleWords('Legale Legale Servizio Legale')).toBe('Legale Servizio Legale');
    expect(jobDisplayTitle({ title: 'Legale  legale Servizio Legale (80-100%)' })).toBe('Legale Servizio Legale (80-100%)');
    // Trailing punctuation of the dropped twin is kept.
    expect(dedupeAdjacentTitleWords('Giurista Giurista, Servizio legale')).toBe('Giurista, Servizio legale');
    expect(dedupeAdjacentTitleWords('Legale (Legale)')).toBe('Legale (Legale)');
  });

  it('keeps localized title slots as search aliases', () => {
    expect(jobSearchTitleText({ title: 'Macchinista', titleByLocale: { de: 'Maschinist', fr: 'Conducteur' } }))
      .toContain('Maschinist');
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
// direct locale-slot read in these files could bring the machine-translated
// title back on the job pages. The
// remaining occurrences are non-display inputs (search / slug or
// employment-type inference), allowlisted with their reason and pinned by
// count so a new one has to be classified here.
const ROOT = resolve(__dirname, '..');
const LOCALE_TITLE_RE = /titleByLocale\?\.\[(?:locale|entry\.locale|loc)\]/g;
const ALLOWED_LOCALE_TITLE_READS: Record<string, { count: number; why: string }> = {
  'build-plugins/jobsSeoPagesPlugin.ts': { count: 1, why: 'localized title used only for employment-type workload inference' },
  'components/community/JobBoard.tsx': { count: 5, why: 'search haystack, related-article matching, slug fallback, query suggestions (x2)' },
  'components/community/JobBridgeView.tsx': { count: 0, why: '' },
  'components/community/JobExpiredView.tsx': { count: 0, why: '' },
  'components/jobs/EmployerBrandHub.tsx': { count: 0, why: '' },
  'build-plugins/shared/jobListEntry.ts': { count: 0, why: '' },
  'services/seoService.ts': { count: 0, why: '' },
};

describe('job title display sites read the shared helper, not raw titleByLocale', () => {
  it.each(Object.entries(ALLOWED_LOCALE_TITLE_READS))('%s', (file, { count }) => {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    expect(source.match(LOCALE_TITLE_RE)?.length ?? 0).toBe(count);
  });
});
