#!/usr/bin/env node
import { isInvokedDirectly } from './is-invoked-directly.mjs';
/**
 * Cross-repository Firestore lease helper for the canonical jobs-data writer
 * and other explicitly scoped cross-repository critical sections.
 *
 * GitHub Actions concurrency groups are repository-local. The crawler groups
 * run in the site repository while translation runs are dispatched from the
 * corpus repository, so they need one shared serialization point. Firestore
 * already backs the project configuration and is reachable from both runners;
 * this helper uses its REST transaction API and only Node built-ins.
 *
 * The default document is deliberately acquired around the commit/push
 * helper, not around crawling or translation. Callers that need a separate
 * critical section may pass `leaseDoc`; each document is still arbitrated by
 * the same Firestore transaction protocol. A crashed runner leaves an expiry
 * that the next owner can take over. A release deletes only a document still
 * owned by the releasing run.
 */
import fs from 'node:fs';
import { createSign } from 'node:crypto';
import { isTransientFetchError } from './transient-fetch.mjs';

export const GLOBAL_DATA_PIPELINE_LEASE_DOC = 'ci_leases/jobs-data-pipeline';
export const GLOBAL_DATA_PIPELINE_LEASE_TTL_MS = 60 * 60 * 1000;
// Group jobs finish in a deliberately narrow wall-clock band. Give their
// commit phases a bounded queue so a normal convoy does not discard a whole
// crawl and wait for the next scheduled cycle. A stale/crashed owner still
// expires after the TTL; callers that outlive this wait window remain
// retryable via exit 44.
//
// That intent is right and unchanged. The 5-minute value DEFEATED it, and the
// sentence above was an assertion the data disproves: a normal convoy was
// discarding whole crawls, every wave, for 124 hours.
//
// Measured 2026-09-18 (corpus issue #1573):
//   · one group-batch hold, with no push contention at all: 2m23s
//     (group 03 run 35350742718 — 13:47:24Z acquire → 13:49:47Z pushed)
//   · 23 groups reach their commit inside a ~48-minute band
//     (13:57Z–14:45Z in the last healthy wave)
//   · serialized demand therefore ≈ 23 × 2.4 min ≈ 55 min per wave, BEFORE any
//     push-retry backoff
//
// Against 55 minutes of demand, a 5-minute wait admits only the first two to
// four arrivals; everyone else exits 44 and throws away a finished crawl. That
// is exactly what was observed: 23 of 23 groups delivering daily through
// 2026-09-13, then 2, 0, 4, 6, 2 per day — one group discarded 27 successful
// crawlers out of 27 (run 35351794322).
//
// The wait now equals the TTL, and that bound is not arbitrary: the ONLY case
// in which giving up is correct is a dead owner, and a dead owner becomes
// takeable exactly at `expiresAt`, where `leaseDecision` already returns
// `{action: 'acquire', reason: 'expired'}`. So a waiter never abandons before
// the lease is provably takeable, and 60 minutes absorbs the 55 of a full
// 23-deep convoy.
//
// Safe against the job budget, which is the failure mode to avoid — waiting an
// hour and then being killed is worse than discarding early, because it burns
// the crawl without delivering it. Groups reach their commit phase 11–22
// minutes into a 340-minute job budget (measured on groups 03, 04, 13), so the
// worst case lands at ~82 minutes and leaves ~258 minutes of headroom.
//
// NOT sufficient on its own, and the remaining half is deliberately not in this
// change: the hold spans the whole 14-attempt push-retry loop in
// git-commit-data.sh, whose backoff alone sleeps ~10 minutes while holding the
// global mutex. Three contended holders push demand past 60 minutes and the
// starvation returns. Releasing the lease around that backoff is the causal
// fix; it rewrites the lease boundary inside the shared push path and belongs
// in its own change. Tracked in corpus issue #1573.
export const GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS = GLOBAL_DATA_PIPELINE_LEASE_TTL_MS;
// Keep a 15s simple-GET poll. The old 5s value multiplied with a full
// transaction per poll; after this fix a waiter spends that budget on cheap
// reads and only a candidate (absent/expired/same-owner) opens a transaction.
// The cost is granularity: a freed lease is noticed up to 15s late instead of
// 5s. Stable ±20% jitter prevents the writers from waking in one herd while
// keeping the request rate bounded.
export const GLOBAL_DATA_PIPELINE_LEASE_POLL_MS = 15 * 1000;

