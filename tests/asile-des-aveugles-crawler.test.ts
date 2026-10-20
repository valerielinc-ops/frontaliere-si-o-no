import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASILE_DES_AVEUGLES_CAREERS_URL,
  ASILE_DES_AVEUGLES_KEY,
  ASILE_DES_AVEUGLES_LISTING_URL,
  ASILE_DES_AVEUGLES_SOURCE_SPEC,
  extractAsileListingRows,
  extractAsileOfficialAddress,
  extractAsileOfficialPlatform,
  fetchAllAsileDesAveuglesJobs,
  isAsileDesAveuglesJob,
  isAsileDesAveuglesTargetTitle,
  isTrustedDomain,
  parseAsileDetailPage,
  sanitizeAsileDescription,
} from '../scripts/lib/asile-des-aveugles-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import { matchProfessionTitle } from '../scripts/lib/profession-taxonomy.mjs';
import {
  MIN_JOBS,
  meetsJobsFloor,
  renderProfessionBelowFloorBridge,
} from '../build-plugins/shared/professionJobsFloor';

const fixture = (name: string) => readFileSync(
  new URL(`./fixtures/${name}`, import.meta.url),
  'utf8',
);

const CAREERS_HTML = fixture('asile-des-aveugles-careers.html');
const LISTING_HTML = fixture('asile-des-aveugles-listing.html');
const DETAIL_HTML = fixture('asile-des-aveugles-job-1919.html');
const DETAIL_URL = 'https://emploi.ophtalmique.ch/?page=advertisement_display&id=1919';

