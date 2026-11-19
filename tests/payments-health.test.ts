import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectStripeSignals,
  collectSumUpSignals,
  countSumUpWebhookFailures,
  paymentsHealthExitCode,
  runPaymentsHealth,
} from '../scripts/payments-health.mjs';

const minute = 60_000;
const nowMs = Date.now();
const start = nowMs - 48 * 60 * minute;
const key = 'fixture-key';
const sensitive = { amount: 1234, currency: 'EUR', email: 'private@example.invalid', card: 'card-fixture' };

function json(body: unknown) {
  return new Response(JSON.stringify(body));
}

function stripePage(data: unknown[] = [], has_more = false) {
  return json({ data, has_more });
}

describe('Stripe signals', () => {
  it('bounds each query, pages events, applies grace periods and projects only known fields', async () => {
    const eventCutoff = Math.floor((nowMs - 15 * minute) / 1000);
    const openCutoff = Math.floor((nowMs - 60 * minute) / 1000);
    const completeCutoff = Math.floor(nowMs / 1000);
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe('https://api.stripe.com');
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` });
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('created[gte]')).toBe(String(Math.ceil(start / 1000)));
      const upper = url.searchParams.get('created[lte]');
      if (url.pathname === '/v1/events') {
        expect(upper).toBe(String(eventCutoff));
        expect(url.searchParams.get('delivery_success')).toBe('false');
        return url.searchParams.has('starting_after')
          ? stripePage([{ id: 'evt_second', created: eventCutoff - 1 }])
          : stripePage([{ id: 'evt_old', created: eventCutoff }, { id: 'evt_recent', created: eventCutoff + 1 }], true);
      }
      if (url.searchParams.get('status') === 'open') {
        expect(upper).toBe(String(openCutoff));
        return stripePage([
          { id: 'cs_old', created: openCutoff, status: 'open', payment_status: 'unpaid' },
          { id: 'cs_recent', created: openCutoff + 1, status: 'open' },
        ]);
      }
      expect(upper).toBe(String(completeCutoff));
      if (url.pathname === '/v1/refunds') {
        return stripePage([
          { id: 're_old', created: completeCutoff, status: 'pending', ...sensitive },
          { id: 're_new', created: completeCutoff, status: 'future_status' },
        ]);
      }
      if (url.pathname === '/v1/disputes') {
        return stripePage([{ id: 'dp_old', created: completeCutoff, status: 'needs_response', ...sensitive }]);
      }
      expect(url.searchParams.get('status')).toBe('complete');
      return stripePage([
        {
          id: 'cs_done', created: completeCutoff, status: 'complete', payment_status: 'paid',
          client_reference_id: 'order_1', ...sensitive,
          metadata: { product: 'assisted_application', orderId: 'order_1', ...sensitive },
        },
        { id: 'cs_reader', created: completeCutoff, status: 'complete', client_reference_id: 'reader_uid' },
      ]);
    });
    const result = await collectStripeSignals({ apiKey: key, nowMs, fetchImpl });
    expect(result.counts).toMatchObject({
      failedEvents: 2, staleOpenCheckouts: 1, refunds: { pending: 1, unknown: 1 },
      disputes: { needs_response: 1 },
    });
    expect(fetchImpl.mock.calls.some(([url]) => url.searchParams.get('starting_after') === 'evt_recent')).toBe(true);
    expect(result.details.completeCheckouts).toMatchObject([
      { id: 'cs_done', orderId: 'order_1', clientReferenceId: 'order_1', paymentStatus: 'paid' },
      { id: 'cs_reader', clientReferenceId: null, paymentStatus: 'unknown' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/amount|currency|private@|card-fixture|future_status|reader_uid/);
    expect(JSON.stringify(result.counts)).not.toMatch(/cs_done|order_1|evt_old/);
  });

  it('rejects incomplete Stripe pages at the cap and detects a cursor stalled by a duplicate', async () => {
    let calls = 0;
    const cappedFetch = async (url: URL) => url.pathname === '/v1/events'
      ? stripePage([{ id: `evt_${++calls}`, created: Math.ceil(start / 1000) }], true)
      : stripePage();
    await expect(collectStripeSignals({ apiKey: key, nowMs, fetchImpl: cappedFetch })).rejects.toThrow('stripe.events: page_limit');
    expect(calls).toBe(20);

    const stalledFetch = async (url: URL) => url.pathname === '/v1/events'
      ? stripePage([{ id: 'evt_duplicate', created: Math.ceil(start / 1000) }], true)
      : stripePage();
    await expect(collectStripeSignals({ apiKey: key, nowMs, fetchImpl: stalledFetch })).rejects.toThrow('stripe.events: pagination_stalled');
  });
});

describe('SumUp signals', () => {
  const scope = { apiKey: key, merchantCode: 'M_TEST', nowMs };
  const path = '/v2.1/merchants/M_TEST/transactions/history';
  const timestamp = new Date(nowMs - 1).toISOString();

  it('counts only merchant history in range and restricts checkout reads to deduped order IDs', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      expect(url.origin).toBe('https://api.sumup.com');
      if (url.pathname === path) {
        expect(url.searchParams.get('oldest_time')).toBe(new Date(start).toISOString());
        expect(url.searchParams.get('newest_time')).toBe(new Date(nowMs).toISOString());
        expect(url.searchParams.getAll('types[]')).toEqual(['REFUND', 'CHARGE_BACK']);
        if (url.searchParams.has('newest_ref')) {
          return json({ items: [
            { type: 'CHARGE_BACK', timestamp, ...sensitive },
            { type: 'REFUND', timestamp: new Date(start - 1).toISOString() },
          ], links: [{ rel: 'prev', href: 'oldest_ref=tx_2' }] });
        }
        return json({ items: [{ type: 'REFUND', timestamp }], links: [{ rel: 'next', href: 'newest_ref=tx_1' }] });
      }
      const id = url.pathname.split('/').at(-1);
      return json({
        id, merchant_code: scope.merchantCode, date: timestamp,
        status: id === 'co_1' ? ' paid ' : 'provider-extra',
        checkout_reference: 'order_1~sumup~2', ...sensitive,
      });
    });
    const result = await collectSumUpSignals({ ...scope, checkoutIds: ['co_1', 'co_2', 'co_1'], fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.counts).toEqual({
      refunds: 1, chargebacks: 1,
      checkouts: { PENDING: 0, PAID: 1, FAILED: 0, EXPIRED: 0, CANCELLED: 0, unknown: 1 },
    });
    expect(result.details.checkouts[0]).toEqual({
      id: 'co_1', status: 'PAID', createdMs: nowMs - 1, checkoutReference: 'order_1~sumup~2',
    });
    expect(JSON.stringify(result)).not.toMatch(/amount|currency|private@|card-fixture|provider-extra/);
    expect(JSON.stringify(result.counts)).not.toMatch(/co_1|order_1/);
  });

  it.each([
    'https://api.sumup.com.example.invalid/v2.1/merchants/M_TEST/transactions/history?newest_ref=tx',
    'https://api.sumup.com/v2.1/merchants/OTHER/transactions/history?newest_ref=tx',
    'newest_ref=tx&types%5B%5D=PAYMENT',
  ])('rejects a next link outside the original scope (%s)', async (href) => {
    const fetchImpl = vi.fn(async () => json({ items: [], links: [{ rel: 'next', href }] }));
    await expect(collectSumUpSignals({ ...scope, checkoutIds: [], fetchImpl })).rejects.toThrow('sumup.transactions: invalid_pagination');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact next URL and rejects repeated cursors and missing pagination on full pages', async () => {
    const href = `https://api.sumup.com${path}?newest_ref=tx`;
    const repeatedFetch = vi.fn(async () => json({ items: [], links: [{ rel: 'next', href }] }));
    await expect(collectSumUpSignals({ ...scope, checkoutIds: [], fetchImpl: repeatedFetch }))
      .rejects.toThrow('sumup.transactions: pagination_stalled');
    expect(repeatedFetch).toHaveBeenCalledTimes(2);

    const fullFetch = async () => json({ items: Array.from({ length: 100 }, () => ({ type: 'REFUND', timestamp })) });
    await expect(collectSumUpSignals({ ...scope, checkoutIds: [], fetchImpl: fullFetch }))
      .rejects.toThrow('sumup.transactions: invalid_pagination');
  });

  it('rejects history with a continuation beyond page twenty', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => json({
      items: [{ type: 'REFUND', timestamp }],
      links: [{ rel: 'next', href: `newest_ref=tx_${++page}` }],
    }));
    await expect(collectSumUpSignals({ ...scope, checkoutIds: [], fetchImpl }))
      .rejects.toThrow('sumup.transactions: page_limit');
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it('fails incomplete scopes, oversized scopes and mismatched checkout IDs', async () => {
    const fetchImpl = vi.fn(async (url: URL) => url.pathname === path ? json({ items: [] }) : json({ id: 'other' }));
    await expect(collectSumUpSignals({ ...scope, fetchImpl })).rejects.toThrow('sumup: invalid_scope');
    await expect(collectSumUpSignals({
      ...scope, checkoutIds: Array.from({ length: 201 }, (_, i) => `co_${i}`), fetchImpl,
    })).rejects.toThrow('sumup.checkouts: checkout_limit');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(collectSumUpSignals({ ...scope, checkoutIds: ['co_1'], fetchImpl }))
      .rejects.toThrow('sumup.checkouts: checkout_mismatch');
  });

  it('keeps checkout concurrency at four', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = async (url: URL) => {
      if (url.pathname === path) return json({ items: [] });
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return json({ id: url.pathname.split('/').at(-1), status: 'PENDING' });
    };
    const checkoutIds = Array.from({ length: 9 }, (_, i) => `co_${i}`);
    const result = await collectSumUpSignals({ ...scope, checkoutIds, fetchImpl });
    expect(result.counts.checkouts.PENDING).toBe(9);
    expect(peak).toBe(4);
  });
});

