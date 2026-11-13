import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeJobsSplitPlugin } from '../build-plugins/localeJobsSplitPlugin';
import { buildLocaleJob } from '../build-plugins/shared/slimJobIndex';

const date = '2026-01-01';
const atsApplicationForm = {
  provider: 'ncoreplat',
  sourceUrl: 'https://app.ncoreplat.com/jobposition/808005/cmc-senior-specialist/sintetica',
  checkedAt: '2026-11-12T12:00:00.000Z',
  stage: 'Inoltra ora la candidatura',
  fields: [{ label: 'Nome', type: 'text', required: true, kind: 'question' }],
};
describe('localized and per-job detail data projection', () => {
  it.each(['reported', 'unknown', undefined])('preserves %s provenance without backfilling legacy', (postingDateSource) => {
    const root = mkdtempSync(join(tmpdir(), 'date-projection-'));
    try {
      mkdirSync(join(root, 'data'));
      const sourceJob = {
        id: 'publication-projection', slug: 'publication-projection', title: 'Infermiere',
        company: 'Example SA', location: 'Lugano', canton: 'TI', description: 'Assistenza ai pazienti.',
        titleByLocale: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier' },
        descriptionByLocale: {
          it: 'Assistenza ai pazienti.', en: 'Patient care.', de: 'Betreuung von Patienten.', fr: 'Soins aux patients.',
        },
        slugByLocale: { it: 'infermiere', en: 'nurse', de: 'pflegefachperson', fr: 'infirmier' },
        postingDateSource, datePosted: date, postedDate: date,
        atsApplicationForm,
      };
      writeFileSync(join(root, 'data/jobs.json'), JSON.stringify([sourceJob]));
      (localeJobsSplitPlugin(root).closeBundle as () => void)();
      for (const locale of ['it', 'en', 'de', 'fr']) {
        expect(buildLocaleJob(sourceJob, locale).atsApplicationForm).toEqual(atsApplicationForm);
        for (const suffix of ['index', 'index-first']) {
          const [record] = JSON.parse(readFileSync(join(root, 'dist/data', `jobs-${locale}-${suffix}.json`), 'utf8'));
          expect(record.postingDateSource).toBe(postingDateSource);
          expect(record.datePosted).toBe(date);
          expect(record.postedDate).toBe(date);
        }
      }
      const detail = JSON.parse(readFileSync(join(root, 'dist/data/job-detail/publication-projection.json'), 'utf8'));
      expect(detail.postingDateSource).toBe(postingDateSource);
      expect(detail.datePosted).toBe(date);
      expect(detail.description).toBe('Assistenza ai pazienti.');
      expect(detail.atsApplicationForm).toEqual(atsApplicationForm);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
