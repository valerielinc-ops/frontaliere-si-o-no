import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKantonsspitalUriJobs } from '../scripts/lib/kantonsspital-uri-job-parser.mjs';
import { fetchAllSpitalSchwyzJobs } from '../scripts/lib/spital-schwyz-job-parser.mjs';
import { fetchAllZugerKantonsspitalJobs } from '../scripts/lib/zuger-kantonsspital-job-parser.mjs';
import { extractRexxDetail } from '../scripts/lib/rexx-systems-job-parser-common.mjs';

const sourceDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const sourceTimestamp = `${sourceDay}T12:30:00.123+02:00`;
const futureDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const description = 'Wir suchen eine motivierte Pflegefachperson für die interdisziplinäre Betreuung unserer Patientinnen und Patienten. Sie arbeiten gemeinsam mit dem ärztlichen Team und übernehmen Verantwortung für die Planung, Durchführung und Dokumentation der Pflege. Wir bieten eine strukturierte Einführung, fachliche Weiterbildung und ein modernes Arbeitsumfeld. Gute Deutschkenntnisse, Teamfähigkeit und eine anerkannte Ausbildung sind Voraussetzungen für diese abwechslungsreiche Aufgabe in unserem regionalen Spital.';
const companies = [
  { key: 'kantonsspital-uri', host: 'stellen.ksuri.ch', city: 'Altdorf', canton: 'UR', postal: '6460', fetchJobs: fetchAllKantonsspitalUriJobs },
  { key: 'spital-schwyz', host: 'jobs.spital-schwyz.ch', city: 'Schwyz', canton: 'SZ', postal: '6430', fetchJobs: fetchAllSpitalSchwyzJobs },
  { key: 'zuger-kantonsspital', host: 'jobs.zgks.ch', city: 'Baar', canton: 'ZG', postal: '6340', fetchJobs: fetchAllZugerKantonsspitalJobs },
];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const company of companies) {
  describe(`${company.key} original publication through Rexx extractor and factory`, () => {
    it.each([
      ['source day', sourceDay, sourceDay],
      ['full timestamp', sourceTimestamp, sourceTimestamp],
      ['absent', undefined, ''],
      ['invalid calendar', '2026-02-30', ''],
      ['future', futureDay, ''],
      ['unparseable', 'yesterday', ''],
    ])('%s keeps both aliases and provenance consistent', async (_label, raw, expected) => {
      const url = `https://${company.host}/Pflegefachperson-de-j123.html`;
      const title = 'Pflegefachperson 80-100%';
      const listing = `<article class="joboffer_container" onclick="window.location.href='${url}'"><a href="${url}">${title}</a></article>`;
      const detail = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'JobPosting', title, url, description,
        datePosted: raw, employmentType: 'FULL_TIME',
        jobStartDate: sourceDay, dateCreated: sourceDay, dateModified: sourceDay,
        hiringOrganization: { '@type': 'Organization', name: company.key },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'CH',
          addressLocality: company.city, addressRegion: company.canton, postalCode: company.postal, streetAddress: 'Spitalstrasse 1' } },
      })}</script></head><body><h1>${title}</h1><h2>Ihre Aufgaben</h2><p>${description}</p></body></html>`;
      const publication = { datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' };
      expect(extractRexxDetail(detail, url)).toMatchObject(publication);
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const target = String(input);
        if (target.endsWith('/stellenangebote.html')) return new Response(listing, { status: 200 });
        if (target === url) return new Response(detail, { status: 200 });
        return new Response('', { status: 404 });
      }));
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ ...publication, companyKey: company.key, title, url, canton: company.canton, postalCode: company.postal });
      expect(jobs[0].description).toContain('interdisziplinäre');
      expect(jobs[0].crawledAt).toBeTruthy();
      expect(jobs[0].crawledAt).not.toBe(expected);
    });
  });
}
