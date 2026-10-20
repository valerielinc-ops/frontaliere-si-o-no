import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllModellstationSomosaJobs } from '../scripts/lib/modellstation-somosa-job-parser.mjs';
import { fetchAllMolecularPartnersJobs } from '../scripts/lib/molecular-partners-job-parser.mjs';
import { fetchAllPallasKlinikenJobs } from '../scripts/lib/pallas-kliniken-job-parser.mjs';
const title = 'Fachperson Pflege';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const [name, producer] of [['Somosa', fetchAllModellstationSomosaJobs], ['Molecular', fetchAllMolecularPartnersJobs], ['Pallas', fetchAllPallasKlinikenJobs]] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future', 'creation-only', 'foreign-url', 'foreign-sameas', 'ambiguous', 'singleton-url-less']) {
    it(`${name}: source publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = ['valid', 'foreign-url', 'foreign-sameas', 'ambiguous', 'singleton-url-less'].includes(kind) ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T00:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const url = name === 'Somosa' ? 'https://www.somosa.ch/offene-stellen-detail/fixture' : name === 'Molecular' ? 'https://molecularpartners-career.talent-soft.com/job/fixture.aspx' : 'https://pallasjobs.careers.flair.hr/positions/fixture';
      const posting = { '@type': 'JobPosting', title, description: body, datePosted: raw, dateCreated: `${year}-01-01`, url: ['ambiguous', 'singleton-url-less'].includes(kind) ? undefined : kind === 'foreign-url' ? 'https://wrong.example/job' : url, sameAs: kind === 'foreign-sameas' ? 'https://wrong.example/job' : undefined };
      const detail = `<script type="application/ld+json">${JSON.stringify(posting)}</script>${kind === 'ambiguous' ? `<script type="application/ld+json">${JSON.stringify({ ...posting, datePosted: `${year}-01-01` })}</script>` : ''}<h1>${title}</h1><main><div class="ce_text"><p>${body}</p></div></main><div id="contenu-ficheoffre"><p>${body}</p></div>`;
      const listing = name === 'Somosa' ? `<a href="offene-stellen-detail/fixture" title="Den Artikel lesen: ${title}">Weiterlesen</a>` : name === 'Molecular' ? `<li class="ts-offer-list-item" onclick="location.href='/job/fixture.aspx';"><h3><a class="ts-offer-list-item__title-link">${title}</a></h3><span data-reference="2025-001"></span><ul class="ts-offer-list-item__description"><li>15/06/${year}</li></ul></li>` : '<a href="/positions/fixture">Details</a>';
      const transport = vi.fn(async (input: string | URL | Request) => new Response(String(input) === url ? detail : String(input).includes('&page=2') ? '' : listing, { status: 200 }));
      vi.stubGlobal('fetch', transport); const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(['valid', 'singleton-url-less'].includes(kind) ? { datePosted: raw, postedDate: raw!.slice(0, 10), postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('engagierten Team'); expect(jobs[0].url).toBe(url); expect(jobs[0].crawledAt).toBeTruthy();
      expect(transport).toHaveBeenCalledTimes(name === 'Molecular' ? 3 : 2);
    });
  }
}
