import assert from 'node:assert/strict';
import {
  breakdownSeries,
  COST_DRIVERS,
  dailyGrowth,
  evaluateCostDrivers,
  FIRESTORE_READ_ATTRIBUTION_METRIC,
  GCP_COST_ISSUE_TITLE,
  measureFirestoreReadAttribution,
  measureCostDrivers,
  renderCostReport,
  STORAGE_DRIVER,
  sumSeries,
} from '../scripts/monitor-gcp-costs.mjs';

const GIB = 1024 ** 3;
const point = (value, endTime = '2026-10-01T18:00:00Z') => ({ interval: { endTime }, value: { int64Value: String(value) } });
const series = (service, ...values) => ({ resource: { labels: { service_name: service } }, points: values.map((value) => point(value)) });
const incidentDay = {
  'firestore-reads': { value: 75_430_000 },
  'firestore-writes': { value: 257_769 },
  'cloud-run-egress': { value: 12.73 * GIB, breakdown: [{ name: 'getplateauctions', value: 12.68 * GIB }] },
  'cloud-run-instance-time': { value: 39_323, breakdown: [{ name: 'getplateauctions', value: 24_174 }, { name: 'getpublicconfig', value: 3_085 }] },
  'firestore-storage-growth': { value: 1.33 * GIB, level: 27.47 * GIB },
};

async function testIncidentEvaluation() {
  const evaluation = evaluateCostDrivers(incidentDay);
  assert.deepEqual(evaluation.breaches.map((row) => row.driver.key), ['firestore-reads', 'cloud-run-egress']);
  assert.deepEqual(evaluation.missing, []);
}

async function testNormalEvaluation() {
  const evaluation = evaluateCostDrivers({
    'firestore-reads': { value: 800_000 },
    'firestore-writes': { value: 250_000 },
    'cloud-run-egress': { value: 0.15 * GIB },
    'cloud-run-instance-time': { value: 11_500 },
    'firestore-storage-growth': { value: 0.4 * GIB, level: 9 * GIB },
  });
  assert.deepEqual(evaluation.breaches, []);
}

async function testMissingDriver() {
  const { 'firestore-writes': _omitted, ...partial } = incidentDay;
  const evaluation = evaluateCostDrivers(partial);
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-writes']);
}

async function testStableIssueTitle() {
  assert.doesNotMatch(GCP_COST_ISSUE_TITLE, /\d/);
}

async function testReportContributors() {
  const report = renderCostReport(evaluateCostDrivers(incidentDay), { windowEnd: '2026-10-01T18:34:36Z' });
  assert.ok(report.includes('| Letture Firestore | 75.43 M | 5.00 M | 26.33 |'));
  assert.ok(report.includes('**Egress internet di Cloud Run, primi contributori:** `getplateauctions` 12.68 GiB'));
  assert.ok(report.includes('**Servizi Cloud Run con più tempo istanza nelle 24 h:** `getplateauctions`'));
  assert.ok(report.includes('Storage Firestore attuale: 27.47 GiB.'));
  assert.ok(report.includes('**1-CAUSA (ipotesi):**'));
}

async function testHealthyReport() {
  const report = renderCostReport(evaluateCostDrivers({ ...incidentDay, 'firestore-reads': { value: 1 }, 'cloud-run-egress': { value: 1 } }));
  assert.equal(report.includes('1-CAUSA'), false);
  assert.equal(report.includes('più tempo istanza'), false);
}

async function testFirestoreAttributionReport() {
  const report = renderCostReport(evaluateCostDrivers(incidentDay), {
    windowEnd: '2026-10-01T18:34:36Z',
    totalFirestoreReads: 75_430_000,
    firestoreAttribution: {
      callers: [
        { name: 'workflow=nightly;run=42;script=scan.mjs', value: 70_000_000 },
        { name: 'workflow=hourly;run=43;script=report.mjs', value: 4_000_000 },
      ],
      attributed: 74_000_000,
    },
  });
  assert.ok(report.includes('**Attribuzione letture Firestore, primi 5 chiamanti:**'));
  assert.ok(report.includes('`workflow=nightly;run=42;script=scan.mjs` 70.00 M'));
  assert.ok(report.includes('**Quota non attribuita:** 1.43 M (totale 75.43 M meno attribuito 74.00 M)'));
  assert.ok(report.includes('Cloud Functions o browser'));
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
  const growth = dailyGrowth([{ points: [point(10 * GIB, '2026-09-24T00:00:00Z'), point(17 * GIB, '2026-10-01T00:00:00Z')] }]);
  assert.equal(growth.level, 17 * GIB);
  assert.ok(Math.abs(growth.perDay - GIB) < 1e-6 * GIB);
}

