import { readFileSync } from 'node:fs';
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
  scrubRittmeyerLegacyLocaleCopies,
} from '../scripts/update-rittmeyer-jobs.mjs';

describe('rittmeyer-job-parser', () => {
  it('parses listing links and detects Ticino rows', () => {
    const html = `
      <a href="/offene-stellen/sales-project-engineer-a-ticino/">Sales Project Engineer (a) Ticino</a>
      <a href="/offene-stellen/sales-project-engineer-a/">Sales Project Engineer (a)</a>
    `;
    const listings = parseRittmeyerListingsPage(html);
    expect(listings).toHaveLength(2);
    // listings[0] carries "Ticino" in the href/title → genuine target listing.
    expect(isRittmeyerTicinoListing(listings[0])).toBe(true);
    // listings[1] has NO location signal — only the word "Sales". Previously it
    // matched the tiny commune Sâles (FR) and was wrongly read as a target
    // listing (the Swatch Group US-jobs leak class, 2026-06-17). "sales" is now
    // excluded from the city-token set, so a location-less listing is treated
    // the same as every other location-less row: not a confirmable target
    // listing. (It is the only stray-word exception that used to slip the
    // listing-stage filter; location-bearing rows like listings[0] are
    // unaffected.)
    expect(isRittmeyerTicinoListing(listings[1])).toBe(false);

    const isoInTitle = parseRittmeyerListingsPage(`
      <a href="/offene-stellen/it-support-in-lugano/">IT Support in Lugano</a>
    `);
    expect(isRittmeyerTicinoListing(isoInTitle[0])).toBe(true);
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
    // Only the source slot is built: copying the source text under translated
    // headings into en/de/fr made the translation step skip those locales.
    expect(Object.keys(localized.descriptionByLocale)).toEqual(['it']);
    expect(Object.keys(localized.titleByLocale)).toEqual(['it']);
  });

  it('reads the German posting by its language-neutral eyebrows and uses the JSON-LD intro', () => {
    // Minimized from the live page (2026-09-29). Its meta description belongs
    // to another vacancy ("Projekte in der Wasser- und Energieversorgung"),
    // the JSON-LD description is this posting's own intro.
    const html = readFileSync(new URL('./fixtures/rittmeyer-detail-eyebrow-de.html', import.meta.url), 'utf8');
    const detail = parseRittmeyerJobDetail(html);
    expect(detail.summary).toMatch(/^Bist du bereit für eine spannende Herausforderung in der Welt der Wasserkraft/);
    expect(detail.summary).not.toContain('Wasser- und Energieversorgung von Anfang bis Ende');
    expect(detail.responsibilitiesHeading).toBe('Was du bei uns bewegen kannst');
    expect(detail.responsibilities).toHaveLength(5);
    expect(detail.requirementsHeading).toBe('Was du mitbringst');
    expect(detail.requirements).toHaveLength(7);
    expect(detail.benefitsHeading).toBe('Was wir dir bieten');
    expect(detail.company).toContain('Als Teil der BRUGG-Gruppe');

    const d = buildRittmeyerLocalizedContent(detail, 'de').descriptionByLocale.de;
    const markers = [
      'Bist du bereit',
      'Als Teil der BRUGG-Gruppe',
      '## Was du bei uns bewegen kannst',
      '- Du erstellst und entwickelst anlagenspezifische Applikationssoftware',
      '## Was du mitbringst',
      '- Eine Reisebereitschaft von etwa 30 %',
      '## Was wir dir bieten',
      '- Jobs mit Zukunft:',
    ];
    let cursor = -1;
    for (const marker of markers) {
      const at = d.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Blog/team teasers after the benefits are page chrome.
    expect(d).not.toContain('Lerne dein Team kennen');
    // Only the page's own text and headings: no invented application line,
    // no parser-side labels (the facts stay structured fields).
    expect(d).not.toMatch(/Onlyfy|Candidat|Bewirb dich über/);
    expect(d).not.toMatch(/^## (?:Wichtige Eckdaten|Überblick|Bewerbung)$/m);
    expect([...d.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      'Was du bei uns bewegen kannst',
      'Was du mitbringst',
      'Was wir dir bieten',
    ]);
    expect(detail).toMatchObject({ area: 'Operations', location: 'Baar', workload: '100%' });
  });

  it('drops the legacy placeholder titles and untranslated locale copies, keeps real translations', () => {
    const scrubbed = scrubRittmeyerLegacyLocaleCopies({
      title: 'Teamleiter Lager & Logistik (a)',
      sourceLang: 'de',
      titleByLocale: {
        it: 'Team Leader Magazzino e Logistica (a)',
        en: 'Sales Project Engineer (m/f/x) Ticino',
        de: 'Teamleiter Lager & Logistik (a)',
        fr: 'Ingenieur commercial projets Tessin',
      },
      descriptionByLocale: {
        de: 'Wir suchen eine engagierte Führungspersönlichkeit für unser Lager und die Logistik in Baar.',
        it: 'Cerchiamo una personalità dirigenziale impegnata per il nostro magazzino e la logistica a Baar.',
        en: '## Overview\nWir suchen eine engagierte Führungspersönlichkeit für unser Lager und die Logistik in Baar.',
        fr: '## Aperçu\nWir suchen eine engagierte Führungspersönlichkeit für unser Lager und die Logistik in Baar.',
      },
    });
    expect(scrubbed.titleByLocale).toEqual({
      it: 'Team Leader Magazzino e Logistica (a)',
      de: 'Teamleiter Lager & Logistik (a)',
    });
    expect(Object.keys(scrubbed.descriptionByLocale).sort()).toEqual(['de', 'it']);

    // The pinned snapshot job (slice 995a6583431): the Italian source slot of
    // the old builder and its copies ended with an invented application line.
    const legacy = scrubRittmeyerLegacyLocaleCopies({
      title: 'Sales Project Engineer (a) Ticino',
      sourceLang: 'de',
      descriptionByLocale: {
        de: 'Wir suchen eine engagierte Persönlichkeit für den Verkauf im Tessin.',
        it: '## Panoramica\nCerchiamo una persona motivata per il nostro team di vendita interno.\n\n## Candidatura\nCandidati tramite il portale ufficiale Rittmeyer/Onlyfy.',
      },
    });
    expect(Object.keys(legacy.descriptionByLocale)).toEqual(['de']);
  });

  it('drops a copied German source title from Italian and requests retranslation', () => {
    const scrubbed = scrubRittmeyerLegacyLocaleCopies({
      sourceLang: 'de',
      title: 'Titel Deutsch',
      titleByLocale: { it: 'Titel Deutsch', de: 'Titel Deutsch' },
      descriptionByLocale: { de: 'Ein ausreichend langer deutscher Quelltext.' },
    });

    expect(scrubbed.titleByLocale).toEqual({ de: 'Titel Deutsch' });
    expect(scrubbed.needsRetranslation).toBe(true);
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
