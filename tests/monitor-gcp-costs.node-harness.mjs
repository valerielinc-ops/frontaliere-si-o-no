import assert from 'node:assert/strict';
import {
  breakdownSeries,
  COST_DRIVERS,
  dailyGrowth,
  evaluateCostDrivers,
  GCP_COST_ISSUE_TITLE,
  measureCostDrivers,
  renderCostReport,
  STORAGE_DRIVER,
  sumSeries,
} from '../scripts/monitor-gcp-costs.mjs';

const GIB = 1024 ** 3;
const point = (value, endTime = '2020-01-08T00:00:00Z') => ({ interval: { endTime }, value: { int64Value: String(value) } });
const series = (service, ...values) => ({ resource: { labels: { service_name: service } }, points: values.map((value) => point(value)) });
const threshold = (key) => COST_DRIVERS.find((driver) => driver.key === key).threshold;
const syntheticOverThreshold = {
  'firestore-reads': { value: threshold('firestore-reads') + 1, breakdown: [{ name: 'synthetic-private-caller-marker', value: 1 }] },
  'firestore-writes': { value: 0 },
  'cloud-run-egress': { value: threshold('cloud-run-egress') + 1, breakdown: [{ name: 'synthetic-private-service-marker', value: 1 }] },
  'cloud-run-requests': { value: 0 },
  'cloud-run-instance-time': { value: threshold('cloud-run-instance-time') + 1, breakdown: [{ name: 'synthetic-private-service-marker', value: 1 }] },
  'firebase-storage-egress': { value: 0 },
  'firestore-storage-growth': { value: 0, level: 0 },
};

async function testOverThresholdEvaluation() {
  const evaluation = evaluateCostDrivers(syntheticOverThreshold);
  assert.deepEqual(evaluation.breaches.map((row) => row.driver.key), ['firestore-reads', 'cloud-run-egress', 'cloud-run-instance-time']);
  assert.deepEqual(evaluation.missing, []);
}

async function testNormalEvaluation() {
  const evaluation = evaluateCostDrivers({
    'firestore-reads': { value: 1 },
    'firestore-writes': { value: 1 },
    'cloud-run-egress': { value: 1 },
    'cloud-run-requests': { value: 1 },
    'cloud-run-instance-time': { value: 1 },
    'firebase-storage-egress': { value: 1 },
    'firestore-storage-growth': { value: 0, level: 1 },
  });
  assert.deepEqual(evaluation.breaches, []);
}

async function testMissingDriver() {
  const { 'firestore-writes': _omitted, ...partial } = syntheticOverThreshold;
  const evaluation = evaluateCostDrivers(partial);
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-writes']);
}

async function testStableIssueTitle() {
  assert.doesNotMatch(GCP_COST_ISSUE_TITLE, /\d/);
}

async function testReportContributors() {
  const report = renderCostReport(evaluateCostDrivers(syntheticOverThreshold));
  assert.ok(report.includes('GCP cost monitor alert'));
  assert.ok(report.includes('measurements and diagnostics are withheld'));
  assert.ok(!report.includes('synthetic-private-caller-marker'));
  assert.ok(!report.includes('synthetic-private-service-marker'));
}

async function testHealthyReport() {
  const report = renderCostReport(evaluateCostDrivers({
    ...syntheticOverThreshold,
    'firestore-reads': { value: 1 },
    'cloud-run-egress': { value: 1 },
    'cloud-run-instance-time': { value: 10_000 },
    'firestore-storage-growth': { value: 1, level: 1 },
  }));
  assert.equal(report.includes('1-CAUSA'), false);
  assert.equal(report.includes('più tempo istanza'), false);
}

async function testSeriesSum() {
  assert.equal(sumSeries([series('a', 1, 2), { points: [{ value: { doubleValue: 0.5 } }] }]), 3.5);
}

