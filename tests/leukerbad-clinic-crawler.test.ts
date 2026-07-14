import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  LEUKERBAD_CLINIC_KEY,
  LEUKERBAD_CLINIC_COMPANY_NAME,
  isLeukerbadClinicJob,
  isTrustedDomain,
  fetchAllLeukerbadClinicJobs,
} from '../scripts/lib/leukerbad-clinic-job-parser.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';

// Regression (issues #4085 / #4169): Leukerbad's Nuxt/Prismic site renders
// every job on ONE language-specific listing page (…/fr/page/jobs/,
// …/de/page/jobs/) — the per-doc detail path 404s, so the parser keeps the
// listing URL as the source URL. Without a per-job discriminator all N jobs of
// a locale shared ONE URL; the shared crawler's URL-based fingerprint
// (canonicalizeJobUrl strips the hash → a bare listing URL collapses to a
// single key) folded them onto ONE fingerprint in mergeAndDeduplicate. The
// slice shrank to 2 (fr + de) and the shrink-guard hard-failed the crawler on
// EVERY run. The fix appends a stable `#job-<hash>` fragment so
// extractJobIdentityFromUrl mints a distinct identity per job — the same
// fragment-as-identity convention the other single-listing-page crawlers use
// (galenica, eHnv, état de vaud, klinik-gut).

const PRISMIC_API = 'https://leukerbad-clinic.cdn.prismic.io/api/v2';

function jobDoc(id: string, uid: string, lang: string, titleText: string) {
  return {
    id,
    uid,
    lang,
    first_publication_date: '2025-09-01T00:00:00+0000',
    last_publication_date: '2025-09-25T00:00:00+0000',
    data: {
      job_title: [{ type: 'heading1', text: titleText }],
      time_percentage: '80-100%',
      workplace: 'Leukerbad',
      job_description: [
        {
          type: 'paragraph',
          text:
            'Nous recherchons une personne motivée pour rejoindre notre équipe. ' +
            'Vous participerez aux soins et au suivi des patients dans un cadre ' +
            'de réadaptation moderne, en collaboration avec une équipe ' +
            'pluridisciplinaire engagée et bienveillante au quotidien.',
        },
      ],
    },
  };
}

describe('Leukerbad Clinic (leukerbad-clinic) crawler parser', () => {
  it('exports valid company key and name', () => {
    expect(LEUKERBAD_CLINIC_KEY).toBe('leukerbad-clinic');
    expect(LEUKERBAD_CLINIC_COMPANY_NAME).toBe('Leukerbad Clinic');
  });

  describe('isLeukerbadClinicJob', () => {
    it('matches by companyKey', () => {
      expect(isLeukerbadClinicJob({ companyKey: 'leukerbad-clinic' })).toBe(true);
    });
    it('matches by URL domain', () => {
      expect(isLeukerbadClinicJob({ url: 'https://leukerbadclinic.ch/fr/page/jobs/#job-abc' })).toBe(true);
    });
    it('rejects unrelated jobs', () => {
      expect(isLeukerbadClinicJob({ companyKey: 'other', url: 'https://other.com/jobs' })).toBe(false);
    });
    it('handles null gracefully', () => {
      expect(isLeukerbadClinicJob(null)).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts the corporate domain (with per-job fragment)', () => {
      expect(isTrustedDomain('https://leukerbadclinic.ch/de/page/jobs/#job-abc')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });
  });

  describe('fetchAllLeukerbadClinicJobs — Prismic REST API', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_TIMEOUT_MS = '1000';
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_TIMEOUT_MS;
    });

    function mockPrismic(docs: unknown[]) {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u === PRISMIC_API) {
          return new Response(
            JSON.stringify({
              refs: [{ ref: 'MASTER_REF', isMasterRef: true }],
              types: { job: 'Job' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/documents/search')) {
          return new Response(
            JSON.stringify({ page: 1, total_pages: 1, results_size: docs.length, results: docs }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as any;
    }

    it('gives every job a DISTINCT fingerprint even though all share one listing URL (shrink-guard regression)', async () => {
      // Multiple distinct job documents on the SAME fr listing page.
      mockPrismic([
        jobDoc('doc-A', 'infirmiere', 'fr-ch', 'INFIRMIER/INFIRMIÈRE DIPLÔMÉ-E (H/F) 80-100%'),
        jobDoc('doc-B', 'assc', 'fr-ch', 'ASSISTANT-E EN SOINS ET SANTE COMMUNAUTAIRE CFC (ASSC)'),
        jobDoc('doc-C', 'physio', 'fr-ch', 'PHYSIOTHERAPEUTE DIPLOME-E (H/F)'),
        jobDoc('doc-D', 'mpa', 'de-ch', 'Medizinische/r Praxisassistent/in (m/w)'),
      ]);

      const jobs = await fetchAllLeukerbadClinicJobs();
      expect(jobs).toHaveLength(4);

      // Every job carries the per-doc fragment and points at the live listing.
      for (const job of jobs) {
        expect(job.companyKey).toBe('leukerbad-clinic');
        expect(job.url).toMatch(/^https:\/\/leukerbadclinic\.ch\/(fr|de)\/page\/jobs\/#job-[0-9a-f]{12}$/);
        expect(isTrustedDomain(job.url)).toBe(true);
      }

      // The fr jobs share the same path but MUST NOT share a fingerprint —
      // this is the exact collapse that shrank the slice 15→2 and tripped the
      // shrink-guard on every run.
      const fps = jobs.map((j) => fingerprintJob(j));
      expect(new Set(fps).size).toBe(jobs.length);

      // And each fingerprint resolves via the fragment identity, not the bare
      // (collapsing) listing URL.
      for (const fp of fps) {
        expect(fp).toMatch(/^id\|leukerbadclinic\.ch\|#job-[0-9a-f]{12}$/);
      }
    });

    it('produces a stable fragment across runs for the same Prismic doc', async () => {
      mockPrismic([jobDoc('doc-A', 'infirmiere', 'fr-ch', 'INFIRMIER/INFIRMIÈRE DIPLÔMÉ-E (H/F) 80-100%')]);
      const first = await fetchAllLeukerbadClinicJobs();
      mockPrismic([jobDoc('doc-A', 'infirmiere', 'fr-ch', 'INFIRMIER/INFIRMIÈRE DIPLÔMÉ-E (H/F) 80-100%')]);
      const second = await fetchAllLeukerbadClinicJobs();
      expect(first[0].url).toBe(second[0].url);
      expect(fingerprintJob(first[0])).toBe(fingerprintJob(second[0]));
    });
  });
});