describe('Fondation Asile des aveugles source-backed crawler', () => {
  it('pins the employer careers page and its official employment platform', () => {
    expect(ASILE_DES_AVEUGLES_SOURCE_SPEC).toMatchObject({
      companyKey: ASILE_DES_AVEUGLES_KEY,
      companyName: 'Fondation Asile des aveugles',
      companyHost: 'asiledesaveugles.ch',
      platform: 'emploi.ophtalmique.ch',
      sourceType: 'official-employer-careers-platform',
      careersUrl: ASILE_DES_AVEUGLES_CAREERS_URL,
      seedUrls: [ASILE_DES_AVEUGLES_LISTING_URL],
      targetTitle: 'Assistant-e en soins et santé communautaire',
    });
    expect(extractAsileOfficialPlatform(CAREERS_HTML)).toBe(ASILE_DES_AVEUGLES_LISTING_URL);
    expect(extractAsileOfficialAddress(CAREERS_HTML)).toEqual({
      streetAddress: 'Avenue de France 15',
      postalCode: '1004',
      addressLocality: 'Lausanne',
      addressRegion: 'VD',
      addressCountry: 'CH',
    });
  });

  it('extracts stable detail and application identities from the official table', () => {
    const rows = extractAsileListingRows(LISTING_HTML);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      sourceId: '1919',
      title: 'Assistant-e en soins et santé communautaire',
      url: DETAIL_URL,
      applyUrl: 'https://emploi.ophtalmique.ch/?page=personal_information&rrid=1919',
      contractLabel: 'Contrat à durée indéterminée',
    });
    expect(isAsileDesAveuglesTargetTitle(rows[1].title)).toBe(true);
    expect(isAsileDesAveuglesTargetTitle('Assistant en soins et santé communautaire')).toBe(true);
    expect(isAsileDesAveuglesTargetTitle('Infirmier-ère EMS Clair-Soleil')).toBe(false);
  });

  it('ignores a missing handoff on an unrelated listing before filtering the ASSC target', async () => {
    const unrelatedWithoutHandoff = LISTING_HTML.replace(
      '<td><a href="?page=personal_information&amp;rrid=1913">postuler</a></td>',
      '<td></td>',
    );
    const jobs = await fetchAllAsileDesAveuglesJobs({
      fetchPage: async (url: string) => {
        if (url === ASILE_DES_AVEUGLES_CAREERS_URL) return CAREERS_HTML;
        if (url === ASILE_DES_AVEUGLES_LISTING_URL) return unrelatedWithoutHandoff;
        if (url === DETAIL_URL) return DETAIL_HTML;
        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('asile-des-aveugles-1919');
  });

  it('reads the ASSC role, rich copy, contract and Lausanne workplace from the detail', () => {
    const detail = parseAsileDetailPage(
      DETAIL_HTML,
      DETAIL_URL,
      'Assistant-e en soins et santé communautaire',
    );
    expect(detail).toMatchObject({
      sourceId: '1919',
      title: 'Assistant-e en soins et santé communautaire',
      location: 'Hôpital ophtalmique Jules-Gonin, Lausanne',
      canton: 'VD',
      workload: '100%',
      contract: 'CDI',
    });
    expect(detail.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
  });

  it('removes the recruiter contact block without inventing replacement prose', () => {
    const description = sanitizeAsileDescription(
      'Votre mission\nAssurer les soins.\nRenseignements :\nMadame Exemple, 021 626 81 42',
    );
    expect(description).toBe('Votre mission\nAssurer les soins.');
    expect(description).not.toMatch(/Madame|021/u);
  });

  it('produces one verifiable oss:VD job from the pinned official fixtures', async () => {
    const requested: string[] = [];
    const fetchPage = async (url: string) => {
      requested.push(url);
      if (url === ASILE_DES_AVEUGLES_CAREERS_URL) return CAREERS_HTML;
      if (url === ASILE_DES_AVEUGLES_LISTING_URL) return LISTING_HTML;
      if (url === DETAIL_URL) return DETAIL_HTML;
      throw new Error(`unexpected URL ${url}`);
    };
    const jobs = await fetchAllAsileDesAveuglesJobs({
      fetchPage,
      now: new Date('2026-10-15T12:00:00Z'),
    });

    expect(jobs).toHaveLength(1);
    expect(matchProfessionTitle(jobs[0].title)).toBe('oss');
    expect(jobs[0]).toMatchObject({
      id: 'asile-des-aveugles-1919',
      companyKey: ASILE_DES_AVEUGLES_KEY,
      company: 'Fondation Asile des aveugles',
      companyDomain: 'asiledesaveugles.ch',
      hiringOrganizationName: 'Fondation Asile des aveugles',
      title: 'Assistant-e en soins et santé communautaire',
      canton: 'VD',
      addressLocality: 'Lausanne',
      postalCode: '1004',
      streetAddress: 'Avenue de France 15',
      url: DETAIL_URL,
      applyUrl: 'https://emploi.ophtalmique.ch/?page=personal_information&rrid=1919',
      datePosted: '',
      postedDate: '',
      postingDateSource: 'unknown',
      employmentType: 'FULL_TIME',
    });
    expect(jobs[0].description).toContain('Dispenser des actes médico-techniques');
    expect(jobs[0].source).toContain('official careers platform');
    expect(requested).toEqual([
      ASILE_DES_AVEUGLES_CAREERS_URL,
      ASILE_DES_AVEUGLES_LISTING_URL,
      DETAIL_URL,
    ]);
  });

  it('accepts a proven target-empty table but rejects an unreadable table', async () => {
    const otherOnly = LISTING_HTML.replace(/<tr>\s*<th><a href="\?page=advertisement_display&amp;id=1919"[\s\S]*?<\/tr>/u, '');
    const jobs = await fetchAllAsileDesAveuglesJobs({
      fetchPage: async (url: string) => {
        if (url === ASILE_DES_AVEUGLES_CAREERS_URL) return CAREERS_HTML;
        if (url === ASILE_DES_AVEUGLES_LISTING_URL) return otherOnly;
        throw new Error(`unexpected URL ${url}`);
      },
    });
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(() => extractAsileListingRows('<main>Nos offres</main>'))
      .toThrow(/vacancy table was not found/u);
  });

  it('trusts the employer/platform chain and rejects marketplaces or lookalikes', () => {
    expect(isTrustedDomain(ASILE_DES_AVEUGLES_CAREERS_URL)).toBe(true);
    expect(isTrustedDomain(DETAIL_URL)).toBe(true);
    expect(isTrustedDomain('https://emploi.ophtalmique.ch.evil.example/?page=advertisement')).toBe(false);
    expect(isTrustedDomain('https://jobup.ch/fr/emplois/detail/1919')).toBe(false);
    expect(isAsileDesAveuglesJob({ companyKey: ASILE_DES_AVEUGLES_KEY })).toBe(true);
    expect(isAsileDesAveuglesJob({ companyKey: 'ophtalmique', url: DETAIL_URL })).toBe(false);
  });

  it('passes the promotion contract without weakening the bridge floor', () => {
    const observed = {
      verdict: 'good',
      score: 1,
      sampled: 1,
      vacancyCount: 1,
      reachableRate: 1,
      titleMatchRate: 1,
      contentfulRate: 1,
      locationSourceRate: 1,
      distinctRate: 1,
      detailDistinctRate: 1,
      jobLikeRate: 1,
      jobLikeEvidenceRate: 1,
      employerIdentityRate: 1,
      employerIdentityMismatchCount: 0,
      logoFound: true,
    };
    const gate = evaluatePromotion({
      status: 'promoted',
      qualityContractVersion: 3,
      crawlerKey: ASILE_DES_AVEUGLES_KEY,
      tenantHost: 'asiledesaveugles.ch',
      aggregator: false,
      validationHistory: [
        { ...observed, qualityContractVersion: 3, at: '2026-10-14T12:00:00Z' },
        { ...observed, qualityContractVersion: 3, at: '2026-10-15T12:00:00Z' },
      ],
    }, { existingKeys: new Set(), hostOwners: new Map() });
    expect(gate.passed, gate.reasons.join('\n')).toBe(true);

    expect(MIN_JOBS).toBe(3);
    expect(meetsJobsFloor({ liveCount: 1 }).meetsFloor).toBe(false);
    expect(renderProfessionBelowFloorBridge('fr', 'VD', 'oss'))
      .toContain('<meta name="robots" content="noindex,follow">');
  });
});
