import { describe, expect, it } from 'vitest';
import { injectHomepageSeoContent } from '../build-plugins/staticPagesPlugin';
import { COMPARISONS_HUB_COPY } from '../build-plugins/comparisonsHubCopy';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import itFisco from '../services/locales/it-fisco';
import enFisco from '../services/locales/en-fisco';
import deFisco from '../services/locales/de-fisco';
import frFisco from '../services/locales/fr-fisco';

const SOURCES = ['https://www.ahv-iv.ch/p/880.i', 'https://servizi2.inps.it/servizi/gss/default.aspx'];
const locales = ['it', 'en', 'de', 'fr'] as const;
const transferConditions = {
  it: /non vengono trasferiti all’INPS/,
  en: /not transferred to INPS/,
  de: /nicht an die INPS übertragen/,
  fr: /ne sont pas transférées à l’INPS/,
};
const separateBenefits = {
  it: /ciascuno Stato calcola e paga/,
  en: /each country calculates and pays/,
  de: /Jeder Staat berechnet und zahlt/,
  fr: /chaque État calcule et verse/,
};
const insuranceConditions = {
  it: /assicurazione obbligatoria italiana/,
  en: /compulsory Italian/,
  de: /obligatorische[rn]? .*versicherung|obligatorischer Versicherung/,
  fr: /assurance italienne obligatoire|assurance obligatoire en Italie/,
};
const earlyWithdrawal = { it: /prima del pensionamento/, en: /before retirement/, de: /vor der Pensionierung/, fr: /avant la retraite/ };
const dictionaries = { it: itFisco, en: enFisco, de: deFisco, fr: frFisco };

describe('cross-border pension coordination in published copy', () => {
  for (const locale of locales) {
    it(`renders separate pensions and conditional occupational withdrawal (${locale})`, () => {
      const html = injectHomepageSeoContent('<html><body><main></main></body></html>', locale);
      expect(html).toMatch(transferConditions[locale]);
      expect(html).toMatch(separateBenefits[locale]);
      expect(html).toMatch(insuranceConditions[locale]);
      expect(html).not.toContain('convenzione bilaterale del 1962');
      for (const source of SOURCES) expect(html).toContain(`href="${source}`);
    });
    it(`keeps the comparison FAQ conditional and sourced (${locale})`, () => {
      const copy = COMPARISONS_HUB_COPY[locale];
      const answer = copy.faqs[3].answer;
      expect(answer).toMatch(insuranceConditions[locale]);
      expect(answer).toMatch(earlyWithdrawal[locale]);
      expect(answer).toContain(SOURCES[0]);
      expect(answer).not.toMatch(/7-8\s?%/);
    });
    it(`does not promise an unconditional lump sum in the return scenario (${locale})`, () => {
      const benefit = dictionaries[locale]['pension.returnIT1'];
      expect(benefit).toMatch(insuranceConditions[locale]);
      expect(benefit).toMatch(earlyWithdrawal[locale]);
      expect(benefit).not.toMatch(/5-10\s?%/);
    });
  }
  for (const locale of ['en', 'de', 'fr'] as const) {
    it(`keeps the severance guide consistent with mandatory insurance (${locale})`, () => {
      const copy = SECTION_EDITORIAL['/tfr-liquidazione-frontaliere'][locale].join(' ');
      expect(copy).toMatch(insuranceConditions[locale]);
      expect(copy).toContain(`href="${SOURCES[0]}"`);
      expect(copy).not.toMatch(/typically 5-8|typischerweise 5-8|typiquement de 5-8/);
    });
  }
});