/**
 * Attesa usata quando si RIPRENDE il lease dopo il backoff del push-retry.
 *
 * Il writer ha gia' il suo turno nel convoglio e lo restituisce solo per la
 * durata del sonno: rimetterlo in coda per un'ora intera significherebbe
 * scambiare la congestione con una latenza peggiore. Ma non puo' nemmeno essere
 * zero, o basterebbe un altro writer nell'istante sbagliato per fargli perdere
 * il turno appena ceduto.
 *
 * Il valore e' legato al backoff che copre: `delay = attempt*5 + RANDOM%20`
 * arriva a ~85 s all'ultimo tentativo, quindi 3 minuti coprono il sonno piu'
 * lungo piu' il tempo di un hold tipico misurato (2m23s) davanti a se'.
 */
export const GLOBAL_DATA_PIPELINE_LEASE_RESUME_WAIT_MS = 3 * 60 * 1000;
// Keep this distinct from git-commit-data.sh's 42 (push contention). A lease
// convoy is a coordination outcome, not evidence that a push lost a race.
export const GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT = 44;
// A bounded series of Firestore transport failures is different from a lease
// convoy: retrying the same job cannot make progress when the coordination
// service cannot be read. Keep this distinct so the workflow reports a real
// error instead of retrying the same generation indefinitely.
export const GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_EXIT = 45;
export const GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT = 3;
export const GLOBAL_DATA_PIPELINE_LEASE_POLL_JITTER_RATIO = 0.2;
export const GLOBAL_DATA_PIPELINE_LEASE_RELEASE_WAIT_MS = 60 * 1000;
export const GLOBAL_DATA_PIPELINE_LEASE_RELEASE_POLL_MS = 2 * 1000;
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

/**
 * Firestore transaction writes use a resource name, not the REST endpoint URL.
 * Keep this separate from the request URL because the two forms are both used
 * by the REST API and are not interchangeable.
 */
