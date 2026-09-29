import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  EPFL_KEY,
  EPFL_COMPANY_NAME,
  fetchAllEpflJobs,
  isEpflJob,
  isTrustedDomain,
} from '../scripts/lib/epfl-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('EPFL crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EPFL_KEY).toBe('epfl');
    expect(EPFL_COMPANY_NAME).toBe('EPFL');
  });

  // ── isCompanyJob ──
  describe('isEpflJob', () => {
    it('matches by companyKey', () => {
      expect(isEpflJob({ companyKey: 'epfl' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEpflJob({ company: 'EPFL' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEpflJob({ url: 'https://epfl.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEpflJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEpflJob(null)).toBe(false);
      expect(isEpflJob(undefined)).toBe(false);
      expect(isEpflJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://epfl.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.epfl.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer epfl ch')).toBe('developer-epfl-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'epfl-abc123',
      slug: 'test-position-epfl-ch',
      slugByLocale: { it: 'test-position-epfl-ch' },
      company: 'EPFL',
      companyKey: 'epfl',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://epfl.ch/jobs/test',
      source: 'EPFL Dedicated Parser',
      sourceLang: 'it',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^epfl-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Issue 5253: the source language came from `${title} ${department}`, so an
// English research title above a French faculty name filed an English body
// under `fr` (36/68 jobs on the 2026-09-29 slice), and a detail page under
// 100 characters got an invented Italian block ("Posizione pubblicata sul
// portale carriere ufficiale EPFL…", "Dettagli della posizione:").
// Fixtures are minimised SuccessFactors page shapes; no `data/**` is read.
describe('fetchAllEpflJobs — the source body decides language and publication', () => {
  const ENGLISH_BODY = 'The laboratory at the School of Architecture, Civil and Environmental Engineering is seeking a highly motivated postdoctoral researcher to join a project on indoor air quality in residential buildings. '
    + 'You will design and run field measurement campaigns, develop models of pollutant transport, and publish the results in leading journals. '
    + 'We offer a stimulating international environment, modern equipment and a competitive salary.';
  const FRENCH_BODY = "Le laboratoire de la Faculté des sciences et techniques de l'ingénieur recherche un ingénieur de recherche motivé pour développer des méthodes d'apprentissage automatique appliquées aux systèmes énergétiques. "
    + "Vous serez responsable de la conception des expériences, de l'analyse des données et de la rédaction des rapports scientifiques. "
    + "Nous offrons un environnement de travail stimulant, des équipements modernes et des conditions d'engagement attractives.";

  const row = (id: string, slug: string, title: string, department: string) => `
    <tr class="data-row">
      <td><span class="jobTitle hidden-phone"><a href="/job/Lausanne-${slug}/${id}/" class="jobTitle-link">${title}</a></span></td>
      <td><span class="jobDepartment">${department}</span></td>
      <td><span class="jobShifttype">Lausanne</span></td>
      <td><span class="jobFacility">CDD</span></td>
    </tr>`;
  const SEARCH = `<table>${[
    row('1000000001', 'Postdoctoral-Scholar', 'Postdoctoral Scholar Opening in Indoor Air Quality', "Faculté de l'environnement naturel, architectural et construit"),
    row('1000000002', 'Research-Engineer', 'Research Engineer in Machine Learning', 'Engineering'),
    row('1000000003', 'Canevas-EPFL-vide', 'Canevas EPFL (vide)', 'Services centraux'),
    row('1000000004', 'Unreachable', 'Technicien-ne de laboratoire', 'Faculté des sciences de base'),
  ].join('')}</table>`;
  const detail = (body: string) => `<div class="jobDisplay"><span class="jobdescription">${body}</span></div>`;
  // The placeholder SuccessFactors template published live as a job: its
  // headings and the contract box, no text — under the 50-word floor.
  const EMPTY_TEMPLATE = '<p><b>Mission</b></p><p>Ajouter texte</p><p><b>Principales tâches et responsabilités</b></p><p><b>Profil</b></p><p><b>Nous offrons</b></p>'
    + "<p><b>Informations</b></p><p>Date d'entrée en fonction : à convenir</p><p>Taux d'occupation : 60-80</p><p>Type de contrat : CDD</p>";
  const DETAILS: Record<string, string> = {
    'https://careers.epfl.ch/job/Lausanne-Postdoctoral-Scholar/1000000001/': detail(`<p>${ENGLISH_BODY}</p>`),
    'https://careers.epfl.ch/job/Lausanne-Research-Engineer/1000000002/': detail(`<p>${FRENCH_BODY}</p>`),
    'https://careers.epfl.ch/job/Lausanne-Canevas-EPFL-vide/1000000003/': detail(EMPTY_TEMPLATE),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function crawl() {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://careers.epfl.ch/search/')) {
        return new Response(url.includes('startrow=0') ? SEARCH : '<table></table>', { status: 200 });
      }
      const html = DETAILS[url];
      return html ? new Response(html, { status: 200 }) : new Response('', { status: 503 });
    });
    return fetchAllEpflJobs();
  }

  it('files each body under its own language, not the language of title and faculty', async () => {
    const jobs = await crawl();
    const byTitle = Object.fromEntries(jobs.map((job) => [job.title, job]));

    const english = byTitle['Postdoctoral Scholar Opening in Indoor Air Quality'];
    expect(english.sourceLang).toBe('en');
    expect(Object.keys(english.descriptionByLocale)).toEqual(['en']);
    expect(Object.keys(english.titleByLocale)).toEqual(['en']);
    expect(Object.keys(english.slugByLocale)).toEqual(['en']);
    expect(english.description).toContain('indoor air quality in residential buildings');

    const french = byTitle['Research Engineer in Machine Learning'];
    expect(french.sourceLang).toBe('fr');
    expect(Object.keys(french.descriptionByLocale)).toEqual(['fr']);
    expect(french.description).toContain("méthodes d'apprentissage automatique");
  }, 15_000);

  it('does not publish an empty template or an unreachable page, and invents no description', async () => {
    const jobs = await crawl();

    expect(jobs.map((job) => job.title).sort()).toEqual([
      'Postdoctoral Scholar Opening in Indoor Air Quality',
      'Research Engineer in Machine Learning',
    ]);
    for (const job of jobs) {
      expect(job.description).not.toMatch(/Posizione pubblicata sul portale|Dettagli della posizione|Datore di lavoro: EPFL/);
    }
  }, 15_000);

  it('keeps the runner on the relabel flag and the published slugs', () => {
    const runner = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'update-epfl-jobs.mjs'), 'utf8');
    expect(runner).toMatch(/fetchJobs:\s*withSourceLangRelabelFlags\(fetchAllEpflJobs,\s*EPFL_KEY\)/);
    expect(runner).toMatch(/preserveExistingSlugs:\s*true/);
  });
});
