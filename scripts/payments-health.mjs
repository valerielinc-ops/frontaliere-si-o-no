import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { withSingleFlightLockAsync } from './lib/single-flight-lock.mjs';
import { fetchRemoteConfigTemplate } from './load-rc-env.mjs';
import { readPaymentRecords, reconcilePayments, writePaymentsHealth } from './lib/payments-health-data.mjs';

const MINUTE_MS = 60_000;
const WINDOW_MS = 48 * 60 * MINUTE_MS;
const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const SUMUP_ORIGIN = 'https://api.sumup.com';
const REFUND_STATES = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'];
const DISPUTE_STATES = [
  'warning_needs_response', 'warning_under_review', 'warning_closed',
  'needs_response', 'under_review', 'appeal_needs_response', 'appeal_under_review',
  'won', 'lost', 'prevented',
];
const SUMUP_STATES = ['OPEN', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'];
const SUMUP_TYPES = ['REFUND', 'CHARGE_BACK'];

class CollectorError extends Error {
  constructor(source, code) {
    super(`${source}: ${code}`);
    this.code = `${source}.${code}`;
  }
}

function fail(source, code) {
  throw new CollectorError(source, code);
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
}

function reference(value, max = 200) {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_~-]+$/u.test(value)
    ? value : null;
}

function windowStart(source, secret, nowMs, fetchImpl) {
  if (typeof secret !== 'string' || !secret.trim() || typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(nowMs) || nowMs < WINDOW_MS || nowMs > 8.64e15) {
    fail(source, 'invalid_scope');
  }
  return nowMs - WINDOW_MS;
}

async function requestJson(source, fetchImpl, url, secret, options = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new CollectorError(source, 'timeout'));
      controller.abort();
    }, TIMEOUT_MS);
  });
  const request = async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      fail(source, 'request_failed');
    }
    if (!response?.ok || response.redirected) fail(source, 'http_error');
    try {
      const body = await response.json();
      if (body && typeof body === 'object' && (Array.isArray(body) === (source === 'firestore.query'))) return body;
    } catch {
      // Provider error bodies and parse exceptions can contain sensitive data.
    }
    fail(source, 'invalid_response');
  };
  try {
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stripeList(request, resource, label, start, end, filters, project) {
  const source = `stripe.${label}`;
  const url = new URL(resource, 'https://api.stripe.com');
  const lower = Math.ceil(start / 1000);
  const upper = Math.floor(end / 1000);
  url.search = new URLSearchParams({
    limit: String(PAGE_SIZE), 'created[gte]': String(lower), 'created[lte]': String(upper),
    ...filters,
  }).toString();
  const seen = new Set();
  const results = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await request(source, new URL(url));
    if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean'
        || body.data.length > PAGE_SIZE) fail(source, 'invalid_response');
    for (const row of body.data) {
      if (!identifier(row?.id) || !Number.isSafeInteger(row.created)) fail(source, 'invalid_response');
      if (seen.has(row.id)) fail(source, 'pagination_stalled');
      seen.add(row.id);
      if (row.created >= lower && row.created <= upper) results.push(project(row, source));
    }
    if (!body.has_more) return results;
    const cursor = body.data.at(-1)?.id;
    if (!cursor) fail(source, 'pagination_stalled');
    url.searchParams.set('starting_after', cursor);
  }
  fail(source, 'page_limit');
}

function stripeCheckout(row, source, expectedStatus) {
  if (row.status !== expectedStatus) fail(source, 'invalid_response');
  const product = row.metadata?.product;
  const orderId = reference(row.metadata?.orderId);
  const serviceId = reference(row.metadata?.serviceId);
  const clientReferenceId = reference(row.client_reference_id);
  const knownReference = product === 'application_concierge' ? serviceId : orderId;
  return {
    id: row.id,
    created: row.created,
    status: row.status,
    paymentStatus: ['paid', 'unpaid', 'no_payment_required'].includes(row.payment_status)
      ? row.payment_status : 'unknown',
    product: ['assisted_application', 'application_concierge', 'consulting'].includes(product)
      ? product : product == null ? null : 'other',
    reader: row.metadata?.plan === 'reader_noads',
    publisher: product == null && !row.metadata?.readerUid && Boolean(reference(row.metadata?.publisherUid)),
    referenceConflict: (product === 'consulting' && row.metadata?.orderId != null && !orderId)
      || Boolean(knownReference && row.client_reference_id != null && clientReferenceId !== knownReference),
    orderId,
    serviceId,
    clientReferenceId: knownReference && clientReferenceId === knownReference ? clientReferenceId : null,
  };
}

