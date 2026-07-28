import { describe, expect, it } from 'vitest';
import {
  aggregate,
  pct,
  comparisonLine,
  formatSegmentTable,
  emptyCell,
  newSegment,
  buildCanonicalDeliveryDocId,
  normalizeEmail,
  parseDaysArg,
  parseSinceArg,
  computeQueryFloor,
  argValue,
  GROUP_ORDER,
  IMMEDIATE_LABEL,
  TRANSACTIONAL_CAMPAIGN_IDS,
} from '../scripts/report-send-hour-impact.mjs';

// ── Fixture helpers ──────────────────────────────────────────────────────
// `aggregate()` only reads `doc.id` and `doc.data()` off each item (it never
// touches `doc.ref` when `data().email` is already set — `d.email || ...`
// short-circuits before the ref-chasing fallback runs), so a plain object
// with those two members is a faithful stand-in for a Firestore
// QueryDocumentSnapshot here. No Firestore mocking needed.

function deliveryDoc({ campaignId, email, sentAt, sendTimeSource = null, opened = false, clicked = false, messageId = null, canonicalId = true, isOperatorVerification = false }: {
  campaignId: string; email: string; sentAt: Date; sendTimeSource?: string | null;
  opened?: boolean; clicked?: boolean; messageId?: string | null; canonicalId?: boolean;
  isOperatorVerification?: boolean;
}) {
  const id = canonicalId
    ? buildCanonicalDeliveryDocId(campaignId, email)
    : `${campaignId}_${normalizeEmail(email)}`; // single-underscore webhook-doc shape
  return {
    id,
    data: () => ({
      email: normalizeEmail(email),
      campaign_id: campaignId,
      sent_at: sentAt,
      send_time_source: sendTimeSource,
      message_id: messageId,
      opened_at: opened ? sentAt : null,
      clicked_at: clicked ? sentAt : null,
      is_operator_verification: isOperatorVerification,
    }),
  };
}

// `timestamp` defaults far in the future so tests that don't care about the
// chronological guard (#3798) — most of them — don't need to specify one
// explicitly and still credit against whatever `sentAt` the delivery doc uses.
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

function eventDoc({ campaignId, alertId, email, type, messageId = null, timestamp = FAR_FUTURE }: {
  campaignId?: string; alertId?: string; email: string; type: 'open' | 'click';
  messageId?: string | null; timestamp?: Date;
}) {
  return {
    id: `evt-${Math.random()}`,
    data: () => ({
      email: normalizeEmail(email),
      campaign_id: campaignId ?? null,
      alert_id: alertId ?? null,
      event_type: type,
      message_id: messageId,
      timestamp,
    }),
  };
}

const CAMPAIGN = 'weekly_2026-07-01';

describe('pct', () => {
  it('returns 0 instead of dividing by zero when deliveries is 0', () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, 0)).toBe(0);
  });

  it('computes a normal percentage', () => {
    expect(pct(25, 100)).toBe(25);
    expect(pct(1, 3)).toBeCloseTo(33.333, 2);
  });
});

describe('aggregate — normal case with mixed groups', () => {
  it('buckets by send_time_source and computes per-group open/click rates', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'personal1@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal', opened: true }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'personal2@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'global1@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'global', clicked: true }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'immediate1@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: null }),
    ];
    const { segments, droppedNonCanonical } = aggregate(deliveries, [], null);
    expect(droppedNonCanonical).toBe(0);
    expect(segments.combined.personal).toEqual({ deliveries: 2, opens: 1, clicks: 0 });
    expect(segments.combined.global).toEqual({ deliveries: 1, opens: 0, clicks: 1 });
    expect(segments.combined[IMMEDIATE_LABEL]).toEqual({ deliveries: 1, opens: 0, clicks: 0 });
    expect(pct(segments.combined.personal.opens, segments.combined.personal.deliveries)).toBe(50);
  });

  it('cross-checks opens/clicks against the events subcollection (webhook-doc providers), ORing with opened_at/clicked_at', () => {
    const deliveries = [
      // No opened_at/clicked_at on the delivery doc itself (as for the 4
      // non-Resend webhook providers) — only the events subcollection knows.
      deliveryDoc({ campaignId: CAMPAIGN, email: 'viaevents@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const events = [
      eventDoc({ campaignId: CAMPAIGN, email: 'viaevents@x.com', type: 'open' }),
      eventDoc({ campaignId: CAMPAIGN, email: 'viaevents@x.com', type: 'click' }),
    ];
    const { segments } = aggregate(deliveries, events, null);
    expect(segments.combined.personal).toEqual({ deliveries: 1, opens: 1, clicks: 1 });
  });

  it('matches an event to its delivery by message_id when email differs (namespaced key, no collision)', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'global', messageId: 'msg-1' }),
    ];
    const events = [eventDoc({ campaignId: CAMPAIGN, email: 'a@x.com', type: 'open', messageId: 'msg-1' })];
    const { segments } = aggregate(deliveries, events, null);
    expect(segments.combined.global.opens).toBe(1);
  });
});

