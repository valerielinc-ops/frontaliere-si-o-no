import { describe, expect, it } from 'vitest';
import { summarizeHouseOrders, summarizeHouseTraffic } from '../scripts/analytics/house-ad-readout.mjs';

describe('house creative readout', () => {
  it('separates enrolled/fixed traffic and never manufactures CTR without impressions', () => {
    const row = (event: string, component: string, n: number) => ({ dimensionValues: [event, component, 'rectangle.article-inline', 'mobile'].map(value => ({ value })), metricValues: [{ value: String(n) }] });
    expect(summarizeHouseTraffic({ rowCount: 3, rows: [row('house_ad_impression', 'control_v1.test.it', 100), row('house_ad_click', 'control_v1.test.it', 5), row('house_ad_click', 'control_v1.fixed.it', 1)] })).toEqual([
      expect.objectContaining({ enrolled: true, impressions: 100, clicks: 5, ctr: .05 }),
      expect.objectContaining({ enrolled: false, impressions: 0, clicks: 1, ctr: null }),
    ]);
    expect(() => summarizeHouseTraffic({ rowCount: 2, rows: [] })).toThrow('truncated');
  });
  it('counts only verified paid ledger entries and separates refunds and unpaid orders', () => {
    const now = Date.now();
    const attribution = { campaign: 'job_search_automation', variant: 'control', creativeId: 'control_v1', format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true, clickedAt: now - 2000 };
    const service = { createdAt: { toMillis: () => now - 1000 }, houseAdAttribution: attribution, amountTotal: 3999, currency: 'eur' };
    const result = summarizeHouseOrders([
      { ...service, paymentStatus: 'pending' },
      { ...service, paymentStatus: 'paid' },
      { ...service, paymentStatus: 'paid', paidAt: { toMillis: () => now } },
      { ...service, paymentStatus: 'refunded', paidAt: { toMillis: () => now } },
    ], now - 86400000, now + 1);
    expect(result).toEqual([expect.objectContaining({ initiatedOrders: 4, confirmedPurchases: 1, refundedOrders: 1, confirmedRevenueEurCents: 3999 })]);
  });
});