async function testSeriesBreakdown() {
  assert.deepEqual(
    breakdownSeries([series('small', 1), series('big', 5, 5), series('mid', 3)], 'resource.label.service_name', 2),
    [{ name: 'big', value: 10 }, { name: 'mid', value: 3 }],
  );
}

async function testDailyGrowth() {
  const growth = dailyGrowth([{ points: [point(10, '2020-01-01T00:00:00Z'), point(17, '2020-01-08T00:00:00Z')] }]);
  assert.equal(growth.level, 17);
  assert.ok(Math.abs(growth.perDay - 1) < 1e-6);
}

async function testCostDriverPaging() {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('filter') || '';
    const firstPage = !parsed.searchParams.get('pageToken');
    const body = filter.includes('read_ops_count') && firstPage
      ? { timeSeries: [series('x', 4_000_000)], nextPageToken: 'p2' }
      : filter.includes('read_ops_count')
        ? { timeSeries: [series('x', 2_000_000)] }
        : filter.includes('data_and_index_storage_bytes')
        ? { timeSeries: [{ points: [point(20, '2020-01-01T00:00:00Z'), point(27, '2020-01-08T00:00:00Z')] }] }
          : filter.includes('request_count')
            ? { timeSeries: [series('synthetic-service', 14)] }
            : filter.includes('storage.googleapis.com/network/sent_bytes_count')
              ? { timeSeries: [{ resource: { labels: { bucket_name: 'synthetic-bucket' } }, points: [point(12)] }] }
          : { timeSeries: [series('synthetic-service', 10)] };
    return { ok: true, status: 200, json: async () => body };
  };
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't', now: new Date('2020-01-08T00:00:00Z') });
  assert.equal(measurements['firestore-reads'].value, 6);
  assert.ok(Math.abs(measurements[STORAGE_DRIVER.key].value - 1) < 1e-6);
  const egressUrl = urls.find((url) => url.includes('sent_bytes_count')) || '';
  assert.ok(new URL(egressUrl).searchParams.get('filter').includes('metric.label.kind="internet"'));
  const requestUrl = urls.find((url) => url.includes('request_count')) || '';
  assert.ok(new URL(requestUrl).searchParams.get('filter').includes('resource.labels.location="europe-west6"'));
  assert.ok(new URL(requestUrl).searchParams.getAll('aggregation.groupByFields').includes('resource.label.service_name'));
  const storageUrl = urls.find((url) => new URL(url).searchParams.get('filter')?.includes('storage.googleapis.com/network/sent_bytes_count')) || '';
  assert.ok(new URL(storageUrl).searchParams.get('filter').includes('resource.labels.bucket_name="frontaliere-ticino.firebasestorage.app"'));
  assert.equal(measurements['cloud-run-requests'].value, 14);
  assert.equal(measurements['firebase-storage-egress'].value, 12);
  assert.equal(urls.length, COST_DRIVERS.length + 2);
}

async function testMonitoringApiError() {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Permission monitoring.timeSeries.list denied' } }) });
  await assert.rejects(
    measureCostDrivers({ fetchImpl, token: 't' }),
    /HTTP 403 Permission monitoring\.timeSeries\.list denied/,
  );
}

const healthyBody = (url) => {
  const filter = new URL(url).searchParams.get('filter') || '';
  return filter.includes('data_and_index_storage_bytes')
    ? { timeSeries: [{ points: [point(20, '2020-01-01T00:00:00Z'), point(21, '2020-01-08T00:00:00Z')] }] }
    : { timeSeries: [series('svc', 1)] };
};

async function testTransientMonitoringTimeoutRetry() {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) throw timeout;
    return { ok: true, status: 200, json: async () => healthyBody(url) };
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { measurements } = await measureCostDrivers({
      fetchImpl,
      token: 't',
      retryOptions: { retries: 1, retryBaseMs: 0 },
    });
    assert.equal(measurements['firestore-reads'].value, 1);
    assert.equal(calls, COST_DRIVERS.length + 2);
  } finally {
    console.warn = originalWarn;
  }
}

