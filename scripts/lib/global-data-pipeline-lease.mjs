#!/usr/bin/env node
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
import { pathToFileURL } from 'node:url';

export const GLOBAL_DATA_PIPELINE_LEASE_DOC = 'ci_leases/jobs-data-pipeline';
export const GLOBAL_DATA_PIPELINE_LEASE_TTL_MS = 60 * 60 * 1000;
// Group jobs finish in a deliberately narrow wall-clock band. Give their
// commit phases a bounded queue so a normal convoy does not discard a whole
// crawl and wait for the next scheduled cycle. A stale/crashed owner still
// expires after the TTL; callers that outlive this wait window remain
// retryable via exit 44.
export const GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS = 5 * 60 * 1000;
export const GLOBAL_DATA_PIPELINE_LEASE_POLL_MS = 5 * 1000;
// Keep this distinct from git-commit-data.sh's 42 (push contention). A lease
// convoy is a coordination outcome, not evidence that a push lost a race.
export const GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT = 44;
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
const TRANSACTION_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function exchangeAssertionForToken(assertion) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    throw new Error('OAuth token exchange failed: ' + response.status + reason);
  }
  if (!body?.access_token) throw new Error('OAuth response missing access_token');
  return body.access_token;
}

async function firestoreRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

async function beginTransaction(baseUrl, token) {
  const body = await firestoreRequest(baseUrl + ':beginTransaction', token, {
    method: 'POST',
    body: JSON.stringify({ options: { readWrite: {} } }),
  });
  if (!body?.transaction) throw new Error('Firestore beginTransaction response missing transaction');
  return body.transaction;
}

async function readLease(baseUrl, token, transaction, leaseDoc) {
  const url = baseUrl + '/' + leaseDoc
    + '?transaction=' + encodeURIComponent(transaction);
  try {
    const document = await firestoreRequest(url, token, { method: 'GET' });
    return { exists: true, updateTime: document.updateTime, lease: leaseFromDocument(document) };
  } catch (error) {
    if (error?.status === 404) return { exists: false, updateTime: null, lease: null };
    throw error;
  }
}

function conflictError(error) {
  return error?.status === 409 || error?.body?.error?.status === 'ABORTED';
}

async function commitTransaction(baseUrl, token, transaction, write) {
  return firestoreRequest(baseUrl + ':commit', token, {
    method: 'POST',
    body: JSON.stringify({ transaction, writes: [write] }),
  });
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
}) {
  const projectId = credentials.project_id || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('service account project_id is missing');
  const baseUrl = 'https://firestore.googleapis.com/v1/projects/'
    + encodeURIComponent(projectId) + '/databases/(default)/documents';
  const token = await exchangeAssertionForToken(createJwtAssertion(credentials));
  const expiresAt = now + ttlMs;

  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt++) {
    const transaction = await beginTransaction(baseUrl, token);
    const current = await readLease(baseUrl, token, transaction, leaseDoc);
    const decision = leaseDecision(current.lease, owner, now);

    if (action === 'acquire' && decision.action === 'busy') {
      return { acquired: false, released: false, busy: true, expiresAt: decision.expiresAt };
    }
    if (action === 'release' && (!current.exists || current.lease.owner !== owner)) {
      return { acquired: false, released: false, busy: false, notOwner: current.exists };
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

    try {
      await commitTransaction(baseUrl, token, transaction, write);
      return {
        acquired: action === 'acquire',
        released: action === 'release',
        busy: false,
        expiresAt,
      };
    } catch (error) {
      if (!conflictError(error) || attempt === TRANSACTION_ATTEMPTS) throw error;
      await sleep(250 * attempt);
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
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('waitMs must be a non-negative integer');
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error('pollMs must be a positive integer');

  const transactionOptions = {
    ...options,
    action: 'acquire',
    credentials: options.credentials || credentialsFromEnvironment(),
    owner: options.owner || ownerFromEnvironment(),
    repo: options.repo || process.env.GITHUB_REPOSITORY || 'local',
    workflow: options.workflow || process.env.GITHUB_WORKFLOW || 'manual',
    runId: options.runId || process.env.GITHUB_RUN_ID || String(process.pid),
    ttlMs: options.ttlMs || positiveEnvInteger('DATA_PIPELINE_LEASE_TTL_MS', GLOBAL_DATA_PIPELINE_LEASE_TTL_MS),
  };
  const deadline = Date.now() + waitMs;
  while (true) {
    const result = await transact(transactionOptions);
    if (!result.busy) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    // Polling is enough for the normal short commit convoy. The transaction
    // still arbitrates the winner; no local sleep can create a double owner.
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function releaseLease(options = {}) {
  return transact({
    ...options,
    action: 'release',
    credentials: options.credentials || credentialsFromEnvironment(),
    owner: options.owner || ownerFromEnvironment(),
    repo: options.repo || process.env.GITHUB_REPOSITORY || 'local',
    workflow: options.workflow || process.env.GITHUB_WORKFLOW || 'manual',
    runId: options.runId || process.env.GITHUB_RUN_ID || String(process.pid),
    ttlMs: options.ttlMs || positiveEnvInteger('DATA_PIPELINE_LEASE_TTL_MS', GLOBAL_DATA_PIPELINE_LEASE_TTL_MS),
  });
}

async function main() {
  const action = process.argv[2];
  if (action !== 'acquire' && action !== 'release') {
    throw new Error('usage: global-data-pipeline-lease.mjs acquire|release');
  }
  const result = action === 'acquire' ? await acquireLease() : await releaseLease();
  if (result.busy) {
    console.error('global data pipeline lease is still busy after the bounded wait; retry on the next scheduled run');
    process.exitCode = GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT;
    return;
  }
  if (result.notOwner) {
    console.warn('global data pipeline lease was not owned by this run; left it untouched');
    return;
  }
  console.log(action === 'acquire' ? 'global data pipeline lease acquired' : 'global data pipeline lease released');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('global data pipeline lease failed: ' + (error?.message || String(error)));
    process.exitCode = 1;
  });
}