describe('aggregate — deliveries=0 (no division by zero, no crash)', () => {
  it('returns all-zero cells for an empty input, never NaN/Infinity', () => {
    const { segments, droppedNonCanonical } = aggregate([], [], null);
    expect(droppedNonCanonical).toBe(0);
    for (const g of GROUP_ORDER) {
      expect(segments.combined[g]).toEqual({ deliveries: 0, opens: 0, clicks: 0 });
      expect(pct(segments.combined[g].opens, segments.combined[g].deliveries)).toBe(0);
    }
  });

  it('comparisonLine reports "insufficient data" instead of NaN% when one side has 0 deliveries', () => {
    const line = comparisonLine('test', emptyCell(), emptyCell(), 'a', 'b');
    expect(line).toContain('insufficient data');
    expect(line).not.toContain('NaN');
    expect(line).not.toContain('Infinity');
  });
});

describe('aggregate — canonical vs non-canonical delivery doc dedup', () => {
  it('drops the non-Resend webhook duplicate (single-underscore id) instead of double-counting', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'dup@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal', canonicalId: true }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'dup@x.com', sentAt: new Date('2026-07-05T10:00:01Z'), sendTimeSource: 'personal', canonicalId: false }),
    ];
    const { segments, droppedNonCanonical } = aggregate(deliveries, [], null);
    expect(segments.combined.personal.deliveries).toBe(1);
    expect(droppedNonCanonical).toBe(1);
  });

  it('skips delivery docs missing sent_at (webhook-only stub docs, not real sends)', () => {
    const stub = { id: buildCanonicalDeliveryDocId(CAMPAIGN, 'stub@x.com'), data: () => ({ email: 'stub@x.com', campaign_id: CAMPAIGN, sent_at: null }) };
    const { segments } = aggregate([stub], [], null);
    expect(segments.combined.personal.deliveries + segments.combined.global.deliveries + segments.combined[IMMEDIATE_LABEL].deliveries).toBe(0);
  });
});