export function firestoreDocumentName(projectId, leaseDoc = GLOBAL_DATA_PIPELINE_LEASE_DOC) {
  return `projects/${projectId}/databases/(default)/documents/${leaseDoc}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const ROLLBACK_TIMEOUT_MS = 2_000;
const TRANSACTION_ATTEMPTS = 4;
const RELEASE_TRANSACTION_ATTEMPTS = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deterministicJitterSample(owner, pollNumber) {
  let hash = 2166136261;
  for (const character of `${owner}:${pollNumber}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/**
 * Keep each writer's poll phase stable but different. Tests may inject a
 * sample in [0, 1] so the sleep remains deterministic without fake timers.
 */
export function leasePollDelayMs(
  pollMs,
  { owner = '', pollNumber = 0, jitter } = {},
) {
  const sample = typeof jitter === 'function'
    ? jitter({ owner, pollNumber })
    : deterministicJitterSample(owner, pollNumber);
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  const factor = 1 + ((normalized * 2) - 1) * GLOBAL_DATA_PIPELINE_LEASE_POLL_JITTER_RATIO;
  return Math.max(1, Math.round(pollMs * factor));
}

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Dependency-free service-account JWT assertion.
 * @param {{client_email: string, private_key: string}} credentials
 * @param {string} scope
 */
export function createJwtAssertion(credentials, scope = FIRESTORE_SCOPE) {
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('service account credentials missing client_email/private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    encodeBase64Url({ alg: 'RS256', typ: 'JWT' }),
    encodeBase64Url({
      iss: credentials.client_email,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  ].join('.');
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return unsigned + '.' + signer.sign(credentials.private_key, 'base64url');
}

/**
 * Decide the only safe local action from a Firestore lease snapshot.
 * A present lease with a malformed or missing expiry is treated as busy: an
 * unknown expiry must never grant takeover permission to a competing writer.
 * Recovery is explicit through the owner's release path (or operator cleanup);
 * ownership is still checked before a release can delete anything.
 */
export function leaseDecision(current, owner, now = Date.now()) {
  if (!current || typeof current !== 'object') {
    return { action: 'acquire', reason: 'absent' };
  }
  const expiresAt = Date.parse(String(current.expiresAt || ''));
  if (!Number.isFinite(expiresAt)) {
    return { action: 'busy', reason: 'malformed_expiry', expiresAt: null };
  }
  if (expiresAt <= now) {
    return { action: 'acquire', reason: 'expired', expiresAt };
  }
  if (String(current.owner || '') === String(owner || '')) {
    return { action: 'renew', reason: 'same_owner', expiresAt };
  }
  return { action: 'busy', reason: 'active_owner', expiresAt };
}

function fieldText(field) {
  if (!field || typeof field !== 'object') return '';
  if (typeof field.stringValue === 'string') return field.stringValue;
  if (typeof field.timestampValue === 'string') return field.timestampValue;
  if (field.integerValue !== undefined) return String(field.integerValue);
  return '';
}

function leaseFromDocument(document) {
  const fields = document?.fields || {};
  return {
    owner: fieldText(fields.owner),
    repo: fieldText(fields.repo),
    workflow: fieldText(fields.workflow),
    runId: fieldText(fields.runId),
    acquiredAt: fieldText(fields.acquiredAt),
    heartbeatAt: fieldText(fields.heartbeatAt),
    expiresAt: fieldText(fields.expiresAt),
  };
}

function stringField(value) {
  return { stringValue: String(value) };
}

function timestampField(value) {
  return { timestampValue: new Date(value).toISOString() };
}

function documentFields({ owner, repo, workflow, runId, now, expiresAt }) {
  return {
    owner: stringField(owner),
    repo: stringField(repo),
    workflow: stringField(workflow),
    runId: stringField(runId),
    acquiredAt: timestampField(now),
    heartbeatAt: timestampField(now),
    expiresAt: timestampField(expiresAt),
  };
}

function credentialsFromEnvironment() {
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error('cannot read GOOGLE_APPLICATION_CREDENTIALS: ' + (error?.message || String(error)));
    }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + (error?.message || String(error)));
    }
  }
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
}

function ownerFromEnvironment() {
  return process.env.DATA_PIPELINE_LEASE_OWNER
    || [
      process.env.GITHUB_REPOSITORY || 'local',
      process.env.GITHUB_WORKFLOW || 'manual',
      process.env.GITHUB_RUN_ID || String(process.pid),
      process.env.GITHUB_RUN_ATTEMPT || '0',
    ].join(':');
}

function positiveEnvInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(name + ' must be a positive integer');
  }
  return value;
}

function nonNegativeEnvInteger(name, fallback) {
  const value = Number(process.env[name] === undefined || process.env[name] === ''
    ? fallback
    : process.env[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + ' must be a non-negative integer');
  }
  return value;
}

function failedPreconditionError(error) {
  const status = Number(
    error?.status
      ?? error?.statusCode
      ?? error?.response?.status
      ?? error?.body?.error?.code,
  );
  return status === 400
    && String(error?.body?.error?.status || '').toUpperCase() === 'FAILED_PRECONDITION';
}

/**
 * Firestore is a coordination aid, not the data source. A transient REST or
 * network failure while acquiring the lease gets a small consecutive retry
 * budget, then becomes an explicit coordination-service failure instead of
 * consuming the whole crawl window. Permanent credential/configuration
 * failures remain fatal and are deliberately not included here.
 */