describe('SumUp webhook request logs', () => {
  const scope = { accessToken: key, nowMs };

  it('counts complete pages including when an intermediate page is empty', async () => {
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe('https://logging.googleapis.com/v2/entries:list');
      expect(init.method).toBe('POST');
      const query = JSON.parse(String(init.body));
      expect(query.resourceNames).toEqual(['projects/frontaliere-ticino']);
      for (const filter of [
        'resource.type="cloud_run_revision"',
        'resource.labels.service_name="sumupassistedapplicationwebhook"',
        'logName="projects/frontaliere-ticino/logs/run.googleapis.com%2Frequests"',
        'httpRequest.status>=500',
        `timestamp >= "${new Date(start).toISOString()}"`,
        `timestamp <= "${new Date(nowMs).toISOString()}"`,
      ]) expect(query.filter).toContain(filter);
      if (!query.pageToken) return json({ entries: [sensitive], nextPageToken: 'more' });
      if (query.pageToken === 'more') return json({ nextPageToken: 'last' });
      return json({ entries: [sensitive, sensitive] });
    });
    await expect(countSumUpWebhookFailures({ ...scope, fetchImpl })).resolves.toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects repeated cursors and sanitizes HTTP and network errors', async () => {
    const stalled = async () => json({ nextPageToken: 'same' });
    await expect(countSumUpWebhookFailures({ ...scope, fetchImpl: stalled })).rejects.toThrow(/^cloud_logging.sumup_webhook: pagination_stalled$/);
    const httpError = async () => new Response(sensitive.email, { status: 503 });
    await expect(countSumUpWebhookFailures({ ...scope, fetchImpl: httpError })).rejects.toThrow(/^cloud_logging.sumup_webhook: http_error$/);
    const requestError = async () => { throw new Error(sensitive.email); };
    await expect(countSumUpWebhookFailures({ ...scope, fetchImpl: requestError })).rejects.toThrow(/^cloud_logging.sumup_webhook: request_failed$/);
  });

  it('rejects log counts with a continuation beyond page twenty', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => json({ nextPageToken: `page_${++page}` }));
    await expect(countSumUpWebhookFailures({ ...scope, fetchImpl }))
      .rejects.toThrow('cloud_logging.sumup_webhook: page_limit');
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it('aborts a request after its timeout even if the injected fetch hangs', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetchImpl = (_url: URL, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>(() => {});
      };
      const assertion = expect(countSumUpWebhookFailures({ ...scope, fetchImpl }))
        .rejects.toThrow(/^cloud_logging.sumup_webhook: timeout$/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

const older = new Date(nowMs - 30 * minute).toISOString();
const recent = new Date(nowMs - minute).toISOString();
const fsRoot = 'projects/frontaliere-ticino/databases/(default)/documents';

function paymentDoc(collection: string, id: string, fields: Record<string, string>, timestamp = older) {
  return { document: {
    name: `${fsRoot}/${collection}/${id}`,
    fields: {
      ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { stringValue: value }])),
      [collection === 'reader_checkout_claims' ? 'claimedAt' : collection === 'consulting_orders' ? 'createdAt' : 'updatedAt']:
        { timestampValue: timestamp },
    },
  } };
}

