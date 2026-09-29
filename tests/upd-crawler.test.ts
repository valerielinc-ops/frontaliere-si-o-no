import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeUmantisUpdJobs,
  fetchAllUpdJobs,
  isTrustedDomain,
  isUpdJob,
  UPD_PROSPECTIVE_MEDIUM_ID,
} from '../scripts/lib/upd-job-parser.mjs';
import { repairStoredUmantisJobs } from '../scripts/lib/umantis-listing-common.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

// Issue 5253. UPD merged with PZM into UPZ Bern: every vacancy of the old
// Umantis tenant 2908 now 302-redirects to jobs.upz-bern.ch, so the Umantis
// factory quarantined 106/106 jobs and the crawler published nothing but 3
// stored descriptions it had written itself. The careers page embeds the
// Prospective careercenter 1000842 (medium 1000842, 107 vacancies). Real
// listing payload cut to 2 vacancies and one rendered vacancy page, minimised;
// contacts anonymised.
const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'upd', name), 'utf8');
const API = fixture('prospective-medium-1000842.json');
const PAGE = fixture('vacancy-726e43e5.html');
const SOCIAL_WORKER_URL = 'https://ohws.prospective.ch/public/v1/jobs/726e43e5-c624-49cc-a985-2c98b4d19ddb';

function stubSource() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes(`/medium/${UPD_PROSPECTIVE_MEDIUM_ID}/jobs`)) {
      return new Response(API, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url) === SOCIAL_WORKER_URL) {
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UPD / UPZ Bern — Prospective medium 1000842', () => {
  it('reads the vacancies of the UPZ medium, with the slugs the tenant already publishes', async () => {
    stubSource();
    const jobs = await fetchAllUpdJobs();
    expect(jobs.map((job: any) => job.title)).toEqual([
      'Sozialarbeiter*in (m/w/d) als Mutterschaftsvertretung',
      'Oberpsychologin / Oberpsychologe Forensik',
    ]);
    // Same `<title> upd <location>` formula as the Umantis slices on main.
    expect(jobs.map((job: any) => job.slug)).toEqual([
      'sozialarbeiter-in-m-w-d-als-mutterschaftsvertretung-upd-bern',
      'oberpsychologin-oberpsychologe-forensik-upd-bern',
    ]);
    for (const job of jobs) {
      expect(job.companyKey).toBe('upd');
      expect([job.location, job.canton]).toEqual(['Bern', 'BE']);
      expect(job.description).not.toMatch(/Umantis-Karriereportal|, Schweiz\.$/m);
      expect(isTrustedDomain(job.url)).toBe(true);
    }
  });

  it('publishes the rendered vacancy page, with the posting\'s own sections', async () => {
    stubSource();
    const [socialWorker, psychologist] = await fetchAllUpdJobs();
    expect(socialWorker.url).toBe(SOCIAL_WORKER_URL);
    expect(socialWorker.description).toContain('## Deine Aufgaben');
    expect(socialWorker.description).toContain('## Das UPZ');
    expect(socialWorker.description).not.toMatch(/Vorname Nachname|\+41 00 000 00 00/);
    // Its page is not served here: the listing text stays the fallback.
    expect(psychologist.description).toContain('Das Universitäre Psychiatrische Zentrum Bern engagieren sich im Ambulatorium');
  });

  it('keeps the stored jobs of the old Umantis tenant trusted and matched to the crawler', () => {
    const legacyUrl = 'https://recruitingapp-2908.umantis.com/Vacancies/3535/Description/1';
    expect(isTrustedDomain(legacyUrl)).toBe(true);
    expect(isUpdJob({ companyKey: 'upd', url: legacyUrl })).toBe(true);
  });
});

// Stored jobs as on main: Umantis URLs, the description the factory wrote.
function storedJob(id: string, title: string, vacancy: number, deSlug: string) {
  const de = `${title} bei Universitäres Psychiatrisches Zentrum Bern AG in Bern (3000, BE), Schweiz.\n\n• Standort: Bern (BE)\n• Bewerbung über das Umantis-Karriereportal von Universitäre Psychiatrische Dienste Bern (UPD)`;
  return {
    id,
    title,
    location: 'Bern',
    companyKey: 'upd',
    url: `https://recruitingapp-2908.umantis.com/Vacancies/${vacancy}/Description/1`,
    slug: deSlug,
    slugByLocale: { de: deSlug },
    sourceLang: 'de',
    description: de,
    descriptionByLocale: { de, en: 'Social worker … Application via the Umantis Career Portal of UPD' },
  };
}

describe('bridgeUmantisUpdJobs — stored Umantis jobs keep their pages', () => {
  it('points each stored job at the one fresh vacancy with its title and location, and the merge keeps its id and slug', async () => {
    stubSource();
    const fresh = await fetchAllUpdJobs();
    const stored = [
      storedJob('upd-5fb68de5d8fe', 'Sozialarbeiter*in (m/w/d) als Mutterschaftsvertretung', 3535, 'sozialarbeiter-in-m-w-d-als-mutterschaftsvertretung-upd-bern'),
      storedJob('upd-f3b31e4d72e7', 'Leitung oder Co-Leitung Reinigung & Textilmanagement', 3484, 'leitung-oder-co-leitung-reinigung-textilmanagement-upd-bern'),
    ];
    repairStoredUmantisJobs(stored, 'UPD');
    expect(bridgeUmantisUpdJobs(stored, fresh)).toBe(1);
    expect(stored[0].url).toBe(SOCIAL_WORKER_URL);
    // No longer published by the source: left on its Umantis URL.
    expect(stored[1].url).toContain('recruitingapp-2908.umantis.com');

    const merged: any[] = mergePreserveLocaleData(stored, fresh);
    const socialWorker = merged.find((job) => job.url === SOCIAL_WORKER_URL);
    expect(socialWorker.id).toBe('upd-5fb68de5d8fe');
    expect(socialWorker.slugByLocale.de).toBe('sozialarbeiter-in-m-w-d-als-mutterschaftsvertretung-upd-bern');
    expect(socialWorker.descriptionByLocale.de).toContain('## Deine Aufgaben');
    for (const job of merged) {
      expect(Object.values(job.descriptionByLocale || {}).join('\n')).not.toMatch(/Umantis-Karriereportal|Umantis Career Portal/);
    }
  });

  it('does not bridge when a title and location is not unique on either side', () => {
    const fresh = [
      { title: 'Pflegefachperson HF', location: 'Bern', url: 'https://ohws.prospective.ch/public/v1/jobs/a' },
      { title: 'Pflegefachperson HF', location: 'Bern', url: 'https://ohws.prospective.ch/public/v1/jobs/b' },
      { title: 'Psychologin', location: 'Bern', url: 'https://ohws.prospective.ch/public/v1/jobs/c' },
    ];
    const stored = [
      { title: 'Pflegefachperson HF', location: 'Bern', url: 'https://recruitingapp-2908.umantis.com/Vacancies/1/Description/1' },
      { title: 'Psychologin', location: 'Bern', url: 'https://recruitingapp-2908.umantis.com/Vacancies/2/Description/1' },
      { title: 'Psychologin', location: 'Bern', url: 'https://recruitingapp-2908.umantis.com/Vacancies/3/Description/1' },
    ];
    expect(bridgeUmantisUpdJobs(stored, fresh)).toBe(0);
    expect(stored.every((job) => job.url.includes('umantis.com'))).toBe(true);
  });
});
