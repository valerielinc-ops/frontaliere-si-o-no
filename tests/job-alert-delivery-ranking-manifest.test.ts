import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  persistJobAlertDelivery,
  __setFirestoreAdminForTest,
} from '../scripts/send-job-alerts.mjs';
import {
  buildRankingJobsManifest,
  jobManifestEntry,
  MANIFEST_ATTRIBUTE_MAX_LENGTH,
} from '../functions/src/lib/jobEmailRankingStore.js';
import { matchJobsForSubscriber } from '../services/newsletter-content.mjs';

// campaign_deliveries.ranking_jobs: annunci completi salvati a ogni invio job alert.
//
// Until this guard, persistJobAlertDelivery stored item.meta.rankingJobs as-is:
// up to ten full job objects per send, each with `description` and
// `descriptionByLocale` (21-24 KB per job, ~200 KB per delivery document).
// The delivery document must carry only the lean manifest that
// job_email_ranking_deliveries already stores for the same delivery.

const MANIFEST_KEYS = [
  'affinity_score',
  'canton',
  'category',
  'company_key',
  'job_id',
  'position',
  'ranking_score',
  'relevance_score',
  'sector',
];

// jobManifestEntry: attributi dell'annuncio assenti nel manifest delle consegne.
// A job_id stops resolving once the listing expires (the expired archive has no
// id, category or canton), so a click on an expired listing must still say
// which kind of listing it was. These four names are read by the interest
// profile and the ranking built on top of it: they are part of the contract.
const ATTRIBUTE_KEYS = ['category', 'canton', 'company_key', 'sector'];

// ~6 KB of text per locale, four locales plus the base description: the same
// order of magnitude as a production job (21-24 KB).
const LONG_TEXT = 'Descrizione completa della posizione con requisiti e mansioni. '.repeat(95);

function fullJob(index: number) {
  return {
    jobId: `job-${index}`,
    id: `job-${index}`,
    slug: `impiegato-di-commercio-${index}`,
    title: `Impiegato di commercio ${index}`,
    company: 'Azienda Esempio SA',
    companyKey: 'azienda-esempio-sa',
    category: 'administration',
    sector: 'Commercio / Vendita',
    location: 'Lugano',
    canton: 'TI',
    url: `https://example.com/jobs/${index}`,
    description: LONG_TEXT,
    descriptionByLocale: { it: LONG_TEXT, en: LONG_TEXT, de: LONG_TEXT, fr: LONG_TEXT },
    titleByLocale: { it: `Impiegato ${index}`, en: `Clerk ${index}` },
    ranking: {
      position: index + 1,
      rankingScore: 0.9 - index * 0.01,
      relevanceScore: 0.8,
      affinityScore: 0.333333,
    },
  };
}

function createDeliveryFakeDb() {
  const sets: Array<{ path: string; data: any; merge: boolean }> = [];
  const docNode = (path: string): any => ({
    collection: (name: string) => collectionNode(`${path}/${name}`),
    set: (data: any, opts: any) => {
      sets.push({ path, data, merge: !!opts?.merge });
      return Promise.resolve();
    },
  });
  const collectionNode = (path: string): any => ({ doc: (id: string) => docNode(`${path}/${id}`) });
  return { db: { collection: (name: string) => collectionNode(name) }, sets };
}

function deliveryItem(rankingJobs?: unknown) {
  return {
    recipient: { email: 'Seeker@Example.com' },
    meta: {
      alertId: 'alert-1',
      rankingDeliveryId: 'jer_job_alert_1',
      rankingVariant: 'ctr_v1',
      sendTimeSource: 'personal',
      ...(rankingJobs === undefined ? {} : { rankingJobs }),
    },
  };
}

