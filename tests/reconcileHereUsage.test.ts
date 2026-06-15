/**
 * Tests for the pure helpers in scripts/reconcile-here-usage.mjs:
 *  - sumRoutingTransactions: extracts billed routing transactions from a HERE
 *    Usage API payload (prefers billableValue, filters to routing + Transactions)
 *  - buildHereOAuthHeader: deterministic OAuth 1.0a signature for the token call
 *  - monthBounds / currentMonthKey: month-window math (Europe/Rome)
 *
 * I/O paths (token fetch, Usage API call, Firestore seed) are not unit-tested
 * here — they require live OAuth credentials and a Firestore connection.
 */

import { describe, it, expect } from 'vitest';
import {
  sumRoutingTransactions,
  buildHereOAuthHeader,
  monthBounds,
  currentMonthKey,
} from '../scripts/reconcile-here-usage.mjs';

describe('sumRoutingTransactions', () => {
  it('sums billableValue across routing services with Transactions driver', () => {
    const payload = {
      usage: [
        { name: 'Routing', valueDriver: 'Transactions', usageValue: 4000, billableValue: 3500 },
        { name: 'Time Aware Routing', valueDriver: 'Transactions', usageValue: 1200, billableValue: 1000 },
        { name: 'Geocode & Reverse Geocode', valueDriver: 'Transactions', usageValue: 999, billableValue: 999 },
        { name: 'Map Tile', valueDriver: 'Requests', usageValue: 50000, billableValue: 50000 },
      ],
    };
    const { total, breakdown } = sumRoutingTransactions(payload);
    // 3500 (Routing) + 1000 (Time Aware) — geocode/tiles excluded
    expect(total).toBe(4500);
    expect(breakdown.map((b) => b.name)).toEqual(['Routing', 'Time Aware Routing']);
  });

  it('falls back to usageValue when billableValue is absent', () => {
    const payload = { usage: [{ name: 'Routing', valueDriver: 'Transactions', usageValue: 320 }] };
    expect(sumRoutingTransactions(payload).total).toBe(320);
  });

  it('accepts a bare array payload and ignores non-routing rows', () => {
    const payload = [
      { name: 'Autocomplete', valueDriver: 'Transactions', billableValue: 10 },
      { name: 'Routing v8', valueDriver: 'Transactions', billableValue: 77 },
    ];
    expect(sumRoutingTransactions(payload).total).toBe(77);
  });

  it('returns 0 for empty or malformed payloads', () => {
    expect(sumRoutingTransactions({}).total).toBe(0);
    expect(sumRoutingTransactions(null).total).toBe(0);
    expect(sumRoutingTransactions({ usage: [] }).total).toBe(0);
  });

  it('parses the real v2 Usage API `items` shape and excludes non-routing rows', () => {
    // Verbatim shape returned by GET /v2/usage/realms/org899238099 (June 2026):
    // a Data IO (DataStorage / GB) row that must be ignored + the routing row.
    const payload = {
      total: 2,
      limit: 100,
      nextOffset: 0,
      items: [
        {
          realmId: 'org899238099',
          category: 'DataStorage',
          name: 'Data IO',
          valueDriver: 'GB',
          usageValue: 3497,
          billableValue: 0,
        },
        {
          realmId: 'org899238099',
          category: 'LocationServices',
          featureId: 'hrn:here:service::olp-here:routing-8:traffic',
          name: 'Time Aware Routing',
          valueDriver: 'Transactions',
          usageValue: 6350,
          billableValue: 6350,
        },
      ],
    };
    const { total, breakdown } = sumRoutingTransactions(payload);
    expect(total).toBe(6350);
    expect(breakdown).toEqual([{ name: 'Time Aware Routing', value: 6350 }]);
  });
});

describe('buildHereOAuthHeader', () => {
  const base = {
    url: 'https://account.api.here.com/oauth2/token',
    method: 'POST',
    bodyParams: { grant_type: 'client_credentials' },
    keyId: 'test-key-id',
    keySecret: 'test-secret',
    nonce: 'fixednonce',
    timestamp: 1700000000,
  };

  it('produces a deterministic OAuth 1.0a header for fixed nonce/timestamp', () => {
    const a = buildHereOAuthHeader(base);
    const b = buildHereOAuthHeader(base);
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^OAuth /);
    expect(a).toContain('oauth_consumer_key="test-key-id"');
    expect(a).toContain('oauth_signature_method="HMAC-SHA256"');
    expect(a).toContain('oauth_signature=');
    expect(a).toContain('oauth_nonce="fixednonce"');
  });

  it('changes the signature when the secret changes', () => {
    const sigOf = (h: string) => h.match(/oauth_signature="([^"]+)"/)?.[1];
    const a = buildHereOAuthHeader(base);
    const b = buildHereOAuthHeader({ ...base, keySecret: 'other-secret' });
    expect(sigOf(a)).not.toBe(sigOf(b));
  });
});

describe('month window math', () => {
  it('monthBounds start is the UTC instant of 00:00 Europe/Rome on the 1st', () => {
    // June 2026 is CEST (UTC+2): Rome midnight = UTC 22:00 of the previous day.
    expect(monthBounds('2026-06').start).toBe('2026-05-31T22:00:00');
    // January 2026 is CET (UTC+1): Rome midnight = UTC 23:00 of the previous day.
    expect(monthBounds('2026-01').start).toBe('2025-12-31T23:00:00');
  });

  it('monthBounds startDate <= endDate holds at Rome month boundary (00:00-02:00 Rome, UTC still prev day)', () => {
    // At 00:30 Rome on July 1 (= 2026-06-30T22:30:00 UTC), start must be < end.
    const { start } = monthBounds('2026-07');
    const endAtBoundary = '2026-06-30T22:30:00'; // UTC, within the boundary window
    expect(start <= endAtBoundary).toBe(true);
  });

  it('currentMonthKey returns a YYYY-MM string', () => {
    expect(currentMonthKey(new Date('2026-06-15T12:00:00Z'))).toMatch(/^\d{4}-\d{2}$/);
    expect(currentMonthKey(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06');
  });
});
