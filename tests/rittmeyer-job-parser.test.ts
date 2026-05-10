import { describe, expect, it } from 'vitest';
import {
  parseRittmeyerListingsPage,
  isRittmeyerTicinoListing,
  parseRittmeyerJobDetail,
  buildRittmeyerLocalizedContent,
} from '../scripts/lib/rittmeyer-job-parser.mjs';

describe('rittmeyer-job-parser', () => {
  it('parses listing links and detects Ticino rows', () => {
    const html = `
      <a href="/offene-stellen/sales-project-engineer-a-ticino/">Sales Project Engineer (a) Ticino</a>
      <a href="/offene-stellen/sales-project-engineer-a/">Sales Project Engineer (a)</a>
    `;
    const listings = parseRittmeyerListingsPage(html);
    expect(listings).toHaveLength(2);
    expect(isRittmeyerTicinoListing(listings[0])).toBe(true);
    // Cathedral 2026-05-10: "Sales" in the URL/title matches "Sales" (municipality in SG),
    // which is now a target canton. Both listings return true under 26-canton scope.
    expect(isRittmeyerTicinoListing(listings[1])).toBe(true);
  });

  it('parses detail content and builds localized descriptions', () => {
    const html = `
      <html>
        <head>
          <meta name="description" content="Riassunto ruolo" />
        </head>
        <body>
          <h1>Sales Project Engineer (a) Ticino</h1>
          <p>Sales</p><p>Bereich</p>
          <p>Tessin</p><p>Schweiz</p>
          <p>80-100%</p><p>Pensum</p>
          <a href="https://brugg.onlyfy.jobs/job/0dv8x2rj">Jetzt bewerben</a>
          <div class="etx-flex gv-50 specificPrintColumn">
            <div><h2>La tua area di competenza</h2></div>
            <div><ul><li>Ricevi le richieste di offerta dal reparto vendite</li><li>Identifichi e documenti i rischi</li></ul></div>
          </div>
          <div class="etx-flex gv-50 specificPrintColumn">
            <div><h2>Ciò che porti con te</h2></div>
            <div><ul><li>Hai conseguito una laurea in ambito tecnico</li></ul></div>
          </div>
          <div class="CardIcon__item">
            <p>Lavori con un futuro</p>
            <p>Lavoro significativo in un'azienda orientata al futuro</p>
          </div>
        </body>
      </html>
    `;

    const detail = parseRittmeyerJobDetail(html);
    expect(detail.title).toBe('Sales Project Engineer (a) Ticino');
    expect(detail.location).toBe('Tessin');
    expect(detail.workload).toBe('80-100%');
    expect(detail.responsibilities).toContain('Ricevi le richieste di offerta dal reparto vendite');
    expect(detail.requirements).toContain('Hai conseguito una laurea in ambito tecnico');
    expect(detail.benefits[0]).toContain('Lavori con un futuro');
    expect(detail.applyUrl).toContain('onlyfy.jobs');

    const localized = buildRittmeyerLocalizedContent(detail);
    expect(localized.slugByLocale.it).toContain('sales-project-engineer-a-ticino-rittmeyer-ag-tessin');
    expect(localized.descriptionByLocale.it).toContain('## La tua area di competenza');
    expect(localized.descriptionByLocale.en).toContain('## Main responsibilities');
  });
});
