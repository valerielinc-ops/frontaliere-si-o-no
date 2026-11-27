import { describe, expect, it } from 'vitest';
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
const point = (value: number, endTime = '2020-01-08T00:00:00Z') => ({ interval: { endTime }, value: { int64Value: String(value) } });
const series = (service: string, ...values: number[]) => ({ resource: { labels: { service_name: service } }, points: values.map((value) => point(value)) });

const threshold = (key: string) => COST_DRIVERS.find((driver) => driver.key === key)!.threshold;
const syntheticOverThreshold = {
  'firestore-reads': { value: threshold('firestore-reads') + 1, breakdown: [{ name: 'synthetic-private-caller-marker', value: 1 }] },
  'firestore-writes': { value: 0 },
  'cloud-run-egress': { value: threshold('cloud-run-egress') + 1, breakdown: [{ name: 'synthetic-private-service-marker', value: 1 }] },
  'cloud-run-requests': { value: 0 },
  'cloud-run-instance-time': { value: threshold('cloud-run-instance-time') + 1, breakdown: [{ name: 'synthetic-private-service-marker', value: 1 }] },
  'firebase-storage-egress': { value: 0 },
  'firestore-storage-growth': { value: 0, level: 0 },
};

describe('GCP cost monitor: evaluation', () => {
  it('detects synthetic values above the configured guards', () => {
    const evaluation = evaluateCostDrivers(syntheticOverThreshold);
    expect(evaluation.breaches.map((row) => row.driver.key)).toEqual(['firestore-reads', 'cloud-run-egress', 'cloud-run-instance-time']);
    expect(evaluation.missing).toEqual([]);
  });

  it('keeps synthetic values under every threshold', () => {
    const evaluation = evaluateCostDrivers({
      'firestore-reads': { value: 1 },
      'firestore-writes': { value: 1 },
      'cloud-run-egress': { value: 1 },
      'cloud-run-requests': { value: 1 },
      'cloud-run-instance-time': { value: 1 },
      'firebase-storage-egress': { value: 1 },
      'firestore-storage-growth': { value: 0, level: 1 },
    });
    expect(evaluation.breaches).toEqual([]);
  });

  it('reports a driver without a measurement as missing, never as healthy', () => {
    const { 'firestore-writes': _omitted, ...partial } = syntheticOverThreshold;
    const evaluation = evaluateCostDrivers(partial);
    expect(evaluation.missing.map((row) => row.driver.key)).toEqual(['firestore-writes']);
  });

  it('keeps the issue title stable and free of measurements for the 60-char dedup', () => {
    expect(GCP_COST_ISSUE_TITLE).not.toMatch(/\d/);
  });

  it('sets the new request, instance-time and bucket traffic guards', () => {
    expect(COST_DRIVERS.find((driver) => driver.key === 'cloud-run-requests')).toMatchObject({
      metric: 'run.googleapis.com/request_count',
      breakdownBy: 'resource.label.service_name',
      threshold: 200_000,
    });
    expect(COST_DRIVERS.find((driver) => driver.key === 'cloud-run-instance-time')?.threshold).toBe(20_000);
    expect(COST_DRIVERS.find((driver) => driver.key === 'firebase-storage-egress')).toMatchObject({
      metric: 'storage.googleapis.com/network/sent_bytes_count',
      threshold: 2 * GIB,
    });
  });
});

describe('GCP cost monitor: report', () => {
  it('keeps measurements and diagnostics out of the public issue body', () => {
    const report = renderCostReport(evaluateCostDrivers(syntheticOverThreshold));
    expect(report).toContain('GCP cost monitor alert');
    expect(report).toContain('measurements and diagnostics are withheld');
    expect(report).not.toContain('synthetic-private-caller-marker');
    expect(report).not.toContain('synthetic-private-service-marker');
  });

  it('omits the investigation card on a healthy day', () => {
    const report = renderCostReport(evaluateCostDrivers({
      ...syntheticOverThreshold,
      'firestore-reads': { value: 1 },
      'cloud-run-egress': { value: 1 },
      'cloud-run-instance-time': { value: 10_000 },
      'firestore-storage-growth': { value: 1, level: 27 * GIB },
    }));
    expect(report).not.toContain('1-CAUSA');
    expect(report).not.toContain('più tempo istanza');
  });

});

describe('GCP cost monitor: series helpers', () => {
  it('sums int64 and double points across series', () => {
    expect(sumSeries([series('a', 1, 2), { points: [{ value: { doubleValue: 0.5 } }] }])).toBe(3.5);
  });

  it('ranks services by total, largest first', () => {
    expect(breakdownSeries([series('small', 1), series('big', 5, 5), series('mid', 3)], 'resource.label.service_name', 2))
      .toEqual([{ name: 'big', value: 10 }, { name: 'mid', value: 3 }]);
  });

  it('measures storage growth per day between the oldest and newest point', () => {
    const growth = dailyGrowth([{ points: [point(10, '2020-01-01T00:00:00Z'), point(17, '2020-01-08T00:00:00Z')] }]);
    expect(growth.level).toBe(17);
    expect(growth.perDay).toBeCloseTo(1, 6);
  });
});