describe('aggregate — transactional sends excluded from the immediate/pre-feature baseline (#4853)', () => {
  it('drops calculator_paywall and lamal_ssn_tool deliveries entirely instead of bucketing them as immediate/pre-feature', () => {
    const deliveries = [
      deliveryDoc({ campaignId: 'calculator_paywall', email: 'calc@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: null, opened: true }),
      deliveryDoc({ campaignId: 'lamal_ssn_tool', email: 'lamal@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: null }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'immediate1@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: null }),
    ];
    const { segments, droppedTransactional } = aggregate(deliveries, [], null);
    expect(droppedTransactional).toBe(2);
    expect(segments.combined[IMMEDIATE_LABEL]).toEqual({ deliveries: 1, opens: 0, clicks: 0 });
  });

  it('exposes the known transactional campaign_id set for reuse/inspection', () => {
    expect(TRANSACTIONAL_CAMPAIGN_IDS.has('calculator_paywall')).toBe(true);
    expect(TRANSACTIONAL_CAMPAIGN_IDS.has('lamal_ssn_tool')).toBe(true);
    expect(TRANSACTIONAL_CAMPAIGN_IDS.has(CAMPAIGN)).toBe(false);
  });
});

describe('aggregate — events filtering (job-alert cross-collection leakage)', () => {
  it('ignores events with no campaign_id AND no alert_id (no send-side identifier to match against)', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const noIdEvent = { id: 'evt-1', data: () => ({ email: 'a@x.com', event_type: 'open' /* no campaign_id, no alert_id */ }) };
    const { segments } = aggregate(deliveries, [noIdEvent], null);
    expect(segments.combined.personal.opens).toBe(0);
  });

  it('credits job-alert events via alert_id fallback (#3798 ALTO #3 — job alerts now write campaign_deliveries keyed the same way)', () => {
    const ALERT_ID = 'alert-123';
    const deliveries = [
      deliveryDoc({ campaignId: ALERT_ID, email: 'a@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const jobAlertOpen = eventDoc({ alertId: ALERT_ID, email: 'a@x.com', type: 'open' });
    const { segments } = aggregate(deliveries, [jobAlertOpen], null);
    expect(segments.combined.personal.opens).toBe(1);
  });

  it('ignores non open/click event types (delivered/bounce/etc.)', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const bounceEvent = eventDoc({ campaignId: CAMPAIGN, email: 'a@x.com', type: 'bounce' as unknown as 'open' });
    const { segments } = aggregate(deliveries, [bounceEvent], null);
    expect(segments.combined.personal.opens).toBe(0);
  });
});

describe('aggregate — operator-verification exclusion (#3798 ALTO #2)', () => {
  it('drops is_operator_verification deliveries and reports the count instead of counting them', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'op@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), isOperatorVerification: true }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'real@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const { segments, droppedOperatorVerification } = aggregate(deliveries, [], null);
    expect(droppedOperatorVerification).toBe(1);
    expect(segments.combined[IMMEDIATE_LABEL].deliveries).toBe(0);
    expect(segments.combined.personal.deliveries).toBe(1);
  });
});

describe('aggregate — chronological guard (#3798 edge case: event before sent_at)', () => {
  const SENT_AT = new Date('2026-07-16T10:08:21.275Z');

  it('does not credit an open/click whose timestamp precedes this delivery\'s sent_at', () => {
    const deliveries = [
      deliveryDoc({ campaignId: 'unknown', email: 'a@x.com', sentAt: SENT_AT, sendTimeSource: 'personal' }),
    ];
    // Simulates the real root cause: an earlier send to the same untagged
    // ('unknown') address left behind an open event, then a later untagged
    // send overwrote sent_at on the shared canonical doc — orphaning it.
    const staleOpen = eventDoc({ campaignId: 'unknown', email: 'a@x.com', type: 'open', timestamp: new Date(SENT_AT.getTime() - 1000) });
    const { segments } = aggregate(deliveries, [staleOpen], null);
    expect(segments.combined.personal.opens).toBe(0);
  });

  it('still credits an open/click whose timestamp is at or after sent_at', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt: SENT_AT, sendTimeSource: 'personal' }),
    ];
    const freshOpen = eventDoc({ campaignId: CAMPAIGN, email: 'a@x.com', type: 'open', timestamp: new Date(SENT_AT.getTime() + 1000) });
    const { segments } = aggregate(deliveries, [freshOpen], null);
    expect(segments.combined.personal.opens).toBe(1);
  });

  it('does not credit the delivery doc\'s own opened_at/clicked_at when they precede sent_at (stale merge)', () => {
    const doc = {
      id: buildCanonicalDeliveryDocId('unknown', 'stale@x.com'),
      data: () => ({
        email: 'stale@x.com',
        campaign_id: 'unknown',
        sent_at: SENT_AT,
        send_time_source: 'personal',
        opened_at: new Date(SENT_AT.getTime() - 60_000), // stale — from a prior send, never cleared
      }),
    };
    const { segments } = aggregate([doc], [], null);
    expect(segments.combined.personal.opens).toBe(0);
  });
});

