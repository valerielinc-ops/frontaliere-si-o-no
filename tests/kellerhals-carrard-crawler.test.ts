import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  fetchAllKellerhalsCarrardJobs,
  KELLERHALS_CARRARD_KEY,
  KELLERHALS_CARRARD_COMPANY_NAME,
  isKellerhalsCarrardJob,
  isTrustedDomain,
  KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/kellerhals-carrard-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';

describe('Kellerhals Carrard crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KELLERHALS_CARRARD_KEY).toBe('kellerhals-carrard');
    expect(KELLERHALS_CARRARD_COMPANY_NAME).toBe('Kellerhals Carrard');
  });

  // ── isCompanyJob ──
  describe('isKellerhalsCarrardJob', () => {
    it('matches by companyKey', () => {
      expect(isKellerhalsCarrardJob({ companyKey: 'kellerhals-carrard' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKellerhalsCarrardJob({ company: 'Kellerhals Carrard' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKellerhalsCarrardJob({ url: 'https://kellerhals-carrard.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKellerhalsCarrardJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKellerhalsCarrardJob(null)).toBe(false);
      expect(isKellerhalsCarrardJob(undefined)).toBe(false);
      expect(isKellerhalsCarrardJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kellerhals-carrard.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.kellerhals-carrard.ch/job/456')).toBe(true);
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
      expect(slugify('Developer kellerhals-carrard ch')).toBe('developer-kellerhals-carrard-ch');
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
      id: 'kellerhals-carrard-abc123',
      slug: 'test-position-kellerhals-carrard-ch',
      slugByLocale: { de: 'test-position-kellerhals-carrard-ch' },
      company: 'Kellerhals Carrard',
      companyKey: 'kellerhals-carrard',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://kellerhals-carrard.ch/jobs/test',
      source: 'Kellerhals Carrard Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^kellerhals-carrard-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllKellerhalsCarrardJobs: published page + office table (#5253) ──
  describe('fetchAllKellerhalsCarrardJobs', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('publishes a Lausanne-only vacancy in Lausanne with the body of its job page', async () => {
      // Live 2026-09-29, posting 2437629: `search.json?language=de` answers
      // with an empty description (the position exists only in French) and
      // office "Lausanne", which was missing from the office table — the job
      // went out as a 199-character placeholder located in Bern.
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify([{
          id: 2437629,
          name: 'Avocat(e) à 100% ou 80%',
          description: '',
          office: 'Lausanne',
          offices: ['Lausanne'],
          schedule: 'full-time',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(`
          <h1 class="page_jobTitle__x detail-title job-position-title">Avocat(e) à 100% ou 80%</h1>
          <div class="page_jobDescriptionItem__x jb-description-item"><h2 class="detail-block-title">Vos tâches</h2>
            <div class="rich-text-content detail-block-description"><ul><li>Conseiller notre clientèle en droit des affaires</li></ul></div></div>
          <div class="page_jobDescriptionItem__x jb-description-item"><h2 class="detail-block-title">Votre profil</h2>
            <div class="rich-text-content detail-block-description"><ul><li>Avocat/e breveté/ée (VD, GE, FR, VS, NE, JU) avec 2 à 3 ans d’expérience.</li><li>Expérience en droit de la famille serait un atout.</li><li>Maîtrise de l’anglais niveau C 1&nbsp;; allemand&nbsp;: bonne connaissance permettant l’utilisation des sources.</li><li>A l’aise dans la relation directe avec le client.</li><li>Expérience du suivi économique du client/dossier.</li><li>Rigoureux(se) dans le traitement des dossiers, avec le sens de l’organisation et de la fixation des priorités.</li><li>Doté(e) d’un fort esprit d’équipe.</li></ul></div></div>
          <div class="page_jobDescriptionItem__x detail-content-block detail-content-block-about-us"><h2 class="detail-block-title">À propos de nous</h2>
            <div class="rich-text-content detail-block-description"><p>Kellerhals Carrard compte plus de 400 collaboratrices et collaborateurs.</p></div></div>
        `, { status: 200 }));

      const [job] = await fetchAllKellerhalsCarrardJobs();

      expect(job.location).toBe('Lausanne');
      expect(job.canton).toBe('VD');
      expect(job.postalCode).toBe('1003');
      expect(job.description).toContain('Conseiller notre clientèle en droit des affaires');
      expect(job.description).toContain('## À propos de nous');
      expect(job.description).toContain('Expérience en droit de la famille serait un atout.');
      expect(job.description).not.toContain('Stelle bei Kellerhals Carrard');
    });

    it('writes no text of its own when the page body is under the 50-word floor (issue 5253)', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify([{
          id: 2437629,
          name: 'Avocat(e) à 100% ou 80%',
          description: '',
          office: 'Lausanne',
          offices: ['Lausanne'],
          schedule: 'full-time',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(`
          <h1 class="page_jobTitle__x detail-title job-position-title">Avocat(e) à 100% ou 80%</h1>
          <div class="page_jobDescriptionItem__x jb-description-item"><h2 class="detail-block-title">Ce que nous proposons</h2>
            <div class="rich-text-content detail-block-description">Le département judiciaire de l’étude d’avocats Kellerhals Carrard à Lausanne est à la recherche d’un.e Avocat.e à plein temps ou à temps partiel.</div></div>
        `, { status: 200 }));

      const [job] = await fetchAllKellerhalsCarrardJobs();

      // Still emitted (same slug): the pipeline keeps the stored source body
      // or quarantines it — no "<title> — Stelle bei Kellerhals Carrard …".
      expect(job.slug).toBe('avocat-e-a-100-ou-80-kellerhals-carrard-lausanne');
      expect(job.description).toBe('');
      expect(job.descriptionByLocale).toEqual({ [job.sourceLang]: '' });
    });
  });

  // ── stored rows written with the old stand-in text (#5253) ──
  describe('KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE', () => {
    // The three shapes of the 3/14 stored rows on main (2026-09-29).
    const stub = 'Avocat(e) à 100% ou 80% — Stelle bei Kellerhals Carrard in Bern (BE), Schweiz. Kellerhals Carrard ist eine der führenden Schweizer Wirtschaftskanzleien mit Standorten in Bern, Zürich, Basel und Genf.';

    it.each([
      ['the parser text', stub],
      ['with the "Beschreibung" heading of the stored slot', `Beschreibung\n\n${stub}`],
      ['with "Stelle" machine-translated', stub.replace('Stelle bei', 'Stars bei')],
    ])('drops %s, its translations and the flat description', (_label, sourceSlot) => {
      const job = {
        sourceLang: 'de',
        description: stub,
        descriptionByLocale: { de: sourceSlot, it: 'Avocat(e) à 100% ou 80% — posizione a Kellerhals Carrard a Berna (BE), Svizzera.' },
      };
      expect(dropFabricatedDescription(job, KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE)).toBe(true);
      expect(job.description).toBe('');
      expect(job.descriptionByLocale).toEqual({});
      expect((job as any).needsRetranslation).toBe(true);
    });

    it('leaves a real posting that quotes the same firm sentence alone', () => {
      const real = 'Wir suchen eine Rechtsanwältin für unser Team in Bern. Kellerhals Carrard ist eine der führenden Schweizer Wirtschaftskanzleien mit Standorten in Bern, Zürich, Basel und Genf. Ihre Aufgaben: Beratung von Unternehmen.';
      const job = { sourceLang: 'de', description: real, descriptionByLocale: { de: real, it: 'Traduzione' } };
      expect(dropFabricatedDescription(job, KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE)).toBe(false);
      expect(job.descriptionByLocale).toEqual({ de: real, it: 'Traduzione' });
      expect(KELLERHALS_CARRARD_FABRICATED_DESCRIPTION_RE.test(`${stub}\n\nIhre Aufgaben: Beratung von Unternehmen.`)).toBe(false);
    });
  });
});
