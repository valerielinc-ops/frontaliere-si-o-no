import { describe, expect, it } from 'vitest';

import { handleEmployerInsights, generateInsightsToken } from '../functions/src/employerInsights.js';
import {
  employerInsightsAdId,
  employerInsightsWindowAdsSubcollection,
  readEmployerInsightsSnapshot,
  restoreEmployerInsightsSnapshot,
  writeEmployerInsightsDocuments,
} from '../scripts/lib/employer-insights-firestore.mjs';

function makeFakeFirestore() {
  const values = new Map<string, Record<string, unknown>>();

  function ref(path: string) {
    const parts = path.split('/');
    return {
      id: parts.at(-1),
      path,
      collection(name: string) {
        return collection(`${path}/${name}`);
      },
      async listCollections() {
        const prefix = `${path}/`;
        const names = [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length).split('/')[0])
          .filter(Boolean);
        return [...new Set(names)].map((name) => collection(`${path}/${name}`));
      },
    };
  }

  function collection(path: string) {
    return {
      id: path.split('/').at(-1),
      doc(id: string) {
        return ref(`${path}/${id}`);
      },
      async get() {
        const prefix = `${path}/`;
        const docs = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && key.slice(prefix.length).split('/').length === 1)
          .map(([key, data]) => ({
            id: key.slice(prefix.length),
            ref: ref(key),
            data: () => data,
          }));
        return { docs };
      },
    };
  }

  return {
    collection,
    batch() {
      const operations: Array<{ type: 'set' | 'delete'; ref: ReturnType<typeof ref>; data?: Record<string, unknown> }> = [];
      const batch = {
        set(target: ReturnType<typeof ref>, data: Record<string, unknown>) {
          operations.push({ type: 'set', ref: target, data });
          return batch;
        },
        delete(target: ReturnType<typeof ref>) {
          operations.push({ type: 'delete', ref: target });
          return batch;
        },
        async commit() {
          for (const operation of operations) {
            if (operation.type === 'delete') values.delete(operation.ref.path);
            else values.set(operation.ref.path, operation.data || {});
          }
        },
      };
      return batch;
    },
    values,
  };
}

function ad(index: number) {
  return {
    jobId: `job-${index}`,
    slug: `role-${index}`,
    title: `Role ${index}`,
    path: `/role-${index}/`,
    views: index,
    visitors: 1,
    applyClicks: 1,
    applyClickUsers: 1,
    applications: null,
    trend: [],
  };
}

