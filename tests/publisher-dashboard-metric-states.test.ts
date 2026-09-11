import { describe, expect, it } from 'vitest';
import {
  countPublisherApplications,
  readPublisherJobMetrics,
  summarizePublisherDashboardMetrics,
} from '@/components/pages/PublisherDashboardPage';

/**
 * V6 §7(a) — a counter that was never read is not a counter that read zero.
 *
 * The dashboard used to initialise every row to `{ views: 0, applyClicks: 0,
 * status: 'available' }` and then leave those values in place when `getDoc`
 * rejected, when the events document did not exist, or when the stored value
 * was not a number (`Number(e.views) || 0`). All three became an observed `0`
 * on screen — a measurement the system never made, shown to the publisher as
 * if it had.
 *
 * Three outcomes, three distinct states, none of them a number:
 *   - the read failed            → `source-unavailable`
 *   - the document is not there  → `data-missing`
 *   - the stored value is junk   → `data-missing`
 * Only a real, non-negative, finite number is `observed`.
 */

describe('publisher job metrics are read fail-closed', () => {
  it('reports source-unavailable when the counter read fails', () => {
    const metrics = readPublisherJobMetrics({ ok: false });
    expect(metrics).toMatchObject({
      views: null,
      applyClicks: null,
      state: 'source-unavailable',
    });
    expect(metrics.applyClicksDeduplication.status).toBe('dedup non disponibile');
  });

  it('reports data-missing when the events document does not exist', () => {
    const metrics = readPublisherJobMetrics({ ok: true, exists: false });
    expect(metrics).toMatchObject({
      views: null,
      applyClicks: null,
      state: 'data-missing',
    });
    expect(metrics.applyClicksDeduplication.status).toBe('dedup non disponibile');
  });

  it('reports data-missing for a stored value that is not a number', () => {
    for (const junk of ['12', null, undefined, Number.NaN, {}, [], -1, 1.5 as unknown]) {
      const metrics = readPublisherJobMetrics({
        ok: true,
        exists: true,
        data: { views: junk, applyClicks: 3 },
      });
      expect(metrics.views, `views for ${JSON.stringify(junk) ?? String(junk)}`).toBeNull();
      expect(metrics.state).toBe('data-missing');
    }
  });

  it('reports data-missing when a counter field is absent from an existing document', () => {
    const metrics = readPublisherJobMetrics({ ok: true, exists: true, data: { views: 7 } });
    expect(metrics.views).toBe(7);
    expect(metrics.applyClicks).toBeNull();
    expect(metrics.state).toBe('data-missing');
  });

  it('reports an observed zero as an observed zero', () => {
    const metrics = readPublisherJobMetrics({
      ok: true,
      exists: true,
      data: { views: 0, applyClicks: 0 },
    });
    expect(metrics).toMatchObject({ views: 0, applyClicks: 0, state: 'observed' });
    expect(metrics.applyClicksDeduplication.status).toBe('available');
  });

  it('keeps the deduplication state of an observed document', () => {
    const metrics = readPublisherJobMetrics({
      ok: true,
      exists: true,
      data: { views: 64, applyClicks: 64, applyClicksDedupUnavailable: 1 },
    });
    expect(metrics).toMatchObject({ views: 64, applyClicks: 64, state: 'observed' });
    expect(metrics.applyClicksDeduplication).toEqual({
      status: 'dedup non disponibile',
      unavailableCount: 1,
    });
  });
});

describe('the dashboard summary never turns an unmeasured row into a number', () => {
  const observed = (views: number, applyClicks: number) => ({
    views,
    applyClicks,
    applyClicksDeduplication: { status: 'available' as const, unavailableCount: 0 },
  });

  it('totals observed rows', () => {
    const summary = summarizePublisherDashboardMetrics([observed(10, 2), observed(5, 1)], 3);
    expect(summary).toMatchObject({ views: 15, clicks: 3, applications: 3 });
  });

  it('reports views as unavailable when any row was not measured', () => {
    const summary = summarizePublisherDashboardMetrics(
      [
        observed(10, 2),
        { views: null, applyClicks: null, applyClicksDeduplication: { status: 'dedup non disponibile', unavailableCount: 0 } },
      ],
      3,
    );
    // A total built on an unread row would be a smaller number presented as
    // complete — the one failure mode a commercial report must not have.
    expect(summary.views).toBeNull();
    expect(summary.clicks).toBeNull();
    expect(summary.intentRate).toBeNull();
  });

  it('reports clicks as unavailable when only the click counter is missing', () => {
    const summary = summarizePublisherDashboardMetrics(
      [
        observed(10, 2),
        { views: 5, applyClicks: null, applyClicksDeduplication: { status: 'dedup non disponibile', unavailableCount: 0 } },
      ],
      3,
    );
    expect(summary.views).toBe(15);
    expect(summary.clicks).toBeNull();
    expect(summary.intentRate).toBeNull();
  });
});

describe('publisher applications preserve the read outcome', () => {
  it('keeps a failed query unavailable while preserving an observed zero', () => {
    expect(countPublisherApplications(null)).toBeNull();
    expect(countPublisherApplications([])).toBe(0);
    expect(summarizePublisherDashboardMetrics([], null).applications).toBeNull();
    expect(summarizePublisherDashboardMetrics([], 0).applications).toBe(0);
  });
});

/**
 * Sibling of the same class, on the WRITE side (AGENTS.md §6: fix the class,
 * not the file the report named). `Number(data.applyClicksDedupUnavailable) || 0`
 * turned a malformed stored counter into `0`, and the status written on that
 * transaction is decided by that number — so a junk value downgraded a
 * document that is NOT provably deduplicated back to `available`. Same
 * construct, same direction of error, on the value the read side then trusts.
 */
describe('the stored deduplication counter is resolved fail-closed on write', () => {
  it('adds a well-formed previous counter', async () => {
    const { resolveApplyClickDedupState } = await import('@/services/publisherAnalyticsService');
    expect(resolveApplyClickDedupState(2, 1)).toEqual({
      status: 'dedup non disponibile',
      unavailableCount: 3,
    });
  });

  it('treats an absent previous counter as zero, not as unknown', async () => {
    const { resolveApplyClickDedupState } = await import('@/services/publisherAnalyticsService');
    // A document written before the ledger existed simply has no counter yet.
    expect(resolveApplyClickDedupState(undefined, 0)).toEqual({
      status: 'available',
      unavailableCount: 0,
    });
  });

  it('never downgrades to available on a malformed previous counter', async () => {
    const { resolveApplyClickDedupState } = await import('@/services/publisherAnalyticsService');
    for (const junk of ['3', null, Number.NaN, -1, {}, [], 1.5]) {
      const state = resolveApplyClickDedupState(junk, 0);
      expect(state.status, `stored value ${JSON.stringify(junk) ?? String(junk)}`)
        .toBe('dedup non disponibile');
    }
  });
});
