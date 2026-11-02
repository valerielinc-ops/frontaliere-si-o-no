import { describe, expect, it, vi } from 'vitest';

// The parser imports `slugify` from the full crawler template, whose module
// also loads generated canton data that is intentionally absent in sparse
// agent checkouts. Keep this unit test scoped to the Klinik parser contract.
vi.mock('../scripts/lib/crawler-template.mjs', () => ({
  slugify: (value: string) => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

import {
  KLINIK_ADELHEID_KEY,
  PUBLIC_CAREER_URL,
  parseAdelheidListing,
} from '../scripts/lib/klinik-adelheid-job-parser.mjs';

// Trimmed current markup from the official career page. The parent
// `/jobs-und-karriere/` page remains the source of the two-column listing;
// `/jobs-und-karriere/offene-stellen/` redirects away from that table.
const LISTING_HTML = `
<table class="table-link">
  <tr>
    <td><a href="/job/chefarztsekretaer-in-80-100-47/">Chefarztsekretär/in 80 – 100%</a></td>
    <td><a href="/job/chefarztsekretaer-in-80-100-47/">Medizin</a></td>
  </tr>
  <tr>
    <td><a href="/job/dipl-pflegefachfrau-mann-hf-60-100-46/">Dipl. Pflegefachfrau/-mann HF 60 - 100%</a></td>
    <td><a href="/job/dipl-pflegefachfrau-mann-hf-60-100-46/">Pflege</a></td>
  </tr>
</table>
`;

describe('Klinik Adelheid crawler parser', () => {
  it('uses the populated official career page as its listing source', () => {
    expect(KLINIK_ADELHEID_KEY).toBe('klinik-adelheid');
    expect(PUBLIC_CAREER_URL).toBe('https://www.klinik-adelheid.ch/jobs-und-karriere/');
  });

  it('extracts current two-column openings and their detail paths', () => {
    expect(parseAdelheidListing(LISTING_HTML)).toEqual([
      {
        path: '/job/chefarztsekretaer-in-80-100-47/',
        title: 'Chefarztsekretär/in 80 – 100%',
        bereich: 'Medizin',
      },
      {
        path: '/job/dipl-pflegefachfrau-mann-hf-60-100-46/',
        title: 'Dipl. Pflegefachfrau/-mann HF 60 - 100%',
        bereich: 'Pflege',
      },
    ]);
  });
});
