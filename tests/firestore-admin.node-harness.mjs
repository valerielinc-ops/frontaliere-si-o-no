import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildFirestoreCaller,
  createFirestoreReadCounter,
  FIRESTORE_READ_METRIC,
  flushFirestoreReadAccounting,
  getFirestoreDb,
  instrumentFirestore,
} from '../scripts/lib/firestore-admin.mjs';

function document(id) {
  return {
    id,
    exists: true,
    data: () => ({ id, documentSecret: 'must-never-leave-the-snapshot' }),
    ref: { id },
  };
}

function queryWith(docs, documentReference) {
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    doc: () => documentReference,
    get: async () => ({ docs }),
    stream: () => {
      const stream = new PassThrough({ objectMode: true });
      queueMicrotask(() => {
        docs.forEach((item) => stream.write(item));
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

function fakeFirestore(docs) {
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
    getAll: async (...refs) => refs.map((ref) => ({ ref, exists: true })),
    runTransaction: async (updateFunction) => updateFunction({
      get: async () => document('transaction'),
      getAll: async (...refs) => refs.map((ref) => ({ ref, exists: true })),
    }),
    batch: () => ({ commit: async () => [] }),
  };
}

async function testCredentialsContract() {
  const originalCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const originalInlineCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  try {
    await assert.rejects(
      getFirestoreDb(),
      { message: 'GOOGLE_APPLICATION_CREDENTIALS required (Firebase service account JSON).' },
    );
  } finally {
    if (originalCredentialsPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialsPath;
    if (originalInlineCredentials === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = originalInlineCredentials;
  }
}

async function testTopLevelDocument() {
  const counter = createFirestoreReadCounter({ caller: 'document' });
  const db = instrumentFirestore(fakeFirestore([]), counter);

  await db.doc('a/b').get();

  assert.equal(counter.reads, 1);
}

async function testNestedCollectionAndReferenceCache() {
  const counter = createFirestoreReadCounter({ caller: 'nested-collection' });
  const db = instrumentFirestore(fakeFirestore([document('a'), document('b')]), counter);

  await db.doc('a/b').collection('c').get();
  assert.equal(counter.reads, 2);

  const direct = db.doc('a/b');
  const throughCollection = db.collection('items').doc('a/b');
  assert.strictEqual(throughCollection, direct);
  await direct.get();
  assert.equal(counter.reads, 3);
}

async function testQueryEntryPoints() {
  const counter = createFirestoreReadCounter({ caller: 'query-entry-points' });
  const db = instrumentFirestore(fakeFirestore([document('a'), document('b'), document('c')]), counter);

  await db.collection('items').where('active', '==', true).get();
  await db.collectionGroup('items').get();
  await db.getAll({ id: 'a' }, { id: 'b' });
  const streamed = [];
  for await (const snapshot of db.collection('items').stream()) streamed.push(snapshot);
  await db.collection('items').count().get();

  assert.equal(streamed.length, 3);
  assert.equal(counter.reads, 14);
}

async function testTransactionAndBatch() {
  const counter = createFirestoreReadCounter({ caller: 'transaction' });
  const db = instrumentFirestore(fakeFirestore([]), counter);

  await db.runTransaction(async (transaction) => {
    await transaction.get({ id: 'a' });
    await transaction.getAll({ id: 'b' }, { id: 'c' });
  });
  await db.batch().commit();

  assert.equal(counter.reads, 3);
}

async function testAccountingOutput() {
  const warnings = [];
  const failure = await flushFirestoreReadAccounting({
    counter: createFirestoreReadCounter({ caller: 'metric-failure' }),
    credentials: { client_email: 'test@example.invalid', private_key: 'not-used', project_id: 'test-project' },
    getTokenImpl: async () => 'test-token',
    fetchImpl: async () => { throw new Error('network unavailable'); },
    writeSummaryImpl: () => true,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(failure.ok, false);
  assert.equal(warnings.length, 1);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'firestore-read-accounting-harness-'));
  const summaryPath = path.join(tempDir, 'summary.md');
  const counter = createFirestoreReadCounter({
    caller: buildFirestoreCaller({ GITHUB_WORKFLOW: 'test workflow', GITHUB_RUN_ID: '42' }, '/workspace/read-secret.mjs'),
  });
  counter.addReturnedDocuments({ docs: [{ data: () => ({ secret: 'document-secret' }) }] });
  let requestBody;
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
      logger: { warn: () => {} },
    });
    assert.equal(result.ok, true);
    const summary = readFileSync(summaryPath, 'utf8');
    assert.equal(summary.includes('document-secret'), false);
    assert.equal(JSON.stringify(requestBody).includes('document-secret'), false);
    assert.equal(JSON.stringify(requestBody).includes('document'), false);
    assert.equal(requestBody.timeSeries[0].metric.type, FIRESTORE_READ_METRIC);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const tests = [
  ['credentials contract', testCredentialsContract],
  ['top-level document read', testTopLevelDocument],
  ['nested collection and reference cache', testNestedCollectionAndReferenceCache],
  ['query entry points', testQueryEntryPoints],
  ['transaction and batch', testTransactionAndBatch],
  ['accounting output', testAccountingOutput],
];

let passed = 0;
let failed = 0;
for (const [name, test] of tests) {
  try {
    await test();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

console.log(`SUMMARY pass=${passed} fail=${failed} skip=0`);
if (failed > 0) process.exitCode = 1;
