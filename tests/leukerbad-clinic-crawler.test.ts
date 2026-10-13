import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEUKERBAD_CLINIC_COMPANY_NAME,
  LEUKERBAD_CLINIC_KEY,
  fetchAllLeukerbadClinicJobs,
  isLeukerbadClinicJob,
  isTrustedDomain,
  leukerbadClinicMatchKey,
  parseLeukerbadClinicDetail,
  parseLeukerbadClinicListing,
} from '../scripts/lib/leukerbad-clinic-job-parser.mjs';

const DE_LISTING = 'https://leukerbadclinic.ch/de/karriere/offene-stellen';
const FR_LISTING = 'https://leukerbadclinic.ch/fr/carriere/postes-vacants';

function listingHtml(lang: 'de' | 'fr', rows: Array<{ slug: string; title: string; conditions: string }>) {
  const prefix = lang === 'de' ? '/de/karriere/offene-stellen' : '/fr/carriere/postes-vacants';
  return `<!doctype html><nav><a href="${prefix}/navigation-noise">noise</a></nav>
    <ul class="offres" data-testid="liste-offres">
      ${rows.map((row) => `<li><h3><a href="${prefix}/${row.slug}">${row.title}</a></h3><p class="conditions">${row.conditions}</p></li>`).join('')}
    </ul><footer><a href="${prefix}/footer-noise">noise</a></footer>`;
}

function detailHtml(lang: 'de' | 'fr', slug: string, title: string) {
  const applyPath = lang === 'de' ? '/de/karriere/initiativbewerbung' : '/fr/carriere/candidature-spontanee';
  return `<!doctype html><main id="contenu"><div class="offre-page"><h1>${title}</h1>
    <div class="corps-page corps-page--colonne">
      <section><h2>Aufgaben</h2><p>Wir suchen eine engagierte Fachperson für unser interdisziplinäres Team in Leukerbad. Sie betreuen Patientinnen und Patienten sorgfältig und arbeiten eng mit Medizin, Pflege und Therapie zusammen.</p></section>
      <section><h2>Profil</h2><p>Sie verfügen über eine anerkannte Ausbildung, arbeiten selbständig, kommunizieren respektvoll und übernehmen Verantwortung. Gute Sprachkenntnisse, Teamgeist und Freude an einer langfristigen Zusammenarbeit ergänzen Ihr Profil.</p></section>
      <section><h2>Angebot</h2><p>Wir bieten eine strukturierte Einführung, zeitgemässe Arbeitsbedingungen, Weiterbildungsmöglichkeiten und ein professionelles Umfeld in einer spezialisierten Rehabilitationsklinik im Wallis.</p></section>
    </div><a href="${applyPath}?offre=${slug}">Bewerben</a></div></main>`;
}

