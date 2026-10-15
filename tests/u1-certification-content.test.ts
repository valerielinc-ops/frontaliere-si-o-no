import { describe, expect, it } from 'vitest';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { CAREER_LANDING_COPY } from '../build-plugins/careerLandingsCopy';
import itGuide from '../services/locales/it-guide';
import enGuide from '../services/locales/en-guide';
import deGuide from '../services/locales/de-guide';
import frGuide from '../services/locales/fr-guide';

const source = 'https://www.arbeit.swiss/it/persone-in-cerca-dimpiego/prestazioni-dellassicurazione';
const dictionaries = { it: itGuide, en: enGuide, de: deGuide, fr: frGuide };
const certificate = { it: /attesta i periodi/, en: /certifies Swiss insurance/, de: /bescheinigt Schweizer Versicherungs/, fr: /atteste les périodes/ };
const noTransfer = { it: /non trasferisce i contributi/, en: /does not transfer the contributions/, de: /Beiträge werden nicht übertragen/, fr: /ne transfère pas les cotisations/ };

describe('PD U1 certification rather than contribution transfer', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`describes the certificate in the UI dictionary (${locale})`, () => {
      const copy = dictionaries[locale]['guide.unemployment.ch.frontalieri3'];
      expect(copy).toMatch(certificate[locale]);
      expect(copy).toMatch(noTransfer[locale]);
    });
  }
  for (const locale of ['en', 'de', 'fr'] as const) {
    it(`sources the static guide without the invented twelve-month certificate threshold (${locale})`, () => {
      const copy = SECTION_EDITORIAL['/guida-frontaliere/disoccupazione-transfrontaliera'][locale].join(' ');
      expect(copy).toMatch(certificate[locale]);
      expect(copy).toMatch(noTransfer[locale]);
      expect(copy).toContain(`href="${source}"`);
      expect(copy).not.toMatch(/12 months|12 Monaten|12 mois/);
    });
  }
  it('distinguishes U1 and U2 in the contract guide and supplies an official source', () => {
    const guide = CAREER_LANDING_COPY.it['contratti-lavoro-frontalieri'];
    const prose = guide.sections.flatMap(section => section.paragraphs).join(' ');
    expect(prose).toContain('Il PD U1 certifica i periodi');
    expect(prose).toContain('Il PD U2 riguarda invece l’esportazione di prestazioni');
    expect(prose).not.toContain('Il trasferimento dei contributi richiede');
    expect(guide.sources.some(item => item.href === source)).toBe(true);
  });
});