function countByStatus(rows, knownStates) {
  const counts = Object.fromEntries([...knownStates, 'unknown'].map((state) => [state, 0]));
  for (const row of rows) counts[row.status]++;
  return counts;
}

function stripeStatus(row, states) {
  return { id: row.id, created: row.created, status: states.includes(row.status) ? row.status : 'unknown' };
}

export async function collectStripeSignals({ apiKey, nowMs, fetchImpl = globalThis.fetch, onIncomplete } = {}) {
  const start = windowStart('stripe', apiKey, nowMs, fetchImpl);
  const request = (source, url) => requestJson(source, fetchImpl, url, apiKey);
  const list = (resource, label, ...args) => {
    const result = stripeList(request, resource, label, ...args);
    return onIncomplete ? result.catch((error) => {
      onIncomplete(error instanceof CollectorError ? error.code : `stripe.${label}.unavailable`);
      return null;
    }) : result;
  };
  const [failedEvents, staleOpenCheckouts, refunds, disputes, completeCheckouts, expiredCheckouts] = await Promise.all([
    list('/v1/events', 'events', start, nowMs - 15 * MINUTE_MS,
      { delivery_success: 'false' }, (row) => ({ id: row.id, created: row.created })),
    list('/v1/checkout/sessions', 'open_checkouts', start, nowMs - 60 * MINUTE_MS,
      { status: 'open' }, (row, source) => stripeCheckout(row, source, 'open')),
    list('/v1/refunds', 'refunds', start, nowMs, {}, (row) => stripeStatus(row, REFUND_STATES)),
    list('/v1/disputes', 'disputes', start, nowMs, {}, (row) => stripeStatus(row, DISPUTE_STATES)),
    list('/v1/checkout/sessions', 'complete_checkouts', start, nowMs,
      { status: 'complete' }, (row, source) => stripeCheckout(row, source, 'complete')),
    onIncomplete && list('/v1/checkout/sessions', 'expired_checkouts', start, nowMs,
      { status: 'expired' }, (row, source) => stripeCheckout(row, source, 'expired')),
  ]);
  return {
    counts: {
      failedEvents: failedEvents?.length ?? null,
      staleOpenCheckouts: staleOpenCheckouts?.length ?? null,
      refunds: refunds && countByStatus(refunds, REFUND_STATES),
      disputes: disputes && countByStatus(disputes, DISPUTE_STATES),
    },
    details: { failedEvents, staleOpenCheckouts, refunds, disputes, completeCheckouts, ...(onIncomplete && { expiredCheckouts }) },
  };
}

function sumUpNext(source, links, initialUrl, pageLength) {
  if (links === undefined && pageLength < PAGE_SIZE) return null;
  if (!Array.isArray(links) || links.some((link) => typeof link?.rel !== 'string')) {
    fail(source, 'invalid_pagination');
  }
  const next = links.filter((link) => link.rel === 'next');
  if (next.length === 0) return null;
  const href = next[0].href;
  if (next.length !== 1 || typeof href !== 'string' || !href || /[\s#\\]/u.test(href)) {
    fail(source, 'invalid_pagination');
  }
  let candidate;
  try {
    if (href.startsWith('https://') || href.startsWith('/')) {
      candidate = new URL(href, initialUrl);
    } else {
      candidate = new URL(initialUrl);
      candidate.search = href;
    }
  } catch {
    fail(source, 'invalid_pagination');
  }
  if (candidate.origin !== SUMUP_ORIGIN || candidate.pathname !== initialUrl.pathname
      || candidate.username || candidate.password || candidate.hash) fail(source, 'invalid_pagination');

  const params = candidate.searchParams;
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    const original = initialUrl.searchParams.getAll(name);
    if (original.length && JSON.stringify([...values].sort()) === JSON.stringify([...original].sort())) continue;
    if (['oldest_ref', 'newest_ref'].includes(name) && values.length === 1 && identifier(values[0])) continue;
    fail(source, 'invalid_pagination');
  }
  if (params.has('oldest_ref') === params.has('newest_ref')) fail(source, 'invalid_pagination');
  for (const [name, value] of initialUrl.searchParams) {
    if (!params.has(name)) params.set(name, value);
  }
  params.delete('types[]');
  for (const type of SUMUP_TYPES) params.append('types[]', type);
  params.sort();
  return candidate;
}