describe('employer insights Firestore storage', () => {
  it('keeps large ad arrays below the root document limit using stable shards', async () => {
    const db = makeFakeFirestore();
    const document = {
      companyKey: 'acme',
      companyName: 'Acme',
      generatedAt: '2026-09-11T00:00:00.000Z',
      totals: { views: 5050, adsCount: 101 },
      ads: Array.from({ length: 101 }, (_, index) => ad(index)),
    };

    const result = await writeEmployerInsightsDocuments(db as never, [document]);
    const root = db.values.get('employer_insights/acme');
    const snapshot = await readEmployerInsightsSnapshot(db as never);

    expect(result).toEqual({ documentsWritten: 1, operationsCommitted: 102 });
    expect(root).not.toHaveProperty('ads');
    expect(root).toMatchObject({
      adsStorage: { type: 'subcollection', collection: 'ads', count: 101 },
    });
    expect(snapshot.ads.get('acme')).toHaveLength(101);
    expect(employerInsightsAdId(ad(7))).toBe(employerInsightsAdId(ad(7)));
    expect(employerInsightsWindowAdsSubcollection('90d')).toBe('ads_90d');
  });

  it('shards additional-window ads instead of nesting them in the root', async () => {
    const db = makeFakeFirestore();
    const document = {
      companyKey: 'acme',
      companyName: 'Acme',
      generatedAt: '2026-09-11T00:00:00.000Z',
      totals: { views: 5050, adsCount: 1 },
      ads: [ad(1)],
      additionalWindows: {
        '90d': {
          window: { from: '2026-06-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
          totals: { views: 5050, adsCount: 101 },
          trend: [],
          ads: Array.from({ length: 101 }, (_, index) => ad(index + 100)),
        },
      },
    };

    const result = await writeEmployerInsightsDocuments(db as never, [document]);
    const root = db.values.get('employer_insights/acme');
    const snapshot = await readEmployerInsightsSnapshot(db as never);

    expect(result).toEqual({ documentsWritten: 1, operationsCommitted: 103 });
    expect(root?.additionalWindows?.['90d']).not.toHaveProperty('ads');
    expect(root?.additionalWindows?.['90d']).toMatchObject({
      adsStorage: { type: 'subcollection', collection: 'ads_90d', count: 101 },
    });
    expect(snapshot.windowAds.get('acme')?.get('ads_90d')).toHaveLength(101);
    expect(Buffer.byteLength(JSON.stringify(root))).toBeLessThan(1_048_576);
  });

  it('removes shards whose new company root was never committed', async () => {
    const db = makeFakeFirestore();
    const document = {
      companyKey: 'newco',
      ads: [ad(1)],
      additionalWindows: { '90d': { ads: [ad(2)] } },
    };
    db.values.set(`employer_insights/newco/ads/${employerInsightsAdId(ad(1))}`, ad(1));
    db.values.set(`employer_insights/newco/ads_90d/${employerInsightsAdId(ad(2))}`, ad(2));

    const before = { roots: new Map(), ads: new Map(), windowAds: new Map() };
    const result = await restoreEmployerInsightsSnapshot(db as never, before, { expectedDocuments: [document] });

    expect(result).toEqual({ attempted: 2, committed: 2 });
    expect([...db.values.keys()]).toHaveLength(0);
  });

  it('removes stale shards and can restore the complete previous snapshot', async () => {
    const db = makeFakeFirestore();
    const initial = {
      companyKey: 'acme', companyName: 'Acme', generatedAt: 'old',
      totals: { views: 2, adsCount: 2 }, ads: [ad(1), ad(2)],
      additionalWindows: { '90d': { totals: { views: 4, adsCount: 2 }, ads: [ad(1), ad(2)] } },
    };
    const replacement = {
      companyKey: 'acme', companyName: 'Acme', generatedAt: 'new',
      totals: { views: 1, adsCount: 1 }, ads: [ad(1)],
      additionalWindows: { '90d': { totals: { views: 1, adsCount: 1 }, ads: [ad(1)] } },
    };

    await writeEmployerInsightsDocuments(db as never, [initial]);
    const before = await readEmployerInsightsSnapshot(db as never);
    await writeEmployerInsightsDocuments(db as never, [replacement], { before });
    expect((await readEmployerInsightsSnapshot(db as never)).ads.get('acme')).toHaveLength(1);
    expect((await readEmployerInsightsSnapshot(db as never)).windowAds.get('acme')?.get('ads_90d')).toHaveLength(1);

    await restoreEmployerInsightsSnapshot(db as never, before);
    const restored = await readEmployerInsightsSnapshot(db as never);
    expect(restored.roots.get('acme')).toMatchObject({ generatedAt: 'old' });
    expect(restored.ads.get('acme')).toHaveLength(2);
    expect(restored.windowAds.get('acme')?.get('ads_90d')).toHaveLength(2);
  });
});

describe('employer insights API storage contract', () => {
  it('reassembles sharded ads while keeping the server timestamp private', async () => {
    const ads = [ad(2), ad(1)].map((value) => ({ id: employerInsightsAdId(value), data: () => value }));
    const adCollection = { get: async () => ({ docs: ads }) };
    const windowAds = [ad(4), ad(3)].map((value) => ({ id: employerInsightsAdId(value), data: () => value }));
    const windowAdCollection = { get: async () => ({ docs: windowAds }) };
    const root = {
      companyKey: 'acme',
      companyName: 'Acme',
      generatedAt: '2026-09-11T00:00:00.000Z',
      adsStorage: { type: 'subcollection', collection: 'ads', count: 2 },
      additionalWindows: {
        '90d': {
          window: { from: '2026-06-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
          totals: { views: 7, adsCount: 2 },
          trend: [],
          adsStorage: { type: 'subcollection', collection: 'ads_90d', count: 2 },
        },
      },
      updatedAt: { serverTimestamp: true },
      totals: { views: 3, applyClicks: 2, applyClickUsers: 2, adsCount: 2 },
    };
    const db = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: true,
                  data: () => root,
                  ref: {
                    collection: (name: string) => name === 'ads_90d' ? windowAdCollection : adCollection,
                  },
                };
              },
            };
          },
        };
      },
    };
    const token = generateInsightsToken('acme', 'test-secret');

    const result = await handleEmployerInsights({
      companyKey: 'acme', token, secret: 'test-secret', db: db as never,
    });

    expect(result).toMatchObject({ status: 200, body: { companyKey: 'acme', totals: { applyClickUsers: 2 } } });
    expect(result.body).not.toHaveProperty('updatedAt');
    expect(result.body).not.toHaveProperty('adsStorage');
    expect(result.body.ads).toEqual([ad(2), ad(1)]);
    expect(result.body.additionalWindows['90d'].ads).toEqual([ad(4), ad(3)]);
    expect(result.body.additionalWindows['90d']).not.toHaveProperty('adsStorage');
  });
});
