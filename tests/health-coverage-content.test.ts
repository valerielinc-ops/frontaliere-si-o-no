import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import metadata from '../services/seo/seo-pages';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { FAQ_TRANSLATIONS } from '../services/seo/faq-translations';
import { renderHealthPremiumFrontalierContext } from '../build-plugins/healthPremiumsLandingPlugin';
import itCore from '../services/locales/it-core';
import enCore from '../services/locales/en-core';
import deCore from '../services/locales/de-core';
import frCore from '../services/locales/fr-core';

// EU EHIC guidance distinguishes necessary care on temporary stays from planned
// treatment and residence. FOPH requires S1 registration for residence-country care.
const locales = [
  ['it', /soggiorno temporaneo/, /medicalmente necessarie/, /cittadinanza/, /cure programmate/, /rimpatrio/, /Paese di (?:residenza|domicilio)/],
  ['en', /temporary stay/, /medically necessary/, /citizenship/, /planned treatment/, /repatriation/, /country of residence/],
  ['de', /vorübergehenden Aufenthalt/, /medizinisch notwendige/, /Staatsangehörigkeit/, /geplante[n]? Behandlungen/, /Rücktransport/, /Wohnsitzland/],
  ['fr', /séjour temporaire/, /médicalement nécessaires/, /nationalité/, /soins programmés/, /rapatriement/, /pays de résidence/],
] as const;
function faqAnswers(value: unknown): Array<{ name: string; text: string }> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(faqAnswers);
  const row = value as Record<string, unknown>;
  if (row['@type'] === 'Question' && typeof row.name === 'string') {
    const answer = row.acceptedAnswer;
    if (answer && typeof answer === 'object' && 'text' in answer && typeof answer.text === 'string') {
      return [{ name: row.name, text: answer.text }];
    }
  }
  return Object.values(row).flatMap(faqAnswers);
}
const coverageQuestions = [
  'Meglio LAMal o SSN per un frontaliere italiano?',
  'Se scelgo il SSN posso farmi curare in Svizzera?',
  "Come funziona l'assicurazione sanitaria per i frontalieri?",
  'Meglio scegliere LAMal svizzera o SSN italiano come assicurazione?',
  'Meglio scegliere LAMal o SSN italiano come frontaliere?',
];

describe('health coverage facts in served FAQ and landing copy', () => {
  it.each(locales)('%s preserves temporary-care limits and eligibility in each affected FAQ', (locale, ...conditions) => {
    const answers = locale === 'it'
      ? faqAnswers(metadata).filter(({ name }) => coverageQuestions.includes(name)).map(({ text }) => text)
      : coverageQuestions.map(question => FAQ_TRANSLATIONS[question][locale].a);
    expect(answers).toHaveLength(coverageQuestions.length);
    if (locale === 'it') {
      const selected = faqAnswers(metadata).filter(({ name }) => coverageQuestions.includes(name));
      expect(new Set(selected.map(({ name }) => name))).toEqual(new Set(coverageQuestions));
    }
    for (const answer of answers) {
      for (const condition of conditions) expect(answer).toMatch(condition);
      expect(answer).toContain('european-health-insurance-card_en');
    }
  });

  it.each(locales)('%s renders cantonal data as Swiss residence data and preserves S1', (locale, ...conditions) => {
    const html = renderHealthPremiumFrontalierContext({ locale, canton: 'Ticino', age: '26+', ageId: 'adulti-26-55', year: 2026, median: '400', min: '300', max: '500' });
    expect(html).toContain('S1');
    expect(html).toContain('cure-allestero-per-gli-assicurati-che-vivono-allestero');
    expect(html).toContain('2026');
    expect(html).toContain('400');
    for (const condition of conditions) expect(html).toMatch(condition);
    expect(html).toMatch(/Non sono premi per frontalieri|not premiums for cross-border|keine Prämien für Grenzgänger|pas les primes des frontaliers/);
    expect(html).not.toMatch(/5-25%|5-25 %|10-15|64 anni|64 years|64 ans/);
  });

  it.each(locales)('%s keeps the pillar guide consistent with temporary stays and S1', (locale, ...conditions) => {
    const guide = SECTION_EDITORIAL['/guida-frontaliere/lamal-frontalieri'][locale].join(' ');
    for (const condition of conditions) expect(guide).toMatch(condition);
    expect(guide).toContain('S1');
    expect(guide).not.toMatch(/7-11|solo per emergenze|typically better|typischerweise besser|convient typiquement mieux/);
  });

  it('removes undocumented personal attribution without relabelling it as editorial testimony', () => {
    for (const core of [itCore, enCore, deCore, frCore]) {
      expect(Object.hasOwn(core, 'seoContent.confronti.expertName')).toBe(false);
      expect(Object.hasOwn(core, 'seoContent.confronti.expertQuote')).toBe(false);
    }
    expect(JSON.stringify(metadata)).not.toContain('Laura Mantovani');
    expect(JSON.stringify(FAQ_TRANSLATIONS)).not.toContain('Laura Mantovani');
  });

  it('keeps the static Italian insurance paragraph aligned with TEAM scope', () => {
    const source = readFileSync('build-plugins/staticPagesPlugin.ts', 'utf8');
    const paragraph = source.split('Il SSN è finanziato dalla fiscalità')[1]?.split('`,')[0];
    expect(paragraph).toBeTruthy();
    expect(paragraph).toContain('medicalmente necessarie');
    expect(paragraph).toContain('soggiorno temporaneo');
    expect(paragraph).toContain('cittadinanza');
    expect(paragraph).toContain('cure programmate');
    expect(paragraph).not.toMatch(/EUR 50|EUR 150|salvo emergenze/);
  });
});
