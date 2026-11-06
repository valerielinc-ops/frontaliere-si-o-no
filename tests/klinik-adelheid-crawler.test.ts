import { describe, expect, it, vi } from 'vitest';

// The parser imports `slugify` from the full crawler template, whose module
// also loads generated canton data that is intentionally absent in sparse
// agent checkouts. Keep this unit test scoped to the Klinik parser contract.
vi.mock('../scripts/lib/crawler-template.mjs', () => ({
  fetchJson: vi.fn(),
  slugify: (value: string) => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

import {
  extractOstendisToken,
  isTrustedDomain,
  KLINIK_ADELHEID_KEY,
  PUBLIC_CAREER_URL,
  parseAdelheidListing,
} from '../scripts/lib/klinik-adelheid-job-parser.mjs';

const OSTENDIS_TOKEN = 'd1bd317b5080428a898215e0bf2cb47e';
const CAREER_HTML = `
  <script src="https://odm.ostendis.com/ojp/assets/loader"
    data-token="${OSTENDIS_TOKEN}" id="ostendisLoader"></script>
  <div id="ostendisJobs"></div>
  <script>OSTENDISJOBS.embed("${OSTENDIS_TOKEN}", "DE", "#ostendisJobs", {});</script>
`;

const LISTING_PAYLOAD = {
  jobs: [
    {
      id: 81965,
      title: 'Chefarztsekretär/in 80 - 100%',
      department: 'Medizin',
      detail: 'https://link.ostendis.com/publication/chefarztsekretaer-in/source-token-1',
      action: '',
      published: '30.09.2026',
    },
    {
      id: 81968,
      title: 'Dipl. Pflegefachfrau/-mann HF 60 - 100%',
      department: 'Pflege',
      detail: 'https://link.ostendis.com/publication/dipl-pflegefachfrau-mann-hf/source-token-2',
      action: '',
      published: '30.09.2026',
    },
  ],
};

describe('Klinik Adelheid crawler parser', () => {
  it('uses the populated official career page as its listing source', () => {
    expect(KLINIK_ADELHEID_KEY).toBe('klinik-adelheid');
    expect(PUBLIC_CAREER_URL).toBe('https://www.klinik-adelheid.ch/jobs-karriere/offene-jobs/');
    expect(extractOstendisToken(CAREER_HTML)).toBe(OSTENDIS_TOKEN);
  });

  it('extracts current Ostendis openings and their detail URLs', () => {
    expect(parseAdelheidListing(LISTING_PAYLOAD)).toEqual([
      {
        id: 81965,
        title: 'Chefarztsekretär/in 80 - 100%',
        bereich: 'Medizin',
        detailUrl: 'https://link.ostendis.com/publication/chefarztsekretaer-in/source-token-1',
        applyUrl: 'https://link.ostendis.com/publication/chefarztsekretaer-in/source-token-1',
        published: '30.09.2026',
      },
      {
        id: 81968,
        title: 'Dipl. Pflegefachfrau/-mann HF 60 - 100%',
        bereich: 'Pflege',
        detailUrl: 'https://link.ostendis.com/publication/dipl-pflegefachfrau-mann-hf/source-token-2',
        applyUrl: 'https://link.ostendis.com/publication/dipl-pflegefachfrau-mann-hf/source-token-2',
        published: '30.09.2026',
      },
    ]);
  });

  it('trusts only the clinic site and the official Ostendis publication host', () => {
    expect(isTrustedDomain(PUBLIC_CAREER_URL)).toBe(true);
    expect(isTrustedDomain(LISTING_PAYLOAD.jobs[0].detail)).toBe(true);
    expect(isTrustedDomain('https://other.example/publication/test')).toBe(false);
  });
});
