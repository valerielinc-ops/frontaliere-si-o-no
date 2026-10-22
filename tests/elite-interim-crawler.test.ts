import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ELITE_INTERIM_KEY,
  eliteInterimDetailText,
  extractEliteInterimWorkplace,
  fetchAllEliteInterimJobs,
  isEliteInterimJob,
  isNeuchatelElectricianDetail,
  isTrustedDomain,
  parseEliteInterimPost,
} from '../scripts/lib/elite-interim-job-parser.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

function officialPost(id: number, title: string, workplace: string, days = 10) {
  return {
    id,
    date_gmt: daysAgo(days),
    date: `${daysAgo(days)}+02:00`,
    link: `https://eliteinterim.ch/${title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')}/`,
    title: { rendered: title },
    content: {
      rendered: `[vc_row][vc_column]<p><strong>Lieu de travail :</strong><br>${workplace}</p>
        <p><strong>Votre profil :</strong></p><ul><li>CFC dans le domaine électrique ou titre équivalent.</li><li>Expérience confirmée et travail autonome.</li><li>Permis de conduire indispensable.</li></ul>
        <p><strong>Début :</strong><br>Immédiatement</p><p><strong>N° d’annonce :</strong><br>0546${id}</p>
        <p><strong>Votre mission :</strong></p><ul><li>Lecture de plans et schémas techniques.</li><li>Installation, contrôle et raccordement des équipements.</li><li>Recherche de pannes et maintenance des installations.</li><li>Respect des normes de sécurité en vigueur.</li></ul>
        <p>Ce poste vous intéresse ? Nous nous réjouissons de recevoir votre candidature complète.</p>[/vc_column][/vc_row]`,
    },
  };
}

function jsonResponse(body: unknown, totalPages?: number) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'x-wp-totalpages' && totalPages != null ? String(totalPages) : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const NE_POSTS = [
  officialPost(2975, 'Installateur électricien de réseau CFC (Canton Neuchâtel)', 'Canton de Neuchâtel'),
  officialPost(2939, 'Électricien de montage CFC (Canton Neuchâtel)', 'Canton de Neuchâtel'),
  officialPost(2882, 'Chef/ffe de projet ou conseiller/e en sécurité électrique avec Brevet Fédéral (Canton Neuchâtel)', 'Canton de Neuchâtel'),
  officialPost(2864, 'Installateur-électricien (Canton Neuchâtel)', 'Canton de Neuchâtel'),
];

