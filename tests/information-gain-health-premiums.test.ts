import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import {
  HEALTH_PREMIUM_CANTONS,
  HEALTH_PREMIUM_LOCALES,
  HEALTH_PREMIUMS_ROUTES,
  buildHealthPremiumsCantonPath,
  buildHealthPremiumsLeafPath,
  buildHealthPremiumsRootPath,
  listHealthPremiumsPaths,
} from '@/build-plugins/shared/healthPremiumsPaths';
import {
  isHealthPremiumsPath as isNodeHealthPremiumsPath,
} from '@/scripts/lib/healthPremiumSections.mjs';

const healthPremiumPage = (value: number): string => `<!doctype html>
<html lang="it"><head><title>Premi cassa malati ${value}</title></head>
<body><main>
  <h1>Premi cassa malati in Svizzera</h1>
  <p>Confronto operativo dei premi per lavoratori frontalieri e famiglie.</p>
  <p>Il premio medio rilevato è ${value} CHF al mese.</p>
</main></body></html>`;

describe('information-gain: le pagine premi cassa malati sono un vertical data-driven', () => {
  it('usa la stessa tabella per root, cantoni e fasce in tutti i locali', () => {
    const paths = listHealthPremiumsPaths();

    expect(paths).toHaveLength(4 * (1 + HEALTH_PREMIUM_CANTONS.length * 7));
    expect(new Set(HEALTH_PREMIUMS_ROUTES).size).toBe(732);
    expect(HEALTH_PREMIUMS_ROUTES).toEqual(paths.map(({ path }) => path));

    for (const path of HEALTH_PREMIUMS_ROUTES) {
      expect(isNodeHealthPremiumsPath(path), path).toBe(true);
      expect(isNodeHealthPremiumsPath(`${path}index.html`), `${path}index.html`).toBe(true);
    }

    for (const locale of HEALTH_PREMIUM_LOCALES) {
      const root = buildHealthPremiumsRootPath(locale);
      const canton = buildHealthPremiumsCantonPath(locale, 'ticino');
      const leaf = buildHealthPremiumsLeafPath(locale, 'ticino', '31-45');
      expect(isNodeHealthPremiumsPath(root), root).toBe(true);
      expect(isNodeHealthPremiumsPath(canton), canton).toBe(true);
      expect(isNodeHealthPremiumsPath(leaf), leaf).toBe(true);
    }
  });

  it('non allarga il matcher a slug simili', () => {
    expect(isNodeHealthPremiumsPath('/premi-cassa-malati-archivio/')).toBe(false);
    expect(isNodeHealthPremiumsPath('/en/health-insurance-premiums-old/ticino/adult-31-45/')).toBe(false);
    expect(isNodeHealthPremiumsPath('/premi-cassa-malati/ticino/adulto-31-45-extra/')).toBe(false);
    expect(isNodeHealthPremiumsPath('/docs/premi-cassa-malati/ticino/')).toBe(false);
  });

  it('esclude tutti i payload premi dal gate editoriale', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    const paths = HEALTH_PREMIUM_LOCALES.flatMap((locale) => [
      buildHealthPremiumsRootPath(locale),
      buildHealthPremiumsCantonPath(locale, 'ticino'),
      buildHealthPremiumsLeafPath(locale, 'ticino', '31-45'),
    ]);

    paths.forEach((path, index) => {
      auditor.collect(`/virtual/dist${path}index.html`, healthPremiumPage(index + 1));
    });

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
