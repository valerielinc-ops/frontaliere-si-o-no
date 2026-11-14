import { describe, expect, it } from 'vitest';
import {
  summarizeHouseOrders, summarizeHouseTraffic, summarizeHouseTrafficTotals, summarizeReaderSubscriptionPurchases,
  summarizeReaderSubscriptionResults, summarizeReaderSubscriptionTraffic,
} from '../scripts/analytics/house-ad-readout.mjs';

describe('house creative readout', () => {
  it('separates enrolled/fixed traffic and never manufactures CTR without impressions', () => {
    const row = (event: string, component: string, n: number, users = n) => ({ dimensionValues: [event, component, 'rectangle.article-inline', 'mobile'].map(value => ({ value })), metricValues: [{ value: String(n) }, { value: String(users) }] });
    expect(summarizeHouseTraffic({ rowCount: 3, rows: [row('house_ad_impression', 'control_v1.test.it', 100), row('house_ad_click', 'control_v1.test.it', 5), row('house_ad_click', 'control_v1.fixed.it', 1)] })).toEqual([
      expect.objectContaining({ enrolled: true, impressions: 100, clicks: 5, ctr: .05, uniqueImpressionUsers: 100, uniqueClickUsers: 5 }),
      expect.objectContaining({ enrolled: false, impressions: 0, clicks: 1, ctr: null }),
    ]);
    expect(() => summarizeHouseTraffic({ rowCount: 2, rows: [] })).toThrow('truncated');
  });
  it('keeps v2 traffic in its own experiment cohort', () => {
    const row = (event: string, component: string, n: number, users = n) => ({ dimensionValues: [event, component, 'rectangle.article-inline', 'mobile'].map(value => ({ value })), metricValues: [{ value: String(n) }, { value: String(users) }] });
    expect(summarizeHouseTraffic({ rowCount: 2, rows: [
      row('house_ad_impression', 'house_creatives_v2.control_v1.test.it', 100),
      row('house_ad_click', 'house_creatives_v2.control_v1.test.it', 5),
    ] })).toEqual([expect.objectContaining({ experimentId: 'house_creatives_v2', variant: 'control', enrolled: true, impressions: 100, clicks: 5, ctr: .05 })]);
  });
  it('segments traffic by bounded page context without exposing job text or location', () => {
    const row = (event: string, count: number) => ({
      dimensionValues: [event, 'house_creatives_v2.profile_match_v1.test.it.job_detail.logistics', 'rectangle.job-detail', 'desktop'].map(value => ({ value })),
      metricValues: [{ value: String(count) }, { value: String(count) }],
    });
    expect(summarizeHouseTraffic({ rowCount: 2, rows: [row('house_ad_impression', 20), row('house_ad_click', 3)] })).toEqual([
      expect.objectContaining({
        experimentId: 'house_creatives_v2', variant: 'profile_match', contextSource: 'job_detail', contextSector: 'logistics',
        impressions: 20, clicks: 3, ctr: .15,
      }),
    ]);
  });
  it('reports distinct GA4 users separately from event counts', () => {
    const row = (event: string, count: number, users: number) => ({
      dimensionValues: [event, 'house_creatives_v2.time_saved_v1.test.it', 'rectangle.article-inline', 'mobile'].map(value => ({ value })),
      metricValues: [{ value: String(count) }, { value: String(users) }],
    });
    expect(summarizeHouseTraffic({ rowCount: 2, rows: [
      row('house_ad_impression', 50, 42), row('house_ad_click', 6, 5),
    ] })).toEqual([expect.objectContaining({
      impressions: 50, uniqueImpressionUsers: 42,
      clicks: 6, uniqueClickUsers: 5, ctr: .12,
    })]);
  });
  it('reports pagewide distinct users at event level without summing placement users', () => {
    expect(summarizeHouseTrafficTotals({ rowCount: 2, rows: [
      { dimensionValues: [{ value: 'house_ad_impression' }], metricValues: [{ value: '300' }, { value: '120' }] },
      { dimensionValues: [{ value: 'house_ad_click' }], metricValues: [{ value: '14' }, { value: '11' }] },
    ] })).toEqual({
      house_ad_impression: { events: 300, uniqueUsers: 120 },
      house_ad_click: { events: 14, uniqueUsers: 11 },
    });
  });
  it('rejects aggregate totals that GA4 says are thresholded or merged into Other', () => {
    expect(() => summarizeHouseTraffic({ rows: [], metadata: { subjectToThresholding: true } })).toThrow('thresholding');
    expect(() => summarizeReaderSubscriptionTraffic({ rows: [], metadata: { dataLossFromOtherRow: true } })).toThrow('Other-row data loss');
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
  it('attributes verified purchases to the Firebase v2 creative arm', () => {
    const now = Date.now();
    const service = {
      createdAt: { toMillis: () => now - 1000 },
      paidAt: { toMillis: () => now },
      paymentStatus: 'paid', amountTotal: 3999, currency: 'eur',
      houseAdAttribution: {
        campaign: 'job_search_automation', experimentId: 'house_creatives_v2', assignmentSource: 'firebase_remote_config',
        variant: 'profile_match', creativeId: 'profile_match_v1', format: 'rectangle', locale: 'it',
        placement: 'article-inline', device: 'mobile', enrolled: true, contextSource: 'job_detail', contextSector: 'logistics', clickedAt: now - 2000,
      },
    };
    expect(summarizeHouseOrders([service], now - 86400000, now + 1)).toEqual([
      expect.objectContaining({ experimentId: 'house_creatives_v2', variant: 'profile_match', enrolled: true, contextSource: 'job_detail', contextSector: 'logistics', confirmedPurchases: 1, confirmedRevenueEurCents: 3999 }),
    ]);
  });
  it('compares viewable impression CTR by assigned arm and reports subscription-card CTR separately', () => {
    const row = (event: string, component: string, n: number, users = n) => ({ dimensionValues: [event, component, 'rectangle.article-inline', 'mobile'].map(value => ({ value })), metricValues: [{ value: String(n) }, { value: String(users) }] });
    const result = summarizeReaderSubscriptionTraffic({ rowCount: 8, rows: [
      row('reader_subscription_experiment_exposure', 'reader_subscription_house_v1.control.test.it', 80, 75),
      row('reader_subscription_experiment_exposure', 'reader_subscription_house_v1.subscription.test.it', 75),
      row('reader_subscription_experiment_impression', 'reader_subscription_house_v1.control.test.it', 80, 70),
      row('reader_subscription_experiment_click', 'reader_subscription_house_v1.control.test.it', 4),
      row('reader_subscription_experiment_impression', 'reader_subscription_house_v1.subscription.test.it', 75),
      row('reader_subscription_experiment_click', 'reader_subscription_house_v1.subscription.test.it', 9),
      row('reader_subscription_ad_impression', 'reader_subscription_house_v1.subscription.test.it', 75),
      row('reader_subscription_ad_click', 'reader_subscription_house_v1.subscription.test.it', 9),
    ] });
    expect(result).toEqual([
      expect.objectContaining({ variant: 'control', exposures: 80, uniqueExposureUsers: 75, impressions: 80, uniqueImpressionUsers: 70, clicks: 4, ctr: .05, subscriptionCardImpressions: 0, subscriptionCardClicks: 0, subscriptionCardCtr: null }),
      expect.objectContaining({ variant: 'subscription', exposures: 75, impressions: 75, clicks: 9, ctr: .12, subscriptionCardImpressions: 75, subscriptionCardClicks: 9, subscriptionCardCtr: .12 }),
    ]);
    expect(() => summarizeReaderSubscriptionTraffic({ rowCount: 2, rows: [] })).toThrow('truncated');
  });
  it('counts only Stripe-confirmed first payments with bounded experiment attribution', () => {
    const now = Date.now();
    const attribution = {
      campaign: 'reader_subscription', experimentId: 'reader_subscription_house_v1',
      assignmentSource: 'firebase_remote_config', variant: 'subscription', creativeId: 'subscription_v1',
      format: 'rectangle', locale: 'it', placement: 'article-inline', device: 'mobile', enrolled: true,
      touchpoint: 'click', attributedAt: now - 5000,
    };
    const subscriptions = [
      { firstPaidAt: { toMillis: () => now }, houseAdAttribution: attribution },
      { firstPaidAt: { toMillis: () => now }, houseAdAttribution: { ...attribution, assignmentSource: 'local_default' } },
      { firstPaidAt: { toMillis: () => now }, houseAdAttribution: { ...attribution, attributedAt: now - 8 * 86400000 } },
      { firstPaidAt: { toMillis: () => 0 }, houseAdAttribution: attribution },
    ];
    const purchases = summarizeReaderSubscriptionPurchases(subscriptions, now - 1000, now + 1);
    expect(purchases).toEqual([expect.objectContaining({ variant: 'subscription', confirmedPaidSubscriptions: 1 })]);
    expect(summarizeReaderSubscriptionResults([
      { variant: 'subscription', locale: 'it', format: 'rectangle', placement: 'article-inline', device: 'mobile', exposures: 50, impressions: 48, clicks: 6, landings: 5, ctr: .125 },
    ], purchases)).toEqual([expect.objectContaining({ confirmedPaidSubscriptions: 1, confirmedSubscriptionsPerExposedSession: .02 })]);
  });
});
