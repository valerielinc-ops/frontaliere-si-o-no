import { describe, it, expect } from 'vitest';
import {
  KLINIK_GUT_KEY,
  KLINIK_GUT_COMPANY_NAME,
  KLINIK_GUT_COMPANY_DOMAIN,
  PUBLIC_CAREER_URL,
  isKlinikGutJob,
  isTrustedDomain,
  parseKlinikGutListing,
  parseKlinikGutDetail,
} from '../scripts/lib/klinik-gut-job-parser.mjs';

// Trimmed real markup from https://www.klinik-gut.ch/de/jobs-karriere (2026-06).
// Each opening is an `rz-infobox__item`; the final "Offene Stellen" card links
// to the access-denied aggregator (`/de/offene-stellen`) and must be dropped.
const LISTING_HTML = `
<section class="paragraph paragraph--type--infobox-container rz-infobox__container">
  <ul class="rz-infobox__list list-unstyled">
    <li class="rz-infobox__item">
      <section class="rz-infobox__content">
        <div class="infobox__informations">
          <h3>Wahlstudienjahr / Praktisches Jahr</h3>
          <div class="infobox__text"><p>Dein Einstieg in die Orthopädie und Chirurgie an unseren Standorten in St.&nbsp;Moritz und Fläsch.</p></div>
          <a href="https://www.klinik-gut.ch/de/wahlstudienjahr-praktisches-jahr" class="infobox__more btn btn-primary">Mehr Informationen</a>
        </div>
      </section>
    </li>
    <li class="rz-infobox__item">
      <section class="rz-infobox__content">
        <div class="infobox__informations">
          <h3>Dipl. Pflegefachperson HF</h3>
          <div class="infobox__text"><p>Weil Pflege Verantwortung ist. Dein Studium zur Dipl. Pflegefachfrau HF bei uns in Chur.</p></div>
          <a href="https://www.klinik-gut.ch/de/dipl-pflegefachperson-hf" class="infobox__more btn btn-primary">Mehr Informationen</a>
        </div>
      </section>
    </li>
    <li class="rz-infobox__item">
      <section class="rz-infobox__content">
        <div class="infobox__informations">
          <h3>Offene Stellen</h3>
          <div class="infobox__text"><p>Finde die Position, die zu dir passt.</p></div>
          <a href="https://www.klinik-gut.ch/de/offene-stellen" class="infobox__more btn btn-primary">Mehr Informationen</a>
        </div>
      </section>
    </li>
  </ul>
</section>
`;

const DETAIL_HTML = `
<main id="rz-main">
  <div class="region region--content">
    <article class="node node--type-page node--view-mode-full">
      <div class="node__content container">
        <h1>Dein Einstieg in die Orthopädie und Chirurgie.</h1>
        <p>Im Rahmen des Wahlstudienjahres bieten wir dir an unseren Klinikstandorten in St. Moritz und Fläsch die Möglichkeit, dein Wissen zu vertiefen. Als Unterassistenzärztin oder Unterassistenzarzt bist du ein aktiver Teil unseres Teams.</p>
        <p>Wir freuen uns auf deine Bewerbung an hr@klinik-gut.ch mit Motivationsschreiben und Lebenslauf.</p>
        <article class="node node--type-team-member node--view-mode-teaser">
          <h2>Zuständige Personen</h2>
          <p>Noemi Bossi — Leitung HR</p>
        </article>
      </div>
    </article>
  </div>
</main>
`;

