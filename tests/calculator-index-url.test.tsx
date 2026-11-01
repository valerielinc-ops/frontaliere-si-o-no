import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCalculatorIndexPath, pushRoute, replaceRoute, updatePathForLocale } from '@/services/router';
import { readStructuredFaq } from '@/components/calculator/StructuredFaqList';

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('/calcola-stipendio/ tiene il proprio URL', () => {
  it.each(['/calcola-stipendio/', '/en/calculate-salary/', '/de/gehalt-berechnen/', '/fr/calculer-salaire/'])('riconosce %s', (path) => {
    expect(isCalculatorIndexPath(path)).toBe(true);
    expect(isCalculatorIndexPath(path.slice(0, -1))).toBe(true);
  });

  it('non scambia una sotto-pagina per la pagina indice', () => {
    expect(isCalculatorIndexPath('/calcola-stipendio/simula-busta-paga/')).toBe(false);
    expect(isCalculatorIndexPath('/')).toBe(false);
  });

  it('la rotta di default non riporta la pagina a /', () => {
    history.replaceState(null, '', '/calcola-stipendio/');
    pushRoute({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    replaceRoute({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    updatePathForLocale('it');
    expect(window.location.pathname).toBe('/calcola-stipendio/');
  });

  it('una rotta diversa cambia ancora URL', () => {
    history.replaceState(null, '', '/calcola-stipendio/');
    pushRoute({ activeTab: 'confronti', confrontiSubTab: 'exchange' });
    expect(window.location.pathname).not.toBe('/calcola-stipendio/');
  });
});

describe('H1 uguali prima e dopo idratazione', () => {
  const read = (rel: string) => readFileSync(path.resolve(rel), 'utf8');

  it("la home statica usa il testo dell'H1 React", () => {
    const title = read('services/locales/it-critical.ts').match(/'seoContent\.calculator\.title': '([^']+)'/)?.[1];
    expect(read('index.html')).toContain(`<h1 id="homepage-static-h1">${title}</h1>`);
  });

  it('il calcolatore indice ha un H1 diverso dalla home e uguale ai metadati', () => {
    const it = read('services/locales/it-critical.ts');
    const home = it.match(/'seoContent\.calculator\.title': '([^']+)'/)?.[1];
    const index = it.match(/'seoContent\.calculatorIndex\.title': '([^']+)'/)?.[1];
    expect(index).toBeTruthy();
    expect(index).not.toBe(home);
    expect(read('services/seo/seo-pages.ts')).toContain(`h1: '${index}'`);
  });

  it('comparatore e guida permessi usano gli stessi H1 dei metadati', () => {
    const seo = read('services/seo/seo-pages.ts');
    const currency = read('services/locales/it-comparatori.ts').match(/'currency\.title': '([^']+)'/)?.[1];
    const permits = read('services/locales/it-guide.ts').match(/'permits\.pageTitle': '([^']+)'/)?.[1];
    expect(seo).toContain(`h1: '${currency}'`);
    expect(seo).toContain(`h1: '${permits}'`);
  });
});

describe('FAQ visibili', () => {
  it('legge le domande dal blocco FAQPage della pagina', () => {
    const root = document.createElement('div');
    root.innerHTML = '<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"name":"Q","acceptedAnswer":{"text":"A"}}]}</script>';
    expect(readStructuredFaq(root)).toEqual([{ question: 'Q', answer: 'A' }]);
  });
});
