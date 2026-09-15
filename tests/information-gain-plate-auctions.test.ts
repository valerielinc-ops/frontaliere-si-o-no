import { describe, expect, it } from 'vitest';
import {
  factory as createInformationGainAuditor,
} from '@/scripts/audit-information-gain.mjs';
import { isPlateAuctionSectionPath } from '@/scripts/lib/plateAuctionSections.mjs';

const auctionPage = (plate: string): string => `<!doctype html>
<html lang="it"><head><title>${plate} — Sciaffusa</title></head>
<body><main>
  <h1>${plate} — Sciaffusa</h1>
  <p>Aste pubbliche di targhe svizzere: prezzi correnti, scadenze e risultati finali verificati.</p>
  <p>Questa pagina raccoglie i cataloghi cantonali esposti pubblicamente.</p>
  <h2>Dettaglio</h2>
  <p>Il prezzo corrente è l’ultima offerta visibile, non una vendita conclusa.</p>
</main></body></html>`;

describe('information-gain: le aste targhe sono un vertical data-driven', () => {
  it('riconosce solo le sezioni canoniche delle aste', () => {
    expect(isPlateAuctionSectionPath('aste-targhe-svizzera/sciaffusa-sh/sh21212/index.html')).toBe(true);
    expect(isPlateAuctionSectionPath('en/swiss-plate-auctions/schaffhausen-sh/sh21212/index.html')).toBe(true);
    expect(isPlateAuctionSectionPath('de/schweizer-nummernschildauktionen/schaffhausen-sh/sh21212/index.html')).toBe(true);
    expect(isPlateAuctionSectionPath('fr/encheres-plaques-suisses/schaffhouse-sh/sh21212/index.html')).toBe(true);
    expect(isPlateAuctionSectionPath('docs/aste-targhe-svizzera/sciaffusa-sh/')).toBe(false);
    expect(isPlateAuctionSectionPath('aste-targhe-svizzera-archivio/sciaffusa-sh/')).toBe(false);
  });

  it('non trasforma il payload numerico delle aste in offender editoriali', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    auditor.collect('/virtual/dist/aste-targhe-svizzera/sciaffusa-sh/sh21212/index.html', auctionPage('SH21212'));
    auditor.collect('/virtual/dist/aste-targhe-svizzera/sciaffusa-sh/sh34449/index.html', auctionPage('SH34449'));

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