async function testRepeatedMonitoringTimeoutDiagnostic() {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      measureCostDrivers({
        fetchImpl,
        token: 't',
        retryOptions: { retries: 1, retryBaseMs: 0 },
      }),
      /Cloud Monitoring firestore\.googleapis\.com\/document\/read_ops_count: request timed out after 30000ms \(attempts 2\/2\)/,
    );
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
}

async function testMissingSeries() {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('write_ops_count') ? { timeSeries: [] } : healthyBody(url)),
  });
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't' });
  const evaluation = evaluateCostDrivers(measurements);
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-writes']);
  assert.ok(renderCostReport(evaluation).includes('measurements and diagnostics are withheld'));
}

async function testSingleStorageObservation() {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('data_and_index_storage_bytes') ? { timeSeries: [{ points: [point(27)] }] } : healthyBody(url)),
  });
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't' });
  assert.deepEqual(evaluateCostDrivers(measurements).missing.map((row) => row.driver.key), [STORAGE_DRIVER.key]);
}

async function testUnreadablePoint() {
  assert.equal(Number.isNaN(sumSeries([{ points: [{ value: {} }] }])), true);
  assert.equal(Number.isNaN(sumSeries([])), true);
  const evaluation = evaluateCostDrivers({ ...syntheticOverThreshold, 'firestore-reads': { value: sumSeries([{ points: [{ value: { int64Value: 'x' } }] }]) } });
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-reads']);
}

async function testUnreadableJson() {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(measureCostDrivers({ fetchImpl, token: 't' }), /HTTP 200 with an unreadable JSON body/);
}

async function testProjectTotals() {
  const egress = (...gib) => evaluateCostDrivers({
    ...syntheticOverThreshold,
    'firestore-reads': { value: 1 },
    'cloud-run-egress': { value: gib.reduce((sum, value) => sum + value, 0) * GIB },
    'cloud-run-instance-time': { value: 10_000 },
  }).breaches.map((row) => row.driver.key);
  assert.deepEqual(egress(3, 3), ['cloud-run-egress']);
  assert.deepEqual(egress(6), ['cloud-run-egress']);
  assert.deepEqual(egress(2, 2), []);
}

async function testRequestAndStorageThresholds() {
  const evaluation = evaluateCostDrivers({
    ...syntheticOverThreshold,
    'firestore-reads': { value: 1 },
    'cloud-run-egress': { value: 1 },
    'cloud-run-instance-time': { value: 10_000 },
    'cloud-run-requests': { value: 190_000 },
    'firebase-storage-egress': { value: 2.1 * GIB, breakdown: [{ name: 'synthetic-bucket', value: 2.1 * GIB }] },
  });
  assert.deepEqual(evaluation.breaches.map((row) => row.driver.key), ['firebase-storage-egress']);
}

const tests = [
  ['synthetic over-threshold evaluation', testOverThresholdEvaluation],
  ['normal evaluation', testNormalEvaluation],
  ['missing driver', testMissingDriver],
  ['stable issue title', testStableIssueTitle],
  ['report contributors', testReportContributors],
  ['healthy report', testHealthyReport],
  ['series sum', testSeriesSum],
  ['series breakdown', testSeriesBreakdown],
  ['daily growth', testDailyGrowth],
  ['cost driver paging', testCostDriverPaging],
  ['monitoring API error', testMonitoringApiError],
  ['transient Monitoring timeout retry', testTransientMonitoringTimeoutRetry],
  ['repeated Monitoring timeout diagnostic', testRepeatedMonitoringTimeoutDiagnostic],
  ['missing series', testMissingSeries],
  ['single storage observation', testSingleStorageObservation],
  ['unreadable point', testUnreadablePoint],
  ['unreadable JSON', testUnreadableJson],
  ['project totals', testProjectTotals],
  ['request and Storage thresholds', testRequestAndStorageThresholds],
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