async function testAttributionMetricQuery() {
  const result = await measureFirestoreReadAttribution({
    token: 't',
    start: new Date('2026-10-01T00:00:00Z'),
    end: new Date('2026-10-02T00:00:00Z'),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.ok(parsed.searchParams.get('filter').includes(`metric.type="${FIRESTORE_READ_ATTRIBUTION_METRIC}"`));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          timeSeries: [
            { metric: { labels: { caller: 'workflow=one;run=1;script=a.mjs' } }, points: [point(7)] },
            { metric: { labels: { caller: 'workflow=two;run=2;script=b.mjs' } }, points: [point(3)] },
          ],
        }),
      };
    },
  });
  assert.equal(result.attributed, 10);
  assert.deepEqual(result.callers.map((item) => item.name), [
    'workflow=one;run=1;script=a.mjs',
    'workflow=two;run=2;script=b.mjs',
  ]);
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
          ? { timeSeries: [{ points: [point(20 * GIB, '2026-09-24T00:00:00Z'), point(27 * GIB, '2026-10-01T00:00:00Z')] }] }
          : { timeSeries: [series('getplateauctions', 10)] };
    return { ok: true, status: 200, json: async () => body };
  };
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't', now: new Date('2026-10-01T18:00:00Z') });
  assert.equal(measurements['firestore-reads'].value, 6_000_000);
  assert.ok(Math.abs(measurements[STORAGE_DRIVER.key].value - GIB) < 1e-6 * GIB);
  const egressUrl = urls.find((url) => url.includes('sent_bytes_count')) || '';
  assert.ok(new URL(egressUrl).searchParams.get('filter').includes('metric.label.kind="internet"'));
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
    ? { timeSeries: [{ points: [point(20 * GIB, '2026-09-24T00:00:00Z'), point(21 * GIB, '2026-10-01T00:00:00Z')] }] }
    : { timeSeries: [series('svc', 1)] };
};

async function testMissingSeries() {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('write_ops_count') ? { timeSeries: [] } : healthyBody(url)),
  });
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't' });
  const evaluation = evaluateCostDrivers(measurements);
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-writes']);
  assert.ok(renderCostReport(evaluation).includes('| Scritture Firestore | n/d | 1.00 M | n/d | ~250 k/giorno (09/2026) | MANCANTE |'));
}

async function testSingleStorageObservation() {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('data_and_index_storage_bytes') ? { timeSeries: [{ points: [point(27 * GIB)] }] } : healthyBody(url)),
  });
  const { measurements } = await measureCostDrivers({ fetchImpl, token: 't' });
  assert.deepEqual(evaluateCostDrivers(measurements).missing.map((row) => row.driver.key), [STORAGE_DRIVER.key]);
}

async function testUnreadablePoint() {
  assert.equal(Number.isNaN(sumSeries([{ points: [{ value: {} }] }])), true);
  assert.equal(Number.isNaN(sumSeries([])), true);
  const evaluation = evaluateCostDrivers({ ...incidentDay, 'firestore-reads': { value: sumSeries([{ points: [{ value: { int64Value: 'x' } }] }]) } });
  assert.deepEqual(evaluation.missing.map((row) => row.driver.key), ['firestore-reads']);
}

async function testUnreadableJson() {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(measureCostDrivers({ fetchImpl, token: 't' }), /HTTP 200 with an unreadable JSON body/);
}

async function testProjectTotals() {
  const egress = (...gib) => evaluateCostDrivers({
    ...incidentDay,
    'firestore-reads': { value: 1 },
    'cloud-run-egress': { value: gib.reduce((sum, value) => sum + value, 0) * GIB },
  }).breaches.map((row) => row.driver.key);
  assert.deepEqual(egress(3, 3), ['cloud-run-egress']);
  assert.deepEqual(egress(6), ['cloud-run-egress']);
  assert.deepEqual(egress(2, 2), []);
}

const tests = [
  ['incident evaluation', testIncidentEvaluation],
  ['normal evaluation', testNormalEvaluation],
  ['missing driver', testMissingDriver],
  ['stable issue title', testStableIssueTitle],
  ['report contributors', testReportContributors],
  ['healthy report', testHealthyReport],
  ['Firestore attribution report', testFirestoreAttributionReport],
  ['series sum', testSeriesSum],
  ['series breakdown', testSeriesBreakdown],
  ['daily growth', testDailyGrowth],
  ['attribution metric query', testAttributionMetricQuery],
  ['cost driver paging', testCostDriverPaging],
  ['monitoring API error', testMonitoringApiError],
  ['missing series', testMissingSeries],
  ['single storage observation', testSingleStorageObservation],
  ['unreadable point', testUnreadablePoint],
  ['unreadable JSON', testUnreadableJson],
  ['project totals', testProjectTotals],
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
