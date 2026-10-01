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
const point = (value: number, endTime = '2026-10-01T18:00:00Z') => ({ interval: { endTime }, value: { int64Value: String(value) } });
const series = (service: string, ...values: number[]) => ({ resource: { labels: { service_name: service } }, points: values.map((value) => point(value)) });

// The 24 h ending 2026-10-01 18:34 UTC, measured live with this script.
const incidentDay = {
  'firestore-reads': { value: 75_430_000 },
  'firestore-writes': { value: 257_769 },
  'cloud-run-egress': { value: 12.73 * GIB, breakdown: [{ name: 'getplateauctions', value: 12.68 * GIB }] },
  'cloud-run-instance-time': { value: 39_323, breakdown: [{ name: 'getplateauctions', value: 24_174 }, { name: 'getpublicconfig', value: 3_085 }] },
  'firestore-storage-growth': { value: 1.33 * GIB, level: 27.47 * GIB },
};

describe('GCP cost monitor: evaluation', () => {
  it('flags the September incident day on reads and egress, not on the rest', () => {
    const evaluation = evaluateCostDrivers(incidentDay);
    expect(evaluation.breaches.map((row) => row.driver.key)).toEqual(['firestore-reads', 'cloud-run-egress']);
    expect(evaluation.missing).toEqual([]);
  });

  it('keeps a normal early-September day under every threshold', () => {
    const evaluation = evaluateCostDrivers({
      'firestore-reads': { value: 800_000 },
      'firestore-writes': { value: 250_000 },
      'cloud-run-egress': { value: 0.15 * GIB },
      'cloud-run-instance-time': { value: 11_500 },
      'firestore-storage-growth': { value: 0.4 * GIB, level: 9 * GIB },
    });
    expect(evaluation.breaches).toEqual([]);
  });

  it('reports a driver without a measurement as missing, never as healthy', () => {
    const { 'firestore-writes': _omitted, ...partial } = incidentDay;
    const evaluation = evaluateCostDrivers(partial);
    expect(evaluation.missing.map((row) => row.driver.key)).toEqual(['firestore-writes']);
  });

  it('keeps the issue title stable and free of measurements for the 60-char dedup', () => {
    expect(GCP_COST_ISSUE_TITLE).not.toMatch(/\d/);
  });
});

describe('GCP cost monitor: report', () => {
  it('names the over-threshold drivers, their main contributors and the heaviest services', () => {
    const report = renderCostReport(evaluateCostDrivers(incidentDay), { windowEnd: '2026-10-01T18:34:36Z' });
    expect(report).toContain('| Letture Firestore | 75.43 M | 5.00 M | 26.33 |');
    expect(report).toContain('**Egress internet di Cloud Run, primi contributori:** `getplateauctions` 12.68 GiB');
    // Ranked by work: the September culprit made few, heavy calls.
    expect(report).toContain('**Servizi Cloud Run con più tempo istanza nelle 24 h:** `getplateauctions`');
    expect(report).toContain('Storage Firestore attuale: 27.47 GiB.');
    expect(report).toContain('**1-CAUSA (ipotesi):**');
  });

  it('omits the investigation card on a healthy day', () => {
    const report = renderCostReport(evaluateCostDrivers({ ...incidentDay, 'firestore-reads': { value: 1 }, 'cloud-run-egress': { value: 1 } }));
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
    const growth = dailyGrowth([{ points: [point(10 * GIB, '2026-09-24T00:00:00Z'), point(17 * GIB, '2026-10-01T00:00:00Z')] }]);
    expect(growth.level).toBe(17 * GIB);
    expect(growth.perDay).toBeCloseTo(GIB, 6);
  });
});

describe('GCP cost monitor: Cloud Monitoring calls', () => {
  it('pages through every driver and applies the internet-egress filter', async () => {
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
            ? { timeSeries: [{ points: [point(20 * GIB, '2026-09-24T00:00:00Z'), point(27 * GIB, '2026-10-01T00:00:00Z')] }] }
            : { timeSeries: [series('getplateauctions', 10)] };
      return { ok: true, status: 200, json: async () => body };
    };
    const { measurements } = await measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't', now: new Date('2026-10-01T18:00:00Z') });
    expect(measurements['firestore-reads'].value).toBe(6_000_000);
    expect(measurements[STORAGE_DRIVER.key].value).toBeCloseTo(GIB, 6);
    const egressUrl = urls.find((url) => url.includes('sent_bytes_count')) || '';
    expect(new URL(egressUrl).searchParams.get('filter')).toContain('metric.label.kind="internet"');
    expect(urls).toHaveLength(COST_DRIVERS.length + 2);
  });

  it('fails loudly on an API error instead of reporting zero', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Permission monitoring.timeSeries.list denied' } }) });
    await expect(measureCostDrivers({ fetchImpl: fetchImpl as never, token: 't' })).rejects.toThrow('HTTP 403 Permission monitoring.timeSeries.list denied');
  });
});
