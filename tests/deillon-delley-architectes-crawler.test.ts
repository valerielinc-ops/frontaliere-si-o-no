import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildDeillonDelleyArchitectesJobs,
  DEILLON_DELLEY_ARCHITECTES_CAREERS_URL,
  DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME,
  DEILLON_DELLEY_ARCHITECTES_KEY,
  extractOfficialLocationEvidence,
  fetchAllDeillonDelleyArchitectesJobs,
  isArchitectRoleTitle,
  isDeillonDelleyArchitectesJob,
  isTrustedDomain,
  parseDeillonDelleyListing,
} from '../scripts/lib/deillon-delley-architectes-job-parser.mjs';
import { meetsSourceBodyFloor } from '../scripts/lib/source-body-floor.mjs';

const OFFICIAL_PAGE_HTML = `
  <html lang="fr">
    <body>
      <header>Navigation</header>
      <main class="entry-content">
        <h1>Nos offres d’emploi en détail</h1>
        <p>Notre réflexion architecturale s’appuie sur la qualité des usages, la précision constructive et le dialogue avec chaque maître d’ouvrage.</p>
        <p>Vous êtes :</p>
        <h2>Architecte développement junior</h2>
        <p>Formation architecte EPF HES ou équivalent. Vous êtes à l’aise dans la présentation de projets et souhaitez participer au développement de réalisations variées.</p>
        <h2>Architecte développement senior</h2>
        <p>Formation architecte EPF HES ou équivalent. Vous disposez d’un minimum de 5 ans de pratique, d’une expérience de coordination pluridisciplinaire et d’une capacité à gérer une équipe.</p>
        <h2>Au sein de notre équipe vous pourrez bénéficier :</h2>
        <ul>
          <li>de conditions de planification et de travail flexibles ;</li>
          <li>de formations continues adaptées à vos responsabilités ;</li>
          <li>d’une rémunération en lien avec votre expérience ;</li>
          <li>d’un environnement de travail agréable et collaboratif ;</li>
          <li>d’une culture ouverte aux échanges et à la qualité des projets ;</li>
          <li>d’une flexibilité favorisant l’équilibre professionnel et personnel.</li>
        </ul>
        <p>Nous vous garantissons un cadre professionnel stimulant, une équipe engagée et la possibilité de contribuer à des projets architecturaux de qualité dans la région.</p>
      </main>
      <footer>rue lécheretta 1 | ch – 1630 bulle | Deillon Delley Architectes SA</footer>
    </body>
  </html>
`;

