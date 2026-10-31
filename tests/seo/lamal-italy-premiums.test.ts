import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('premi LAMal per i residenti in Italia', () => {
  it('le pagine citano la tabella UFSP 2026, non i premi del Ticino', () => {
    expect(read('services/seo/seo-pages.ts')).toContain('CHF 279–487/mese adulti da 26 anni, CHF 41–204 bambini');
    expect(read('build-plugins/editorialContent.ts')).toContain('CHF 279-487/month');
  });

  it('non torna la forchetta senza fonte per i frontalieri', () => {
    for (const rel of ['services/seo/seo-pages.ts', 'services/seo/faq-translations.ts', 'build-plugins/editorialContent.ts']) {
      expect(read(rel), rel).not.toMatch(/270[-–]560/);
    }
  });
});
