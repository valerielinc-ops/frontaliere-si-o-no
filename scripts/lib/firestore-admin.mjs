// Shared firebase-admin Firestore bootstrap for the outreach/insights scripts.
//
// Every script that writes employer data (build-employer-insights,
// sync-employer-contacts-to-firestore, send-cold-emails, write-employer-traffic…)
// repeated the same cert-from-GOOGLE_APPLICATION_CREDENTIALS init. One copy here
// stops the project id / credential-shape handling from drifting between them.
// The returned handle is also the one place where script-side Firestore reads
// are counted before the job reports them to Cloud Monitoring.

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { getServiceAccountAccessToken } from './google-service-account-token.mjs';

export const FIRESTORE_READ_METRIC = 'custom.googleapis.com/firestore/reads_by_caller';
export const FIRESTORE_PROJECT_ID = 'frontaliere-ticino';
const MONITORING_API = 'https://monitoring.googleapis.com/v3';
const MONITORING_WRITE_SCOPE = 'https://www.googleapis.com/auth/monitoring.write';
const MONITORING_TIMEOUT_MS = 30_000;

/**
 * Firestore billing rule for aggregation queries:
 * one read per batch of up to 1,000 index entries, with a minimum of one read.
 * The Admin SDK does not expose the index-entry count. When an aggregation
 * result exposes `count`, use it as the observable estimate; for sum/average
 * results without count, attribute the minimum one read and leave any extra
 * index-entry charge in the monitor's unallocated quota.
 */
export const FIRESTORE_AGGREGATION_BILLING_RULE =
  'one read per up to 1000 index entries, minimum one; use result.count when available, otherwise minimum one';

function safePart(value, fallback, maxLength) {
  const sanitized = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:@/-]+/g, '_')
    .slice(0, maxLength);
  return sanitized || fallback;
}

/** Build a stable, non-sensitive caller label from the GitHub job identity. */
export function buildFirestoreCaller(env = process.env, scriptPath = process.argv[1]) {
  const workflow = safePart(env.GITHUB_WORKFLOW, 'local', 80);
  const runId = safePart(env.GITHUB_RUN_ID, 'none', 40);
  const script = safePart(path.basename(scriptPath || 'unknown-script'), 'unknown-script', 100);
  return `workflow=${workflow};run=${runId};script=${script}`;
}

function markdownSafe(value) {
  return String(value).replace(/[|\r\n]/g, '_');
}

function readCountFromSnapshot(snapshot, minimumOne = true) {
  if (Array.isArray(snapshot)) return minimumOne ? Math.max(1, snapshot.length) : snapshot.length;
  if (Array.isArray(snapshot?.docs)) return minimumOne ? Math.max(1, snapshot.docs.length) : snapshot.docs.length;
  return 1;
}

function readCountFromAggregate(snapshot) {
  const data = typeof snapshot?.data === 'function' ? snapshot.data() : null;
  const count = Number(data?.count);
  return Number.isFinite(count) && count >= 0 ? Math.max(1, Math.ceil(count / 1000)) : 1;
}

/** Mutable per-process read counter. It never stores or serializes documents. */
export class FirestoreReadCounter {
  constructor({ caller = buildFirestoreCaller() } = {}) {
    this.caller = caller;
    this.reads = 0;
  }

  addReturnedDocuments(value, { minimumOne = true } = {}) {
    this.reads += readCountFromSnapshot(value, minimumOne);
  }

  addAggregation(value) {
    this.reads += readCountFromAggregate(value);
  }
}

export function createFirestoreReadCounter(options = {}) {
  return new FirestoreReadCounter(options);
}

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

function isQueryLike(value) {
  return value && typeof value === 'object'
    && typeof value.get === 'function'
    && typeof value.where === 'function';
}

function isDocumentReferenceLike(value) {
  return value && typeof value === 'object'
    && typeof value.get === 'function'
    && typeof value.set === 'function';
}