describe('computeQueryFloor — "before" baseline anchoring (#3798 ALTO #1)', () => {
  const SINCE = new Date('2026-07-12T00:00:00.000Z');
  const DAYS = 20;

  it('with no --since, floors at now - days (unchanged rolling-window behavior)', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    const floor = computeQueryFloor(now, DAYS, null);
    expect(floor.toISOString()).toBe(new Date(now.getTime() - DAYS * 86_400_000).toISOString());
  });

  it('regression: once now - days drifts past --since, the floor stays anchored before --since instead of AT it (the Aug-1 vanishing-baseline bug)', () => {
    // now - 20d == SINCE exactly: the day the old `sinceDate < cutoffDate ?
    // sinceDate : cutoffDate` ternary first floors the query AT sinceDate,
    // permanently emptying the "before" segment from this point forward.
    const now = new Date('2026-08-01T00:00:00.000Z');
    const floor = computeQueryFloor(now, DAYS, SINCE);
    expect(floor.getTime()).toBeLessThan(SINCE.getTime());
    expect(floor.toISOString()).toBe(new Date(SINCE.getTime() - DAYS * 86_400_000).toISOString());
  });

  it('keeps anchoring to (since - days) indefinitely as now advances further', () => {
    const now = new Date('2026-09-15T00:00:00.000Z'); // weeks past the drift-over point
    const floor = computeQueryFloor(now, DAYS, SINCE);
    expect(floor.toISOString()).toBe(new Date(SINCE.getTime() - DAYS * 86_400_000).toISOString());
  });

  it('anchors to (since - days) even before the drift-over point, whenever that is the wider (earlier) floor', () => {
    // now - 20d (2026-06-25) is well before SINCE (07-12), but (since - days)
    // (06-22) is wider still — always take the earlier floor so the baseline
    // window is stable from day one, not just once drift sets in.
    const now = new Date('2026-07-15T00:00:00.000Z');
    const floor = computeQueryFloor(now, DAYS, SINCE);
    expect(floor.toISOString()).toBe(new Date(SINCE.getTime() - DAYS * 86_400_000).toISOString());
  });
});

describe('aggregate — since-date boundary (before/after split)', () => {
  const since = new Date('2026-07-10T00:00:00.000Z');

  it('a delivery sent exactly at the since instant lands in "after" (>=, not >)', () => {
    const exactlyAt = deliveryDoc({ campaignId: CAMPAIGN, email: 'boundary@x.com', sentAt: new Date(since), sendTimeSource: 'personal' });
    const { segments } = aggregate([exactlyAt], [], since);
    expect(segments.after.personal.deliveries).toBe(1);
    expect(segments.before.personal.deliveries).toBe(0);
  });

  it('one millisecond before the since instant lands in "before"', () => {
    const justBefore = deliveryDoc({ campaignId: CAMPAIGN, email: 'boundary2@x.com', sentAt: new Date(since.getTime() - 1), sendTimeSource: 'personal' });
    const { segments } = aggregate([justBefore], [], since);
    expect(segments.before.personal.deliveries).toBe(1);
    expect(segments.after.personal.deliveries).toBe(0);
  });

  it('reads a Firestore Timestamp-shaped sent_at (toDate()) the same as a plain Date', () => {
    const fakeTimestamp = { toDate: () => new Date(since.getTime() + 1000) };
    const doc = {
      id: buildCanonicalDeliveryDocId(CAMPAIGN, 'ts@x.com'),
      data: () => ({ email: 'ts@x.com', campaign_id: CAMPAIGN, sent_at: fakeTimestamp, send_time_source: 'global' }),
    };
    const { segments } = aggregate([doc], [], since);
    expect(segments.after.global.deliveries).toBe(1);
  });
});

