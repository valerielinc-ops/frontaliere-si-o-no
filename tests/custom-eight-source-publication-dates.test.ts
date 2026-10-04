import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCaritasSchweizJobs } from '../scripts/lib/caritas-schweiz-job-parser.mjs';
import { fetchAllEmpaJobs } from '../scripts/lib/empa-job-parser.mjs';
import { fetchAllGallikerJobs } from '../scripts/lib/galliker-job-parser.mjs';
import { fetchAllPignaJobs } from '../scripts/lib/pigna-job-parser.mjs';
import { fetchAllPrivatklinikHoheneggJobs } from '../scripts/lib/privatklinik-hohenegg-job-parser.mjs';
import { fetchAllSpitalLimmattalJobs } from '../scripts/lib/spital-limmattal-job-parser.mjs';
import { fetchAllSpruengliJobs } from '../scripts/lib/spruengli-job-parser.mjs';
import { fetchAllZfvUnternehmungenJobs } from '../scripts/lib/zfv-unternehmungen-job-parser.mjs';

const pastDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${pastDay}T23:30:00.123-03:00`;
const futureDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const title = 'Fachperson Administration 80-100%';
const description = 'Wir suchen eine motivierte Fachperson für die interdisziplinäre Zusammenarbeit in unserem Team. Sie übernehmen Verantwortung für die Planung, Durchführung und Dokumentation der täglichen Aufgaben. Wir bieten eine strukturierte Einführung, fachliche Weiterbildung und ein modernes Arbeitsumfeld. Gute Deutschkenntnisse, Teamfähigkeit und eine anerkannte Ausbildung sind Voraussetzungen für diese abwechslungsreiche Aufgabe. Sie unterstützen unsere Mitarbeitenden und sorgen für zuverlässige Abläufe in der Administration.';
const companies = [
  { key: 'caritas-schweiz', tenant: '126757', fetchJobs: fetchAllCaritasSchweizJobs },
  { key: 'empa', tenant: '673276', fetchJobs: fetchAllEmpaJobs },
  { key: 'galliker', tenant: '878019', fetchJobs: fetchAllGallikerJobs },
  { key: 'pigna', tenant: '1531', fetchJobs: fetchAllPignaJobs },
  { key: 'privatklinik-hohenegg', tenant: '640332', fetchJobs: fetchAllPrivatklinikHoheneggJobs },
  { key: 'spital-limmattal', tenant: '486538', fetchJobs: fetchAllSpitalLimmattalJobs },
  { key: 'spruengli', tenant: '116352', fetchJobs: fetchAllSpruengliJobs },
  { key: 'zfv-unternehmungen', tenant: '', fetchJobs: fetchAllZfvUnternehmungenJobs },
];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function listingHtml(key: string, url: string) {
  const link = `<a href="${url}">${title}</a>`;
  if (key === 'pigna') return `<div class="listblock listcontent">${link}<div class="item workName">Zürich</div></div></div>`;
  if (key === 'zfv-unternehmungen') return `<article class="joboffer_container" onclick="window.location.href='${url}'">${link}</article>`;
  const workplace = key === 'privatklinik-hohenegg' ? '' : '<td class="workplace">Zürich</td>';
  const row = `<tr><td class="position">${link}</td>${workplace}<td class="workload">80-100%</td><td class="entryDate">${pastDay}</td></tr>`;
  return key === 'caritas-schweiz' ? `<div class="searchBox"><div class="title">Offene Stellen</div>${row}</div></form>` : `<table>${row}</table>`;
}
for (const company of companies) {
  describe(`${company.key} custom parser publication provenance`, () => {
    it.each([
      ['full original timestamp', timestamp, timestamp], ['missing', undefined, ''],
      ['invalid', '2026-02-30', ''], ['future', futureDay, ''],
    ] as const)('%s survives real listing, detail and builder', async (_label, raw, expected) => {
      const url = company.tenant ? `https://apply.refline.ch/${company.tenant}/123/pub/1/index.html` : 'https://jobs.zfv.ch/Fachperson-de-j123.html';
      const detail = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'JobPosting', title, url,
        description: `<p>${description}</p>`, datePosted: raw,
        dateCreated: pastDay, dateModified: pastDay, jobStartDate: pastDay, validThrough: futureDay,
        employmentType: 'FULL_TIME', hiringOrganization: { '@type': 'Organization', name: company.key },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'CH',
          addressLocality: 'Zürich', addressRegion: 'ZH', postalCode: '8000', streetAddress: 'Teststrasse 1' } },
      })}</script></head><body><h1>${title}</h1><p>${description}</p></body></html>`;
      const listing = listingHtml(company.key, url);
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const target = String(input);
        return new Response(target === url ? detail : target.includes('?start=') ? '' : listing, { status: 200 });
      }));
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ companyKey: company.key, title, datePosted: expected, postedDate: expected,
        postingDateSource: expected ? 'reported' : 'unknown', url });
      expect(jobs[0].description).toContain('interdisziplinäre');
      expect(jobs[0].canton).toBeTruthy();
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(jobs[0].slugByLocale).toBeTruthy();
    });
  });
}