export function isRetryableLeaseError(error) {
  if (!error || typeof error !== 'object') return false;
  if (isTransientFetchError(error)) return true;

  const status = Number(
    error.status
      ?? error.statusCode
      ?? error.response?.status
      ?? error.body?.error?.code,
  );
  // 409 is a Firestore transaction conflict. It is deliberately lease-local:
  // a generic HTTP 409 is not necessarily safe to retry as a fetch.
  if (status === 409) return true;

  const apiStatus = String(error.body?.error?.status || '').toUpperCase();
  if (apiStatus === 'ABORTED' || apiStatus === 'DEADLINE_EXCEEDED' || apiStatus === 'UNAVAILABLE') {
    return true;
  }
  if (failedPreconditionError(error)) return true;

  return false;
}

async function exchangeAssertionForToken(assertion, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(requestTimeoutMs)))),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const reason = typeof body?.error === 'string' ? ' (' + body.error + ')' : '';
    const error = new Error('OAuth token exchange failed: ' + response.status + reason);
    error.status = response.status;
    throw error;
  }
  if (!body?.access_token) throw new Error('OAuth response missing access_token');
  return body.access_token;
}

async function firestoreRequest(url, token, options = {}, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(requestTimeoutMs)));
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error('Firestore REST request failed: ' + response.status);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function deadlineTimeoutError() {
  const error = new Error('Firestore lease request budget exhausted');
  error.name = 'TimeoutError';
  return error;
}

function requestTimeoutFor(deadlineAt, reserveMs = 0) {
  if (deadlineAt === undefined || deadlineAt === null) return REQUEST_TIMEOUT_MS;
  const totalRemaining = deadlineAt - Date.now();
  const reserve = Math.min(reserveMs, Math.max(1, Math.floor(totalRemaining / 2)));
  const remaining = totalRemaining - reserve;
  if (remaining <= 0) throw deadlineTimeoutError();
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function beginTransaction(baseUrl, token, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const body = await firestoreRequest(baseUrl + ':beginTransaction', token, {
    method: 'POST',
    body: JSON.stringify({ options: { readWrite: {} } }),
  }, requestTimeoutMs);
  if (!body?.transaction) throw new Error('Firestore beginTransaction response missing transaction');
  return body.transaction;
}

async function readLease(baseUrl, token, transaction, leaseDoc, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const url = baseUrl + '/' + leaseDoc
    + '?transaction=' + encodeURIComponent(transaction);
  try {
    const document = await firestoreRequest(url, token, { method: 'GET' }, requestTimeoutMs);
    return { exists: true, updateTime: document.updateTime, lease: leaseFromDocument(document) };
  } catch (error) {
    if (error?.status === 404) return { exists: false, updateTime: null, lease: null };
    throw error;
  }
}

async function readLeaseSnapshot(baseUrl, token, leaseDoc, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const document = await firestoreRequest(baseUrl + '/' + leaseDoc, token, { method: 'GET' }, requestTimeoutMs);
    return { exists: true, updateTime: document.updateTime, lease: leaseFromDocument(document) };
  } catch (error) {
    if (error?.status === 404) return { exists: false, updateTime: null, lease: null };
    throw error;
  }
}

function conflictError(error) {
  return error?.status === 409
    || error?.body?.error?.status === 'ABORTED'
    || failedPreconditionError(error);
}

async function commitTransaction(baseUrl, token, transaction, write, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  return firestoreRequest(baseUrl + ':commit', token, {
    method: 'POST',
    body: JSON.stringify({ transaction, writes: [write] }),
  }, requestTimeoutMs);
}

async function createFirestoreContext(credentials, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  const projectId = credentials.project_id || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('service account project_id is missing');
  const baseUrl = 'https://firestore.googleapis.com/v1/projects/'
    + encodeURIComponent(projectId) + '/databases/(default)/documents';
  const token = await exchangeAssertionForToken(createJwtAssertion(credentials), requestTimeoutMs);
  return { projectId, baseUrl, token };
}