describe('Klinik Gut crawler parser', () => {
  it('exports valid constants pointing at the accessible landing', () => {
    expect(KLINIK_GUT_KEY).toBe('klinik-gut');
    expect(KLINIK_GUT_COMPANY_NAME).toBe('Klinik Gut AG');
    expect(KLINIK_GUT_COMPANY_DOMAIN).toBe('klinik-gut.ch');
    // Must NOT use the access-denied `/de/offene-stellen` aggregator (#1872).
    expect(PUBLIC_CAREER_URL).toBe('https://www.klinik-gut.ch/de/jobs-karriere');
    expect(PUBLIC_CAREER_URL).not.toContain('offene-stellen');
  });

  describe('isKlinikGutJob', () => {
    it('matches by companyKey', () => {
      expect(isKlinikGutJob({ companyKey: 'klinik-gut' })).toBe(true);
    });
    it('matches by URL', () => {
      expect(isKlinikGutJob({ url: 'https://www.klinik-gut.ch/de/praktika' })).toBe(true);
    });
    it('rejects unrelated', () => {
      expect(isKlinikGutJob(null)).toBe(false);
      expect(isKlinikGutJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts klinik-gut.ch and subdomains', () => {
      expect(isTrustedDomain('https://www.klinik-gut.ch/de/praktika')).toBe(true);
      expect(isTrustedDomain('https://klinik-gut.ch/x')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://evil-klinik-gut.example.com')).toBe(false);
      expect(isTrustedDomain('not a url')).toBe(false);
    });
  });

  describe('parseKlinikGutListing', () => {
    it('extracts real openings and drops the restricted aggregator card', () => {
      const rows = parseKlinikGutListing(LISTING_HTML);
      // 3 cards in fixture, but the "/de/offene-stellen" CTA is filtered out.
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.id)).toEqual([
        'wahlstudienjahr-praktisches-jahr',
        'dipl-pflegefachperson-hf',
      ]);
      expect(rows.map((r) => r.detailUrl)).not.toContain(
        'https://www.klinik-gut.ch/de/offene-stellen',
      );
    });

    it('drops a card linking off-domain to a social profile (#2680 Instagram)', () => {
      const html = `<ul>
    <li class="rz-infobox__item">
      <h3>Social Media</h3>
      <div class="infobox__text">Folgen Sie uns auf Instagram</div>
      <a href="https://www.instagram.com/klinikgut/" class="infobox__more btn btn-primary">Mehr Informationen</a>
    </li>
    <li class="rz-infobox__item">
      <h3>Dipl. Pflegefachperson HF</h3>
      <div class="infobox__text">Pflege in St. Moritz</div>
      <a href="https://www.klinik-gut.ch/de/dipl-pflegefachperson-hf" class="infobox__more btn btn-primary">Mehr Informationen</a>
    </li>
  </ul>`;
      const rows = parseKlinikGutListing(html);
      // The Instagram "Social Media" card is filtered; only the real opening remains.
      expect(rows.map((r) => r.id)).toEqual(['dipl-pflegefachperson-hf']);
      expect(rows.every((r) => r.detailUrl.includes('klinik-gut.ch'))).toBe(true);
    });

    it('uses the stable path slug as canonical id', () => {
      const rows = parseKlinikGutListing(LISTING_HTML);
      expect(rows[0].id).toBe('wahlstudienjahr-praktisches-jahr');
      expect(rows[0].detailUrl).toBe(
        'https://www.klinik-gut.ch/de/wahlstudienjahr-praktisches-jahr',
      );
    });

    it('captures the teaser text and decodes entities', () => {
      const rows = parseKlinikGutListing(LISTING_HTML);
      expect(rows[0].teaser).toContain('Orthopädie');
      expect(rows[0].teaser).not.toContain('&nbsp;');
    });

    it('keeps the HQ default when a card names two group sites', () => {
      // Card 1 names BOTH St. Moritz and Fläsch → ambiguous → HQ default.
      const rows = parseKlinikGutListing(LISTING_HTML);
      expect(rows[0].location.city).toBe('St. Moritz');
      expect(rows[0].location.canton).toBe('GR');
    });

    it('upgrades location when a card names exactly one site', () => {
      // Card 2 names only Chur (GR).
      const rows = parseKlinikGutListing(LISTING_HTML);
      expect(rows[1].location.city).toBe('Chur');
      expect(rows[1].location.canton).toBe('GR');
    });

    it('returns empty on empty/invalid HTML', () => {
      expect(parseKlinikGutListing('')).toEqual([]);
      expect(parseKlinikGutListing(null)).toEqual([]);
    });

    it('still parses rows when Drupal appends a modifier class', () => {
      // e.g. `class="rz-infobox__item rz-infobox__item--featured"`; the item
      // regex must match the class token, not a quote-strict `class="X"`.
      const html = LISTING_HTML.replace(
        /class="rz-infobox__item"/g,
        'class="rz-infobox__item rz-infobox__item--featured"',
      );
      const rows = parseKlinikGutListing(html);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.id)).toEqual([
        'wahlstudienjahr-praktisches-jahr',
        'dipl-pflegefachperson-hf',
      ]);
    });
  });

  describe('parseKlinikGutDetail', () => {
    it('extracts the posting body from the node--type-page content', () => {
      const { body } = parseKlinikGutDetail(DETAIL_HTML);
      expect(body).toContain('Wahlstudienjahres');
      expect(body).toContain('Unterassistenzärztin');
      expect(body.split(/\s+/).length).toBeGreaterThan(30);
    });

    it('trims the trailing "Zuständige Personen" contact card', () => {
      const { body } = parseKlinikGutDetail(DETAIL_HTML);
      expect(body).not.toContain('Zuständige Personen');
      expect(body).not.toContain('Noemi Bossi');
    });

    it('returns an empty body on empty/invalid HTML', () => {
      expect(parseKlinikGutDetail('').body).toBe('');
      expect(parseKlinikGutDetail(null).body).toBe('');
    });
  });
});