describe('Elite Interim electrician:NE crawler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pins the promoted spec to the official employer surface', () => {
    const spec = JSON.parse(readFileSync(new URL('../data/prospector/crawlers/elite-interim.json', import.meta.url), 'utf8'));
    expect(spec.companyKey).toBe(ELITE_INTERIM_KEY);
    expect(spec.companyHost).toBe('eliteinterim.ch');
    expect(spec.seedUrls).toEqual(['https://eliteinterim.ch/toutes-nos-offres-demplois/']);
    expect(spec.detailEnrichment).toBe(true);
    expect(spec.sampleVacancyCount).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(spec)).not.toMatch(/jobup\.ch|jobs\.ch/);
  });

  it('removes WordPress builder chrome and reads workplace from the detail body', () => {
    const text = eliteInterimDetailText(NE_POSTS[0].content.rendered);
    expect(text).not.toContain('[vc_');
    expect(extractEliteInterimWorkplace(text)).toBe('Canton de Neuchâtel');
    expect(text).toContain('Lecture de plans');
  });

  it('accepts only electrical roles whose official detail is NE-only', () => {
    expect(isNeuchatelElectricianDetail(NE_POSTS[0].title.rendered, 'Canton de Neuchâtel')).toBe(true);
    expect(isNeuchatelElectricianDetail('Installateur électricien', 'Canton de Vaud')).toBe(false);
    expect(isNeuchatelElectricianDetail('Conseiller en sécurité électrique', 'Arc Jurassien (Jura, Jura bernois et canton de Neuchâtel)')).toBe(false);
    expect(isNeuchatelElectricianDetail('Électricien', 'Neuchâtel / Arc jurassien')).toBe(false);
    expect(isNeuchatelElectricianDetail('Technicien de maintenance', 'Canton de Neuchâtel')).toBe(false);
  });

  it('accepts a workplace label authored as a WordPress list item', () => {
    const post = officialPost(3200, 'Électricien CFC', 'Neuchâtel');
    post.content.rendered = post.content.rendered.replace(
      '<p><strong>Lieu de travail :</strong><br>Neuchâtel</p>',
      '<ul><li><strong>Lieu :</strong> Neuchâtel</li></ul>',
    );
    expect(parseEliteInterimPost(post)?.location).toBe('Neuchâtel');
  });

  it('stops from WordPress pagination metadata when the last page contains 100 posts', async () => {
    const posts = Array.from({ length: 100 }, (_, index) =>
      officialPost(4000 + index, `Électricien CFC ${index + 1}`, 'Canton de Neuchâtel'));
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      if (url.includes('page=2')) throw new Error('invalid page must not be requested');
      return jsonResponse(posts, 1);
    }));

    await expect(fetchAllEliteInterimJobs()).resolves.toHaveLength(100);
    expect(requested).toHaveLength(1);
  });

  it('extracts four source-backed jobs with stable URLs, source dates, descriptions and detail locations', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return jsonResponse([
        ...NE_POSTS,
        officialPost(2977, 'Installateur électricien de réseau CFC (Canton Vaud)', 'Canton de Vaud'),
        officialPost(3109, 'Conseiller en sécurité électrique avec brevet fédéral (Arc Jurassien)', 'Arc Jurassien (Jura, Jura bernois et canton de Neuchâtel)'),
      ]);
    }));

    const jobs = await fetchAllEliteInterimJobs();

    expect(jobs).toHaveLength(4);
    expect(new Set(jobs.map((job) => job.url)).size).toBe(4);
    expect(jobs.every((job) => job.id.startsWith('elite-interim-'))).toBe(true);
    expect(jobs.every((job) => job.url.startsWith('https://eliteinterim.ch/'))).toBe(true);
    expect(jobs.every((job) => job.url.endsWith('/'))).toBe(true);
    expect(jobs.every((job) => job.canton === 'NE' && job.location === 'Canton de Neuchâtel')).toBe(true);
    expect(jobs.every((job) => job.addressLocality === job.location && job.postalCode === '' && job.streetAddress === '')).toBe(true);
    expect(jobs.every((job) => job.postingDateSource === 'reported' && Number.isFinite(Date.parse(job.datePosted)))).toBe(true);
    expect(jobs.every((job) => job.description.split(/\s+/).length >= 50)).toBe(true);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('eliteinterim.ch/wp-json/wp/v2/posts');
    expect(requested[0]).not.toMatch(/jobup\.ch|jobs\.ch/);

    const observed = {
      verdict: 'good',
      score: 1,
      sampled: jobs.length,
      vacancyCount: jobs.length,
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
      crawlerKey: ELITE_INTERIM_KEY,
      tenantHost: 'eliteinterim.ch',
      aggregator: false,
      validationHistory: [
        { ...observed, qualityContractVersion: 3, at: new Date(Date.now() - 86_400_000).toISOString() },
        { ...observed, qualityContractVersion: 3, at: new Date().toISOString() },
      ],
    }, { existingKeys: new Set(), hostOwners: new Map() });
    expect(gate.passed, gate.reasons.join('\n')).toBe(true);
  });

  it('trusts only the official Elite Interim origin', () => {
    expect(isTrustedDomain('https://eliteinterim.ch/un-installateur-electricien-neuchatel/')).toBe(true);
    expect(isEliteInterimJob({ companyKey: ELITE_INTERIM_KEY })).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/emplois/detail/123')).toBe(false);
    expect(isTrustedDomain('https://jobs.ch/fr/offres-emplois/detail/123')).toBe(false);
  });
});