async function rollbackTransaction(baseUrl, token, transaction, deadlineAt) {
  const remaining = deadlineAt == null ? ROLLBACK_TIMEOUT_MS : Math.max(1, deadlineAt - Date.now());
  try {
    await firestoreRequest(baseUrl + ':rollback', token, {
      method: 'POST',
      body: JSON.stringify({ transaction }),
    }, Math.min(ROLLBACK_TIMEOUT_MS, remaining));
  } catch (error) {
    console.warn(
      'global data pipeline lease rollback failed; Firestore may retain the transaction lock: '
        + (error?.message || String(error)),
    );
  }
}

function attachLeaseHolder(error, holder) {
  if (holder && error && typeof error === 'object' && !error.leaseHolder) {
    error.leaseHolder = holder;
  }
  return error;
}

async function transact({
  action,
  credentials,
  owner,
  repo,
  workflow,
  runId,
  now = Date.now(),
  ttlMs,
  leaseDoc = GLOBAL_DATA_PIPELINE_LEASE_DOC,
  transactionAttempts = TRANSACTION_ATTEMPTS,
  deadlineAt,
  sleepFn = sleep,
  firestoreContext = null,
}) {
  const context = firestoreContext || await createFirestoreContext(
    credentials,
    requestTimeoutFor(deadlineAt),
  );
  const { projectId, baseUrl, token } = context;
  const expiresAt = now + ttlMs;

  for (let attempt = 1; attempt <= transactionAttempts; attempt++) {
    let transaction;
    let transactionClosed = false;
    let holder;
    const rollback = async () => {
      if (!transaction || transactionClosed) return;
      transactionClosed = true;
      await rollbackTransaction(baseUrl, token, transaction, deadlineAt);
    };

    try {
      transaction = await beginTransaction(baseUrl, token, requestTimeoutFor(deadlineAt));
      const current = await readLease(
        baseUrl,
        token,
        transaction,
        leaseDoc,
        requestTimeoutFor(deadlineAt, ROLLBACK_TIMEOUT_MS),
      );
      holder = current.lease;
      const decision = leaseDecision(current.lease, owner, now);

      if (action === 'acquire' && decision.action === 'busy') {
        await rollback();
        return {
          acquired: false,
          released: false,
          busy: true,
          reason: decision.reason,
          expiresAt: decision.expiresAt,
          holder: current.lease,
        };
      }
      if (action === 'release' && !current.exists) {
        await rollback();
        return {
          acquired: false,
          released: true,
          busy: false,
          notOwner: false,
          alreadyReleased: true,
          contended: false,
        };
      }
      if (action === 'release' && current.lease.owner !== owner) {
        await rollback();
        return {
          acquired: false,
          released: false,
          busy: false,
          notOwner: current.exists,
          contended: current.exists && current.lease.owner !== owner,
          holder: current.lease || undefined,
        };
      }

      const documentName = firestoreDocumentName(projectId, leaseDoc);
      const precondition = current.exists
        ? { currentDocument: { updateTime: current.updateTime } }
        : { currentDocument: { exists: false } };
      const write = action === 'release'
        ? { delete: documentName, ...precondition }
        : {
            update: {
              name: documentName,
              fields: documentFields({ owner, repo, workflow, runId, now, expiresAt }),
            },
            ...precondition,
          };

      await commitTransaction(
        baseUrl,
        token,
        transaction,
        write,
        requestTimeoutFor(deadlineAt, ROLLBACK_TIMEOUT_MS),
      );
      transactionClosed = true;
      return {
        acquired: action === 'acquire',
        released: action === 'release',
        busy: false,
        expiresAt,
      };
    } catch (error) {
      await rollback();
      if (!conflictError(error) || attempt === transactionAttempts) {
        throw attachLeaseHolder(error, holder);
      }
      const remaining = deadlineAt == null ? Infinity : deadlineAt - Date.now();
      if (remaining <= 0) throw attachLeaseHolder(error, holder);
      await sleepFn(Math.min(250 * attempt, remaining));
    }
  }
  throw new Error('Firestore lease transaction exhausted');
}

