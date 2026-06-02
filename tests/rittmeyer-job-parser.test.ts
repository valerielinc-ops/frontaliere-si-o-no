import { describe, expect, it } from 'vitest';
import {
  parseRittmeyerListingsPage,
  isRittmeyerTicinoListing,
  parseRittmeyerJobDetail,
  buildRittmeyerLocalizedContent,
} from '../scripts/lib/rittmeyer-job-parser.mjs';
import {
  resolveRittmeyerSiteAddress,
  RITTMEYER_SITES,
} from '../scripts/update-rittmeyer-jobs.mjs';

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

// ─── Site resolver (regression: Camorino jobs were getting Baar HQ postal) ──

describe('resolveRittmeyerSiteAddress', () => {
  it('maps the German label "Tessin" to Camorino TI 6528', () => {
    const site = resolveRittmeyerSiteAddress('Tessin');
    expect(site.canton).toBe('TI');
    expect(site.postalCode).toBe('6528');
    expect(site.streetAddress).toBe('Via Sottomontagna 9');
    expect(site.addressLocality).toBe('Camorino');
  });

  it('maps "Romanshorn" to TG, not TI', () => {
    const site = resolveRittmeyerSiteAddress('Romanshorn');
    expect(site.canton).toBe('TG');
    expect(site.postalCode).toBe('8590');
    expect(site.addressLocality).toBe('Romanshorn');
  });

  it('maps "Baar" to ZG (HQ)', () => {
    const site = resolveRittmeyerSiteAddress('Baar');
    expect(site.canton).toBe('ZG');
    expect(site.postalCode).toBe('6340');
    expect(site.streetAddress).toBe('Inwilerriedstrasse 57');
  });

  it('falls back to Baar HQ for empty input', () => {
    const site = resolveRittmeyerSiteAddress('');
    expect(site.key).toBe('baar');
  });

  it('infers the canton for an off-registry Swiss site, never forging Baar HQ', () => {
    // Nationwide crawl can surface a 4th Swiss site. Resolve its real canton
    // from the source location text and keep street/postal empty (safe-default
    // downstream) instead of forging the Baar ZG address onto it.
    const site = resolveRittmeyerSiteAddress('Bern');
    expect(site.canton).toBe('BE');
    expect(site.addressLocality).toBe('Bern');
    expect(site.postalCode).toBe('');
    expect(site.streetAddress).toBe('');
    // Must NOT carry the Baar HQ postal/street/canton.
    expect(site.canton).not.toBe('ZG');
    expect(site.postalCode).not.toBe('6340');
  });

  it('falls back to Baar HQ only when the canton cannot be inferred', () => {
    const site = resolveRittmeyerSiteAddress('Atlantis');
    expect(site.key).toBe('baar');
    expect(site.canton).toBe('ZG');
  });

  it('registry exposes Camorino with verified Via Sottomontagna 9 address', () => {
    const camorino = RITTMEYER_SITES.find((s) => s.key === 'camorino');
    expect(camorino?.streetAddress).toBe('Via Sottomontagna 9');
    expect(camorino?.postalCode).toBe('6528');
    // Regression guard: must NOT carry the Baar HQ postal/street.
    expect(camorino?.postalCode).not.toBe('6340');
    expect(camorino?.streetAddress).not.toBe('Inwilerriedstrasse 57');
  });
});
