import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const SURFACES = [
  'build-plugins/shared/jobPostingFaq.ts',
  'build-plugins/weeklyEmployersPlugin.ts',
  'build-plugins/editorialContent.ts',
  'build-plugins/staticPagesPlugin.ts',
  'services/seo/seo-pages.ts',
  'services/seo/howto-translations.ts',
  'services/seo/glossaryTermDefinitions.ts',
  'services/locales/it-guide.ts',
  'services/locales/en-guide.ts',
  'services/locales/de-guide.ts',
  'services/locales/fr-guide.ts',
];

describe('permesso G: dati SEM e SPOP su tutte le superfici', () => {
  it('non promette un rinnovo annuale: la SEM indica 5 anni o la durata del contratto', () => {
    const annual = /rinnovo annuale|rinnovo è annuale|rinnovo è automatico ogni anno|annual renewal|yearly renewal|jährliche Verlängerung|renouvellement annuel|renouvelé chaque année/i;
    for (const rel of SURFACES) expect(read(rel), rel).not.toMatch(annual);
  });

  it('non richiede una zona di frontiera, abolita per i cittadini UE/AELS', () => {
    const zone = /residenza nella zona di frontiera|residen\w* (?:with)?in the (?:20 km )?border zone|Wohnsitz in der (?:20-km-)?Grenzzone|Grenzzone des an den Kanton|zone frontali[eè]re du pays voisin|zona di frontiera dei 20 km/i;
    for (const rel of SURFACES) expect(read(rel), rel).not.toMatch(zone);
  });

  it('usa la tariffa SPOP e non più le forchette senza fonte', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(read(`services/locales/${locale}-guide.ts`)).toMatch(/'permits\.g\.cost': 'CHF 75 /);
    }
    for (const rel of SURFACES) expect(read(rel), rel).not.toMatch(/CHF 65-(?:85|100)/);
  });
});