export async function acquireLease(options = {}) {
  const waitMs = options.waitMs === undefined
    ? nonNegativeEnvInteger('DATA_PIPELINE_LEASE_WAIT_MS', GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS)
    : options.waitMs;
  const pollMs = options.pollMs === undefined
    ? positiveEnvInteger('DATA_PIPELINE_LEASE_POLL_MS', GLOBAL_DATA_PIPELINE_LEASE_POLL_MS)
    : options.pollMs;
  const transientErrorLimit = options.transientErrorLimit === undefined
    ? positiveEnvInteger(
        'DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT',
        GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT,
      )
    : options.transientErrorLimit;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('waitMs must be a non-negative integer');
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error('pollMs must be a positive integer');
  if (!Number.isSafeInteger(transientErrorLimit) || transientErrorLimit <= 0) {
    throw new Error('transientErrorLimit must be a positive integer');
  }

  const owner = options.owner || ownerFromEnvironment();
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;
  const jitter = options.jitterFn || options.jitter;

  const transactionOptions = {
    ...options,
    action: 'acquire',
    credentials: options.credentials || credentialsFromEnvironment(),
    owner,
    repo: options.repo || process.env.GITHUB_REPOSITORY || 'local',
    workflow: options.workflow || process.env.GITHUB_WORKFLOW || 'manual',
    runId: options.runId || process.env.GITHUB_RUN_ID || String(process.pid),
    ttlMs: options.ttlMs || positiveEnvInteger('DATA_PIPELINE_LEASE_TTL_MS', GLOBAL_DATA_PIPELINE_LEASE_TTL_MS),
    leaseDoc: options.leaseDoc ?? GLOBAL_DATA_PIPELINE_LEASE_DOC,
    sleepFn,
  };
  const deadline = Date.now() + waitMs;
  // waitMs=0 still permits one immediate snapshot/transaction attempt. A
  // positive wait gets a bounded request budget for each operation.
  const requestDeadline = waitMs === 0 ? undefined : deadline;
  let transientErrorCount = 0;
  let lastHolder;
  let pollNumber = 0;
  while (true) {
    let result;
    try {
      // A normal waiter must not repeatedly acquire a pessimistic Firestore
      // read lock. The simple snapshot is lock-free; only a snapshot that
      // could be acquired is rechecked inside a transaction, where a race is
      // resolved atomically before the write.
      const context = await createFirestoreContext(
        transactionOptions.credentials,
        requestTimeoutFor(requestDeadline),
      );
      const snapshot = await readLeaseSnapshot(
        context.baseUrl,
        context.token,
        transactionOptions.leaseDoc,
        requestTimeoutFor(requestDeadline),
      );
      const decision = leaseDecision(
        snapshot.lease,
        transactionOptions.owner,
        transactionOptions.now === undefined ? Date.now() : transactionOptions.now,
      );
      if (decision.action === 'busy') {
        result = {
          acquired: false,
          released: false,
          busy: true,
          reason: decision.reason,
          expiresAt: decision.expiresAt,
          holder: snapshot.lease,
        };
      } else {
        result = await transact({
          ...transactionOptions,
          deadlineAt: requestDeadline,
          firestoreContext: context,
        });
      }
    } catch (error) {
      if (!isRetryableLeaseError(error)) throw error;
      transientErrorCount += 1;
      if (error?.leaseHolder) lastHolder = error.leaseHolder;
      const remaining = deadline - Date.now();
      if (transientErrorCount >= transientErrorLimit || remaining <= 0) {
        return {
          acquired: false,
          released: false,
          busy: true,
          transientError: true,
          reason: 'transient_error',
          error: error?.message || String(error),
          expiresAt: null,
          transientErrorCount,
          lastHolder,
        };
      }
      const delay = Math.min(
        leasePollDelayMs(pollMs, { owner, pollNumber: pollNumber++, jitter }),
        remaining,
      );
      console.warn(
        'global data pipeline lease encountered a transient Firestore error; '
          + `retry ${transientErrorCount}/${transientErrorLimit} in ${delay}ms: ${error?.message || String(error)}`,
      );
      await sleepFn(delay);
      continue;
    }
    transientErrorCount = 0;
    if (result?.holder) lastHolder = result.holder;
    if (!result.busy) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    // Polling is a simple GET; only an acquire/renew decision enters the
    // transaction, where the updateTime precondition arbitrates the winner.
    const delay = Math.min(
      leasePollDelayMs(pollMs, { owner, pollNumber: pollNumber++, jitter }),
      remaining,
    );
    await sleepFn(delay);
  }
}

