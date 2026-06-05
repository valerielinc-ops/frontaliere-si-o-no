import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs crawler lib, no type declarations
import { parseOnlyfyListing } from '../scripts/lib/onlyfy-listing-common.mjs';

// Redesigned onlyfy.jobs card markup (2026). Both spitex-zuerich and
// vitrea-gesundheit sit on this portal; the old `<strong class="job-title">`
// selector silently returned 0 after this redesign.
const NEW_MARKUP = `
<div class="results">
  <a class="..." data-testid="job-card"
     aria-label="Dipl. Pflegefachfrau/-mann 60-100% (a)"
     href="/de/job/m6pttk2bqih13nqd4pbab9zfy4ntcpd">
    <div><h3 class="heading text-primary" data-testid="job-title">Dipl. Pflegefachfrau/-mann 60-100% (a)</h3></div>
    <div class="text-sm text-primary" data-testid="job-more-info">Zürich | Teilzeit / Vollzeit | 18.05.2026</div>
  </a>
  <a data-testid="job-card" aria-label="Fachfrau Gesundheit FaGe 40-90%"
     href="/de/job/acyvj8k21gua2zs1trmrl9ksk9ph92j">
    <div><h3 data-testid="job-title">Fachfrau Gesundheit FaGe 40-90%</h3></div>
    <div data-testid="job-more-info">Winterthur | Teilzeit | 12.05.2026</div>
  </a>
</div>`;

// The legacy markup the parser used to depend on — must yield nothing now, so a
// silent fallback to the old selector can never mask a future redesign.
const OLD_MARKUP = `
<strong class="job-title"><a href="/job/abc123def456">Pflegefachperson HF</a></strong>
<i class="icon-map-marker">Zürich</i><i class="icon-time">Teilzeit</i>`;

describe('parseOnlyfyListing', () => {
  it('extracts cards from the redesigned data-testid markup', () => {
    const rows = parseOnlyfyListing(NEW_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
      defaultLocation: 'Zürich',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Dipl. Pflegefachfrau/-mann 60-100% (a)',
      location: 'Zürich',
      employmentTypeStr: 'Teilzeit / Vollzeit',
      url: 'https://spitex-zuerich.onlyfy.jobs/de/job/m6pttk2bqih13nqd4pbab9zfy4ntcpd',
    });
    expect(rows[1].location).toBe('Winterthur');
  });

  it('returns no rows for the deprecated legacy markup (no silent fallback)', () => {
    const rows = parseOnlyfyListing(OLD_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(0);
  });

  it('dedupes repeated job-card hrefs', () => {
    const rows = parseOnlyfyListing(NEW_MARKUP + NEW_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(2);
  });

  // onlyfy hashes are opaque; a `-` separator must NOT make the listing guard
  // reject the card (silent-zero) nor truncate the per-tenant matchKey to a
  // partial key (previousSlugs fragmentation, #829 class). Hash char-class is
  // `[a-z0-9-]` here AND in the update-* matchKey regex — keep them in lockstep.
  it('accepts job hashes that contain a hyphen separator', () => {
    const HYPHEN_MARKUP = `
      <a data-testid="job-card" aria-label="Pflegefachperson HF 80%"
         href="/de/job/abc123-def456-ghi789">
        <div><h3 data-testid="job-title">Pflegefachperson HF 80%</h3></div>
        <div data-testid="job-more-info">Zürich | Vollzeit | 01.06.2026</div>
      </a>`;
    const rows = parseOnlyfyListing(HYPHEN_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://spitex-zuerich.onlyfy.jobs/de/job/abc123-def456-ghi789');

    // Mirror of the `matchKey` extraction in the update-* crawlers: the full
    // hyphenated hash must survive, not truncate at the first `-`.
    const matchKey = (j: { url: string }) =>
      j.url.match(/\/job\/([a-z0-9-]+)/i)?.[1] || j.url;
    expect(matchKey(rows[0])).toBe('abc123-def456-ghi789');
  });
});
