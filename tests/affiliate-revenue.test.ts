import { describe, expect, it } from 'vitest';
import {
  buildAffiliatePubref,
  buildAffiliateLinkHref,
} from '../services/affiliateService';
import {
  normalizeAffiliateTransaction,
  parseAffiliateCsv,
  reconcileAffiliateTransactions,
} from '../scripts/lib/affiliateRevenue.mjs';

describe('affiliate link attribution', () => {
  it('keeps partner, surface, position, campaign, and variant in the PII-free pubref', () => {
    expect(buildAffiliatePubref({
      partnerId: 'wise',
      surface: 'web',
      position: 'exchange-1',
      campaign: 'g4-contextual',
      variant: 'v1',
    })).toBe('wise-v1-web-exchange-1-g4-contextual');

    const longDimensions = {
      partnerId: 'creditagricole',
      surface: 'web',
      campaign: 'g4-contextual',
      variant: 'control',
    };
    const longPubref = buildAffiliatePubref({
      ...longDimensions,
      position: 'partner-page-banking-2',
    });
    expect(longPubref.length).toBeLessThanOrEqual(48);
    expect(longPubref).toMatch(/-[a-z0-9]{7}$/);
    expect(longPubref).not.toBe(buildAffiliatePubref({
      ...longDimensions,
      position: 'partner-page-banking-3',
    }));
    expect(longPubref).not.toBe(buildAffiliatePubref({
      ...longDimensions,
      position: 'partner-page-banking-2',
      campaign: 'g4-seasonal',
    }));

    const href = buildAffiliateLinkHref({ id: 'wise' }, {
      surface: 'web',
      position: 'exchange-1',
      campaign: 'g4-contextual',
      variant: 'v1',
    });
    const url = new URL(href);
    expect(url.pathname).toBe('/go/wise/');
    expect(url.searchParams.get('pos')).toContain('web-exchange-1');
    expect(url.searchParams.get('utm_campaign')).toBe('g4-contextual');
    expect(url.searchParams.get('utm_content')).toContain('v1');
    expect(url.searchParams.has('ne')).toBe(false);
    expect(url.searchParams.has('ac')).toBe(false);
    expect([...url.searchParams.keys()].some((key) => /token|email/i.test(key))).toBe(false);
  });

  it('drops accidental email/token-shaped attribution values instead of laundering them', () => {
    const href = buildAffiliateLinkHref({ id: 'wise' }, {
      surface: 'web',
      position: 'person@example.com',
      campaign: 'auth-token',
      variant: 'control',
      acquisitionSource: 'subscriber@example.com',
    });
    const url = new URL(href);
    expect(href).not.toMatch(/person|example|subscriber|auth-token|@/i);
    expect(url.searchParams.get('pos')).toContain('web-unknown');
    expect(url.searchParams.has('ne')).toBe(false);
    expect(url.searchParams.has('ac')).toBe(false);
  });
});