async function sumUpHistory(request, merchantCode, start, nowMs) {
  const source = 'sumup.transactions';
  const initialUrl = new URL(`/v2.1/merchants/${merchantCode}/transactions/history`, SUMUP_ORIGIN);
  initialUrl.search = new URLSearchParams({
    limit: String(PAGE_SIZE), order: 'descending',
    oldest_time: new Date(start).toISOString(), newest_time: new Date(nowMs).toISOString(),
  }).toString();
  for (const type of SUMUP_TYPES) initialUrl.searchParams.append('types[]', type);
  initialUrl.searchParams.sort();
  const seen = new Set();
  const counts = { REFUND: 0, CHARGE_BACK: 0 };
  let url = initialUrl;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (seen.has(url.href)) fail(source, 'pagination_stalled');
    seen.add(url.href);
    const body = await request(source, url);
    if (!Array.isArray(body.items) || body.items.length > PAGE_SIZE) fail(source, 'invalid_response');
    for (const row of body.items) {
      const timestamp = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(timestamp) || (row.merchant_code != null && row.merchant_code !== merchantCode)) {
        fail(source, 'invalid_response');
      }
      if (timestamp < start || timestamp >= nowMs) continue;
      if (!SUMUP_TYPES.includes(row.type)) fail(source, 'invalid_response');
      counts[row.type]++;
    }
    url = sumUpNext(source, body.links, initialUrl, body.items.length);
    if (!url) return counts;
  }
  fail(source, 'page_limit');
}

async function sumUpCheckouts(request, merchantCode, ids, onIncomplete) {
  const source = 'sumup.checkouts';
  const checkouts = [];
  const checkout = async (id) => {
    const row = await request(source, new URL(`/v0.1/checkouts/${id}`, SUMUP_ORIGIN));
    if (row.id !== id || (row.merchant_code != null && row.merchant_code !== merchantCode)) {
      fail(source, 'checkout_mismatch');
    }
    const rawStatus = typeof row.status === 'string' ? row.status.trim() : '';
    const status = /^[A-Za-z]+$/u.test(rawStatus) ? rawStatus.toUpperCase() : '';
    const timestamp = typeof row.date === 'string' ? Date.parse(row.date) : NaN;
    return {
      id,
      status: SUMUP_STATES.includes(status) ? status : 'unknown',
      createdMs: Number.isFinite(timestamp) ? timestamp : null,
      checkoutReference: reference(row.checkout_reference, 64),
    };
  };
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = await Promise.all(ids.slice(offset, offset + 4).map((id) => {
      const result = checkout(id);
      return onIncomplete ? result.catch((error) => {
        onIncomplete(error instanceof CollectorError ? error.code : 'sumup.checkouts.unavailable');
        return null;
      }) : result;
    }));
    checkouts.push(...batch.filter(Boolean));
  }
  return checkouts;
}

