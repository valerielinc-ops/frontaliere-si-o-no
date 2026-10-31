import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('regime dei frontalieri nei template del sito', () => {
  it("non attribuisce ai comuni italiani l'80% dell'imposta alla fonte", () => {
    const prose = read('build-plugins/shared/jobListingProse.ts');
    expect(prose).not.toMatch(/ricevono il 80|receive 80 %|erhalten 80 %|reçoivent 80 %/);
    expect(prose).toContain('tassazione concorrente');
  });

  it('non riduce il vecchio regime alla data di assunzione', () => {
    for (const rel of ['build-plugins/frontalierePillarCopy.ts', 'build-plugins/fiscalMunicipalityPagesPlugin.ts']) {
      const source = read(rel);
      expect(source, rel).not.toMatch(/assunti prima del 17 luglio|hired before 17 July|embauchés avant le 17 juillet/);
      expect(source, rel).toContain('31 dicembre 2018');
    }
  });

  it('non parla di un 20% residuale in Italia per i nuovi frontalieri', () => {
    expect(read('build-plugins/careerLandingsCopy.ts')).not.toContain('20% residuale');
  });
});
