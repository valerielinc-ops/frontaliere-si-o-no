import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SENEVITA_KEY,
  SENEVITA_COMPANY_NAME,
  parseSenevitaListing,
  parseSenevitaDeclaredTotal,
  isSenevitaJob,
  isTrustedDomain,
} from '../scripts/lib/senevita-job-parser.mjs';

// Trimmed real markup from https://jobs.senevita.ch/stellenangebote.html
// (fetched live 2026-08-07): the results-container opening tag that carries the
// source-declared total, plus the first 3 job cards exactly as rexx systems
// renders them TODAY — i.e. as `<article class="joboffer_container">`.
const LISTING_HTML = readFileSync(
  path.join(__dirname, 'fixtures', 'senevita-listing.html'),
  'utf8',
);

// The SAME card, rendered the way rexx used to emit it before 2026-08-02: a
// `<div>` wrapper instead of an `<article>`. Kept as a live test rather than a
// comment because that one-character difference is the whole of #5246 — the
// parser must not care which of the two it is handed.
const LEGACY_DIV_HTML = `
<section class="real_table_container" data-count="1" data-all-count="1">
<div id="joboffers">
<div class="joboffer_container" onclick="window.location.href='https://jobs.senevita.ch/Pflegefachfrau-mann-80-100-de-j4242.html'">
<div class="joboffer_outer"><div class="joboffer_inner">
<div class="joboffer_title_text joboffer_box">
<a target="_self" href="https://jobs.senevita.ch/Pflegefachfrau-mann-80-100-de-j4242.html">Pflegefachfrau/-mann 80-100%</a>
</div>
<div class="joboffer_informations joboffer_box">BE Burgdorf</div>
</div></div>
</div>
</div>
</section>`;

describe('Senevita crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SENEVITA_KEY).toBe('senevita');
    expect(SENEVITA_COMPANY_NAME).toBe('Senevita');
  });

  // ── parseSenevitaListing ──
  describe('parseSenevitaListing', () => {
    it('extracts one row per card from the current <article> markup (#5246)', () => {
      const rows = parseSenevitaListing(LISTING_HTML);
      expect(rows).toHaveLength(3);
    });

    it('reads the job id out of the card URL', () => {
      const rows = parseSenevitaListing(LISTING_HTML);
      expect(rows[0].jobId).toBe('5187');
      expect(rows[0].url).toBe(
        'https://jobs.senevita.ch/Zeit-fuer-Pflege-statt-Klingelstress-Spitex-Senevita-Casa--de-j5187.html',
      );
    });

    it('reads the title from the card\'s own detail anchor', () => {
      const rows = parseSenevitaListing(LISTING_HTML);
      expect(rows[0].title).toContain('Spitex Senevita Casa Emmental');
      // Trailing &nbsp; and the surrounding whitespace must be normalised away.
      expect(rows[0].title).toBe(rows[0].title.trim());
      expect(rows[0].title).not.toMatch(/ /);
    });

    it('reads the location from the job_standort span', () => {
      const rows = parseSenevitaListing(LISTING_HTML);
      expect(rows[0].location).toBe('BE Muri b. Bern');
      expect(rows.every((r) => r.location.length > 0)).toBe(true);
    });

    it('parses the LAST card on the page, which has no following card to stop at', () => {
      // The previous implementation bounded each card with a lookahead naming
      // the markup that follows the list (pagebar / joblist_navigator / …), so
      // the final card was lost whenever that trailing markup changed shape.
      const rows = parseSenevitaListing(LISTING_HTML);
      expect(rows[2].jobId).toBe('4520');
      expect(rows[2].title.length).toBeGreaterThan(3);
      expect(rows[2].location).toBe('BE Muri b. Bern');
    });

    it('still parses the legacy <div> wrapper', () => {
      const rows = parseSenevitaListing(LEGACY_DIV_HTML);
      expect(rows).toHaveLength(1);
      expect(rows[0].jobId).toBe('4242');
      expect(rows[0].title).toBe('Pflegefachfrau/-mann 80-100%');
      expect(rows[0].location).toBe('BE Burgdorf');
    });

    it('is not bound to the wrapper tag name at all', () => {
      // Guards the actual regression class: rexx swapping <article> for some
      // third element must not take the crawler to zero again.
      const asSectionTag = LEGACY_DIV_HTML
        .replace('<div class="joboffer_container"', '<li class="joboffer_container"');
      expect(parseSenevitaListing(asSectionTag)).toHaveLength(1);
    });

    it('does not match a differently-named class by prefix', () => {
      const renamed = LEGACY_DIV_HTML.replace('joboffer_container"', 'joboffer_container_v2"');
      expect(parseSenevitaListing(renamed)).toHaveLength(0);
    });

    it('skips cards whose URL carries no -j<id> suffix', () => {
      const noId = LEGACY_DIV_HTML.replace('-de-j4242.html', '-de.html');
      expect(parseSenevitaListing(noId)).toHaveLength(0);
    });

    it('deduplicates repeated job ids', () => {
      const doubled = LEGACY_DIV_HTML + LEGACY_DIV_HTML;
      expect(parseSenevitaListing(doubled)).toHaveLength(1);
    });

    it('handles empty / non-string input', () => {
      expect(parseSenevitaListing('')).toEqual([]);
      expect(parseSenevitaListing(null as unknown as string)).toEqual([]);
      expect(parseSenevitaListing(undefined as unknown as string)).toEqual([]);
    });
  });

  // ── parseSenevitaDeclaredTotal ──
  describe('parseSenevitaDeclaredTotal', () => {
    it('reads the source-declared total off the results container', () => {
      expect(parseSenevitaDeclaredTotal(LISTING_HTML)).toBe(172);
    });

    it('returns null when the counter is absent', () => {
      expect(parseSenevitaDeclaredTotal('<div>no counter here</div>')).toBeNull();
      expect(parseSenevitaDeclaredTotal('')).toBeNull();
    });
  });

  // ── isSenevitaJob ──
  describe('isSenevitaJob', () => {
    it('matches by companyKey, company name and URL', () => {
      expect(isSenevitaJob({ companyKey: 'senevita' })).toBe(true);
      expect(isSenevitaJob({ company: 'Senevita AG' })).toBe(true);
      expect(isSenevitaJob({ url: 'https://jobs.senevita.ch/foo-de-j1.html' })).toBe(true);
    });

    it('rejects unrelated jobs and handles null input', () => {
      expect(isSenevitaJob({ companyKey: 'other', company: 'Other', url: 'https://other.ch' })).toBe(false);
      expect(isSenevitaJob(null)).toBe(false);
      expect(isSenevitaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the ATS host and the corporate domain', () => {
      expect(isTrustedDomain('https://jobs.senevita.ch/x-de-j1.html')).toBe(true);
      expect(isTrustedDomain('https://www.senevita.ch/')).toBe(true);
    });

    it('rejects other domains and invalid URLs', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('https://senevita.ch.evil.com/')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });
});