function createFirestoreWrapperContext(counter) {
  const firestoreCache = new WeakMap();
  const queryCache = new WeakMap();
  const documentCache = new WeakMap();
  const aggregateCache = new WeakMap();
  const transactionCache = new WeakMap();
  const proxyTargets = new WeakMap();

  const unwrap = (value) => proxyTargets.get(value) || value;
  const unwrapArgs = (args) => args.map(unwrap);

  function remember(cache, target, proxy) {
    cache.set(target, proxy);
    proxyTargets.set(proxy, target);
    return proxy;
  }

  function wrapStream(stream) {
    const output = new PassThrough({ objectMode: true });
    let count = 0;
    stream.on('data', () => { count += 1; });
    stream.once('end', () => counter.addReturnedDocuments(new Array(count)));
    stream.once('error', (error) => output.destroy(error));
    stream.pipe(output);
    return output;
  }

  function wrapTransaction(target) {
    if (transactionCache.has(target)) return transactionCache.get(target);
    const proxy = new Proxy(target, {
      get(transaction, property) {
        const value = Reflect.get(transaction, property, transaction);
        if (property === 'get') {
          return (...args) => Promise.resolve(value.apply(transaction, unwrapArgs(args))).then((snapshot) => {
            counter.addReturnedDocuments(snapshot);
            return snapshot;
          });
        }
        if (property === 'getAll') {
          return (...args) => Promise.resolve(value.apply(transaction, unwrapArgs(args))).then((snapshots) => {
            counter.addReturnedDocuments(snapshots, { minimumOne: false });
            return snapshots;
          });
        }
        if (typeof value === 'function') return (...args) => value.apply(transaction, unwrapArgs(args));
        return value;
      },
    });
    return remember(transactionCache, target, proxy);
  }

  function wrapAggregate(target) {
    if (aggregateCache.has(target)) return aggregateCache.get(target);
    const proxy = new Proxy(target, {
      get(aggregate, property) {
        const value = Reflect.get(aggregate, property, aggregate);
        if (property === 'get') {
          return (...args) => Promise.resolve(value.apply(aggregate, unwrapArgs(args))).then((snapshot) => {
            counter.addAggregation(snapshot);
            return snapshot;
          });
        }
        if (typeof value === 'function') return (...args) => value.apply(aggregate, unwrapArgs(args));
        return value;
      },
    });
    return remember(aggregateCache, target, proxy);
  }

  function wrapDocument(target) {
    if (documentCache.has(target)) return documentCache.get(target);
    const proxy = new Proxy(target, {
      get(reference, property) {
        const value = Reflect.get(reference, property, reference);
        if (property === 'get') {
          return (...args) => Promise.resolve(value.apply(reference, unwrapArgs(args))).then((snapshot) => {
            // A missing document is still one billed document read.
            counter.addReturnedDocuments([snapshot]);
            return snapshot;
          });
        }
        if (property === 'collection') {
          return (...args) => wrapQuery(value.apply(reference, unwrapArgs(args)));
        }
        if (property === 'listCollections') {
          return (...args) => Promise.resolve(value.apply(reference, unwrapArgs(args)))
            .then((collections) => collections.map((collection) => wrapQuery(collection)));
        }
        if (property === 'parent') return wrapQuery(value);
        if (typeof value === 'function') return (...args) => value.apply(reference, unwrapArgs(args));
        return value;
      },
    });
    return remember(documentCache, target, proxy);
  }

  function wrapQuery(target) {
    if (queryCache.has(target)) return queryCache.get(target);
    const proxy = new Proxy(target, {
      get(query, property) {
        const value = Reflect.get(query, property, query);
        if (property === 'get') {
          return (...args) => Promise.resolve(value.apply(query, unwrapArgs(args))).then((snapshot) => {
            counter.addReturnedDocuments(snapshot);
            return snapshot;
          });
        }
        if (property === 'stream') {
          return (...args) => wrapStream(value.apply(query, unwrapArgs(args)));
        }
        if (property === 'count' || property === 'sum' || property === 'average' || property === 'aggregate') {
          return (...args) => wrapAggregate(value.apply(query, unwrapArgs(args)));
        }
        if (typeof value === 'function') {
          return (...args) => {
            const result = value.apply(query, unwrapArgs(args));
            if (property === 'doc') return wrapDocument(result);
            if (property === 'collection' || property === 'collectionGroup') return wrapQuery(result);
            if (isQueryLike(result)) return wrapQuery(result);
            if (isDocumentReferenceLike(result)) return wrapDocument(result);
            return result;
          };
        }
        if (isQueryLike(value)) return wrapQuery(value);
        if (isDocumentReferenceLike(value)) return wrapDocument(value);
        return value;
      },
    });
    return remember(queryCache, target, proxy);
  }

  function wrapFirestore(target) {
    if (firestoreCache.has(target)) return firestoreCache.get(target);
    const proxy = new Proxy(target, {
      get(firestore, property) {
        const value = Reflect.get(firestore, property, firestore);
        if (property === 'getAll') {
          return (...args) => Promise.resolve(value.apply(firestore, unwrapArgs(args))).then((snapshots) => {
            counter.addReturnedDocuments(snapshots, { minimumOne: false });
            return snapshots;
          });
        }
        if (property === 'doc') {
          return (...args) => wrapDocument(value.apply(firestore, unwrapArgs(args)));
        }
        if (property === 'collection' || property === 'collectionGroup') {
          return (...args) => wrapQuery(value.apply(firestore, unwrapArgs(args)));
        }
        if (property === 'runTransaction') {
          return (updateFunction, ...args) => value.apply(firestore, [
            (transaction) => updateFunction(wrapTransaction(transaction)),
            ...unwrapArgs(args),
          ]);
        }
        if (typeof value === 'function') return (...args) => value.apply(firestore, unwrapArgs(args));
        return value;
      },
    });
    return remember(firestoreCache, target, proxy);
  }

  return { wrapFirestore };
}