function runtimeFixture({ webhook = false, orders = false, incomplete = false } = {}) {
  const reportIssue = vi.fn();
  const accessToken = vi.fn(async (scope: string) => scope);
  const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'firebaseremoteconfig.googleapis.com') {
      return json({ parameters: Object.fromEntries([
        'STRIPE_SECRET_KEY', 'SUMUP_API_KEY', 'SUMUP_MERCHANT_CODE', 'UNRELATED_SECRET',
      ].map((name) => [name, { defaultValue: { value: key } }])) });
    }
    if (url.hostname === 'logging.googleapis.com') {
      return json({});
    }
    if (url.hostname === 'firestore.googleapis.com') {
      const body = JSON.parse(String(init?.body));
      if (init?.method === 'PATCH') return json({});
      expect(url.pathname).toContain(':runQuery');
      const collection = body.structuredQuery.from[0].collectionId;
      expect(body.structuredQuery.select.fields.map(({ fieldPath }: { fieldPath: string }) => fieldPath))
        .not.toEqual(expect.arrayContaining(['uid']));
      if (!orders) return json([{ readTime: older }]);
      if (collection === 'assisted_applications') return json([
        paymentDoc(collection, 'app_1', { paymentStatus: 'pending', stripeCheckoutSessionId: 'cs_assisted' }),
        paymentDoc(collection, 'app_2', { paymentStatus: 'paid', stripeSessionId: 'cs_async' }),
        paymentDoc(collection, 'app_3', { paymentStatus: 'pending', stripeCheckoutSessionId: 'cs_grace' }, recent),
        paymentDoc(collection, 'app_4', { paymentStatus: 'paid', stripeSessionId: 'cs_expired' }),
      ]);
      if (collection === 'application_concierge_services') return json([
        paymentDoc(collection, 'service_1', { paymentStatus: 'paid', paymentProvider: 'sumup', sumupCheckoutId: 'su_checkout' }),
        paymentDoc(collection, 'service_2', { paymentStatus: 'paid', paymentProvider: 'sumup', sumupCheckoutId: 'su_wrong' }),
      ]);
      if (collection === 'orders') return json([
        paymentDoc(collection, 'publisher_order', { status: 'active', stripeCheckoutSessionId: 'cs_publisher' }),
      ]);
      if (collection === 'consulting_orders') return json([
        paymentDoc(collection, 'cs_consulting', { status: 'paid', stripeSessionId: 'cs_consulting' }),
      ]);
      if (collection === 'reader_checkout_claims') return json([paymentDoc(collection, 'cs_claim', {})]);
      throw new Error('unexpected collection');
    }
    if (url.hostname === 'api.stripe.com') {
      const created = Math.floor((nowMs - 30 * minute) / 1000);
      if (url.pathname === '/v1/events') return webhook ? stripePage([{ id: 'evt_fixture', created, ...sensitive }]) : stripePage();
      const status = url.searchParams.get('status');
      if (!orders || !status || status === 'open') return stripePage();
      if (status === 'complete' && incomplete) return stripePage([], true);
      const row = (id: string, metadata: object, payment_status = 'paid', client_reference_id?: string) =>
        ({ id, created, status, payment_status, metadata, client_reference_id, ...sensitive });
      const assisted = (orderId: string) => ({ product: 'assisted_application', orderId });
      return status === 'expired'
        ? stripePage([row('cs_expired', assisted('app_4'), 'unpaid')])
        : stripePage([
          row('cs_assisted', assisted('app_1')),
          row('cs_async', assisted('app_2'), 'unpaid'),
          row('cs_grace', assisted('app_3')),
          row('cs_publisher', { publisherUid: 'owner_fixture', orderId: 'publisher_order' }, 'paid', 'publisher_order'),
          row('cs_consulting', { product: 'consulting' }),
          row('cs_claim', { plan: 'reader_noads' }),
          row('cs_unclaimed', { plan: 'reader_noads', readerUid: 'owner_fixture' }, 'paid', 'owner_fixture'),
          row('cs_foreign', {}, 'paid', 'app_2'),
        ]);
    }
    if (url.hostname === 'api.sumup.com') {
      return url.pathname.endsWith('/history') ? json({ items: [] }) : json({
        id: url.pathname.split('/').at(-1), status: 'FAILED',
        checkout_reference: 'service_1~sumup~2', merchant_code: key,
      });
    }
    throw new Error('unexpected request');
  });
  return { fetchImpl, accessToken, reportIssue };
}

