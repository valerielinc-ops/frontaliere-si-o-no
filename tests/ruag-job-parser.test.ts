import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseRuagListingLinks,
  parseRuagJobDetail,
  isRuagTargetLocation,
  inferRuagCanton,
} from '../scripts/lib/ruag-job-parser.mjs';

describe('ruag-job-parser', () => {
  it('extracts official job links from listing-like html', () => {
    const html = `
      <a href="https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a">One</a>
      <a href="https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719425f-0598-427b-94ec-9d6a1189fe64">Two</a>
    `;
    expect(parseRuagListingLinks(html)).toEqual([
      'https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a',
      'https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719425f-0598-427b-94ec-9d6a1189fe64',
    ]);
  });

  it('parses a RUAG detail page and prefers the structured workplace', () => {
    const html = `
      <html>
        <head>
          <title>Apprendista Polimeccanico/a AFC 2026 100% (f/m/d)</title>
          <link rel="canonical" href="https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719" />
          <script type="application/ld+json">
            {"@context":"http://schema.org","@type":"JobPosting","title":"BetriebselektrikerIn (Facility Manager Technics)","datePosted":"2025-10-31","validThrough":"2053-03-16","employmentType":"FULL_TIME","hiringOrganization":{"name":"RUAG MRO Holding AG"},"jobLocation":{"@type":"Place","address":{"addressLocality":"Schattdorf","addressRegion":"Uri","postalCode":"6467"}},"responsibilities":"<ul><li>Lavorazione di metalli</li></ul>","qualifications":"<ul><li>Buone prestazioni in matematica</li></ul>"}
          </script>
        </head>
        <body>
          <section id="about"><div class="contentTextWrapper"><h2><b>Il tuo ambito di lavoro</b></h2><div>Presso la nostra sede di Lodrino abbiamo un posto di apprendistato libero.</div></div></section>
          <section id="benefits"><div class="benefitIntroduction"><h2><b>I tuoi vantaggi</b></h2><div>Molti vantaggi.</div></div></section>
          <section id="applicationProcess"><div class="contentTextWrapper"><h2>Ecco come funziona il nostro processo di candidatura</h2><div id="applicationProcessText"><ul><li>Usa jobs.ruag.ch</li></ul></div></div></section>
          <section id="contact"><div class="contactInfoText"><div class="contactInfoName">Sonja Schwyn</div><p>Human Resources Assistant</p><a href="tel:+41584886234">+41 58 488 62 34</a></div></section>
          <a id="otherJob-0" href="https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a"></a>
          <a href="https://jobs.ruag.ch/apply/ats/8719">Apply</a>
          <script>
            $('#location .placeList').html('Lodrino');
          </script>
        </body>
      </html>
    `;
    const parsed = parseRuagJobDetail(html, 'https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719');
    expect(parsed.title).toContain('Apprendista Polimeccanico');
    expect(parsed.location).toBe('Schattdorf');
    expect(parsed.canton).toBe('UR');
    expect(parsed.applyUrl).toBe('https://jobs.ruag.ch/apply/ats/8719');
    expect(parsed.similarLinks).toHaveLength(1);
    // Section headings come from the page itself (verbatim), not from a
    // parser-side Italian label table that never matched the German pages.
    expect(parsed.description).toContain('## Il tuo ambito di lavoro');
    expect(parsed.description).toContain('Presso la nostra sede di Lodrino');
    // Template without `.jobInfoList`: the JSON-LD lists are the fallback.
    expect(parsed.description).toContain('## Responsabilita');
    expect(parsed.description).toContain('- Lavorazione di metalli');
    expect(parsed.description).toContain('## Requisiti');
    expect(parsed.description).toContain('## I tuoi vantaggi');
    expect(parsed.description).toContain('- Usa jobs.ruag.ch');
    expect(parsed.description).toContain('Sonja Schwyn');
  });

  it('keeps every role section of the current jobs.ruag.ch template and no page chrome', () => {
    // Minimized from the live German detail page (2026-09-29, contact anonymized).
    const html = readFileSync(new URL('./fixtures/ruag-detail-jobinfo-template.html', import.meta.url), 'utf8');
    const parsed = parseRuagJobDetail(html, 'https://jobs.ruag.ch/offene-stellen/betriebselektrikerin-facility-manager-technics/190b7508-d7e8-403d-b49f-7c2f57a59965');
    const d = parsed.description;

    expect(parsed.location).toBe('Schattdorf');
    // introduction, tasks, profile, encouragement note, workplace, division
    // blurb, benefit cards, application notes, contact — in page order.
    const markers = [
      'Rund 3000 Mitarbeitende von RUAG',
      '## Das kannst du bewegen',
      '- Revisionen, Reparaturen und Servicearbeiten',
      '## Das bringst du mit',
      '- Führerausweis Kategorie B',
      'Erfüllst du nicht alle Voraussetzungen hundertprozentig?',
      '## Arbeitsort',
      'Militärstrasse 22, 6467 Schattdorf',
      '## Über den Bereich',
      '## Deine Vorteile',
      '- Lohn und Nebenleistungen: Wir bieten dir',
      '## So funktioniert unser Bewerbungsprozess',
      '- Vor Anstellungsbeginn wirst du darum gebeten',
      '## Deine Ansprechperson',
      'Erika Muster',
    ];
    let cursor = -1;
    for (const marker of markers) {
      const at = d.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
    // The print-only contact card repeats section#contact: rendered once.
    expect(d.split('Erika Muster')).toHaveLength(2);
    // Cookie placeholders, contact form, similar-job teasers stay out.
    for (const chrome of ['Externer Inhalt von YouTube', 'Cookies zulassen', 'Ich wünsche eine Kontaktaufnahme', 'Weitere Stellen', 'Datenschutzerklärung']) {
      expect(d).not.toContain(chrome);
    }
    // Keyword classification keeps reading the role lists, not the benefit
    // cards ("Homeoffice-Optionen" is on every page).
    expect(parsed.roleText).toContain('HLKSE');
    expect(parsed.roleText).not.toContain('Homeoffice');
  });

  it('matches Ticino and Grigioni locations', () => {
    expect(isRuagTargetLocation('Lodrino')).toBe(true);
    expect(isRuagTargetLocation('Chur')).toBe(true);
    expect(inferRuagCanton('Lodrino')).toBe('TI');
    expect(inferRuagCanton('Chur')).toBe('GR');
  });

  it('rejects country-only labels without inventing a job locality', () => {
    expect(isRuagTargetLocation('Switzerland')).toBe(false);
    expect(isRuagTargetLocation('Swiss')).toBe(false);
    expect(isRuagTargetLocation('Ticino')).toBe(true);
  });
});