/**
 * One-line operator diagnosis of a busy acquire result: who holds the lease,
 * until when, or that Firestore failed and no holder was read at all.
 */
export function describeLeaseBusy(result, now = Date.now()) {
  if (result?.transientError) {
    const holder = result.lastHolder || result.holder || {};
    const expiresAt = Date.parse(holder.expiresAt || '');
    const expired = Number.isFinite(expiresAt) ? (expiresAt <= now ? 'yes' : 'no') : 'unknown';
    return `reason=transient_error: ${result.transientErrorCount || 0} transient Firestore error(s); `
      + `last holder owner=${holder.owner || 'unknown'}, expiresAt=${holder.expiresAt || 'unknown'}, expired=${expired}; `
      + `last error=${result.error || 'unknown error'}; this is not a lease conflict`;
  }
  const holder = result?.holder || {};
  const parts = [
    `reason=${result?.reason || 'unknown'}`,
    `owner=${holder.owner || 'unknown'}`,
    `workflow=${holder.workflow || 'unknown'}`,
    `runId=${holder.runId || 'unknown'}`,
  ];
  if (/^[\w.-]+\/[\w.-]+$/u.test(holder.repo || '') && /^\d+$/u.test(holder.runId || '')) {
    parts.push(`run=https://github.com/${holder.repo}/actions/runs/${holder.runId}`);
  }
  if (holder.acquiredAt) parts.push(`acquiredAt=${holder.acquiredAt}`);
  const expiresAt = Date.parse(holder.expiresAt || '');
  if (!Number.isFinite(expiresAt)) {
    parts.push(`expiresAt=${JSON.stringify(holder.expiresAt ?? null)} (malformed: the lease never expires on its own; only the owner release or an operator delete clears it)`);
  } else {
    parts.push(`expiresAt=${holder.expiresAt} (${Math.max(0, Math.ceil((expiresAt - now) / 60_000))} min left)`);
  }
  return parts.join(', ');
}

export function describeLeaseRelease(result, now = Date.now()) {
  const holder = result?.holder || result?.lastHolder || {};
  const expiresAt = Date.parse(holder.expiresAt || '');
  const expired = Number.isFinite(expiresAt) ? (expiresAt <= now ? 'yes' : 'no') : 'unknown';
  const contended = result?.contended === true ? 'yes' : result?.contended === false ? 'no' : 'unknown';
  return `lease release failed or was skipped: contended=${contended}, `
    + `owner=${holder.owner || 'unknown'}, expiresAt=${holder.expiresAt || 'unknown'}, expired=${expired}, `
    + `attempts=${result?.attempts || 0}, error=${result?.error || 'none'}`;
}