describe('payments health runtime', () => {
  it('reports one confirmed webhook failure with only its aggregate and records by UTC hour', async () => {
    const fixture = runtimeFixture({ webhook: true });
    const summary = await runPaymentsHealth({ ...fixture, nowMs, record: true, notify: true });
    expect(fixture.reportIssue).toHaveBeenCalledExactlyOnceWith({
      title: 'Payments health: webhook falliti non rilevati',
      description: '- Stripe webhook failures: 1',
    });
    expect(summary.incomplete).toEqual([]);
    expect(paymentsHealthExitCode(summary)).toBe(0);
    const writes = fixture.fetchImpl.mock.calls.filter(([, request]) => request?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(decodeURIComponent(String(writes[0][0]))).toContain(`/payments_health/${summary.hour}`);
    expect(writes[0][1]?.body).toContain('"failedEvents":{"integerValue":"1"}');
    for (const output of [summary, writes[0][1]?.body, fixture.reportIssue.mock.calls]) {
      expect(JSON.stringify(output)).not.toMatch(/private@|evt_fixture|fixture-key|card-fixture|1234/);
    }
  });

  it('reports mismatches in both directions while preserving grace and unknown evidence', async () => {
    const fixture = runtimeFixture({ orders: true });
    const summary = await runPaymentsHealth({ ...fixture, nowMs, notify: true });
    expect(summary.reconciliation).toEqual({
      matched: 3, providerPaidAppUnpaid: 1, appPaidProviderIncompatible: 2, grace: 1, unknown: 3,
    });
    expect(summary.incomplete).toEqual(['reconciliation.insufficient_evidence']);
    expect(paymentsHealthExitCode(summary)).toBe(0);
    expect(fixture.reportIssue).toHaveBeenCalledExactlyOnceWith({
      title: 'Payments health: payment reconciliation gaps',
      description: '- Provider paid, application unpaid: 1\n- Application paid, provider incompatible: 2',
    });
    expect(JSON.stringify(summary)).not.toMatch(/cs_|app_\d|su_checkout|owner_fixture|publisher_order/);
  });

  it('does not infer a mismatch from failed Stripe pagination', async () => {
    const fixture = runtimeFixture({ orders: true, incomplete: true });
    const summary = await runPaymentsHealth({ ...fixture, nowMs });
    expect(summary.reconciliation.providerPaidAppUnpaid).toBe(0);
    expect(summary.reconciliation.unknown).toBeGreaterThan(0);
    expect(summary.incomplete).toContain('stripe.complete_checkouts.pagination_stalled');
    expect(paymentsHealthExitCode(summary)).toBe(1);
    expect(fixture.reportIssue).not.toHaveBeenCalled();
  });

  it('fails the run when the sources are unavailable even if the snapshot is written', async () => {
    const fixture = runtimeFixture();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return fixture.fetchImpl(input, init);
      return new Response(null, { status: 403 });
    });
    const summary = await runPaymentsHealth({ ...fixture, fetchImpl, nowMs, record: true, notify: true });

    expect(summary.incomplete).toEqual(expect.arrayContaining([
      'remote_config.unavailable', 'cloud_logging.sumup_webhook.http_error',
      'firestore.orders.query_failed', 'stripe.invalid_scope', 'sumup.invalid_scope',
    ]));
    expect(summary.incomplete).not.toContain('firestore.record_failed');
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.reportIssue).not.toHaveBeenCalled();
    expect(paymentsHealthExitCode(summary)).toBe(1);
  });

  it('retains independently verified SumUp evidence when history or another checkout fails', async () => {
    const fixture = runtimeFixture({ orders: true });
    const summary = await runPaymentsHealth({
      ...fixture, nowMs, notify: true,
      fetchImpl: async (input, init) => {
        if (/api\.sumup\.com.*(?:history|su_wrong)$/.test(new URL(input).origin + new URL(input).pathname)) {
          return new Response('private@example.invalid', { status: 503 });
        }
        return fixture.fetchImpl(input, init);
      },
    });
    expect(summary.sumup?.refunds).toBeNull();
    expect(summary.sumup?.checkouts?.FAILED).toBe(1);
    expect(summary.reconciliation.appPaidProviderIncompatible).toBe(2);
    expect(summary.incomplete).toEqual([
      'reconciliation.insufficient_evidence', 'sumup.checkouts.http_error', 'sumup.transactions.http_error',
    ]);
    expect(fixture.reportIssue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(summary)).not.toContain('private@');
  });

  it('bounds query pagination and records a failed snapshot write using stable codes', async () => {
    const fixture = runtimeFixture();
    let pages = 0;
    const summary = await runPaymentsHealth({
      ...fixture, nowMs, record: true, notify: true,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (url.hostname === 'firestore.googleapis.com' && init?.method === 'PATCH') {
          return new Response('private@example.invalid', { status: 403 });
        }
        if (url.pathname.endsWith(':runQuery')) {
          const { structuredQuery } = JSON.parse(String(init?.body));
          if (structuredQuery.from[0].collectionId === 'orders') {
            const startAt = structuredQuery.startAt;
            expect(structuredQuery.limit).toBe(101);
            if (pages > 0) expect(startAt).toEqual({ before: false, values: [
              { timestampValue: older }, { referenceValue: `${fsRoot}/orders/order_${pages * 100 - 1}` },
            ] });
            const offset = pages++ * 100;
            return json(Array.from({ length: 101 }, (_, index) =>
              paymentDoc('orders', `order_${offset + index}`, { status: 'created' })));
          }
        }
        return fixture.fetchImpl(input, init);
      },
    });
    expect(pages).toBe(10);
    expect(summary.reconciliation.unknown).toBe(1000);
    expect(summary.incomplete).toEqual([
      'firestore.orders.page_limit', 'firestore.record_failed', 'reconciliation.insufficient_evidence',
    ]);
    expect(paymentsHealthExitCode(summary)).toBe(1);
    expect(fixture.reportIssue).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toContain('private@');
  });

  it('uses ADC and separate scopes through the production read-only path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payments-health-test-'));
    const credentialsPath = join(directory, 'adc.json');
    const fixture = runtimeFixture({ webhook: true });
    const scopes: string[] = [];
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    try {
      await writeFile(credentialsPath, JSON.stringify({
        client_email: 'synthetic@example.invalid',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      }), { mode: 0o600 });
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', credentialsPath);
      vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
        if (new URL(url).hostname === 'oauth2.googleapis.com') {
          const claim = (init?.body as URLSearchParams).get('assertion')!.split('.')[1];
          const { scope } = JSON.parse(Buffer.from(claim, 'base64url').toString());
          scopes.push(scope);
          return json({ access_token: scope });
        }
        return fixture.fetchImpl(url, init);
      });
      const result = await runPaymentsHealth({ nowMs, reportIssue: fixture.reportIssue });
      expect(scopes.sort()).toEqual(['datastore', 'firebase.remoteconfig', 'logging.read']
        .map((scope) => `https://www.googleapis.com/auth/${scope}`));
      expect(result.stripe?.failedEvents).toBe(1);
      expect(result.incomplete).toEqual([]);
      expect(fixture.fetchImpl.mock.calls.every(([url, init]) =>
        !init?.method || (init.method === 'POST' && /:runQuery|entries:list/.test(String(url))))).toBe(true);
      expect(fixture.reportIssue).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