describe('Deillon Delley Architectes SA crawler parser', () => {
  it('recognises the official architect role titles', () => {
    expect(isArchitectRoleTitle('Architecte développement junior')).toBe(true);
    expect(isArchitectRoleTitle('Architecte responsable de projet')).toBe(true);
    expect(isArchitectRoleTitle('Nos offres d’emploi')).toBe(false);
    expect(isArchitectRoleTitle('Assistante administrative')).toBe(false);
  });

  it('accepts only the employer domain and company identity', () => {
    expect(isDeillonDelleyArchitectesJob({ companyKey: DEILLON_DELLEY_ARCHITECTES_KEY })).toBe(true);
    expect(isDeillonDelleyArchitectesJob({ company: DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME })).toBe(true);
    expect(isDeillonDelleyArchitectesJob({ url: `${DEILLON_DELLEY_ARCHITECTES_CAREERS_URL}#role` })).toBe(true);
    expect(isDeillonDelleyArchitectesJob({ url: 'https://www.jobs.ch/fr/offres-emploi/' })).toBe(false);
    expect(isTrustedDomain(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL)).toBe(true);
    expect(isTrustedDomain('https://deillon-delley.example/jobs/')).toBe(false);
  });

  it('requires the official Bulle address evidence', () => {
    const evidence = extractOfficialLocationEvidence(OFFICIAL_PAGE_HTML);
    expect(evidence).toMatchObject({
      location: 'Bulle',
      canton: 'FR',
      addressLocality: 'Bulle',
      addressRegion: 'FR',
      addressCountry: 'CH',
      postalCode: '1630',
      streetAddress: 'rue lécheretta 1',
    });
    expect(extractOfficialLocationEvidence(OFFICIAL_PAGE_HTML.replace(/<footer>[\s\S]*?<\/footer>/, ''))).toBeNull();
  });

  it('extracts both roles from the single official detail page', () => {
    const listings = parseDeillonDelleyListing(OFFICIAL_PAGE_HTML);
    expect(listings).toHaveLength(2);
    expect(listings.map((listing) => listing.title)).toEqual([
      'Architecte développement junior',
      'Architecte développement senior',
    ]);
    expect(listings.every((listing) => meetsSourceBodyFloor(listing.description))).toBe(true);
    expect(listings[0].description).toContain('Formation architecte EPF HES');
    expect(listings[0].description).toContain('formations continues');
    expect(listings[0].url).toMatch(/^https:\/\/deillondelley\.ch\/emplois\/details-emplois\/#:~:text=/);
    expect(listings[0].url).not.toContain('jobs.ch');
  });

  it('does not publish a thin or location-less source record', () => {
    const short = '<main><h2>Architecte développement junior</h2><p>Formation EPF HES.</p></main><footer>rue lécheretta 1 | ch – 1630 bulle |</footer>';
    expect(parseDeillonDelleyListing(short)).toEqual([]);
    expect(parseDeillonDelleyListing(OFFICIAL_PAGE_HTML.replace(/rue lécheretta 1 \| ch – 1630 bulle \|/i, ''))).toEqual([]);
  });

  it('builds source-backed FR jobs with stable per-role identities and structured address fields', () => {
    const jobs = buildDeillonDelleyArchitectesJobs(parseDeillonDelleyListing(OFFICIAL_PAGE_HTML));
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.id).toMatch(/^deillon-delley-architectes-[0-9a-f]{12}$/);
      expect(job.sourceLang).toBe('fr');
      expect(job.canton).toBe('FR');
      expect(job.location).toBe('Bulle');
      expect(job.postalCode).toBe('1630');
      expect(job.streetAddress).toBe('rue lécheretta 1');
      expect(job.addressRegion).toBe('FR');
      expect(job.addressCountry).toBe('CH');
      expect(job.employmentType).toBe('OTHER');
      expect(job.postingDateSource).toBe('unknown');
      expect(meetsSourceBodyFloor(job.description)).toBe(true);
      expect(job.url.startsWith(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL)).toBe(true);
      expect(job.url).toContain('#:~:text=');
    }
    expect(new Set(jobs.map((job) => job.url)).size).toBe(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
  });

  it('uses the injected official fetcher without reaching third-party listings', async () => {
    const jobs = await fetchAllDeillonDelleyArchitectesJobs({
      fetchPage: async (url: string) => {
        expect(url).toBe(DEILLON_DELLEY_ARCHITECTES_CAREERS_URL);
        return OFFICIAL_PAGE_HTML;
      },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => isTrustedDomain(job.url))).toBe(true);
  });

  it('has a promoted prospecting spec and manifest workflow entry', () => {
    const spec = JSON.parse(readFileSync(new URL('../data/prospector/crawlers/deillon-delley-architectes.json', import.meta.url), 'utf8'));
    expect(spec).toMatchObject({
      companyKey: DEILLON_DELLEY_ARCHITECTES_KEY,
      candidateKey: 'deillon-delley-architectes@bulle',
      companyHost: 'deillondelley.ch',
      sourceLang: 'fr',
      canton: 'FR',
      detailEnrichment: true,
    });
    expect(spec.sampleVacancyCount).toBeGreaterThanOrEqual(1);
    expect(spec.sampleTitles).toContain('Architecte développement junior');

    const manifest = JSON.parse(readFileSync(new URL('../data/crawler-manifest.json', import.meta.url), 'utf8'));
    const entry = manifest.manifest.find((item: { slug: string }) => item.slug === DEILLON_DELLEY_ARCHITECTES_KEY);
    expect(entry).toMatchObject({
      file: 'update-jobs-deillon-delley-architectes.yml',
      jobKey: 'update-deillon-delley-architectes-jobs',
      runStep: { run: 'node scripts/update-deillon-delley-architectes-jobs.mjs' },
    });
  });
});