describe('significance testing — real two-proportion z-test, not a fixed n<100 threshold (#3798 Fix MEDIO #4)', () => {
  it('formatSegmentTable prints raw counts with no per-row significance claim', () => {
    // A single group has no "significant/not significant" verdict in isolation
    // — that requires a comparison. The old n<100 annotation made a claim the
    // data couldn't support; the table now just reports numbers.
    const cells = newSegment();
    cells.personal = { deliveries: 42, opens: 10, clicks: 2 };
    const table = formatSegmentTable('title', cells);
    expect(table).not.toContain('significant');
  });

  it('comparisonLine flags two LARGE (n=500) groups with near-identical rates as not significant', () => {
    // Both groups clear the old n>=100 threshold, so the old heuristic would
    // never have flagged this — but a 50.0% vs 49.6% gap on n=500 is
    // genuinely indistinguishable from noise. Real test: p ~ 0.9.
    const a = { deliveries: 500, opens: 250, clicks: 50 };
    const b = { deliveries: 500, opens: 248, clicks: 50 };
    const line = comparisonLine('x', a, b, 'a', 'b');
    expect(line).toContain('not significant');
  });

  it('comparisonLine flags two SMALL (n=60) groups with a decisive rate gap as significant', () => {
    // Both groups are below the old n<100 threshold, so the old heuristic
    // would always have flagged this as "not significant" — but an 83% vs 8%
    // gap on n=60 is an enormous, real effect (z ~ 8). Real test: p << 0.05.
    const a = { deliveries: 60, opens: 50, clicks: 10 };
    const b = { deliveries: 60, opens: 5, clicks: 1 };
    const line = comparisonLine('x', a, b, 'a', 'b');
    expect(line).toContain('[significant');
    expect(line).not.toContain('not significant');
  });

  it('comparisonLine reports the p-value inline', () => {
    const a = { deliveries: 500, opens: 250, clicks: 50 };
    const b = { deliveries: 500, opens: 248, clicks: 50 };
    expect(comparisonLine('x', a, b, 'a', 'b')).toMatch(/p=\d\.\d{3}/);
  });
});

describe('parseDaysArg — off-by-one / invalid-input hardening', () => {
  it('defaults to 30 when the flag is absent', () => {
    expect(parseDaysArg(null)).toEqual({ days: 30, warning: null });
  });

  it('rejects a negative value instead of silently using it as a future cutoff', () => {
    // Bug this regression-tests: `Number(raw) || 30` treats -5 as truthy and
    // keeps it, which computes a cutoff date in the FUTURE (now - (-5)d).
    const { days, warning } = parseDaysArg('-5');
    expect(days).toBe(30);
    expect(warning).toMatch(/positive number/);
  });

  it('rejects zero and NaN, falling back to the default with a warning', () => {
    expect(parseDaysArg('0').days).toBe(30);
    expect(parseDaysArg('abc').days).toBe(30);
    expect(parseDaysArg('abc').warning).toMatch(/positive number/);
  });

  it('accepts a valid positive value with no warning', () => {
    expect(parseDaysArg('60')).toEqual({ days: 60, warning: null });
  });
});

describe('parseSinceArg — calendar-invalid date hardening', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    const { date, warning } = parseSinceArg('2026-07-01');
    expect(warning).toBeNull();
    expect(date?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects a calendar-invalid date instead of silently rolling it over', () => {
    // Bug this regression-tests: plain `new Date("2026-02-30T00:00:00.000Z")`
    // silently returns 2026-03-02 (JS Date rolls over out-of-range fields)
    // instead of failing, which would shift the pre/post split with zero
    // warning to the operator.
    const { date, warning } = parseSinceArg('2026-02-30');
    expect(date).toBeNull();
    expect(warning).toMatch(/not a valid/);
  });

  it('rejects a malformed string', () => {
    const { date, warning } = parseSinceArg('not-a-date');
    expect(date).toBeNull();
    expect(warning).toMatch(/not a valid/);
  });

  it('returns no date and no warning when omitted', () => {
    expect(parseSinceArg(null)).toEqual({ date: null, warning: null });
  });
});

describe('argValue', () => {
  it('reads the value following a flag', () => {
    expect(argValue(['--days', '7'], '--days')).toBe('7');
  });

  it('returns null when the flag is absent or has no following value', () => {
    expect(argValue(['--json'], '--days')).toBeNull();
    expect(argValue(['--days'], '--days')).toBeNull();
  });
});

describe('normalizeEmail / buildCanonicalDeliveryDocId', () => {
  it('lowercases and trims email, and matches functions/src/lib/deliveryDocId.js\'s double-underscore shape', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
    expect(buildCanonicalDeliveryDocId('weekly_2026-07-01', 'User@Example.com')).toBe('weekly_2026-07-01__user@example.com');
  });
});
