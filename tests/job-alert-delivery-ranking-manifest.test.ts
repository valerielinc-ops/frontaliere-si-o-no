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
} from '../functions/src/lib/jobEmailRankingStore.js';

// campaign_deliveries.ranking_jobs: annunci completi salvati a ogni invio job alert.
//
// Until this guard, persistJobAlertDelivery stored item.meta.rankingJobs as-is:
// up to ten full job objects per send, each with `description` and
// `descriptionByLocale` (21-24 KB per job, ~200 KB per delivery document).
// The delivery document must carry only the lean manifest that
// job_email_ranking_deliveries already stores for the same delivery.

const MANIFEST_KEYS = [
  'ctr_shrink',
  'job_id',
  'position',
  'random_boost',
  'ranking_score',
  'relevance_score',
];

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
      ctrShrink: 0.05,
      randomBoost: 0.001,
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
      ctr_shrink: 0.05,
      random_boost: 0.001,
    }]);
  });
});
