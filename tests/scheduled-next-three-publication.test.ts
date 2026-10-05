import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchAllCantonValaisJobs } from '../scripts/lib/canton-valais-job-parser.mjs';
import { fetchAllClinicaHolisticaJobs } from '../scripts/lib/clinica-holistica-engiadina-job-parser.mjs';
import { fetchAllCicJobs } from '../scripts/lib/clinique-cic-job-parser.mjs';
const browserFixture = vi.hoisted(() => ({ detail: '', visits: 0 }));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({ launchChromium: async () => ({
  close: async () => {},
  newContext: async () => ({
    setDefaultNavigationTimeout: () => {}, addInitScript: async () => {},
    newPage: async () => {
      let dom: JSDOM;
      return {
        goto: async (url: string) => {
          browserFixture.visits++;
          dom = new JSDOM(url.endsWith('/karriere') ? '<a href="https://www.clinica-holistica.ch/de/job/fixture">Stellenausschreibung</a>' : browserFixture.detail, { url, runScripts: 'outside-only' });
          Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
          return { status: () => 200 };
        },
        evaluate: async (fn: () => unknown) => dom.window.eval(`(${fn.toString()})()`),
        close: async () => dom?.window.close(),
      };
    },
  }),
}) }));
const title = 'Fachperson Pflege';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Patienten und die Zusammenarbeit im medizinischen Team. '.repeat(8);
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); browserFixture.visits = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
for (const kind of ['valid', 'missing', 'creation-only', 'invalid', 'future', 'other-title'] as const) {
  for (const name of ['Holistica', 'CIC'] as const) {
    it(`${name}: same-detail publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = kind === 'valid' || kind === 'other-title' ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const posting = { '@type': 'JobPosting', title: kind === 'other-title' ? 'Another vacancy' : title, description: body, datePosted: raw, dateCreated: kind === 'creation-only' ? `${year}-01-01` : undefined, dateModified: `${year}-06-01` };
      const html = `<h1>${title}</h1><article class="node node--type-smjob"><div class="field-description">${body}</div></article><script type="application/ld+json">${JSON.stringify(posting)}</script>`;
      browserFixture.detail = html;
      const transport = vi.fn(async (input) => new Response(String(input).includes('/masks/')
        ? `<div class=job_offer><a href="https://www.jobup.ch/fr/emplois/detail/fixture/" title="${title} - 1907 Saxon">${title}</a></div><div class=job_location>Clinique CIC Saxon</div><div class=job_lvlmin>Permanent 100%</div>`
        : html, { status: 200 }));
      vi.stubGlobal('fetch', transport);
      const pending = name === 'Holistica' ? fetchAllClinicaHolisticaJobs() : fetchAllCicJobs();
      await vi.runAllTimersAsync();
      const jobs = await pending;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('medizinischen Team');
      expect(jobs[0].crawledAt).toBeTruthy();
      if (name === 'Holistica') expect(browserFixture.visits).toBe(2);
      else expect(transport).toHaveBeenCalledTimes(2);
    });
  }
}
for (const hasCreation of [false, true]) {
  it(`Valais: actual OTB listing has no proven publication (creation marker ${hasCreation})`, async () => {
    const html = `<div class="ivs-job-offer"><h2>${title}</h2><p>${body} Sion</p><div><a href="https://otb.apps.vs.ch/iapply?job=fixture">Candidature</a>${hasCreation ? `<time class="sys_created_on">${new Date().getUTCFullYear() - 1}-01-01</time>` : ''}</div></div>`;
    const transport = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const pending = fetchAllCantonValaisJobs();
    await vi.runAllTimersAsync();
    const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(jobs[0].description).toContain('medizinischen Team');
    expect(transport).toHaveBeenCalledTimes(1);
  });
}
