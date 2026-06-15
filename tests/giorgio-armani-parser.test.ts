import { describe, it, expect } from 'vitest';
import {
  parseGiorgioArmaniListingHtml,
  listingHasRenderedJobs,
  isGiorgioArmaniSwissJob,
  parseGiorgioArmaniJobDetail,
} from '../scripts/lib/giorgio-armani-job-parser.mjs';

// Hydrated listing markup, mirroring the real SAP SuccessFactors SPA output
// (career5.successfactors.eu, company=3397177P) after the in-browser DWR render.
// Each job is a `tr.jobResultItem` with `a.jobTitle` + a `.noteSection` whose
// `.jobContentEM` spans are [reqId, "Posted on DATE", AREA, COUNTRY].
const LISTING_HTML = `
<table><tbody>
  <tr class="jobResultItem">
    <td><div role="heading" aria-level="3">
      <a class="jobTitle" href="/career?career%5fns=job%5flisting&company=3397177P&career_job_req_id=5103&selected_lang=it_IT">Talent Acquisition Specialist</a>
    </div>
    <div class="noteSection" role="note"><div>Requisition ID: <span class="jobContentEM">5103</span> - <span class="jobContentEM">Posted on 06/11/2026</span> - <span class="jobContentEM">HUMAN RESOURCES</span>&nbsp;&nbsp;-&nbsp;&nbsp;<span class="jobContentEM">Italy</span></div></div>
    </td>
  </tr>
  <tr class="jobResultItem">
    <td><div role="heading" aria-level="3">
      <a class="jobTitle" href="/career?career%5fns=job%5flisting&company=3397177P&career_job_req_id=5074&selected_lang=it_IT">Sales Associate - Armani Outlet Mendrisio</a>
    </div>
    <div class="noteSection" role="note"><div>Requisition ID: <span class="jobContentEM">5074</span> - <span class="jobContentEM">Posted on 05/30/2026</span> - <span class="jobContentEM">RETAIL</span>&nbsp;&nbsp;-&nbsp;&nbsp;<span class="jobContentEM">Switzerland</span></div></div>
    </td>
  </tr>
</tbody></table>
`;

describe('parseGiorgioArmaniListingHtml', () => {
  it('extracts reqId, title, area, country, postedDate from hydrated tiles', () => {
    const rows = parseGiorgioArmaniListingHtml(LISTING_HTML);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      reqId: '5103',
      title: 'Talent Acquisition Specialist',
      area: 'HUMAN RESOURCES',
      country: 'Italy',
      postedDate: '06/11/2026',
    });
    expect(rows[1]).toMatchObject({
      reqId: '5074',
      title: 'Sales Associate - Armani Outlet Mendrisio',
      area: 'RETAIL',
      country: 'Switzerland',
      postedDate: '05/30/2026',
    });
  });

  it('returns [] for an un-hydrated SPA shell (no jobResultItem rows)', () => {
    expect(parseGiorgioArmaniListingHtml('<html><body><div id="app"></div></body></html>')).toEqual([]);
  });
});

describe('listingHasRenderedJobs', () => {
  it('is true once hydrated job tiles are present', () => {
    expect(listingHasRenderedJobs(LISTING_HTML)).toBe(true);
  });
  it('is false for the empty SPA shell', () => {
    expect(listingHasRenderedJobs('<html><body></body></html>')).toBe(false);
  });
  it('stays true when SuccessFactors appends a state class to the row', () => {
    // SF routinely renders `class="jobResultItem odd"` / `"jobTitle active"`;
    // the gate must match the class token, not a quote-strict `class="X"`.
    expect(listingHasRenderedJobs('<tr class="jobResultItem odd">')).toBe(true);
    expect(listingHasRenderedJobs('<a class="jobTitle active">')).toBe(true);
  });
});

describe('isGiorgioArmaniSwissJob (filter applied to listing rows)', () => {
  it('keeps Switzerland-country rows and Swiss-city titles, drops Italy', () => {
    const rows = parseGiorgioArmaniListingHtml(LISTING_HTML);
    const swiss = rows.filter((r: { title: string; country: string }) =>
      isGiorgioArmaniSwissJob(r.title, r.country),
    );
    expect(swiss.map((r: { reqId: string }) => r.reqId)).toEqual(['5074']);
  });
});

describe('parseGiorgioArmaniJobDetail (hydrated detail page)', () => {
  it('extracts the title and the .joqReqDescription body', () => {
    const detailHtml = `
      <html><head><title>Career Opportunities: Sales Associate - Armani Outlet Mendrisio (5074)</title></head>
      <body>
        <div tabindex="0">Requisition ID <b>5074</b> - Posted <b id="postedOnDate"></b> - <b>RETAIL</b> - <b>Switzerland</b></div>
        <div class="joqReqDescription"><div class="externalPosting">
          <p>Il Gruppo Armani cerca un Sales Associate per l'outlet di Mendrisio.</p>
          <ul><li>Accoglienza clienti</li><li>Gestione vendite</li></ul>
        </div></div>
      </body></html>`;
    const parsed = parseGiorgioArmaniJobDetail(detailHtml);
    expect(parsed.title).toBe('Sales Associate - Armani Outlet Mendrisio');
    expect(parsed.country).toBe('Switzerland');
    expect(parsed.description).toContain('Sales Associate');
    expect(parsed.description).toContain('Accoglienza clienti');
  });
});
