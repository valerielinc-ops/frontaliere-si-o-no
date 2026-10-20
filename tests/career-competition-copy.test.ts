import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCompetitionNoticeNarrative,
  renderCareerPageForTest,
} from '../build-plugins/careerLandingsPlugin';
import { CAREER_LANDING_COPY } from '../build-plugins/careerLandingsCopy';
import { CAREER_LOCALES } from '../build-plugins/careerLandingsData';

interface CompetitionDataset {
  concorsi: Array<{
    ref?: string | null;
    title?: string;
    organization?: string | null;
    location?: string | null;
    deadline?: string | null;
    url?: string;
  }>;
}

const dataset = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../data/seo/concorsi-ti.json', import.meta.url)),
    'utf8',
  ),
) as CompetitionDataset;

const notices = dataset.concorsi;
const datasetRefs = new Set(
  notices
    .map((notice) => notice.ref)
    .filter((ref): ref is string => Boolean(ref)),
);
const COMPETITION_REF = /\b\d{1,3}\/\d{2}\b/g;

describe('career competition copy provenance', () => {
  it.each(CAREER_LOCALES)(
    'does not hard-code a competition reference absent from the source snapshot (%s)',
    (locale) => {
      const copy = JSON.stringify(CAREER_LANDING_COPY[locale]);
      const refs = copy.match(COMPETITION_REF) ?? [];

      expect(refs.every((ref) => datasetRefs.has(ref))).toBe(true);
    },
  );

  it.each(CAREER_LOCALES)(
    'renders the current source records in the localized snapshot copy (%s)',
    (locale) => {
      const narrative = buildCompetitionNoticeNarrative(locale, notices);
      const page = renderCareerPageForTest({
        locale,
        id: 'concorsi-pubblici-lugano',
        dateStamp: '2026-10-05',
        snapshot: {
          liveCount: notices.length,
          fresh30Count: 0,
          medianSalaryChf: null,
          featured: [],
          topCities: [],
          topEmployers: [],
          competitionNotices: notices,
        },
        agencyCount: 0,
        concorsiCount: notices.length,
      });

      for (const ref of datasetRefs) {
        expect(narrative).toContain(ref);
        expect(page.html).toContain(ref);
      }
    },
  );
});
