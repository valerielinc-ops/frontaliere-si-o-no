import { describe, expect, it } from 'vitest';

import { handleEmployerInsights, generateInsightsToken } from '../functions/src/employerInsights.js';
import {
  employerInsightsAdId,
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
    };
  }

  function collection(path: string) {
    return {
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
  });

  it('removes stale shards and can restore the complete previous snapshot', async () => {
    const db = makeFakeFirestore();
    const initial = {
      companyKey: 'acme', companyName: 'Acme', generatedAt: 'old',
      totals: { views: 2, adsCount: 2 }, ads: [ad(1), ad(2)],
    };
    const replacement = {
      companyKey: 'acme', companyName: 'Acme', generatedAt: 'new',
      totals: { views: 1, adsCount: 1 }, ads: [ad(1)],
    };

    await writeEmployerInsightsDocuments(db as never, [initial]);
    const before = await readEmployerInsightsSnapshot(db as never);
    await writeEmployerInsightsDocuments(db as never, [replacement], { before });
    expect((await readEmployerInsightsSnapshot(db as never)).ads.get('acme')).toHaveLength(1);

    await restoreEmployerInsightsSnapshot(db as never, before);
    const restored = await readEmployerInsightsSnapshot(db as never);
    expect(restored.roots.get('acme')).toMatchObject({ generatedAt: 'old' });
    expect(restored.ads.get('acme')).toHaveLength(2);
  });
});

describe('employer insights API storage contract', () => {
  it('reassembles sharded ads while keeping the server timestamp private', async () => {
    const ads = [ad(2), ad(1)].map((value) => ({ id: employerInsightsAdId(value), data: () => value }));
    const adCollection = { get: async () => ({ docs: ads }) };
    const root = {
      companyKey: 'acme',
      companyName: 'Acme',
      generatedAt: '2026-09-11T00:00:00.000Z',
      adsStorage: { type: 'subcollection', collection: 'ads', count: 2 },
      updatedAt: { serverTimestamp: true },
      totals: { views: 3, applyClicks: 2, applyClickUsers: 2, adsCount: 2 },
    };
    const db = {
      collection() {
        return {
          doc() {
            return {
              async get() {
                return { exists: true, data: () => root, ref: { collection: () => adCollection } };
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
  });
});
