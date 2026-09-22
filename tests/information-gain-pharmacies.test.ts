import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import {
  isPharmacySectionPath,
  PHARMACY_SECTION_BASES,
} from '@/scripts/lib/pharmacySections.mjs';

const pharmacyPage = (name: string): string => `<!doctype html>
<html lang="it"><head><title>${name} — Farmacie</title></head>
<body><main>
  <h1>${name} — Farmacie</h1>
  <p>Directory verificata con indirizzo, contatti, orari e servizi pubblicati dalla fonte citata.</p>
  <p>Controlla la fonte e contatta la sede prima di partire.</p>
</main></body></html>`;

describe('information-gain: le farmacie sono un vertical data-driven', () => {
  it('riconosce tutte le basi canoniche senza allargarsi a slug simili', () => {
    for (const base of PHARMACY_SECTION_BASES) {
      expect(isPharmacySectionPath(`${base}/ticino/lugano/index.html`), base).toBe(true);
      expect(isPharmacySectionPath(`/${base}/ticino/lugano/index.html`), `${base} leading slash`).toBe(true);
    }
    expect(isPharmacySectionPath('stipendio-farmacista-lucerna/index.html')).toBe(false);
    expect(isPharmacySectionPath('docs/farmacie/ticino/index.html')).toBe(false);
    expect(isPharmacySectionPath('farmacie-archivio/ticino/index.html')).toBe(false);
  });

  it('non trasforma il payload strutturato delle farmacie in offender editoriali', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    auditor.collect('/virtual/dist/farmacie/ticino/lugano/farmacia-centro/index.html', pharmacyPage('Farmacia Centro'));
    auditor.collect('/virtual/dist/en/pharmacies/ticino/lugano/farmacia-centro/index.html', pharmacyPage('Central Pharmacy'));

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