describe('GCP cost monitor: Cloud Monitoring calls', () => {
  it('pages every driver and scopes request and Storage metrics to their resources', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
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
    const { measurements } = await measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't', now: new Date('2020-01-08T00:00:00Z') });
    expect(measurements['firestore-reads'].value).toBe(6);
    expect(measurements[STORAGE_DRIVER.key].value).toBeCloseTo(1, 6);
    const egressUrl = urls.find((url) => url.includes('sent_bytes_count')) || '';
    expect(new URL(egressUrl).searchParams.get('filter')).toContain('metric.label.kind="internet"');
    const requestUrl = urls.find((url) => url.includes('request_count')) || '';
    expect(new URL(requestUrl).searchParams.get('filter')).toContain('resource.labels.location="europe-west6"');
    expect(new URL(requestUrl).searchParams.getAll('aggregation.groupByFields')).toContain('resource.label.service_name');
    const storageUrl = urls.find((url) => new URL(url).searchParams.get('filter')?.includes('storage.googleapis.com/network/sent_bytes_count')) || '';
    expect(new URL(storageUrl).searchParams.get('filter')).toContain('resource.labels.bucket_name="frontaliere-ticino.firebasestorage.app"');
    expect(measurements['cloud-run-requests'].value).toBe(14);
    expect(measurements['firebase-storage-egress'].value).toBe(12);
    expect(urls).toHaveLength(COST_DRIVERS.length + 2);
  });

  it('fails loudly on an API error instead of reporting zero', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Permission monitoring.timeSeries.list denied' } }) });
    await expect(measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't' })).rejects.toThrow('HTTP 403 Permission monitoring.timeSeries.list denied');
  });

  // Review on 10805: telemetry that cannot be read must never look like a
  // healthy day, or the monitor would close the issue.
  const healthyBody = (url: string) => {
    const filter = new URL(url).searchParams.get('filter') || '';
    return filter.includes('data_and_index_storage_bytes')
      ? { timeSeries: [{ points: [point(20, '2020-01-01T00:00:00Z'), point(21, '2020-01-08T00:00:00Z')] }] }
      : { timeSeries: [series('svc', 1)] };
  };

  it('retries one transient Monitoring timeout and completes the measurement', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockImplementation(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => healthyBody(url),
      }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { measurements } = await measureCostDrivers({
      fetchImpl: fetchImpl as never,
      token: 't',
      retryOptions: { retries: 1, retryBaseMs: 0 },
    });

    expect(measurements['firestore-reads'].value).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(COST_DRIVERS.length + 2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('firestore.googleapis.com/document/read_ops_count'));
    warn.mockRestore();
  });

  it('names the metric and attempt budget after repeated Monitoring timeouts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(measureCostDrivers({
      fetchImpl: fetchImpl as never,
      token: 't',
      retryOptions: { retries: 1, retryBaseMs: 0 },
    })).rejects.toThrow(
      'Cloud Monitoring firestore.googleapis.com/document/read_ops_count: request timed out after 30000ms (attempts 2/2)',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reports a driver whose answer has no series as missing, not as zero', async () => {
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('write_ops_count') ? { timeSeries: [] } : healthyBody(url)),
    });
    const { measurements } = await measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't' });
    const evaluation = evaluateCostDrivers(measurements);
    expect(evaluation.missing.map((row) => row.driver.key)).toEqual(['firestore-writes']);
    expect(renderCostReport(evaluation)).toContain('measurements and diagnostics are withheld');
  });

  it('keeps request volume below the guard but alarms on excess bucket egress', () => {
    const evaluation = evaluateCostDrivers({
      ...syntheticOverThreshold,
      'firestore-reads': { value: 1 },
      'cloud-run-egress': { value: 1 },
      'cloud-run-instance-time': { value: 10_000 },
      'cloud-run-requests': { value: 190_000 },
      'firebase-storage-egress': { value: 2.1 * GIB, breakdown: [{ name: 'synthetic-bucket', value: 2.1 * GIB }] },
    });
    expect(evaluation.breaches.map((row) => row.driver.key)).toEqual(['firebase-storage-egress']);
  });

  it('reports storage growth as missing with a single observation', async () => {
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('data_and_index_storage_bytes') ? { timeSeries: [{ points: [point(27)] }] } : healthyBody(url)),
    });
    const { measurements } = await measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't' });
    expect(evaluateCostDrivers(measurements).missing.map((row) => row.driver.key)).toEqual([STORAGE_DRIVER.key]);
  });

  it('reports a point without a readable value as missing', () => {
    expect(Number.isNaN(sumSeries([{ points: [{ value: {} }] }]))).toBe(true);
    expect(Number.isNaN(sumSeries([]))).toBe(true);
    expect(evaluateCostDrivers({ ...syntheticOverThreshold, 'firestore-reads': { value: sumSeries([{ points: [{ value: { int64Value: 'x' } }] }]) } })
      .missing.map((row) => row.driver.key)).toEqual(['firestore-reads']);
  });

  it('fails on an unreadable JSON body instead of reporting zero', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't' })).rejects.toThrow('HTTP 200 with an unreadable JSON body');
  });
});

describe('GCP cost monitor: thresholds apply to the project total', () => {
  // The bill counts the total: two services at 3 GiB cost as much as one at 6.
  const egress = (...gib: number[]) => evaluateCostDrivers({
    ...syntheticOverThreshold,
    'firestore-reads': { value: 1 },
    'cloud-run-egress': { value: gib.reduce((sum, value) => sum + value, 0) * GIB },
    'cloud-run-instance-time': { value: 10_000 },
  }).breaches.map((row) => row.driver.key);

  it('alarms on two services under the threshold whose total is over it', () => {
    expect(egress(3, 3)).toEqual(['cloud-run-egress']);
    expect(egress(6)).toEqual(['cloud-run-egress']);
    expect(egress(2, 2)).toEqual([]);
  });
});
