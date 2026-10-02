import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import {
  isBorderWaitPath as isNodeBorderWaitPath,
  BORDER_WAIT_CURRENT_SECTION_BASES,
  BORDER_WAIT_LEGACY_SECTION_BASES,
} from '@/scripts/lib/borderWaitSections.mjs';
import {
  BORDER_WAIT_LOCALES,
  buildArchivePath,
  buildOggiPath,
  buildRegionalHubPath,
  buildRootHubPath,
  isBorderWaitPath as isRuntimeBorderWaitPath,
} from '@/build-plugins/borderWaitData';

const CURRENT_PATHS = BORDER_WAIT_LOCALES.flatMap((locale) => [
  buildRootHubPath(locale),
  buildRegionalHubPath(locale, 'ticino-como'),
  buildOggiPath(locale, 'chiasso-brogeda'),
  buildArchivePath(locale, 'chiasso-brogeda', '2026-04'),
]);

const LEGACY_PATHS = [
  '/guida-frontaliere/tempi-attesa-dogana/',
  '/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/',
  '/en/cross-border-guide/border-waiting-times/',
  '/en/cross-border-guide/border-waiting-times/chiasso-brogeda/',
  '/de/grenzgaenger-ratgeber/wartezeiten-grenze/',
  '/de/grenzgaenger-ratgeber/wartezeiten-grenze/chiasso-brogeda/',
  '/fr/guide-frontalier/temps-attente-douane/',
  '/fr/guide-frontalier/temps-attente-douane/chiasso-brogeda/',
  '/tempi-attesa-frontiera/chiasso-brogeda/',
  '/en/border-wait-times/chiasso-brogeda/',
  '/de/grenzwartezeiten/chiasso-brogeda/',
  '/fr/temps-attente-frontiere/chiasso-brogeda/',
];

const borderWaitPage = (path: string): string => `<!doctype html>
<html><head><title>Border wait ${path}</title></head><body><main>
  <h1>Border crossing wait times</h1>
  <p>Live crossing data and practical information for planning a cross-border trip.</p>
  <p>Check the current reading and compare the available crossing options before leaving.</p>
</main></body></html>`;

describe('information-gain: border-wait è un vertical data-driven', () => {
  it('riconosce root, regione, valico, oggi/archivio e gli alias legacy in tutti i locali', () => {
    for (const path of [...CURRENT_PATHS, ...LEGACY_PATHS]) {
      expect(isNodeBorderWaitPath(path), path).toBe(true);
      expect(isRuntimeBorderWaitPath(path), `runtime ${path}`).toBe(true);
      expect(isNodeBorderWaitPath(`dist${path}index.html`), `dist ${path}`).toBe(true);
    }
  });

  it('mantiene i confini della famiglia senza catturare slug simili', () => {
    expect(BORDER_WAIT_CURRENT_SECTION_BASES).toContain('traffico-dogane');
    expect(BORDER_WAIT_LEGACY_SECTION_BASES).toContain('guida-frontaliere/tempi-attesa-dogana');
    expect(isNodeBorderWaitPath('/blog/tempi-attesa-frontiera/chiasso-brogeda/')).toBe(false);
    expect(isNodeBorderWaitPath('/traffico-dogane-archivio/chiasso-brogeda/oggi/')).toBe(false);
    expect(isNodeBorderWaitPath('/traffico-dogane/chiasso-brogeda/not-a-date/')).toBe(false);
    expect(isRuntimeBorderWaitPath('/traffico-dogane/not-a-crossing/oggi/')).toBe(false);
  });

  it('esclude tutte le route border-wait prima del fingerprint editoriale', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    for (const path of [...CURRENT_PATHS, ...LEGACY_PATHS]) {
      auditor.collect(`/virtual/dist${path}index.html`, borderWaitPage(path));
    }

    const report = auditor.report();
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