export async function collectSumUpSignals({ apiKey, merchantCode, checkoutIds, nowMs, fetchImpl = globalThis.fetch, onIncomplete } = {}) {
  const start = windowStart('sumup', apiKey, nowMs, fetchImpl);
  if (!identifier(merchantCode) || !Array.isArray(checkoutIds)) fail('sumup', 'invalid_scope');
  const ids = [...new Set(checkoutIds)];
  if (!ids.every(identifier)) fail('sumup.checkouts', 'invalid_scope');
  if (ids.length > 200) fail('sumup.checkouts', 'checkout_limit');
  const request = (source, url) => requestJson(source, fetchImpl, url, apiKey);
  const read = (result) => onIncomplete ? result.catch((error) => {
    onIncomplete(error instanceof CollectorError ? error.code : 'sumup.unavailable');
    return null;
  }) : result;
  const [transactions, checkouts] = await Promise.all([
    read(sumUpHistory(request, merchantCode, start, nowMs)),
    sumUpCheckouts(request, merchantCode, ids, onIncomplete),
  ]);
  return {
    counts: {
      refunds: transactions?.REFUND ?? null,
      chargebacks: transactions?.CHARGE_BACK ?? null,
      checkouts: checkouts && countByStatus(checkouts, SUMUP_STATES),
    },
    details: { checkouts },
  };
}

export async function countSumUpWebhookFailures({ accessToken, nowMs, fetchImpl = globalThis.fetch } = {}) {
  const source = 'cloud_logging.sumup_webhook';
  const start = windowStart(source, accessToken, nowMs, fetchImpl);
  const url = new URL('https://logging.googleapis.com/v2/entries:list');
  const query = {
    resourceNames: ['projects/frontaliere-ticino'],
    filter: [
      'resource.type="cloud_run_revision"',
      'resource.labels.service_name="sumupassistedapplicationwebhook"',
      'logName="projects/frontaliere-ticino/logs/run.googleapis.com%2Frequests"',
      'httpRequest.status>=500',
      `timestamp >= "${new Date(start).toISOString()}"`,
      `timestamp <= "${new Date(nowMs).toISOString()}"`,
    ].join(' AND '),
    pageSize: PAGE_SIZE,
  };
  let count = 0;
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await requestJson(source, fetchImpl, url, accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    const entries = body.entries === undefined ? [] : body.entries;
    if (!Array.isArray(entries)) fail(source, 'invalid_response');
    count += entries.length;
    const token = body.nextPageToken;
    if (token === undefined || token === '') return count;
    if (typeof token !== 'string' || !token.trim()) fail(source, 'invalid_pagination');
    if (seen.has(token)) fail(source, 'pagination_stalled');
    seen.add(token);
    query.pageToken = token;
  }
  fail(source, 'page_limit');
}

const PROJECT = 'frontaliere-ticino';
const OPEN_DISPUTES = [
  'warning_needs_response', 'warning_under_review', 'needs_response', 'under_review',
  'appeal_needs_response', 'appeal_under_review',
];

async function reportGithubIssue({ title, description }) {
  // The shared CLI calls createGithubIssue and may print gh diagnostics.
  // Keep those streams out of this monitor's aggregate output.
  const reporterPath = fileURLToPath(new URL('./lib/github-issue-creator.mjs', import.meta.url));
  await promisify(execFile)(process.execPath, [
    reporterPath, '--title', title, '--description', description,
    '--consecutive-gate', '-1', '--require-persisted',
  ], { timeout: 60_000 });
}

