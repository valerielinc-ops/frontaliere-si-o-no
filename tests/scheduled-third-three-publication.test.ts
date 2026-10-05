import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllCroixRougeFribourgeoiseJobs } from '../scripts/lib/croix-rouge-fribourgeoise-job-parser.mjs';
import { fetchAllEngadinTourismusJobs } from '../scripts/lib/engadin-tourismus-job-parser.mjs';
import { fetchAllEnteroJobs } from '../scripts/lib/entero-job-parser.mjs';
const title = 'Fachperson Kundenberatung';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
const id = '00000000-0000-4000-8000-000000000000';
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const [name, producer] of [['Croix', fetchAllCroixRougeFribourgeoiseJobs], ['Engadin', fetchAllEngadinTourismusJobs], ['Entero', fetchAllEnteroJobs]] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future', 'creation-only', 'foreign-url', 'other-title'] as const) {
    if (name === 'Croix' && (kind === 'foreign-url' || kind === 'other-title')) continue;
    it(`${name}: explicit detail publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = ['valid', 'foreign-url', 'other-title'].includes(kind) ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const detailUrl = name === 'Croix' ? `https://www.jobup.ch/fr/emplois/detail/${id}/` : name === 'Engadin' ? 'https://www.engadintourismus.ch/ueber-uns/jobs/jobs/fixture' : 'https://www.entero.ch/de/karriere/fixture';
      const structuredUrl = kind === 'valid' && name !== 'Croix' ? `${detailUrl}/` : undefined;
      const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Another vacancy' : title, url: kind === 'foreign-url' ? 'https://employer.example/jobs/someone-else' : structuredUrl, description: body, datePosted: raw, dateCreated: kind === 'creation-only' ? `${year}-01-01` : undefined, jobLocation: { address: { addressLocality: 'Fribourg' } } };
      const html = `<main><h1>${title}</h1><div class="ce-bodytext">${body}</div></main><script type="application/ld+json">${JSON.stringify(posting)}</script>`;
      const transport = vi.fn(async (input) => {
        const url = String(input);
        let text = html;
        if (name === 'Croix' && url.includes('/job-list/')) text = '<html>No listing links</html>';
        else if (name === 'Croix' && url.includes('/societes/')) text = `<section data-cy="company-job-list"><a href="${detailUrl}">${title}</a></section>`;
        else if (name === 'Engadin' && !url.endsWith('/fixture')) text = `<a class="more" title="${title}" href="/ueber-uns/jobs/jobs/fixture">Mehr lesen</a>`;
        else if (name === 'Entero' && !url.endsWith('/fixture')) text = `<h3>${title}</h3><a href="/de/karriere/fixture">Details</a>`;
        return new Response(text, { status: 200 });
      });
      vi.stubGlobal('fetch', transport);
      const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('engagierten Team');
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(transport).toHaveBeenCalledTimes(name === 'Croix' ? 3 : 2);
    });
  }
}
for (const invalid of [false, true]) {
  it(`Croix: explicit Date de publication label validates calendar (${invalid})`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const day = invalid ? `30.2.${year}` : `15.6.${year}`;
    const path = `/fr/jobs/${id}`;
    const html = `<main><h1>${title}</h1><div class="text-rich-text w-richtext"><div class="C_PBODYHTML">${body}</div></div><div class="job_details_keyinfos-wrapper"><div class="job_details_keyinfo-details"><div class="text-weight-semibold">Date de publication</div><div class="text-size-small">${day}</div></div></div></main>`;
    vi.stubGlobal('fetch', vi.fn(async (input) => new Response(String(input).includes('/job-list/') ? `<a href="${path}">${title}</a>` : html, { status: 200 })));
    const pending = fetchAllCroixRougeFribourgeoiseJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(invalid ? { datePosted: '', postedDate: '', postingDateSource: 'unknown' } : { datePosted: `${year}-06-15`, postedDate: `${year}-06-15`, postingDateSource: 'reported' });
  });
}
