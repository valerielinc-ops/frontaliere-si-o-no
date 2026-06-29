import { describe, it, expect } from 'vitest';
import {
  KLINIK_GUT_KEY,
  KLINIK_GUT_COMPANY_NAME,
  KLINIK_GUT_COMPANY_DOMAIN,
  PUBLIC_CAREER_URL,
  isKlinikGutJob,
  isTrustedDomain,
  parseKlinikGutOpenings,
} from '../scripts/lib/klinik-gut-job-parser.mjs';

// Trimmed real markup from https://www.klinik-gut.ch/de/offene-stellen (2026-06).
// Openings migrated from per-page `rz-infobox__item` cards (#2966) to inline
// Bootstrap accordion items grouped under per-site `btn btn-primary` headings.
// The numeric `drz-accordion-id-{NNNN}` is the stable Drupal node id; the body
// lives inline in each `accordion-body` (no detail page to fetch).
const OPENINGS_HTML = `
<div class="view-content">
  <div class="col-12 field__item rz-paragraph-type-text">
    <h2><a class="btn btn-primary" href="https://www.klinik-gut.ch/de/standorte/klinik-gut-st-moritz" data-entity-type="node" title="Klinik Gut St. Moritz">Klinik Gut Standort St. Moritz&nbsp;</a></h2>
  </div>
  <div class="col-12 field__item rz-paragraph-type-accordion_container">
    <section class="paragraph paragraph--type--accordion-container">
      <div class="accordion field__items" id="drz-accordion-">
        <div class="field__item accordion-item" id="drz-accordion-custom-id__diplpflegefachfraumannhffh">
          <h2 class="accordion-header">
            <button class="accordion-button collapsed" type="button" data-bs-target="#drz-accordion-id-2110" aria-expanded="true">Dipl. Pflegefachfrau/mann HF oder FH 60-100%</button>
          </h2>
          <div id="drz-accordion-id-2110" class="accordion-collapse collapse">
            <div class="accordion-body">
              <section class="paragraph paragraph--type--accordion-item">
                <p><strong>Neuer Job im Oberengadin?</strong></p>
                <p>Für unser Pflegeteam am <strong>Klinikstandort St. Moritz</strong> suchen wir per sofort eine motivierte Persönlichkeit.</p>
                <p>Dein Wirkungsfeld bei uns</p>
                <ul><li>Individuelle Pflege und zielgerichtete Steuerung des Pflegeprozesses.</li><li>Qualität leben nach unseren Pflegerichtlinien und Standards.</li><li>Du gibst dein Wissen gerne weiter und unterstützt die Ausbildung.</li></ul>
                <p>Damit überzeugst du uns als Dipl. Pflegefachfrau/-mann HF/FH mit Berufserfahrung, Servicegedanke und einer zuverlässigen, eigenverantwortlichen Arbeitsweise.</p>
              </section>
            </div>
          </div>
        </div>
        <div class="field__item accordion-item">
          <h2 class="accordion-header">
            <button class="accordion-button collapsed" type="button" data-bs-target="#drz-accordion-id-3196">Med. Praxisassistent/in 60 – 80% - Wintersaison 2026/27</button>
          </h2>
          <div id="drz-accordion-id-3196" class="accordion-collapse collapse">
            <div class="accordion-body">
              <section class="paragraph paragraph--type--accordion-item">
                <p>Für unsere Praxis in St. Moritz suchen wir für die Wintersaison eine medizinische Praxisassistentin oder einen medizinischen Praxisassistenten.</p>
                <ul><li>Empfang und Betreuung unserer nationalen und internationalen Kundschaft.</li><li>Assistenz bei Untersuchungen und administrative Aufgaben am Empfang.</li></ul>
                <p>Du bringst eine abgeschlossene Ausbildung als MPA EFZ und Freude am Patientenkontakt mit. Wir freuen uns auf deine Bewerbung per E-Mail.</p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
  <div class="col-12 field__item rz-paragraph-type-text">
    <h2><a class="btn btn-primary" href="https://www.klinik-gut.ch/de/standorte/klinik-gut-flaesch" data-entity-type="node" title="Klinik Gut Fläsch">Klinik Gut Standort Fläsch&nbsp;</a></h2>
  </div>
  <div class="col-12 field__item rz-paragraph-type-accordion_container">
    <section class="paragraph paragraph--type--accordion-container">
      <div class="accordion field__items" id="drz-accordion-">
        <div class="field__item accordion-item" id="drz-accordion-custom-id__arzt">
          <h2 class="accordion-header">
            <button class="accordion-button collapsed" type="button" data-bs-target="#drz-accordion-id-1575">Assistenzärztin / Assistenzarzt 100%</button>
          </h2>
          <div id="drz-accordion-id-1575" class="accordion-collapse collapse">
            <div class="accordion-body">
              <section class="paragraph paragraph--type--accordion-item">
                <p>Für unseren Klinikstandort Fläsch suchen wir eine Assistenzärztin oder einen Assistenzarzt der Orthopädie und Traumatologie.</p>
                <ul><li>Stationäre und ambulante Betreuung unserer Patientinnen und Patienten.</li><li>Mitarbeit im Operationssaal und in der Sprechstunde.</li></ul>
                <p>Du verfügst über ein abgeschlossenes Medizinstudium und Interesse an der Orthopädie. Wir bieten ein strukturiertes Weiterbildungsprogramm.</p>
                <div class="rz-paragraph-type-document"><span class="file file--mime-application-pdf"><a href="/sites/default/files/file/info.pdf">Info.pdf</a></span> <span>(288 KB)</span></div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
`;