describe('Leukerbad Clinic official HTML crawler', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('identifies retired Prismic records but trusts only the live corporate host', () => {
    expect(LEUKERBAD_CLINIC_KEY).toBe('leukerbad-clinic');
    expect(LEUKERBAD_CLINIC_COMPANY_NAME).toBe('Leukerbad Clinic');
    expect(isLeukerbadClinicJob({ url: 'https://leukerbad-clinic.cdn.prismic.io/api/v2' })).toBe(true);
    expect(isLeukerbadClinicJob({ url: `${DE_LISTING}/mpa` })).toBe(true);
    expect(isTrustedDomain(`${DE_LISTING}/mpa`)).toBe(true);
    expect(isTrustedDomain('https://leukerbad-clinic.cdn.prismic.io/api/v2')).toBe(false);
  });

  it('parses only detail links inside the source-owned vacancy list', () => {
    const rows = parseLeukerbadClinicListing(listingHtml('de', [
      { slug: 'mpa', title: 'Medizinische/r Praxisassistent/in (m/w)', conditions: '60–100 % · sofort oder nach Vereinbarung' },
    ]), DE_LISTING, 'de');

    expect(rows).toEqual([{
      detailUrl: `${DE_LISTING}/mpa`,
      title: 'Medizinische/r Praxisassistent/in (m/w)',
      conditions: '60–100 % · sofort oder nach Vereinbarung',
      sourceLang: 'de',
    }]);
  });

  it('requires the detail body and explicit source application handoff', () => {
    const row = { detailUrl: `${DE_LISTING}/mpa`, title: 'Fallback', conditions: '60–100 %', sourceLang: 'de' };
    const detail = parseLeukerbadClinicDetail(detailHtml('de', 'mpa', 'Medizinische/r Praxisassistent/in (m/w)'), row);
    expect(detail.title).toBe('Medizinische/r Praxisassistent/in (m/w)');
    expect(detail.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(detail.applyUrl).toBe('https://leukerbadclinic.ch/de/karriere/initiativbewerbung?offre=mpa');
    expect(() => parseLeukerbadClinicDetail('<h1>Thin</h1>', row)).toThrow('50-word source floor');
  });

  it('uses the two official Astro listings and never calls the retired Prismic API (issue 13078)', async () => {
    const pages = new Map([
      [DE_LISTING, listingHtml('de', [
        { slug: 'mpa', title: 'Medizinische/r Praxisassistent/in (m/w)', conditions: '60–100 % · sofort oder nach Vereinbarung' },
        { slug: 'ma-gap', title: 'Verwaltungsmitarbeiter/in – Patientenmanagement', conditions: '100 % · Sofort oder nach Vereinbarung' },
      ])],
      [FR_LISTING, listingHtml('fr', [
        { slug: 'infirmiere', title: 'INFIRMIER/INFIRMIÈRE DIPLÔMÉ∙E (H/F)', conditions: '80–100 % · De suite ou à convenir' },
      ])],
      [`${DE_LISTING}/mpa`, detailHtml('de', 'mpa', 'Medizinische/r Praxisassistent/in (m/w)')],
      [`${DE_LISTING}/ma-gap`, detailHtml('de', 'ma-gap', 'Verwaltungsmitarbeiter/in – Patientenmanagement')],
      [`${FR_LISTING}/infirmiere`, detailHtml('fr', 'infirmiere', 'INFIRMIER/INFIRMIÈRE DIPLÔMÉ∙E (H/F)')],
    ]);
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('prismic.io')) return new Response('', { status: 404 });
      const body = pages.get(url);
      return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 });
    }) as any;

    const jobs = await fetchAllLeukerbadClinicJobs();
    expect(jobs).toHaveLength(3);
    expect((globalThis.fetch as any).mock.calls.some(([url]: [unknown]) => String(url).includes('prismic.io'))).toBe(false);
    expect(jobs.map((job) => job.url)).toEqual([
      `${DE_LISTING}/mpa`,
      `${DE_LISTING}/ma-gap`,
      `${FR_LISTING}/infirmiere`,
    ]);
    expect(jobs.every((job) => job.applyUrl.includes('?offre='))).toBe(true);
    expect(jobs.every((job) => job.source.includes('official Astro HTML'))).toBe(true);
    expect(jobs.map((job) => job.sourceLang)).toEqual(['de', 'de', 'fr']);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
    expect(leukerbadClinicMatchKey(jobs[0])).toBe(jobs[0].id);
  });

  it('fails closed when either locale loses its listing contract', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url === DE_LISTING) return new Response(listingHtml('de', [
        { slug: 'mpa', title: 'Medizinische/r Praxisassistent/in (m/w)', conditions: '60–100 %' },
      ]), { status: 200 });
      if (url === FR_LISTING) return new Response('<html><p>redesigned</p></html>', { status: 200 });
      return new Response('', { status: 404 });
    }) as any;

    await expect(fetchAllLeukerbadClinicJobs()).rejects.toThrow('listing contract missing');
  });
});
