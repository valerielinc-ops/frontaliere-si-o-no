import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKlinikSchlossMammernJobs, fetchKsmDetailPage } from '../scripts/lib/klinik-schloss-mammern-job-parser.mjs';
import { fetchAllKlinikSchuetzenJobs } from '../scripts/lib/klinik-schuetzen-job-parser.mjs';
import { fetchAllKlinikSeeschauJobs, KLINIK_SEESCHAU_CAREERS_URL } from '../scripts/lib/klinik-seeschau-job-parser.mjs';
import { fetchAllKudelskiNagraJobs } from '../scripts/lib/kudelski-nagra-job-parser.mjs';
const date = '2025-09-29T23:45:12+02:00';
const text = 'Professionelle Teams begleiten Menschen mit Aufmerksamkeit und Sorgfalt. Zu den Aufgaben gehören die Planung und Dokumentation sowie die Zusammenarbeit mit Kollegen und Angehörigen. Wir bieten eine verantwortungsvolle Tätigkeit und unterstützen die fachliche Weiterbildung unserer Mitarbeitenden im täglichen Arbeitsalltag. '.repeat(4);
const tuple = (value = '') => ({ datePosted: value, postedDate: value ? value.slice(0, 10) : '', postingDateSource: value ? 'reported' : 'unknown' });
afterEach(() => vi.unstubAllGlobals());
const ksmUrl = 'https://ksm-jobs.ch/job/pflegefachperson/';
const ksmPosting = (raw: unknown) => ({ '@type': 'JobPosting', url: ksmUrl, datePosted: raw });
function stubKsm(posting: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input) === 'https://ksm-jobs.ch/jobs-sitemap.xml') return new Response(`<urlset><url><loc><![CDATA[${ksmUrl}]]></loc><lastmod>2025-09-29</lastmod></url></urlset>`);
    if (String(input) === ksmUrl) return new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script><h1 class="elementor-heading-title">Pflegefachperson</h1><div class="elementor-widget-theme-post-content"><div class="elementor-widget-text-editor"><p>${text}</p></div></div>`);
    throw new Error(`Unexpected request ${input}`);
  }));
}
describe('Schloss Mammern same-detail publication, preserving URL guard', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: never substitutes sitemap lastmod or crawl time`, async () => {
      stubKsm(ksmPosting(raw));
      const jobs = await fetchAllKlinikSchlossMammernJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ url: ksmUrl, canton: 'TG', ...tuple(label === 'timestamp' ? date : '') });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
    });
  }
  for (const identity of [undefined, 'https://ksm-jobs.ch/job/another-role/']) {
    it(`unknown for unverified detail identity ${identity}`, async () => {
      stubKsm({ ...ksmPosting(date), url: identity });
      expect((await fetchAllKlinikSchlossMammernJobs())[0]).toMatchObject(tuple());
    });
  }
  it('retains the fail-closed fetch guard for a non-KSM URL', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await fetchKsmDetailPage('http://169.254.169.254/job/pflege/')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
const schuetzenUrl = 'https://www.klinikschuetzen.ch/ueber-uns/arbeiten-in-der-klinik';
for (const [name, run, pageUrl, block] of [
  ['Schuetzen', fetchAllKlinikSchuetzenJobs, schuetzenUrl, (id: string) => `<section id="job-${id}"><a class="accordion-label">Pflegefachperson ${id}</a><p>${text}</p></section>`],
  ['Seeschau', fetchAllKlinikSeeschauJobs, KLINIK_SEESCHAU_CAREERS_URL, (id: string) => `<li class="mod-entry"><h2 class="mod-entry-title">Pflegefachperson ${id}</h2><div class="mod-entry-desc"><p>${text}</p></div></li>`],
] as const) {
  describe(`${name} listing without verified vacancy publication`, () => {
    for (const incidental of ['', '<meta property="article:modified_time" content="2025-09-29"><time>29.09.2025</time>']) {
      it(`keeps two isolated records unknown, metadata present=${Boolean(incidental)}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
          expect(String(input)).toBe(pageUrl);
          return new Response(`${incidental}${block('A1')}${block('B2')}<footer>Footer</footer>`);
        }));
        const jobs = await run();
        expect(jobs).toHaveLength(2);
        for (const job of jobs) { expect(job).toMatchObject(tuple()); expect(job.description.split(/\s+/).length).toBeGreaterThan(50); }
        expect(new Set(jobs.map(job => job.id)).size).toBe(2);
      });
    }
  });
}
const nagraUrl = 'https://boards.greenhouse.io/kudelski/jobs/123';
describe('Kudelski Nagra publication source, not creation/update or table date', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: uses only Greenhouse first_published`, async () => {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        expect(String(input)).toContain('boards-api.greenhouse.io');
        return new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Software Engineer', absolute_url: nagraUrl, content: text, location: { name: 'Lausanne, Switzerland' }, first_published: raw, created_at: date, updated_at: date }] }), { headers: { 'Content-Type': 'application/json' } });
      }));
      const jobs = await fetchAllKudelskiNagraJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ url: nagraUrl, canton: 'VD', ...tuple(label === 'timestamp' ? date : '') });
    });
  }
  it('does not attest an unlabelled HTML table date on API fallback', async () => {
    const detailUrl = 'https://careers.nagra.com/?page=advertisement_display&id=123';
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('boards-api.greenhouse.io')) return new Response('{"jobs":[]}', { headers: { 'Content-Type': 'application/json' } });
      if (url === 'https://careers.nagra.com/?page=advertisement') return new Response('<table><tr class="table-primary"><td>123</td><td>29-09-2025</td><td><a href="?page=advertisement_display&id=123">Software Engineer</a></td><td>Permanent</td><td>Lausanne, Switzerland</td><td>Nagra</td></tr></table>');
      if (url === detailUrl) return new Response(`<div id="advert"><p>${text}</p></div>`);
      throw new Error(`Unexpected request ${url}`);
    }));
    const jobs = await fetchAllKudelskiNagraJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url: detailUrl, canton: 'VD', ...tuple() });
  });
});
