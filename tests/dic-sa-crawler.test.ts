import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DIC_SA_KEY,
  DIC_SA_COMPANY_NAME,
  isDicSaJob,
  isTrustedDomain,
  fetchAllDicSaJobs,
} from '../scripts/lib/dic-sa-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const WP_POST = {
  id: 5352,
  date: '2026-04-29T14:36:36',
  slug: 'un%c2%b7e-ingenieur%c2%b7e-civil%c2%b7e-epf-chef%c2%b7fe-de-projet-3',
  link: 'https://www.dic-ing.ch/team/job-offers/un%c2%b7e-ingenieur%c2%b7e-civil%c2%b7e-epf-chef%c2%b7fe-de-projet-3/',
  title: { rendered: 'UN·E INGENIEUR·E CIVIL·E EPF &#8211; CHEF·FE DE PROJET' },
  content: {
    rendered:
      '<p><strong>Aigle | 80&#8211;100% | Entrée en fonction : de suite ou à convenir</strong></p>' +
      '<p><strong>Vos missions</strong></p>' +
      '<ul><li>Gestion de projets de moyenne ou grande envergure de structures en béton armé, en acier, en bois ou d&#8217;assainissement et renforcement d&#8217;ouvrages</li>' +
      '<li>Calculs statiques et direction des travaux dans les domaines de la construction et de la réfection de ponts et de bâtiments</li></ul>' +
      '<p><strong>Nous offrons</strong></p>' +
      '<ul><li>Des projets variés, exigeants et à forte valeur technique, notamment dans les domaines des ouvrages d’art et des structures</li>' +
      '<li>Des conditions salariales attractives et un cadre de travail moderne et flexible</li></ul>' +
      '<p><strong>Votre profil</strong></p>' +
      '<ul><li>Diplôme d’ingénieur·e civil·e EPF (ou équivalent reconnu en Suisse)</li>' +
      '<li>Expérience en bureau d’ingénieurs en Suisse, idéalement en structures ou ouvrages d’art</li></ul>' +
      '<p><strong>Votre dossier</strong></p>' +
      '<p>Merci d’adresser votre dossier complet à : job@dic-ing.ch</p>',
  },
};

