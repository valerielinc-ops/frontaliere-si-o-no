/**
 * Tests for the eHnv (Étab. Hospitaliers du Nord Vaudois) Johdi Suite parser.
 *
 * eHnv moved off the jobup.ch mask feed (which returned 0 jobs for 5+
 * consecutive days while the real career page listed ~15 openings —
 * confirmed via live browser capture 2026-07-08) to its actual source:
 * the Johdi Suite ATS embedded on https://www.ehnv.ch/emplois.
 *
 * Verifies exported constants and matcher behavior; see
 * `tests/parsers/jobup-ch-feed-parser.test.ts` for the shared jobup.ch
 * parser tests (still used by Pôle Santé Pays-d'Enhaut).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  EHNV_KEY,
  EHNV_COMPANY_NAME,
  EHNV_COMPANY_DOMAIN,
  isEhnvJob,
  isTrustedDomain as isEhnvTrusted,
  fetchAllEhnvJobs,
} from '../../scripts/lib/ehnv-job-parser.mjs';

describe('eHnv (Johdi Suite) — exported constants', () => {
  it('has the expected key, name and domain', () => {
    expect(EHNV_KEY).toBe('ehnv');
    expect(EHNV_COMPANY_NAME).toMatch(/Nord Vaudois/);
    expect(EHNV_COMPANY_DOMAIN).toBe('ehnv.ch');
  });
});

describe('isEhnvJob — matcher', () => {
  it('matches by companyKey', () => {
    expect(isEhnvJob({ companyKey: 'ehnv', url: 'https://ats.johdisuite.ch/offer/1' })).toBe(true);
  });

  it('matches by corporate domain in url', () => {
    expect(isEhnvJob({ url: 'https://www.ehnv.ch/emplois#offer/4220/x' })).toBe(true);
  });

  it('does not match unrelated jobs', () => {
    expect(isEhnvJob({ companyKey: 'daler-hopital', url: 'https://daler.ch/emplois/' })).toBe(false);
    expect(isEhnvJob({ url: 'https://malicious.example/x' })).toBe(false);
  });
});

describe('isTrustedDomain — eHnv trusts its own domain and johdisuite.ch', () => {
  it('trusts ehnv.ch and ats.johdisuite.ch', () => {
    expect(isEhnvTrusted('https://www.ehnv.ch/emplois')).toBe(true);
    expect(isEhnvTrusted('https://ats.johdisuite.ch/api/company/x/offer/1')).toBe(true);
  });

  it('rejects unrelated or malformed URLs', () => {
    expect(isEhnvTrusted('https://malicious.example/x')).toBe(false);
    expect(isEhnvTrusted('not-a-url')).toBe(false);
    expect(isEhnvTrusted('')).toBe(false);
  });
});

// ── fetchAllEhnvJobs — end-to-end Johdi Suite API parsing (#3805/#3797) ──
// Fixture data mirrors the LIVE ats.johdisuite.ch response shape captured
// 2026-07-08 (see PR that added this block): eHnv posts across 4 physical
// sites (Yverdon, Chamblon, Orbe, Saint-Loup) with per-job `zip_code`.
describe('fetchAllEhnvJobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const LISTING = [
    {
      id: 4220,
      title: "Un.e médecin chef.fe en radiologie à 80-100 %",
      introduction: '<p>LE SERVICE DE RADIOLOGIE TRANSVERSE DES EHNV RECHERCHE</p>',
      contract_type: 'CDI',
      work_place: "Site d'Yverdon",
      city: 'Yverdon-les-Bains',
      sector: 'Santé',
      canton: 'Nord vaudois',
      slug: 'une-medecin-cheffe-en-radiologie-a-80-100',
      activity_from: 80,
      activity_to: 100,
      publication_date: '2026-07-01',
    },
    {
      id: 2624,
      title: 'Un.e infirmier.ère à 80-100 %',
      introduction: '<p>LE SITE DE CHAMBLON DES EHNV RECHERCHE</p>',
      contract_type: 'CDI',
      work_place: 'Site de Chamblon',
      city: 'Chamblon',
      sector: 'Santé',
      canton: 'Nord vaudois',
      slug: 'un-e-infirmier-ere-a-80-100',
      activity_from: 80,
      activity_to: 100,
      publication_date: '2026-06-15',
    },
  ];

  const DETAILS = {
    4220: {
      id: 4220,
      title: "Un.e médecin chef.fe en radiologie à 80-100 %",
      work_place: "Site d'Yverdon",
      city: 'Yverdon-les-Bains',
      canton: 'Nord vaudois',
      zip_code: '1400',
      country_code: 'ch',
      activity_from: 80,
      activity_to: 100,
      publication_date: '2026-07-01',
      introduction: '<p>LE SERVICE DE RADIOLOGIE TRANSVERSE DES EHNV RECHERCHE</p>',
      description:
        '<p><strong>COMPÉTENCES – EXIGENCES REQUISES</strong></p><ul><li>Être porteur.se du titre FMH en radiologie ou équivalent</li>' +
        '<li>Aptitude à travailler en équipe</li><li>Compétences dans tous les domaines de la radiologie y compris des actes simples de radiologie interventionnelle non vasculaire</li></ul>' +
        '<p><strong>NOUS OFFRONS</strong></p><ul><li>Un plateau technique moderne comprenant une IRM, 2 CT, des appareils US de toute dernière génération</li>' +
        '<li>Un système d’archivage informatique PACS et télé radiologie</li><li>Une activité hospitalière et ambulatoire variée</li>' +
        '<li>D’élargir ses compétences professionnelles dans une équipe dynamique avec de belles opportunités de développement</li></ul>' +
        '<p>Des renseignements complémentaires peuvent être obtenus auprès de la Direction médicale.</p>',
    },
    2624: {
      id: 2624,
      title: 'Un.e infirmier.ère à 80-100 %',
      work_place: 'Site de Chamblon',
      city: 'Chamblon',
      canton: 'Nord vaudois',
      zip_code: '1436',
      country_code: 'ch',
      activity_from: 80,
      activity_to: 100,
      publication_date: '2026-06-15',
      introduction: '<p>LE SITE DE CHAMBLON DES EHNV RECHERCHE</p>',
      description:
        '<p><strong>VOTRE MISSION</strong></p><ul><li>Assurer les soins infirmiers auprès des patients du site de Chamblon</li>' +
        '<li>Collaborer avec une équipe pluridisciplinaire dynamique et motivée</li><li>Participer aux projets qualité du service</li></ul>' +
        '<p><strong>VOTRE PROFIL</strong></p><ul><li>Diplôme en soins infirmiers HES ou équivalent reconnu</li>' +
        '<li>Sens de l’organisation et de la communication</li><li>Intérêt marqué pour le travail en réseau</li></ul>' +
        '<p>Renseignements complémentaires auprès de la Direction des soins.</p>',
    },
  };

  function mockJohdiSuite({ listing = LISTING, details = DETAILS, listingOk = true, listingBody } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const href = String(url);
        if (href.includes('/offers/')) {
          return {
            ok: listingOk,
            status: listingOk ? 200 : 503,
            json: async () => (listingBody !== undefined ? listingBody : listing),
          };
        }
        const match = href.match(/\/offer\/(\d+)\//);
        const id = match ? Number(match[1]) : null;
        const detail = id !== null ? details[id] : null;
        return {
          ok: true,
          status: 200,
          json: async () => detail,
        };
      }),
    );
  }

  it('parses live-shaped listing+detail payloads into well-formed jobs', async () => {
    mockJohdiSuite();
    const jobs = await fetchAllEhnvJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.id).toMatch(/^ehnv-/);
      expect(job.companyKey).toBe('ehnv');
      expect(job.canton).toBe('VD');
      expect(job.addressCountry).toBe('CH');
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });

  // Regression: PR #3805 fixed the shared Johdi Suite parser hard-coding a
  // single tenant-wide `defaultPostalCode` even though eHnv posts across 4
  // physical sites with different postal codes. Before that fix, EVERY eHnv
  // job (regardless of site) got postalCode "1400" (Yverdon's code).
  it('uses the per-job zip_code, not a single tenant-wide default', async () => {
    mockJohdiSuite();
    const jobs = await fetchAllEhnvJobs();
    const yverdonJob = jobs.find((j) => j.externalId === '4220');
    const chamblonJob = jobs.find((j) => j.externalId === '2624');
    expect(yverdonJob.postalCode).toBe('1400');
    expect(chamblonJob.postalCode).toBe('1436');
    expect(chamblonJob.postalCode).not.toBe(yverdonJob.postalCode);
  });

  it('falls back to the tenant default postal code when zip_code is missing', async () => {
    mockJohdiSuite({
      details: {
        4220: { ...DETAILS[4220], zip_code: null },
        2624: DETAILS[2624],
      },
    });
    const jobs = await fetchAllEhnvJobs();
    const yverdonJob = jobs.find((j) => j.externalId === '4220');
    expect(yverdonJob.postalCode).toBe('1400'); // eHnv's defaultPostalCode fallback
  });

  // Regression: #1305/#1395/#2029/#3791/#3797 — the jobup.ch mask feed (and,
  // before this fix, an anti-bot/error page) returned HTML instead of JSON.
  // `fetchAllEhnvJobs` must degrade to an empty array (existing slice is kept
  // by the pipeline), never throw and crash the crawler run.
  it('returns an empty array (does not throw) when the listing endpoint responds with an HTML block page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE " is not valid JSON');
        },
      })),
    );
    const jobs = await fetchAllEhnvJobs();
    expect(jobs).toEqual([]);
  });

  it('returns an empty array when the listing payload is empty/unexpected', async () => {
    mockJohdiSuite({ listingBody: [] });
    const jobs = await fetchAllEhnvJobs();
    expect(jobs).toEqual([]);
  });
});
