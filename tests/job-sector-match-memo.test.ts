import { describe, expect, it } from 'vitest';
import {
  SECTOR_HUB_KEYS,
  createJobSectorMatchMemo,
  jobMatchesSector,
  type SectorCountableJob,
} from '../build-plugins/jobSectorLanding';

const JOBS: SectorCountableJob[] = [
  { title: 'Infermiere/a diplomato/a', description: 'Reparto di medicina', company: 'EOC', location: 'Lugano' },
  {
    title: 'Mitarbeiter/in',
    titleByLocale: { de: 'Pflegefachperson HF', fr: 'Collaborateur', en: 'Staff' },
    description: 'Casa anziani OSCAM cerca personale',
    company: 'OSCAM',
    location: 'Pregassona',
  },
  { title: 'Junior IT', category: 'Security Officer', tags: ['cloud', 'network'] },
  { title: 'Autista C/E', descriptionByLocale: { fr: 'Chauffeur poids lourds' }, sector: 'Energia' },
  { title: 'Software Engineer', titleByLocale: { it: 'Sviluppatore software' }, tags: 'devops' },
  { title: '', description: '' },
];

const LOCALES = [undefined, 'it', 'en', 'de', 'fr'] as const;

describe('createJobSectorMatchMemo', () => {
  it('answers exactly like jobMatchesSector for every job × sector × locale, twice', () => {
    const memo = createJobSectorMatchMemo();
    for (let pass = 0; pass < 2; pass++) {
      for (const job of JOBS) {
        for (const sector of SECTOR_HUB_KEYS) {
          for (const locale of LOCALES) {
            expect(memo(job, sector, locale)).toBe(jobMatchesSector(job, sector, locale));
          }
        }
      }
    }
  });

  it('keeps locale scoping: a locale-only match does not leak to another locale', () => {
    const memo = createJobSectorMatchMemo();
    const job = JOBS[1];
    expect(memo(job, 'infermieri', 'de')).toBe(jobMatchesSector(job, 'infermieri', 'de'));
    expect(memo(job, 'infermieri', 'fr')).toBe(jobMatchesSector(job, 'infermieri', 'fr'));
  });

  it('falls back to the uncached matcher for an unknown locale', () => {
    const memo = createJobSectorMatchMemo();
    const job = JOBS[0];
    expect(memo(job, 'infermieri', 'xx' as never)).toBe(jobMatchesSector(job, 'infermieri', 'xx' as never));
  });
});
