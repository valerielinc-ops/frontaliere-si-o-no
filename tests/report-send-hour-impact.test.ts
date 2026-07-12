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
  argValue,
  GROUP_ORDER,
  IMMEDIATE_LABEL,
} from '../scripts/report-send-hour-impact.mjs';

// ── Fixture helpers ──────────────────────────────────────────────────────
// `aggregate()` only reads `doc.id` and `doc.data()` off each item (it never
// touches `doc.ref` when `data().email` is already set — `d.email || ...`
// short-circuits before the ref-chasing fallback runs), so a plain object
// with those two members is a faithful stand-in for a Firestore
// QueryDocumentSnapshot here. No Firestore mocking needed.

function deliveryDoc({ campaignId, email, sentAt, sendTimeSource = null, opened = false, clicked = false, messageId = null, canonicalId = true }: {
  campaignId: string; email: string; sentAt: Date; sendTimeSource?: string | null;
  opened?: boolean; clicked?: boolean; messageId?: string | null; canonicalId?: boolean;
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
    }),
  };
}

function eventDoc({ campaignId, email, type, messageId = null }: {
  campaignId?: string; email: string; type: 'open' | 'click'; messageId?: string | null;
}) {
  return {
    id: `evt-${Math.random()}`,
    data: () => ({
      email: normalizeEmail(email),
      campaign_id: campaignId ?? null,
      event_type: type,
      message_id: messageId,
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

describe('aggregate — events filtering (job-alert cross-collection leakage)', () => {
  it('ignores events with no campaign_id (job_alert_subscribers events use alert_id, not campaign_id)', () => {
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt: new Date('2026-07-05T10:00:00Z'), sendTimeSource: 'personal' }),
    ];
    const jobAlertEvent = { id: 'evt-1', data: () => ({ email: 'a@x.com', event_type: 'open' /* no campaign_id */ }) };
    const { segments } = aggregate(deliveries, [jobAlertEvent], null);
    expect(segments.combined.personal.opens).toBe(0);
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

describe('n<100 small-sample flagging (SMALL_SAMPLE_THRESHOLD)', () => {
  it('formatSegmentTable annotates a group with fewer than 100 deliveries as not significant', () => {
    const cells = newSegment();
    cells.personal = { deliveries: 42, opens: 10, clicks: 2 };
    const table = formatSegmentTable('title', cells);
    expect(table).toContain('n<100, not significant');
  });

  it('does NOT flag a group with >= 100 deliveries', () => {
    const cells = newSegment();
    cells.personal = { deliveries: 150, opens: 30, clicks: 5 };
    const table = formatSegmentTable('title', cells);
    const personalLine = table.split('\n').find((l) => l.trim().startsWith('personal'));
    expect(personalLine).toBeDefined();
    expect(personalLine).not.toContain('not significant');
  });

  it('comparisonLine flags [not significant] when either side is below the threshold', () => {
    const small = { deliveries: 10, opens: 5, clicks: 1 };
    const big = { deliveries: 500, opens: 250, clicks: 50 };
    expect(comparisonLine('x', small, big, 'a', 'b')).toContain('not significant');
    expect(comparisonLine('x', big, big, 'a', 'b')).not.toContain('not significant');
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
