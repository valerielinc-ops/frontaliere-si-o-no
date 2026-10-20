import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllLindenhofgruppeJobs } from '../scripts/lib/lindenhofgruppe-job-parser.mjs';
import { fetchAllSpitalUsterJobs } from '../scripts/lib/spital-uster-job-parser.mjs';
import { fetchAllUnispitalBaselJobs } from '../scripts/lib/unispital-basel-job-parser.mjs';
import { fetchAllUszJobs } from '../scripts/lib/usz-job-parser.mjs';

const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Patienten und die Zusammenarbeit im medizinischen Team. '.repeat(8);
afterEach(() => vi.unstubAllGlobals());
for (const [name, producer, domain] of [
  ['Lindenhof', fetchAllLindenhofgruppeJobs, 'lindenhofgruppe.ch'],
  ['Uster', fetchAllSpitalUsterJobs, 'spitaluster.ch'],
  ['Basel', fetchAllUnispitalBaselJobs, 'unispital-basel.ch'],
  ['USZ', fetchAllUszJobs, 'usz.ch'],
] as const) {
  describe(name, () => {
    for (const kind of ['unverified-start', 'missing', 'modified-only', 'invalid', 'future'] as const) {
      it(`preserves source publication through the real producer: ${kind}`, async () => {
        const year = new Date().getUTCFullYear() - 1;
        const raw = kind === 'unverified-start' ? `${year}-10-01T22:30:00-02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
        const row = {
          id: 'fixture', start_date: raw,
          last_modification_timestamp: kind === 'missing' ? undefined : new Date(Date.now() - 86400000).toISOString(),
          links: { directlink: `https://${domain}/jobs/fixture` },
          szas: { sza_title: 'Diplomierte Pflegefachperson', sza_introduction: body, 'sza_location.city': '8000 Zürich', sza_apply_link: `https://${domain}/jobs/fixture/apply` },
        };
        const transport = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes('/public/v1/medium/')) return new Response(JSON.stringify({ jobs: [row], total: 1 }), { status: 200 });
          // Real description enrichment retains the listing body on a missing detail.
          return new Response('', { status: 404 });
        });
        vi.stubGlobal('fetch', transport);
        const jobs = await producer();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
        expect(jobs[0].description).toContain('medizinischen Team');
        expect(jobs[0].crawledAt).toBeTruthy();
        expect(jobs[0].url).toBe(`https://${domain}/jobs/fixture`);
        expect(transport).toHaveBeenCalled();
      });
    }
  });
}

for (const [name, producer, domain] of [['Uster', fetchAllSpitalUsterJobs, 'spitaluster.ch'], ['USZ', fetchAllUszJobs, 'usz.ch']] as const) {
  for (const guard of ['valid', 'other-title', 'unrelated-body', 'untrusted-redirect'] as const) {
    it(`${name}: existing detail fetch gates publication on identity/body (${guard})`, async () => {
      const datePosted = new Date(Date.now() - 4 * 86400000).toISOString();
      const title = 'Diplomierte Pflegefachperson';
      const url = `https://${domain}/jobs/fixture`;
      const transport = vi.fn(async (input) => {
        if (String(input).includes('/public/v1/medium/')) return new Response(JSON.stringify({ total: 1, jobs: [{ links: { directlink: url }, szas: { sza_title: title, sza_introduction: body, 'sza_location.city': '8000 Zürich' } }] }), { headers: { 'content-type': 'application/json' } });
        const pageBody = guard === 'unrelated-body' ? 'Site unavailable' : body;
        const html = `<main><h1>${title}</h1><p>${pageBody}</p></main><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: guard === 'other-title' ? 'Other vacancy' : title, datePosted })}</script>`;
        const response = new Response(html, { headers: { 'content-type': 'text/html' } });
        Object.defineProperty(response, 'url', { value: guard === 'untrusted-redirect' ? 'https://untrusted.example/jobs/fixture' : url });
        return response;
      });
      vi.stubGlobal('fetch', transport);
      const jobs = await producer();
      expect(transport).toHaveBeenCalledTimes(2);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(guard === 'valid'
        ? { datePosted, postedDate: datePosted, postingDateSource: 'reported' }
        : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
  }
}
