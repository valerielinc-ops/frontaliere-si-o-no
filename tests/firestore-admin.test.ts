import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildFirestoreCaller,
  createFirestoreReadCounter,
  FIRESTORE_READ_METRIC,
  flushFirestoreReadAccounting,
  getFirestoreDb,
  instrumentFirestore,
} from '../scripts/lib/firestore-admin.mjs';

const firebaseAdminApp = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: vi.fn(() => []),
  applicationDefault: vi.fn(),
}));
const firebaseAdminFirestore = vi.hoisted(() => ({
  getFirestore: vi.fn(),
}));

vi.mock('firebase-admin/app', () => firebaseAdminApp);
vi.mock('firebase-admin/firestore', () => firebaseAdminFirestore);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function document(id: string) {
  return {
    id,
    exists: true,
    data: () => ({ id, documentSecret: 'must-never-leave-the-snapshot' }),
    ref: { id },
  };
}

function queryWith(docs: object[], documentReference?: object) {
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    doc: () => documentReference,
    get: async () => ({ docs }),
    stream: () => {
      const stream = new PassThrough({ objectMode: true });
      queueMicrotask(() => {
        docs.forEach((doc) => stream.write(doc));
        stream.end();
      });
      return stream;
    },
    count: () => ({
      get: async () => ({ data: () => ({ count: 2_500 }) }),
    }),
  };
  return query;
}

function fakeFirestore(docs: object[]) {
  const childQuery = queryWith(docs);
  const documentReference = {
    get: async () => document('top-level'),
    set: async () => {},
    collection: () => childQuery,
  };
  const query = queryWith(docs, documentReference);
  return {
    doc: () => documentReference,
    collection: () => query,
    collectionGroup: () => query,
    getAll: async (...refs: object[]) => refs.map((ref) => ({ ref, exists: true })),
    runTransaction: async (updateFunction: (transaction: {
      get: (ref: object) => Promise<object>,
      getAll: (...refs: object[]) => Promise<object[]>,
    }) => unknown) => updateFunction({
      get: async () => document('transaction'),
      getAll: async (...refs: object[]) => refs.map((ref) => ({ ref, exists: true })),
    }),
    batch: () => ({ commit: async () => [] }),
  };
}

describe('Firestore read accounting', () => {
  it('keeps main behavior without credentials and never requests a Firestore client', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', '');

    await expect(getFirestoreDb()).rejects.toThrow(
      'GOOGLE_APPLICATION_CREDENTIALS required (Firebase service account JSON).',
    );
    expect(firebaseAdminApp.initializeApp).not.toHaveBeenCalled();
    expect(firebaseAdminApp.applicationDefault).not.toHaveBeenCalled();
    expect(firebaseAdminFirestore.getFirestore).not.toHaveBeenCalled();
  });

  it('counts documents returned by get, getAll, collectionGroup and stream', async () => {
    const counter = createFirestoreReadCounter({ caller: 'test-caller' });
    const db = instrumentFirestore(fakeFirestore([document('a'), document('b'), document('c')]), counter);

    await db.collection('items').where('active', '==', true).get();
    await db.collectionGroup('items').get();
    await db.getAll({ id: 'a' }, { id: 'b' });
    const streamed: object[] = [];
    for await (const snapshot of db.collection('items').stream()) streamed.push(snapshot);

    expect(streamed).toHaveLength(3);
    expect(counter.reads).toBe(11);
  });

  it('counts a top-level document read', async () => {
    const counter = createFirestoreReadCounter({ caller: 'document' });
    const db = instrumentFirestore(fakeFirestore([]), counter);

    await db.doc('a/b').get();

    expect(counter.reads).toBe(1);
  });

  it('counts documents returned by a collection below a top-level document reference', async () => {
    const counter = createFirestoreReadCounter({ caller: 'nested-collection' });
    const db = instrumentFirestore(fakeFirestore([document('a'), document('b')]), counter);

    await db.doc('a/b').collection('c').get();

    expect(counter.reads).toBe(2);
  });

  it('does not double-wrap the same document reference across entry points', async () => {
    const counter = createFirestoreReadCounter({ caller: 'same-reference' });
    const db = instrumentFirestore(fakeFirestore([]), counter);
    const direct = db.doc('a/b');
    const throughCollection = db.collection('items').doc('a/b');

    expect(throughCollection).toBe(direct);
    await direct.get();

    expect(counter.reads).toBe(1);
  });

  it('counts transaction reads and leaves write batches uncounted', async () => {
    const counter = createFirestoreReadCounter({ caller: 'transaction' });
    const db = instrumentFirestore(fakeFirestore([]), counter);

    await db.runTransaction(async (transaction) => {
      await transaction.get({ id: 'a' });
      await transaction.getAll({ id: 'b' }, { id: 'c' });
    });
    await db.batch().commit();

    expect(counter.reads).toBe(3);
  });

  it('counts an empty query as one read', async () => {
    const counter = createFirestoreReadCounter({ caller: 'empty-query' });
    const db = instrumentFirestore(fakeFirestore([]), counter);

    await db.collection('items').where('active', '==', true).get();
    expect(counter.reads).toBe(1);
  });

  it('uses the documented aggregation billing tranche when count is observable', async () => {
    const counter = createFirestoreReadCounter({ caller: 'aggregate' });
    const db = instrumentFirestore(fakeFirestore([]), counter);

    await db.collection('items').count().get();
    expect(counter.reads).toBe(3);
  });
});

describe('Firestore read accounting output', () => {
  it('fails open with a warning when the custom metric cannot be written', async () => {
    const warnings: string[] = [];
    const result = await flushFirestoreReadAccounting({
      counter: createFirestoreReadCounter({ caller: 'metric-failure' }),
      credentials: { client_email: 'test@example.invalid', private_key: 'not-used', project_id: 'test-project' },
      getTokenImpl: async () => 'test-token',
      fetchImpl: async () => { throw new Error('network unavailable'); },
      writeSummaryImpl: () => true,
      logger: { warn: (message: string) => warnings.push(message) },
    });

    expect(result.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('warning');
  });

  it('keeps documents and secrets out of the summary and metric payload', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'firestore-read-accounting-'));
    const summaryPath = path.join(tempDir, 'summary.md');
    const counter = createFirestoreReadCounter({
      caller: buildFirestoreCaller({ GITHUB_WORKFLOW: 'test workflow', GITHUB_RUN_ID: '42' }, '/workspace/read-secret.mjs'),
    });
    counter.addReturnedDocuments({ docs: [{ data: () => ({ secret: 'document-secret' }) }] });
    let requestBody: Record<string, unknown> | undefined;

    try {
      const result = await flushFirestoreReadAccounting({
        counter,
        env: { GITHUB_STEP_SUMMARY: summaryPath },
        credentials: { client_email: 'test@example.invalid', private_key: 'not-used', project_id: 'test-project' },
        getTokenImpl: async () => 'test-token',
        fetchImpl: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return { ok: true, status: 200 };
        },
        logger: { warn: vi.fn() },
      });

      expect(result.ok).toBe(true);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).not.toContain('document-secret');
      expect(JSON.stringify(requestBody)).not.toContain('document-secret');
      expect(JSON.stringify(requestBody)).not.toContain('document');
      expect((requestBody?.timeSeries as Array<{ metric: { type: string } }>)[0].metric.type).toBe(FIRESTORE_READ_METRIC);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