describe('affiliate revenue reconciliation', () => {
  const rows = [
    { network: 'partnerize', transaction_id: 'tx-1', partner_id: 'wise', status: 'pending', currency: 'CHF', amount: '2.00', transaction_date: '2026-09-02', updated_at: '2026-09-02T10:00:00Z', pubref: 'web-exchange-1-campaign-a-control-wise' },
    { network: 'partnerize', transaction_id: 'tx-1', partner_id: 'wise', status: 'approved', currency: 'CHF', amount: '2.00', transaction_date: '2026-09-02', updated_at: '2026-09-04T10:00:00Z', pubref: 'web-exchange-1-campaign-a-control-wise' },
    { network: 'partnerize', transaction_id: 'tx-2', partner_id: 'fineco', status: 'reversed', currency: 'EUR', amount: '5.00', transaction_date: '2026-09-03', updated_at: '2026-09-04T10:00:00Z', pubref: 'email-recommended-1-campaign-b-control-fineco' },
  ];

  it('deduplicates revisions and keeps pending/approved/reversed separate', () => {
    const report = reconcileAffiliateTransactions({
      rows,
      from: '2026-09-01',
      to: '2026-09-07',
      exposures: { web: 1000, email: 500 },
    });
    expect(report.status).toBe('measurable');
    expect(report.deduplicatedTransactions).toBe(2);
    expect(report.byCurrency.CHF.pending).toBe(0);
    expect(report.byCurrency.CHF.approved).toBe(2);
    expect(report.byCurrency.CHF.approvedPer1000Exposures.web).toBe(2);
    expect(report.byCurrency.CHF.approvedPer1000Exposures.email).toBe(4);
    expect(report.byCurrency.EUR.reversed).toBe(5);
    expect(report.byCurrency.EUR.approved).toBe(0);
  });

  it('is unmeasurable when the denominator is missing, never zero', () => {
    const report = reconcileAffiliateTransactions({ rows, from: '2026-09-01', to: '2026-09-07' });
    expect(report.status).toBe('unmeasurable');
    expect(report.reason).toMatch(/denominator/i);
    expect(report.byCurrency.CHF.approvedPer1000Exposures.web).toBeNull();
    expect(report.byCurrency.CHF.approvedPer1000Exposures.email).toBeNull();
  });

  it('rejects malformed rows with an explicit diagnostic', () => {
    const result = normalizeAffiliateTransaction({ status: 'approved', amount: 2, currency: 'CHF' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing transaction id');
  });

  it('parses quoted CSV cells without changing the commercial fields', () => {
    const parsed = parseAffiliateCsv('transaction_id,status,currency,amount,transaction_date\n"tx,3",approved,CHF,"2,50",2026-09-04');
    expect(parsed).toEqual([{
      transaction_id: 'tx,3',
      status: 'approved',
      currency: 'CHF',
      amount: '2,50',
      transaction_date: '2026-09-04',
    }]);
  });

  it('parses network exports with thousands and decimal separators', () => {
    expect(normalizeAffiliateTransaction({
      transaction_id: 'tx-large-us',
      status: 'approved',
      currency: 'USD',
      amount: '1,234.56',
      transaction_date: '2026-09-04',
    })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ amount: 1234.56 }) }));

    expect(normalizeAffiliateTransaction({
      transaction_id: 'tx-large-eu',
      status: 'approved',
      currency: 'EUR',
      amount: '1.234,56',
      transaction_date: '2026-09-04',
    })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ amount: 1234.56 }) }));

    expect(normalizeAffiliateTransaction({
      transaction_id: 'tx-grouped-comma',
      status: 'approved',
      currency: 'CHF',
      amount: '1,234',
      transaction_date: '2026-09-04',
    }, { amountFormat: 'grouped' })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ amount: 1234 }) }));

    expect(normalizeAffiliateTransaction({
      transaction_id: 'tx-grouped-dot',
      status: 'approved',
      currency: 'CHF',
      amount: '1.234.567',
      transaction_date: '2026-09-04',
    })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ amount: 1234567 }) }));

    for (const [amount, expected] of [
      ['0.500', 0.5],
      ['0,500', 0.5],
      ['-0.500', -0.5],
      ['0.5', 0.5],
      ['0,5', 0.5],
    ] as const) {
      expect(normalizeAffiliateTransaction({
        transaction_id: `tx-fraction-${amount}`,
        status: 'approved',
        currency: 'CHF',
        amount,
        transaction_date: '2026-09-04',
      })).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ amount: expected }),
      }));
    }
  });

  it('refuses ambiguous three-digit amounts until the export format is declared', () => {
    const row = {
      transaction_id: 'tx-ambiguous',
      status: 'approved',
      currency: 'CHF',
      amount: '12.500',
      transaction_date: '2026-09-04',
    };

    expect(normalizeAffiliateTransaction(row)).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/ambiguous numeric amount/i)],
    });
    expect(normalizeAffiliateTransaction(row, { amountFormat: 'decimal' })).toMatchObject({
      ok: true,
      value: { amount: 12.5 },
    });
    expect(normalizeAffiliateTransaction(row, { amountFormat: 'grouped' })).toMatchObject({
      ok: true,
      value: { amount: 12500 },
    });
  });

  it('carries the declared amount format from a network export into reconciliation', () => {
    const report = reconcileAffiliateTransactions({
      rows: [{
        transaction_id: 'tx-export-format',
        status: 'approved',
        currency: 'CHF',
        amount: '12.500',
        transaction_date: '2026-09-04',
      }],
      from: '2026-09-01',
      to: '2026-09-07',
      exposures: { web: 1000 },
      amountFormat: 'decimal',
    });

    expect(report.invalidRows).toBe(0);
    expect(report.byCurrency.CHF.approved).toBe(12.5);
  });

  it('normalises underscores out of publisher references', () => {
    expect(buildAffiliatePubref({ partnerId: 'wise', variant: 'control', surface: 'web', position: 'hero_slot', campaign: 'g4' }))
      .toBe('wise-control-web-hero-slot-g4');
  });
});
