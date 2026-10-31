import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import premiums from '../../data/health-premiums-eu/2026.json';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

type Tariffs = Record<string, { withoutAccident?: Record<string, number> }>;
const insurers = Object.values(premiums.countries.IT.insurers) as Array<{ premiums: Tariffs }>;
const rangeFor = (ageClass: string) => {
  const values = insurers.flatMap(i => Object.values(i.premiums[ageClass]?.withoutAccident ?? {}));
  return [Math.round(Math.min(...values)), Math.round(Math.max(...values))];
};

describe('premi LAMal per i residenti in Italia', () => {
  it('le cifre citate sono quelle della tabella UFSP in data/', () => {
    const [adultMin, adultMax] = rangeFor('26+');
    const [childMin, childMax] = rangeFor('0-18');
    expect(read('services/seo/seo-pages.ts')).toContain(`CHF ${adultMin}–${adultMax}/mese adulti da 26 anni, CHF ${childMin}–${childMax} bambini`);
    expect(read('build-plugins/editorialContent.ts')).toContain(`CHF ${adultMin}-${adultMax}/month`);
  });

  it('non torna la forchetta senza fonte per i frontalieri', () => {
    for (const rel of ['services/seo/seo-pages.ts', 'services/seo/faq-translations.ts', 'build-plugins/editorialContent.ts']) {
      expect(read(rel), rel).not.toMatch(/270[-–]560/);
    }
  });
});
