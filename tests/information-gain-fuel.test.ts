import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import { isFuelSectionPath } from '@/scripts/lib/fuelSections.mjs';

const canonicalFuelPaths = [
  '/prezzi-benzina/oggi/',
  '/prezzi-diesel/oggi/',
  '/en/gasoline-price-switzerland/today/',
  '/en/diesel-price-switzerland/today/',
  '/de/benzinpreis-schweiz/heute/',
  '/de/dieselpreis-schweiz/heute/',
  '/fr/prix-essence-suisse/aujourd-hui/',
  '/fr/prix-gasoil-suisse/aujourd-hui/',
];

const legacyFuelPaths = [
  '/prezzi-benzina-svizzera/oggi/',
  '/prezzi-carburante-svizzera/oggi/',
  '/fuel-prices-switzerland/today/',
  '/fr/prix-diesel-suisse/aujourd-hui/',
  '/de/benzinpreise-schweiz/heute/',
];

const fuelPage = (price: string): string => `<!doctype html>
<html lang="it"><head><title>Prezzi carburante ${price}</title></head>
<body><main>
  <h1>Prezzi carburante in Svizzera</h1>
  <p>Prezzi aggiornati, stazioni e dati operativi per chi attraversa il confine.</p>
  <p>Il valore rilevato oggi è ${price} CHF al litro.</p>
</main></body></html>`;

describe('information-gain: fuel-daily è un vertical data-driven', () => {
  it('riconosce le sezioni canoniche e gli alias in tutti i formati di locale', () => {
    for (const path of [...canonicalFuelPaths, ...legacyFuelPaths]) {
      expect(isFuelSectionPath(path), path).toBe(true);
    }
    expect(isFuelSectionPath('/blog/prezzi-benzina/oggi/')).toBe(false);
    expect(isFuelSectionPath('/prezzi-benzina-archivio/oggi/')).toBe(false);
  });

  it('esclude il payload strutturato fuel da information-gain editoriale', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    canonicalFuelPaths.forEach((path, index) => {
      auditor.collect(`/virtual/dist${path}index.html`, fuelPage(`${1.7 + index / 100}`));
    });

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
