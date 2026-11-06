import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import { isEventsSectionPath } from '@/scripts/lib/eventsSections.mjs';

const eventPaths = [
  '/eventi/',
  '/eventi/zurigo/',
  '/eventi/zurigo/questo-weekend/',
  '/eventi/zurigo/zurigo/festival-ricorrente-2026/',
  '/en/events/',
  '/en/events/zurich/',
  '/en/events/zurich/this-weekend/',
  '/en/events/zurich/zurich/recurring-festival-2026/',
  '/de/veranstaltungen/',
  '/de/veranstaltungen/zurich/',
  '/de/veranstaltungen/zurich/dieses-wochenende/',
  '/de/veranstaltungen/zurich/zurich/wiederkehrendes-festival-2026/',
  '/fr/evenements/',
  '/fr/evenements/zurich/',
  '/fr/evenements/zurich/ce-week-end/',
  '/fr/evenements/zurich/zurich/festival-recurrent-2026/',
];

const eventPage = (path: string): string => `<!doctype html>
<html><head><title>Agenda eventi ${path}</title></head><body><main>
  <h1>Eventi in Svizzera</h1>
  <p>Agenda pubblica con date, luoghi e informazioni operative verificate.</p>
  <p>Controlla sempre la data e il luogo presso l'organizzatore.</p>
</main></body></html>`;

describe('information-gain: le pagine eventi sono un vertical data-driven', () => {
  it('riconosce hub, cantoni, digest e dettagli ricorrenti in tutti i locali', () => {
    for (const path of eventPaths) {
      expect(isEventsSectionPath(path), path).toBe(true);
    }
  });

  it('esclude il payload strutturato eventi da information-gain editoriale', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    eventPaths.forEach((path) => {
      auditor.collect(`/virtual/dist${path}index.html`, eventPage(path));
    });

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
