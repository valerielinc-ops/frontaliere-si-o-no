import { describe, expect, it } from 'vitest';
import { parseSolinaListing } from '../scripts/lib/solina-job-parser.mjs';

/* ── Listing HTML fixtures ─────────────────────────────────── */

// New 2-segment shape (post 2026-07 restructure) — consolidated listing.
const NEW_SHAPE_HTML = `
<div class="news-list">
  <a href="/offene-stellen/pflege-betreuung/pflegehelferin-1xcklcar">Pflegehelfer:in</a>
  <a href="/offene-stellen/pflege-betreuung/fachfrau-fachmann-gesundheit-hskbuacc">Fachfrau/-mann Gesundheit</a>
  <a href="/offene-stellen/pflege-betreuung/pflegehelferin-1xcklcar">Pflegehelfer:in (duplicate)</a>
</div>
`;

// Old 3-segment /details/ shape — still served by ausbildung-praktika.
const OLD_DETAILS_HTML = `
<div class="news-list">
  <a href="/offene-stellen/ausbildung-praktika/details/praktikantin-wh3pi42l">Praktikant:in</a>
  <a href="/offene-stellen/ausbildung-praktika/details/vorpraktikantin-hthofbkc">Vorpraktikant:in</a>
</div>
`;

// Lehrstellen 3-segment shape — also on ausbildung-praktika.
const LEHRSTELLEN_HTML = `
<div class="news-list">
  <a href="/offene-stellen/ausbildung-praktika/lehrstellen/lehrstelle-koechin-koch-ex5t63qi">Lehrstelle Köchin / Koch</a>
  <a href="/offene-stellen/ausbildung-praktika/lehrstellen/lehrstelle-kauffrau-kaufmann-o7rpsozf">Lehrstelle Kauffrau/-mann</a>
</div>
`;

// Static apply-now page: same 2-segment shape but no "-{hash}" suffix.
const FALSE_POSITIVE_HTML = `
<div class="news-list">
  <a href="/offene-stellen/zivildienst/bewerbung">Jetzt bewerben</a>
  <a href="/offene-stellen/pflege-betreuung">Kategorie-Link (1 Segment)</a>
</div>
`;

/* ── Tests ─────────────────────────────────────────────────── */

describe('parseSolinaListing', () => {
  it('matches the new 2-segment shape and dedupes', () => {
    const urls = parseSolinaListing(NEW_SHAPE_HTML);
    expect(urls).toEqual([
      'https://jobs.solina.ch/offene-stellen/pflege-betreuung/pflegehelferin-1xcklcar',
      'https://jobs.solina.ch/offene-stellen/pflege-betreuung/fachfrau-fachmann-gesundheit-hskbuacc',
    ]);
  });

  it('matches the old 3-segment /details/ shape', () => {
    const urls = parseSolinaListing(OLD_DETAILS_HTML);
    expect(urls).toEqual([
      'https://jobs.solina.ch/offene-stellen/ausbildung-praktika/details/praktikantin-wh3pi42l',
      'https://jobs.solina.ch/offene-stellen/ausbildung-praktika/details/vorpraktikantin-hthofbkc',
    ]);
  });

  it('matches the /lehrstellen/ shape', () => {
    const urls = parseSolinaListing(LEHRSTELLEN_HTML);
    expect(urls).toEqual([
      'https://jobs.solina.ch/offene-stellen/ausbildung-praktika/lehrstellen/lehrstelle-koechin-koch-ex5t63qi',
      'https://jobs.solina.ch/offene-stellen/ausbildung-praktika/lehrstellen/lehrstelle-kauffrau-kaufmann-o7rpsozf',
    ]);
  });

  it('excludes non-job links without the hash suffix (e.g. /zivildienst/bewerbung)', () => {
    expect(parseSolinaListing(FALSE_POSITIVE_HTML)).toEqual([]);
  });

  it('finds all three shapes on a mixed page', () => {
    const urls = parseSolinaListing(NEW_SHAPE_HTML + OLD_DETAILS_HTML + LEHRSTELLEN_HTML + FALSE_POSITIVE_HTML);
    expect(urls).toHaveLength(6);
    expect(urls.some((u) => u.includes('/bewerbung'))).toBe(false);
  });
});