describe('Klinik Gut crawler parser', () => {
  it('exports valid constants pointing at the now-accessible openings page', () => {
    expect(KLINIK_GUT_KEY).toBe('klinik-gut');
    expect(KLINIK_GUT_COMPANY_NAME).toBe('Klinik Gut AG');
    expect(KLINIK_GUT_COMPANY_DOMAIN).toBe('klinik-gut.ch');
    // The 403 wall on `/de/offene-stellen` (#1872) was lifted; it now inlines
    // every opening as an accordion and is the canonical source (#2966).
    expect(PUBLIC_CAREER_URL).toBe('https://www.klinik-gut.ch/de/offene-stellen');
  });

  describe('isKlinikGutJob', () => {
    it('matches by companyKey', () => {
      expect(isKlinikGutJob({ companyKey: 'klinik-gut' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isKlinikGutJob({ url: 'https://www.klinik-gut.ch/de/offene-stellen' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isKlinikGutJob(null)).toBe(false);
      expect(isKlinikGutJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts klinik-gut.ch and subdomains', () => {
      expect(isTrustedDomain('https://www.klinik-gut.ch/de/offene-stellen')).toBe(true);
      expect(isTrustedDomain('https://klinik-gut.ch/x')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://evil-klinik-gut.example.com')).toBe(false);
      expect(isTrustedDomain('not a url')).toBe(false);
    });
  });

  describe('parseKlinikGutOpenings', () => {
    it('extracts every accordion opening', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.num)).toEqual(['2110', '3196', '1575']);
      expect(rows.map((r) => r.title)).toEqual([
        'Dipl. Pflegefachfrau/mann HF oder FH 60-100%',
        'Med. Praxisassistent/in 60 – 80% - Wintersaison 2026/27',
        'Assistenzärztin / Assistenzarzt 100%',
      ]);
    });

    it('builds a stable per-opening fragment deep-link as the canonical url', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      expect(rows[0].id).toBe('drz-accordion-id-2110');
      expect(rows[0].detailUrl).toBe(
        'https://www.klinik-gut.ch/de/offene-stellen#drz-accordion-id-2110',
      );
      // Distinct fragments keep the N positions unique (mergeUrlKey preserves it).
      expect(new Set(rows.map((r) => r.detailUrl)).size).toBe(rows.length);
    });

    it('extracts the full inline posting body (no thin content)', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      const first = rows[0];
      expect(first.body).toContain('Oberengadin');
      expect(first.body).toContain('Individuelle Pflege');
      // Inline body must be real content, well above the 50-word thin floor.
      expect(first.body.split(/\s+/).filter(Boolean).length).toBeGreaterThan(50);
    });

    it('does not leak the next opening or per-site heading into a body', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      // First St. Moritz item must not absorb the second item's title/body…
      expect(rows[0].body).not.toContain('Med. Praxisassistent');
      expect(rows[0].body).not.toContain('Praxis in St. Moritz');
      // …nor the next group's heading text.
      expect(rows[1].body).not.toContain('Klinik Gut Standort Fläsch');
    });

    it('trims a trailing PDF/document artifact from the body', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      const arzt = rows.find((r) => r.num === '1575')!;
      expect(arzt.body).not.toContain('Info.pdf');
      expect(arzt.body).not.toMatch(/Datei\s*$/);
    });

    it('scopes each opening to the nearest preceding per-site heading', () => {
      const rows = parseKlinikGutOpenings(OPENINGS_HTML);
      // Both St. Moritz items.
      expect(rows[0].location.city).toBe('St. Moritz');
      expect(rows[0].location.canton).toBe('GR');
      expect(rows[1].location.city).toBe('St. Moritz');
      // Item under the Fläsch heading.
      expect(rows[2].location.city).toBe('Fläsch');
      expect(rows[2].location.canton).toBe('GR');
    });

    it('returns empty on empty/invalid HTML', () => {
      expect(parseKlinikGutOpenings('')).toEqual([]);
      expect(parseKlinikGutOpenings(null)).toEqual([]);
    });

    it('still parses openings when Drupal appends a modifier class to the button', () => {
      // e.g. `class="accordion-button collapsed is-open"`; the regex must match
      // the `accordion-button` token, not a quote-strict `class="X"`.
      const html = OPENINGS_HTML.replace(
        /class="accordion-button collapsed"/g,
        'class="accordion-button collapsed is-open"',
      );
      const rows = parseKlinikGutOpenings(html);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.num)).toEqual(['2110', '3196', '1575']);
    });
  });
});