describe('DIC SA crawler parser', () => {
  // ── Constants ──
  it('exports valid company key name', () => {
    expect(DIC_SA_KEY).toBe('dic-sa');
    expect(DIC_SA_COMPANY_NAME).toBe('DIC SA');
  });

  // ── isCompanyJob ──
  describe('isDicSaJob', () => {
    it('matches by companyKey', () => {
      expect(isDicSaJob({ companyKey: 'dic-sa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDicSaJob({ company: 'DIC SA' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDicSaJob({ url: 'https://www.dic-ing.ch/fr/emploi/test-job' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isDicSaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('rejects unrelated jobs with a generic "DIC" acronym but different company', () => {
      expect(
        isDicSaJob({ companyKey: 'dic-holding-inc', company: 'DIC Holding Inc', url: 'https://dic-holding.example.com/careers' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDicSaJob(null)).toBe(false);
      expect(isDicSaJob(undefined)).toBe(false);
      expect(isDicSaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts dic-ing.ch host and subdomains', () => {
      expect(isTrustedDomain('https://www.dic-ing.ch/fr/emploi/test-job')).toBe(true);
      expect(isTrustedDomain('https://dic-ing.ch/team/')).toBe(true);
    });

    it('no longer trusts jobs.ch/jobup.ch (migrated off the aggregator)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc-123/')).toBe(false);
      expect(isTrustedDomain('https://www.jobup.ch/fr/emploi/detail/abc-123/')).toBe(false);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other-company.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── slugify ──
  describe('slugify', () => {
    it('produces a URL-safe slug from a job title + company + location', () => {
      expect(slugify('Ingénieur civil EPF - Chef de projet (H/F) dic sa aigle')).toBe(
        'ingenieur-civil-epf-chef-de-projet-h-f-dic-sa-aigle'
      );
    });
  });

  // ── fetchAllDicSaJobs (own WordPress REST API, post-migration off jobup.ch) ──
  describe('fetchAllDicSaJobs', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches the employer\'s own wp-json job-offers feed and links to dic-ing.ch, not jobup.ch', async () => {
      const requestedUrls: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('wp-json/wp/v2/job-offers')) return jsonResponse(200, [WP_POST]);
        return jsonResponse(404, { message: 'not found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      const jobs = await fetchAllDicSaJobs();

      expect(requestedUrls.some((u) => u.includes('dic-ing.ch/wp-json/wp/v2/job-offers'))).toBe(true);
      expect(jobs).toHaveLength(1);
      const [job] = jobs;

      expect(job.title).toContain('INGENIEUR');
      expect(job.url).toBe(WP_POST.link);
      expect(job.applyUrl).toBe(WP_POST.link);
      expect(job.url).toContain('dic-ing.ch');
      expect(job.url).not.toContain('jobup.ch');
      expect(job.url).not.toContain('jobs.ch');
      expect(job.location).toBe('Aigle');
      expect(job.canton).toBe('VD');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.source).toBe('DIC SA Dedicated Parser (dic-ing.ch)');
      // HTML entities from the WordPress REST payload (&#8211;, &eacute; via
      // é, &#8217;) must be decoded, not leaked into the description.
      expect(job.description).not.toContain('&#8211;');
      expect(job.description).not.toContain('&#8217;');
      expect(job.description).toContain('Gestion de projets');
      const wordCount = job.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'dic-sa-abc123',
      slug: 'ingenieur-civil-chef-de-projet-dic-sa-aigle',
      slugByLocale: { fr: 'ingenieur-civil-chef-de-projet-dic-sa-aigle' },
      company: 'DIC SA',
      companyKey: 'dic-sa',
      companyDomain: 'dic-ing.ch',
      title: 'Ingénieur civil EPF - Chef de projet (H/F)',
      titleByLocale: { fr: 'Ingénieur civil EPF - Chef de projet (H/F)' },
      description:
        'Depuis plus de 40 ans, DIC SA ingénieurs s\'impose comme un bureau reconnu pour la qualité et la précision de ses ouvrages dans les domaines du génie civil, des ouvrages d\'art et des infrastructures routières et ferroviaires. Notre équipe à taille humaine met un point d\'honneur à produire des projets techniquement exigeants, avec un haut niveau de responsabilité et une forte autonomie au sein du bureau basé à Aigle dans le canton de Vaud, avec des succursales à Sion et Martigny en Valais desservant toute la région.',
      descriptionByLocale: {
        fr:
          'Depuis plus de 40 ans, DIC SA ingénieurs s\'impose comme un bureau reconnu pour la qualité et la précision de ses ouvrages dans les domaines du génie civil, des ouvrages d\'art et des infrastructures routières et ferroviaires. Notre équipe à taille humaine met un point d\'honneur à produire des projets techniquement exigeants, avec un haut niveau de responsabilité et une forte autonomie au sein du bureau basé à Aigle dans le canton de Vaud, avec des succursales à Sion et Martigny en Valais desservant toute la région.',
      },
      location: 'Aigle',
      canton: 'VD',
      url: 'https://www.dic-ing.ch/team/job-offers/un%c2%b7e-ingenieur%c2%b7e-civil%c2%b7e-epf-chef%c2%b7fe-de-projet-3/',
      source: 'DIC SA Dedicated Parser (dic-ing.ch)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Aigle',
      addressRegion: 'VD',
      streetAddress: 'Les Glariers',
      postalCode: '1860',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://www.dic-ing.ch/team/job-offers/un%c2%b7e-ingenieur%c2%b7e-civil%c2%b7e-epf-chef%c2%b7fe-de-projet-3/',
      hiringOrganizationName: 'DIC SA',
    };

    it('includes all Non-Negotiable #3 required structured-data fields', () => {
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.datePosted ?? validJob.postedDate).toBeTruthy();
      expect(validJob.hiringOrganizationName).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.addressLocality || validJob.location).toBeTruthy();
      expect(validJob.canton).toBeTruthy();
    });

    it('description satisfies Non-Negotiable #4 (≥50 word thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^dic-sa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is a valid Swiss canton code', () => {
      expect(validJob.canton).toMatch(/^[A-Z]{2}$/);
    });

    it('url/applyUrl point at the employer\'s own site, not a job-board aggregator', () => {
      expect(validJob.url).toContain('dic-ing.ch');
      expect(validJob.url).not.toContain('jobup.ch');
      expect(validJob.url).not.toContain('jobs.ch');
    });
  });
});