/** Wrap a Firestore handle without changing document/query payloads. */
export function instrumentFirestore(db, counter = createFirestoreReadCounter()) {
  if (!db || typeof db !== 'object') throw new TypeError('instrumentFirestore requires a Firestore handle');
  return createFirestoreWrapperContext(counter).wrapFirestore(db);
}

function readCredentials(env = process.env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      return null;
    }
  }
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeSummary(summaryPath, counter) {
  if (!summaryPath) return false;
  fs.appendFileSync(summaryPath, [
    '',
    '### Firestore read accounting',
    '',
    '| Caller | Letture attribuite |',
    '|---|---:|',
    `| ${markdownSafe(counter.caller)} | ${counter.reads} |`,
    '',
  ].join('\n'));
  return true;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240);
}

async function writeMonitoringPoint({ fetchImpl, token, projectId, counter, now }) {
  const response = await fetchImpl(`${MONITORING_API}/projects/${encodeURIComponent(projectId)}/timeSeries`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeSeries: [{
        metric: { type: FIRESTORE_READ_METRIC, labels: { caller: counter.caller } },
        resource: { type: 'global', labels: { project_id: projectId } },
        points: [{
          interval: { endTime: now.toISOString() },
          value: { int64Value: String(counter.reads) },
        }],
      }],
    }),
    signal: AbortSignal.timeout(MONITORING_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cloud Monitoring HTTP ${response.status}`);
}

/**
 * Write the local summary and the best-effort Cloud Monitoring point.
 * Metric failures are deliberately returned, logged as warnings, and never
 * propagated to the caller's job.
 */
export async function flushFirestoreReadAccounting({
  counter,
  env = process.env,
  credentials = readCredentials(env),
  fetchImpl = fetch,
  getTokenImpl = getServiceAccountAccessToken,
  now = new Date(),
  writeSummaryImpl = (summaryPath, readCounter) => writeSummary(summaryPath, readCounter),
  logger = console,
} = {}) {
  if (!counter) throw new TypeError('flushFirestoreReadAccounting requires a counter');
  try {
    writeSummaryImpl(env.GITHUB_STEP_SUMMARY, counter);
  } catch (error) {
    logger.warn(`[firestore-read-accounting] warning: summary unavailable (${safeErrorMessage(error)})`);
  }

  try {
    if (!credentials?.client_email || !credentials?.private_key) {
      throw new Error('service-account credentials unavailable');
    }
    const token = await getTokenImpl(credentials, MONITORING_WRITE_SCOPE);
    const projectId = credentials.project_id || FIRESTORE_PROJECT_ID;
    await writeMonitoringPoint({ fetchImpl, token, projectId, counter, now });
    return { ok: true, reads: counter.reads, caller: counter.caller };
  } catch (error) {
    logger.warn(`[firestore-read-accounting] warning: metric unavailable (${safeErrorMessage(error)})`);
    return { ok: false, reads: counter.reads, caller: counter.caller };
  }
}

let processCounter;
let processAccountingRegistered = false;
let processFlushPromise;
let processSummaryWritten = false;

function registerProcessAccounting(counter, env) {
  if (processAccountingRegistered) return;
  processAccountingRegistered = true;
  processCounter = counter;
  const writeSummaryOnce = (summaryPath, readCounter) => {
    if (processSummaryWritten) return false;
    processSummaryWritten = writeSummary(summaryPath, readCounter);
    return processSummaryWritten;
  };
  process.once('beforeExit', () => {
    if (processFlushPromise) return;
    processFlushPromise = flushFirestoreReadAccounting({
      counter: processCounter,
      env,
      writeSummaryImpl: writeSummaryOnce,
    }).catch((error) => {
      console.warn(`[firestore-read-accounting] warning: flush unavailable (${safeErrorMessage(error)})`);
    });
  });
  process.once('exit', () => {
    if (processSummaryWritten || !env.GITHUB_STEP_SUMMARY) return;
    try {
      writeSummaryOnce(env.GITHUB_STEP_SUMMARY, processCounter);
    } catch (error) {
      console.warn(`[firestore-read-accounting] warning: summary unavailable (${safeErrorMessage(error)})`);
    }
  });
}

let activeCounter;
let activeFirestoreDb;

function getActiveCounter(env = process.env) {
  if (!activeCounter) {
    activeCounter = createFirestoreReadCounter({ caller: buildFirestoreCaller(env) });
    registerProcessAccounting(activeCounter, env);
  }
  return activeCounter;
}

/**
 * Initialise (once) and return the instrumented Admin Firestore handle.
 * Credentials come from FIREBASE_SERVICE_ACCOUNT_JSON or the
 * GOOGLE_APPLICATION_CREDENTIALS service-account JSON; an explicit
 * `project_id` uses a cert credential, otherwise we fall back to
 * application-default with the canonical project id.
 *
 * @param {string} [projectId='frontaliere-ticino'] fallback project id
 * @returns {Promise<import('firebase-admin/firestore').Firestore>}
 */
export async function getFirestoreDb(projectId = FIRESTORE_PROJECT_ID) {
  const hasInlineCredentials = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!hasInlineCredentials && (!credPath || !fs.existsSync(credPath))) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS required (Firebase service account JSON).');
  }
  if (activeFirestoreDb) return activeFirestoreDb;
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    let cred = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
      }
    } else if (credPath) {
      if (!fs.existsSync(credPath)) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS points to a missing file');
      }
      cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }
    if (cred?.project_id) initializeApp({ credential: cert(cred) });
    else initializeApp({ credential: applicationDefault(), projectId });
  }
  activeFirestoreDb = instrumentFirestore(getFirestore(), getActiveCounter());
  return activeFirestoreDb;
}