describe('job alert delivery record — ranking_jobs is the lean manifest', () => {
  afterEach(() => {
    __setFirestoreAdminForTest(null);
  });

  it('writes only the manifest for ten full jobs (no description*, under 4 KB)', async () => {
    const jobs = Array.from({ length: 10 }, (_, index) => fullJob(index));
    // The fixture must reproduce the defect size, otherwise the bound below
    // would hold even with the full objects.
    expect(Buffer.byteLength(JSON.stringify(jobs))).toBeGreaterThan(200_000);

    const { db, sets } = createDeliveryFakeDb();
    __setFirestoreAdminForTest(db);
    const item = deliveryItem(jobs);
    await persistJobAlertDelivery(item, { provider: 'maileroo', messageId: 'ref_1', scheduledFor: null });

    expect(sets).toHaveLength(1);
    const written = sets[0];
    expect(written.merge).toBe(true);
    expect(written.path).toMatch(/^job_alert_subscribers\/seeker@example\.com\/campaign_deliveries\//);

    const rankingJobs = written.data.ranking_jobs;
    expect(rankingJobs).toHaveLength(10);
    expect(rankingJobs).toEqual(jobs.map(jobManifestEntry));
    for (const entry of rankingJobs) {
      expect(Object.keys(entry).sort()).toEqual(MANIFEST_KEYS);
      expect(Object.keys(entry).some((key) => key.startsWith('description'))).toBe(false);
    }
    expect(JSON.stringify(rankingJobs)).not.toMatch(/description/i);
    expect(Buffer.byteLength(JSON.stringify(rankingJobs))).toBeLessThan(4_000);
    // A complete job alert listing fills all four attributes.
    for (const entry of rankingJobs) {
      expect(entry).toMatchObject({
        category: 'administration',
        canton: 'TI',
        company_key: 'azienda-esempio-sa',
        sector: 'Commercio / Vendita',
      });
    }
    // The whole delivery document stays small, not just the one field.
    expect(Buffer.byteLength(JSON.stringify(written.data))).toBeLessThan(4_000);

    // The other fields of the record are untouched by the projection.
    expect(written.data).toMatchObject({
      email: 'seeker@example.com',
      campaign_id: 'alert-1',
      ranking_delivery_id: 'jer_job_alert_1',
      ranking_variant: 'ctr_v1',
      message_id: 'ref_1',
      provider: 'maileroo',
      scheduled_for: null,
      send_time_source: 'personal',
      is_operator_verification: false,
    });
  });

  it('leaves item.meta.rankingJobs intact in memory (impressions + retry queue read it)', async () => {
    const jobs = Array.from({ length: 3 }, (_, index) => fullJob(index));
    const snapshot = JSON.parse(JSON.stringify(jobs));
    const { db } = createDeliveryFakeDb();
    __setFirestoreAdminForTest(db);
    const item = deliveryItem(jobs);
    await persistJobAlertDelivery(item, { provider: 'maileroo', messageId: 'ref_2' });

    expect(item.meta.rankingJobs).toBe(jobs);
    expect(item.meta.rankingJobs).toEqual(snapshot);
    expect(item.meta.rankingJobs[0].description).toBe(LONG_TEXT);
  });

  it('writes [] when rankingJobs is absent', async () => {
    const { db, sets } = createDeliveryFakeDb();
    __setFirestoreAdminForTest(db);
    await persistJobAlertDelivery(deliveryItem(), { provider: 'maileroo', messageId: 'ref_3' });

    expect(sets).toHaveLength(1);
    expect(sets[0].data.ranking_jobs).toEqual([]);
  });

  it('every sender writes ranking_jobs through the manifest projection (job alerts + newsletter)', () => {
    // send-newsletter.mjs's persistDelivery reads a module-level db and is not
    // importable in isolation, so the class is guarded on the source: no
    // sender may assign the in-memory job list straight to the Firestore field.
    const scriptsDir = path.resolve(__dirname, '../scripts');
    const writers: string[] = [];
    for (const name of fs.readdirSync(scriptsDir)) {
      if (!name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      for (const line of src.split('\n')) {
        if (!/^\s*ranking_jobs\s*:/.test(line)) continue;
        writers.push(name);
        expect(line, `${name}: ${line.trim()}`).toMatch(/ranking_jobs:\s*buildRankingJobsManifest\(/);
      }
    }
    expect(writers.sort()).toEqual(['send-job-alerts.mjs', 'send-newsletter.mjs']);
  });

  it('buildRankingJobsManifest is a pure projection with a safe default', () => {
    expect(buildRankingJobsManifest(undefined)).toEqual([]);
    expect(buildRankingJobsManifest(null)).toEqual([]);
    expect(buildRankingJobsManifest([])).toEqual([]);
    expect(buildRankingJobsManifest([fullJob(4)])).toEqual([{
      job_id: 'job-4',
      position: 5,
      ranking_score: 0.9 - 4 * 0.01,
      relevance_score: 0.8,
      affinity_score: 0.333333,
      category: 'administration',
      canton: 'TI',
      company_key: 'azienda-esempio-sa',
      sector: 'Commercio / Vendita',
    }]);
  });
});

describe('jobManifestEntry — listing attributes', () => {
  it('carries the four attributes with their exact names', () => {
    const entry = jobManifestEntry(fullJob(0), 0);
    for (const key of ATTRIBUTE_KEYS) expect(entry).toHaveProperty(key);
    expect(Object.keys(entry).sort()).toEqual(MANIFEST_KEYS);
  });

  it('normalizes: uppercase canton, trimmed short strings, null when missing', () => {
    const long = `${'x'.repeat(MANIFEST_ATTRIBUTE_MAX_LENGTH)}TAIL`;
    const entry = jobManifestEntry({
      jobId: 'job-n',
      category: '  it\n  software ',
      canton: ' ti ',
      companyKey: long,
      sector: long,
    }, 0);
    expect(MANIFEST_ATTRIBUTE_MAX_LENGTH).toBe(80);
    expect(entry.canton).toBe('TI');
    expect(entry.category).toBe('it software');
    expect(entry.company_key).toHaveLength(80);
    expect(entry.company_key).not.toContain('TAIL');
    expect(entry.sector).toHaveLength(80);

    const bare = jobManifestEntry({ jobId: 'job-bare' }, 3);
    expect(bare).toMatchObject({ category: null, canton: null, company_key: null, sector: null });
    // Empty strings, objects and non-codes are absent values, never "" or junk.
    const junk = jobManifestEntry({
      jobId: 'job-junk', category: '   ', canton: 'Ticino', companyKey: { a: 1 }, sector: '',
    }, 0);
    expect(junk).toMatchObject({ category: null, canton: null, company_key: null, sector: null });
  });

  it('never copies description* or other listing fields', () => {
    const entry = jobManifestEntry(fullJob(1), 1);
    expect(Object.keys(entry).some((key) => key.startsWith('description'))).toBe(false);
    expect(JSON.stringify(entry)).not.toMatch(/description|Impiegato|example\.com/i);
  });

  it('keeps ten realistic entries under 4 KB even with long attributes', () => {
    const jobs = Array.from({ length: 10 }, (_, index) => ({
      ...fullJob(index),
      jobId: `ch-${index}-${'9'.repeat(30)}`,
      category: 'engineering-and-technical-maintenance',
      companyKey: 'ente-ospedaliero-cantonale-servizio-risorse-umane-bellinzona',
      sector: 'Sanità / Ospedali e cliniche private',
    }));
    const size = Buffer.byteLength(JSON.stringify(buildRankingJobsManifest(jobs)));
    expect(size).toBeLessThan(4_000);
  });

  it('a newsletter card carries category and canton from the listing it comes from', () => {
    const description = 'Ruolo completo con mansioni e requisiti a Lugano.';
    const jobs = [
      {
        jobId: 'nl-1', slug: 'contabile-nl-1', title: 'Contabile', company: 'Banca Esempio SA',
        companyKey: 'banca-esempio-sa', location: 'Lugano', canton: 'ti', category: 'finance',
        sector: 'Banche / Finanza', contract: 'full-time', description,
      },
      {
        // No explicit canton and no sector: canton comes from the location
        // through the shared resolver, the card's display sector falls back to
        // the category, the manifest sector stays null.
        jobId: 'nl-2', slug: 'infermiere-nl-2', title: 'Infermiere', company: 'Clinica Esempio',
        companyKey: 'clinica-esempio', location: 'Bellinzona', category: 'healthcare',
        contract: 'full-time', description,
      },
      {
        // A half-canton keeps its own code: the resolver would fold BS into
        // the BASILEA URL group.
        jobId: 'nl-3', slug: 'logistico-nl-3', title: 'Logistico', company: 'Logistica Basel AG',
        companyKey: 'logistica-basel-ag', location: 'Basel', canton: 'BS', category: 'logistics',
        sector: 'Trasporti / Logistica', contract: 'full-time', description,
      },
    ];
    const cards = matchJobsForSubscriber({ locale: 'it' }, jobs, 3, 'it');
    expect(cards).toHaveLength(3);
    const byCompany = new Map(cards.map((card: any) => [card.companyKey, card]));

    // The card keeps the fields the template and the alert matcher read.
    const clinic = byCompany.get('clinica-esempio');
    expect(clinic.sector).toBe('healthcare');

    const manifest = cards.map((card: any, index: number) => jobManifestEntry(card, index));
    const byKey = new Map(manifest.map((entry) => [entry.company_key, entry]));
    expect(byKey.get('banca-esempio-sa')).toMatchObject({
      category: 'finance', canton: 'TI', sector: 'Banche / Finanza',
    });
    expect(byKey.get('clinica-esempio')).toMatchObject({
      category: 'healthcare', canton: 'TI', sector: null,
    });
    expect(byKey.get('logistica-basel-ag')).toMatchObject({
      category: 'logistics', canton: 'BS', sector: 'Trasporti / Logistica',
    });
    for (const entry of manifest) {
      expect(Object.keys(entry).sort()).toEqual(MANIFEST_KEYS);
    }
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(4_000);
  });
});