export async function releaseLease(options = {}) {
  const waitMs = options.waitMs ?? options.releaseWaitMs ?? GLOBAL_DATA_PIPELINE_LEASE_RELEASE_WAIT_MS;
  const pollMs = options.pollMs ?? options.releasePollMs ?? GLOBAL_DATA_PIPELINE_LEASE_RELEASE_POLL_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('release waitMs must be a non-negative integer');
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error('release pollMs must be a positive integer');

  const owner = options.owner || ownerFromEnvironment();
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;
  const jitter = options.jitterFn || options.jitter;
  const credentials = options.credentials || credentialsFromEnvironment();
  // waitMs=0 still permits one immediate release attempt; it means “no
  // retry”, not “skip the GET”. The normal path remains capped at 60 seconds.
  const deadline = waitMs === 0
    ? undefined
    : Date.now() + Math.min(waitMs, GLOBAL_DATA_PIPELINE_LEASE_RELEASE_WAIT_MS);
  let attempts = 0;
  let lastHolder;
  let lastError;
  let contended;
  let pollNumber = 0;

  while (true) {
    attempts += 1;
    try {
      const result = await transact({
        ...options,
        action: 'release',
        credentials,
        owner,
        repo: options.repo || process.env.GITHUB_REPOSITORY || 'local',
        workflow: options.workflow || process.env.GITHUB_WORKFLOW || 'manual',
        runId: options.runId || process.env.GITHUB_RUN_ID || String(process.pid),
        ttlMs: options.ttlMs || positiveEnvInteger('DATA_PIPELINE_LEASE_TTL_MS', GLOBAL_DATA_PIPELINE_LEASE_TTL_MS),
        transactionAttempts: RELEASE_TRANSACTION_ATTEMPTS,
        deadlineAt: deadline,
        sleepFn,
      });
      if (result.holder) lastHolder = result.holder;
      if (result.contended !== undefined) contended = result.contended;
      if (result.notOwner || result.released) return { ...result, attempts, ...(contended === undefined ? {} : { contended }) };
    } catch (error) {
      lastError = error;
      if (error?.leaseHolder) lastHolder = error.leaseHolder;
      if (conflictError(error)) contended = true;
      if (!isRetryableLeaseError(error)) break;
    }

    const remaining = deadline == null ? 0 : deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(
      leasePollDelayMs(pollMs, { owner, pollNumber: pollNumber++, jitter }),
      remaining,
    );
    await sleepFn(delay);
  }

  return {
    acquired: false,
    released: false,
    busy: false,
    releaseFailed: true,
    transientError: Boolean(lastError && isRetryableLeaseError(lastError)),
    attempts,
    contended,
    holder: lastHolder,
    lastHolder,
    error: lastError?.message || String(lastError || 'release budget exhausted'),
  };
}

async function main() {
  const action = process.argv[2];
  if (action !== 'acquire' && action !== 'release') {
    throw new Error('usage: global-data-pipeline-lease.mjs acquire|release [--resume-wait]');
  }
  // `--resume-wait`: il writer sta RIPRENDENDO il lease dopo il sonno del
  // backoff, non entrando in coda da zero. Aveva gia' il suo turno e lo ha
  // ceduto solo per la durata del sonno, quindi rimetterlo in coda per l'ora
  // intera scambierebbe la congestione con una latenza peggiore.
  const resumeWait = process.argv.includes('--resume-wait');
  if (resumeWait && action !== 'acquire') {
    throw new Error('--resume-wait applies only to acquire');
  }
  const result = action === 'acquire'
    ? await acquireLease(resumeWait ? { waitMs: GLOBAL_DATA_PIPELINE_LEASE_RESUME_WAIT_MS } : {})
    : await releaseLease();
  if (result.releaseFailed) {
    console.error(`global data pipeline lease release failed (${describeLeaseRelease(result)})`);
    process.exitCode = 1;
    return;
  }
  if (result.transientError) {
    console.error(`global data pipeline lease stopped after transient Firestore errors (${describeLeaseBusy(result)})`);
    process.exitCode = GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_EXIT;
    return;
  }
  if (result.busy) {
    console.error(`global data pipeline lease is still busy after the bounded wait; retry on the next scheduled run (${describeLeaseBusy(result)})`);
    process.exitCode = GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT;
    return;
  }
  if (result.notOwner) {
    console.warn(`global data pipeline lease was not owned by this run; left it untouched (${describeLeaseRelease(result)})`);
    return;
  }
  console.log(action === 'acquire' ? 'global data pipeline lease acquired' : 'global data pipeline lease released');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error('global data pipeline lease failed: ' + (error?.message || String(error)));
    process.exitCode = 1;
  });
}
