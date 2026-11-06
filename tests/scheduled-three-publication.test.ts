import { afterEach, expect, it, vi } from 'vitest';
import { fetchAllAirZermattJobs } from '../scripts/lib/air-zermatt-job-parser.mjs';
import { fetchAllAmsteinWalthertJobs } from '../scripts/lib/amstein-walthert-job-parser.mjs';
import { fetchAllBcvsJobs } from '../scripts/lib/bcvs-job-parser.mjs';
const title = 'Fachperson Kundenberatung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
afterEach(() => vi.unstubAllGlobals());
for (const [name, producer] of [['Air Zermatt', fetchAllAirZermattJobs], ['Amstein', fetchAllAmsteinWalthertJobs], ['BCVS', fetchAllBcvsJobs]] as const) {
  for (const kind of ['valid', 'missing', 'creation-only', 'invalid', 'future', 'other-title'] as const) {
    it(`${name} preserves only this vacancy's explicit publication (${kind})`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = kind === 'valid' || kind === 'other-title' ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const ld = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Another vacancy' : title, datePosted: raw, dateCreated: kind === 'creation-only' ? `${year}-01-01` : undefined, dateModified: `${year}-06-01` };
      const detail = `<main><h1>${title}</h1><div class="intro listing-content-text">${body}</div></main><script type="application/ld+json">${JSON.stringify(ld)}</script>`;
      const path = name === 'Air Zermatt' ? '/de/service/offene-stellen/fixture-123' : name === 'Amstein' ? '/de/uber-w/w-als-arbeitgeber/offene-stellen/fixture/' : '/la-bcvs/carriere/offres/job/fixture';
      const listing = name === 'Air Zermatt'
        ? `<div class="listing_entry" data-entry-id="123"><h2 class="listing-title"><a href="${path}">${title}</a></h2><div class="listing-content-text">${body}</div></div>`
        : name === 'Amstein' ? JSON.stringify({ objects: [{ id: 'fixture', title, url: path, workplace: 'Zürich', workplace_id: 'zurich' }] })
        : `<a href="${path}"><h4>${title}</h4><ul><li>Sion</li><li>100%</li></ul></a>`;
      const transport = vi.fn(async (input) => new Response(String(input).endsWith(path) ? detail : listing, { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const jobs = await producer();
      expect(jobs).toHaveLength(1);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(jobs[0]).toMatchObject(kind === 'valid'
        ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' }
        : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(jobs[0].description).toContain('engagierten Team');
    });
  }
}