export async function runPaymentsHealth({
  nowMs = Date.now(),
  record = false,
  notify = false,
  fetchImpl = globalThis.fetch,
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  accessToken = async (scope) => {
    const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    return getServiceAccountAccessToken(credentials, `https://www.googleapis.com/auth/${scope}`);
  },
  reportIssue = reportGithubIssue,
} = {}) {
  const incomplete = new Set();
  const attempt = async (code, operation) => {
    try {
      return await operation();
    } catch (error) {
      incomplete.add(error instanceof CollectorError ? error.code : code);
      return null;
    }
  };
  const [template, firestoreToken, logging] = await Promise.all([
    attempt('remote_config.unavailable', async () => (await fetchRemoteConfigTemplate({
      projectId: PROJECT,
      accessToken: await accessToken('firebase.remoteconfig'),
      fetchImpl: (url, options) => fetchImpl(url, { ...options, redirect: 'error' }),
    })).parameters),
    attempt('firestore.auth_unavailable', () => accessToken('datastore')),
    attempt('cloud_logging.sumup_webhook.unavailable', async () => countSumUpWebhookFailures({
      accessToken: await accessToken('logging.read'), nowMs, fetchImpl,
    })),
  ]);
  const secret = (key) => template?.[key]?.defaultValue?.value;
  const firestore = (path, options) => requestJson(
    path === ':runQuery' ? 'firestore.query' : 'firestore', fetchImpl, new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents${path}`),
    firestoreToken, options,
  );
  const onIncomplete = (code) => incomplete.add(code);
  const [stripe, records] = await Promise.all([
    attempt('stripe.unavailable', () => collectStripeSignals({
      apiKey: secret('STRIPE_SECRET_KEY'), nowMs, fetchImpl, onIncomplete,
    })),
    firestoreToken ? readPaymentRecords(firestore, nowMs, onIncomplete) : [],
  ]);
  const checkoutIds = [...new Set(records.map((row) => row.sumupId).filter(Boolean))];
  if (checkoutIds.length > 200) incomplete.add('sumup.checkouts.checkout_limit');
  const sumup = await attempt('sumup.unavailable', () => collectSumUpSignals({
    apiKey: secret('SUMUP_API_KEY'), merchantCode: secret('SUMUP_MERCHANT_CODE'),
    checkoutIds: checkoutIds.slice(0, 200), nowMs, fetchImpl, onIncomplete,
  }));
  const reconciliation = reconcilePayments(records, stripe?.details, sumup?.details, nowMs);
  if (reconciliation.unknown) incomplete.add('reconciliation.insufficient_evidence');

  const disputes = stripe?.counts.disputes;
  const openDisputes = disputes ? OPEN_DISPUTES.reduce((total, state) => total + disputes[state], 0) : null;
  const summary = {
    hour: new Date(Math.floor(nowMs / (60 * MINUTE_MS)) * 60 * MINUTE_MS).toISOString(),
    stripe: stripe?.counts ?? null,
    sumup: sumup?.counts ?? null,
    sumupWebhookFailures: logging,
    openStripeDisputes: openDisputes,
    reconciliation,
    incomplete: [],
  };

  const report = (title, sources) => attempt('github.report_failed', async () => {
    const description = sources.filter(([, count]) => count > 0)
      .map(([source, count]) => `- ${source}: ${count}`).join('\n');
    if (description) return reportIssue({ title, description });
  });
  if (notify) {
    await report('Payments health: webhook falliti non rilevati', [
      ['Stripe webhook failures', stripe?.counts.failedEvents],
      ['SumUp webhook failures (Cloud Logging)', logging],
    ]);
    await report('Payments health: payment reconciliation gaps', [
      ['Provider paid, application unpaid', reconciliation.providerPaidAppUnpaid],
      ['Application paid, provider incompatible', reconciliation.appPaidProviderIncompatible],
      ['Open Stripe disputes', openDisputes],
    ]);
  }
  summary.incomplete = [...incomplete].sort();
  if (record) {
    try {
      if (!firestoreToken) throw new Error('firestore.auth_unavailable');
      await writePaymentsHealth(firestore, summary);
    } catch {
      incomplete.add('firestore.record_failed');
    }
    summary.incomplete = [...incomplete].sort();
  }
  return summary;
}

export function paymentsHealthExitCode({ incomplete }) {
  return incomplete.some((code) => code !== 'reconciliation.insufficient_evidence') ? 1 : 0;
}

if (isInvokedDirectly(import.meta.url)) {
  const flags = process.argv.slice(2);
  try {
    if (flags.some((flag) => !['--record', '--notify'].includes(flag))) throw new Error('invalid_arguments');
    const { value: result, acquired } = await withSingleFlightLockAsync(
      join(tmpdir(), 'frontaliere-payments-health.lock'),
      () => runPaymentsHealth({ record: flags.includes('--record'), notify: flags.includes('--notify') }),
    );
    if (!acquired) {
      console.log(JSON.stringify({ incomplete: ['payments_health.already_running'] }));
    } else {
      console.log(JSON.stringify(result));
      process.exitCode = paymentsHealthExitCode(result);
    }
  } catch {
    console.error(JSON.stringify({ error: 'payments_health.failed' }));
    process.exitCode = 1;
  }
}
