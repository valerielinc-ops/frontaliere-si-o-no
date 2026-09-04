import { describe, expect, it } from 'vitest';
import {
  aggregate,
  pct,
  comparisonLine,
  formatSegmentTable,
  formatCoverageNote,
  emptyCell,
  treatedCell,
  newSegment,
  buildCanonicalDeliveryDocId,
  normalizeEmail,
  parseDaysArg,
  parseSinceArg,
  parseMaturityHoursArg,
  computeQueryFloor,
  computeMaturityCutoff,
  computeFetchFloor,
  effectiveDeliveryDate,
  argValue,
  GROUP_ORDER,
  IMMEDIATE_LABEL,
  PERSONAL_TAIL_LABEL,
  TRANSACTIONAL_CAMPAIGN_IDS,
  DEFAULT_MATURITY_HOURS,
  MAX_SCHEDULE_LOOKAHEAD_MS,
  qualifiesOnlyViaTailWindow,
  collectTailLookupFloors,
} from '../scripts/report-send-hour-impact.mjs';

// ── Fixture helpers ──────────────────────────────────────────────────────
// `aggregate()` reads `doc.id`, `doc.data()` and — for the #6550 tail split —
// walks `doc.ref.parent.parent.parent.id` to learn which subscriber family the
// delivery came from. A plain object with those members is a faithful stand-in
// for a Firestore QueryDocumentSnapshot here; `collection` below builds the
// `{root}/{email}/campaign_deliveries/{id}` ref chain. Omitting it leaves
// `ref` undefined, which is the "root unknown" path both functions tolerate.
// No Firestore mocking needed.

function deliveryDoc({ campaignId, email, sentAt, sendTimeSource = null, opened = false, clicked = false, messageId = null, canonicalId = true, isOperatorVerification = false, scheduledFor = null, collection = null }: {
  campaignId: string; email: string; sentAt: Date; sendTimeSource?: string | null;
  opened?: boolean; clicked?: boolean; messageId?: string | null; canonicalId?: boolean;
  isOperatorVerification?: boolean;
  // Subscriber root collection this delivery lives under (#6550): omitted =>
  // no `ref` at all, mirroring a doc whose ref chain isn't available.
  collection?: string | null;
  // `scheduled_for` is what the cascade actually scheduled (null when the
  // selected provider has no native scheduled-send) — #3798 Fase 4.
  scheduledFor?: Date | { toDate: () => Date } | null;
}) {
  const id = canonicalId
    ? buildCanonicalDeliveryDocId(campaignId, email)
    : `${campaignId}_${normalizeEmail(email)}`; // single-underscore webhook-doc shape
  return {
    id,
    // newsletter_subscribers/{email}/campaign_deliveries/{id}
    ref: collection
      ? { parent: { parent: { id: normalizeEmail(email), parent: { id: collection } } } }
      : undefined,
    data: () => ({
      email: normalizeEmail(email),
      campaign_id: campaignId,
      sent_at: sentAt,
      scheduled_for: scheduledFor,
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
    // No scheduled_for on these fixtures → the treated sub-counts stay 0 while
    // the intent-to-treat counts are unchanged (#3798 Fase 4 coverage).
    expect(segments.combined.personal).toEqual({ deliveries: 2, opens: 1, clicks: 0, scheduled: 0, scheduledOpens: 0, scheduledClicks: 0 });
    expect(segments.combined.global).toEqual({ deliveries: 1, opens: 0, clicks: 1, scheduled: 0, scheduledOpens: 0, scheduledClicks: 0 });
    expect(segments.combined[IMMEDIATE_LABEL]).toEqual({ deliveries: 1, opens: 0, clicks: 0, scheduled: 0, scheduledOpens: 0, scheduledClicks: 0 });
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
    expect(segments.combined.personal).toMatchObject({ deliveries: 1, opens: 1, clicks: 1 });
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

describe('qualifiesOnlyViaTailWindow (#6550)', () => {
  const sentAt = new Date('2026-07-05T10:00:00Z');
  const daysBefore = (n: number) => new Date(sentAt.getTime() - n * 24 * 60 * 60 * 1000);

  it('false when the subscriber already has >= PREFERRED_SEND_MIN_EVENTS within 90 days', () => {
    const eventTimes = [daysBefore(5), daysBefore(20), daysBefore(85)];
    expect(qualifiesOnlyViaTailWindow(eventTimes, sentAt)).toBe(false);
  });

  it('true when the subscriber only clears the threshold inside the 90-180 day tail', () => {
    const eventTimes = [daysBefore(95), daysBefore(120), daysBefore(170)];
    expect(qualifiesOnlyViaTailWindow(eventTimes, sentAt)).toBe(true);
  });

  it('false when even the 180-day window has fewer than PREFERRED_SEND_MIN_EVENTS events', () => {
    const eventTimes = [daysBefore(100), daysBefore(150)];
    expect(qualifiesOnlyViaTailWindow(eventTimes, sentAt)).toBe(false);
  });

  it('ignores events at/after sentAt and events past the 180-day window', () => {
    const eventTimes = [daysBefore(-1), daysBefore(200), daysBefore(100), daysBefore(110), daysBefore(160)];
    expect(qualifiesOnlyViaTailWindow(eventTimes, sentAt)).toBe(true);
  });

  it('false for no event history (empty/undefined)', () => {
    expect(qualifiesOnlyViaTailWindow([], sentAt)).toBe(false);
    expect(qualifiesOnlyViaTailWindow(undefined as unknown as Date[], sentAt)).toBe(false);
  });

  // An unparsable-but-truthy `sent_at` reaches this function as an Invalid Date
  // (collectTailLookupFloors skips those docs, so their 180-day history is never
  // even read). Every NaN comparison being false used to make the answer `true`
  // by construction — even for events that are entirely inside the recent 90
  // days, i.e. the exact opposite of what the bucket means.
  it('false when sentAt is unusable, even with enough recent events to invert the NaN comparisons', () => {
    const recent = [daysBefore(1), daysBefore(2), daysBefore(3)];
    expect(qualifiesOnlyViaTailWindow(recent, new Date('not-a-date'))).toBe(false);
    expect(qualifiesOnlyViaTailWindow(recent, undefined as unknown as Date)).toBe(false);
  });
});

describe('aggregate — personal_tail_90_180 split (#6550)', () => {
  it('keeps a personal delivery in `personal` when the subscriber already qualified within 90 days', () => {
    const sentAt = new Date('2026-07-05T10:00:00Z');
    const daysBefore = (n: number) => new Date(sentAt.getTime() - n * 24 * 60 * 60 * 1000);
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'recent@x.com', sentAt, sendTimeSource: 'personal', opened: true }),
    ];
    const events = [
      eventDoc({ campaignId: 'weekly_2026-06-01', email: 'recent@x.com', type: 'open', timestamp: daysBefore(5) }),
      eventDoc({ campaignId: 'weekly_2026-06-08', email: 'recent@x.com', type: 'open', timestamp: daysBefore(20) }),
      eventDoc({ campaignId: 'weekly_2026-06-15', email: 'recent@x.com', type: 'click', timestamp: daysBefore(30) }),
    ];
    const { segments } = aggregate(deliveries, events, null);
    expect(segments.combined.personal.deliveries).toBe(1);
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(0);
  });

  it('splits a personal delivery into personal_tail_90_180 when the subscriber only qualified via the 90-180 day tail', () => {
    const sentAt = new Date('2026-07-05T10:00:00Z');
    const daysBefore = (n: number) => new Date(sentAt.getTime() - n * 24 * 60 * 60 * 1000);
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'sparse@x.com', sentAt, sendTimeSource: 'personal', opened: true }),
    ];
    const events = [
      eventDoc({ campaignId: 'weekly_2026-04-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(100) }),
      eventDoc({ campaignId: 'weekly_2026-03-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(140) }),
      eventDoc({ campaignId: 'weekly_2026-02-01', email: 'sparse@x.com', type: 'click', timestamp: daysBefore(170) }),
    ];
    const { segments } = aggregate(deliveries, events, null);
    expect(segments.combined.personal.deliveries).toBe(0);
    expect(segments.combined[PERSONAL_TAIL_LABEL]).toMatchObject({ deliveries: 1, opens: 1 });
  });

  it('never reclassifies `global` or immediate deliveries into personal_tail_90_180', () => {
    const sentAt = new Date('2026-07-05T10:00:00Z');
    const daysBefore = (n: number) => new Date(sentAt.getTime() - n * 24 * 60 * 60 * 1000);
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'sparse-global@x.com', sentAt, sendTimeSource: 'global' }),
    ];
    const events = [
      eventDoc({ campaignId: 'weekly_2026-04-01', email: 'sparse-global@x.com', type: 'open', timestamp: daysBefore(100) }),
      eventDoc({ campaignId: 'weekly_2026-03-01', email: 'sparse-global@x.com', type: 'open', timestamp: daysBefore(140) }),
      eventDoc({ campaignId: 'weekly_2026-02-01', email: 'sparse-global@x.com', type: 'click', timestamp: daysBefore(170) }),
    ];
    const { segments } = aggregate(deliveries, events, null);
    expect(segments.combined.global.deliveries).toBe(1);
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(0);
  });
});

describe('collectTailLookupFloors (#6550)', () => {
  const sentAt = new Date('2026-07-05T10:00:00Z');
  const floorOf = (d: Date) => new Date(d.getTime() - 180 * 24 * 60 * 60 * 1000);

  it('returns one 180-day floor per subscriber with a personal delivery', () => {
    const floors = collectTailLookupFloors([
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt, sendTimeSource: 'personal' }),
    ]);
    expect([...floors.keys()]).toEqual(['a@x.com']);
    expect(floors.get('a@x.com')).toEqual({ floor: floorOf(sentAt), collections: ['newsletter_subscribers'] });
  });

  it('keeps the OLDEST delivery floor when a subscriber has several personal deliveries', () => {
    const older = new Date('2026-06-01T10:00:00Z');
    const floors = collectTailLookupFloors([
      deliveryDoc({ campaignId: CAMPAIGN, email: 'a@x.com', sentAt, sendTimeSource: 'personal' }),
      deliveryDoc({ campaignId: 'weekly_2026-06-01', email: 'a@x.com', sentAt: older, sendTimeSource: 'personal' }),
    ]);
    expect(floors.get('a@x.com')).toEqual({ floor: floorOf(older), collections: ['newsletter_subscribers'] });
  });

  it('records the subscriber root collection each floor came from', () => {
    const floors = collectTailLookupFloors([
      deliveryDoc({ campaignId: CAMPAIGN, email: 'n@x.com', sentAt, sendTimeSource: 'personal', collection: 'newsletter_subscribers' }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'j@x.com', sentAt, sendTimeSource: 'personal', collection: 'job_alert_subscribers' }),
    ]);
    expect(floors.get('n@x.com')).toEqual({ floor: floorOf(sentAt), collections: ['newsletter_subscribers'] });
    // The job-alert family is NOT reachable under newsletter_subscribers: its
    // events (and so its preferred hour) live under job_alert_subscribers.
    expect(floors.get('j@x.com')).toEqual({ floor: floorOf(sentAt), collections: ['job_alert_subscribers'] });
  });

  it('records BOTH roots for an email subscribed to newsletter and job alerts', () => {
    const older = new Date('2026-06-01T10:00:00Z');
    const floors = collectTailLookupFloors([
      deliveryDoc({ campaignId: CAMPAIGN, email: 'both@x.com', sentAt, sendTimeSource: 'personal', collection: 'newsletter_subscribers' }),
      deliveryDoc({ campaignId: 'alert_2026-06-01', email: 'both@x.com', sentAt: older, sendTimeSource: 'personal', collection: 'job_alert_subscribers' }),
    ]);
    expect(floors.get('both@x.com')).toEqual({
      floor: floorOf(older),
      collections: ['newsletter_subscribers', 'job_alert_subscribers'],
    });
  });

  it('ignores global/immediate deliveries and operator verification sends', () => {
    const floors = collectTailLookupFloors([
      deliveryDoc({ campaignId: CAMPAIGN, email: 'g@x.com', sentAt, sendTimeSource: 'global' }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'i@x.com', sentAt, sendTimeSource: null }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'op@x.com', sentAt, sendTimeSource: 'personal', isOperatorVerification: true }),
    ]);
    expect(floors.size).toBe(0);
  });
});

describe('aggregate — subscriberEventTimes overrides the window history (#6550)', () => {
  const sentAt = new Date('2026-07-05T10:00:00Z');
  const daysBefore = (n: number) => new Date(sentAt.getTime() - n * 24 * 60 * 60 * 1000);
  const personalDelivery = () =>
    deliveryDoc({ campaignId: CAMPAIGN, email: 'sparse@x.com', sentAt, sendTimeSource: 'personal' });

  it('classifies as tail using history the report window never loaded', () => {
    // No event docs at all in the window — exactly the production shape the
    // dedicated 180-day read exists for.
    const { segments } = aggregate([personalDelivery()], [], null, {
      subscriberEventTimes: new Map([['sparse@x.com', [daysBefore(100), daysBefore(140), daysBefore(170)]]]),
    });
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(1);
    expect(segments.combined.personal.deliveries).toBe(0);
  });

  it('classifies a job-alert delivery on its OWN root history, not the newsletter one', () => {
    // Regression (#6550 review): the qualification read used to be hardcoded to
    // newsletter_subscribers. A job-alert-only subscriber therefore got an
    // EMPTY (not failed) snapshot, which aggregate reads as a real "no history"
    // answer — so it never fell back to the window events and could never be
    // classified as tail. Keyed by root, the real history is found.
    const delivery = deliveryDoc({
      campaignId: CAMPAIGN, email: 'jobs@x.com', sentAt, sendTimeSource: 'personal', collection: 'job_alert_subscribers',
    });
    const { segments } = aggregate([delivery], [], null, {
      subscriberEventTimes: new Map([
        ['job_alert_subscribers::jobs@x.com', [daysBefore(100), daysBefore(140), daysBefore(170)]],
        // Same email under the newsletter root has no history at all — picking
        // this one would silently keep the delivery in `personal`.
        ['newsletter_subscribers::jobs@x.com', []],
      ]),
    });
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(1);
    expect(segments.combined.personal.deliveries).toBe(0);
  });

  it('does not cross-contaminate: newsletter delivery uses the newsletter root history', () => {
    const delivery = deliveryDoc({
      campaignId: CAMPAIGN, email: 'both@x.com', sentAt, sendTimeSource: 'personal', collection: 'newsletter_subscribers',
    });
    const { segments } = aggregate([delivery], [], null, {
      subscriberEventTimes: new Map([
        // Recent qualification on the newsletter side => stays `personal` ...
        ['newsletter_subscribers::both@x.com', [daysBefore(5), daysBefore(20), daysBefore(80)]],
        // ... even though the job-alert side would have read as tail.
        ['job_alert_subscribers::both@x.com', [daysBefore(100), daysBefore(140), daysBefore(170)]],
      ]),
    });
    expect(segments.combined.personal.deliveries).toBe(1);
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(0);
  });

  it('stays in `personal` when the read history shows recent qualification', () => {
    const { segments } = aggregate([personalDelivery()], [], null, {
      subscriberEventTimes: new Map([['sparse@x.com', [daysBefore(5), daysBefore(20), daysBefore(80)]]]),
    });
    expect(segments.combined.personal.deliveries).toBe(1);
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(0);
  });

  it('falls back to the window events when the subscriber read FAILED (null)', () => {
    const events = [
      eventDoc({ campaignId: 'weekly_2026-04-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(100) }),
      eventDoc({ campaignId: 'weekly_2026-03-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(140) }),
      eventDoc({ campaignId: 'weekly_2026-02-01', email: 'sparse@x.com', type: 'click', timestamp: daysBefore(170) }),
    ];
    const { segments } = aggregate([personalDelivery()], events, null, {
      subscriberEventTimes: new Map([['sparse@x.com', null]]),
    });
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(1);
  });

  it('an empty read history is a real answer: the delivery stays in `personal`', () => {
    const events = [
      eventDoc({ campaignId: 'weekly_2026-04-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(100) }),
      eventDoc({ campaignId: 'weekly_2026-03-01', email: 'sparse@x.com', type: 'open', timestamp: daysBefore(140) }),
      eventDoc({ campaignId: 'weekly_2026-02-01', email: 'sparse@x.com', type: 'click', timestamp: daysBefore(170) }),
    ];
    const { segments } = aggregate([personalDelivery()], events, null, {
      subscriberEventTimes: new Map([['sparse@x.com', []]]),
    });
    expect(segments.combined.personal.deliveries).toBe(1);
    expect(segments.combined[PERSONAL_TAIL_LABEL].deliveries).toBe(0);
  });
});

describe('aggregate — deliveries=0 (no division by zero, no crash)', () => {
  it('returns all-zero cells for an empty input, never NaN/Infinity', () => {
    const { segments, droppedNonCanonical } = aggregate([], [], null);
    expect(droppedNonCanonical).toBe(0);
    for (const g of GROUP_ORDER) {
      expect(segments.combined[g]).toEqual(emptyCell());
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
    expect(segments.combined[IMMEDIATE_LABEL]).toEqual({ ...emptyCell(), deliveries: 1 });
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

// ─────────────────────────────────────────────────────────────────────────
// #3798 Fase 4 — instrument fix: the report used to window, split and credit
// on `sent_at` (the moment we called the provider's API). The whole point of
// this feature is that the provider delivers LATER, so `personal` was the only
// cohort systematically delayed relative to its own `sent_at` — a confound
// with exactly the sign of the negative result that was observed. Everything
// below anchors on `scheduled_for ?? sent_at` instead.
// ─────────────────────────────────────────────────────────────────────────

describe('effectiveDeliveryDate — delivery instant, not API-call instant', () => {
  const sentAt = new Date('2026-07-20T03:33:00.000Z');

  it('falls back to sent_at when the provider had no native scheduled-send', () => {
    expect(effectiveDeliveryDate({ sent_at: sentAt, scheduled_for: null })?.toISOString()).toBe(sentAt.toISOString());
  });

  it('uses scheduled_for when the cascade really held the message back', () => {
    const scheduled = new Date('2026-07-20T18:07:00.000Z');
    expect(effectiveDeliveryDate({ sent_at: sentAt, scheduled_for: scheduled })?.toISOString()).toBe(scheduled.toISOString());
  });

  it('reads a Firestore Timestamp-shaped scheduled_for', () => {
    const scheduled = new Date('2026-07-21T09:00:00.000Z');
    expect(effectiveDeliveryDate({ sent_at: sentAt, scheduled_for: { toDate: () => scheduled } })?.toISOString()).toBe(scheduled.toISOString());
  });

  it('never returns an instant BEFORE sent_at — delivery cannot precede the API call', () => {
    // A provider echoing back a clamped/immediate time, or clock skew. Letting
    // it through would drag the delivery to the wrong side of the pre/post split.
    const bogus = new Date(sentAt.getTime() - 60 * 60 * 1000);
    expect(effectiveDeliveryDate({ sent_at: sentAt, scheduled_for: bogus })?.toISOString()).toBe(sentAt.toISOString());
  });

  it('returns null for a stub doc with no sent_at at all', () => {
    expect(effectiveDeliveryDate({ sent_at: null, scheduled_for: sentAt })).toBeNull();
    expect(effectiveDeliveryDate({})).toBeNull();
  });

  it('ignores an unparsable scheduled_for rather than poisoning the row with NaN', () => {
    expect(effectiveDeliveryDate({ sent_at: sentAt, scheduled_for: 'not-a-date' })?.toISOString()).toBe(sentAt.toISOString());
  });
});

describe('aggregate — maturation window (equal opportunity to be opened)', () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  const cutoff = computeMaturityCutoff(now, 48); // 2026-08-03T00:00:00Z

  it('drops a delivery released inside the maturation window, in EVERY group alike', () => {
    const fresh = new Date('2026-08-04T12:00:00.000Z'); // 12h old
    const deliveries = [
      deliveryDoc({ campaignId: CAMPAIGN, email: 'p@x.com', sentAt: fresh, sendTimeSource: 'personal' }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'g@x.com', sentAt: fresh, sendTimeSource: 'global' }),
      deliveryDoc({ campaignId: CAMPAIGN, email: 'i@x.com', sentAt: fresh, sendTimeSource: null }),
    ];
    const { segments, droppedImmature } = aggregate(deliveries, [], null, { maturityCutoff: cutoff });
    expect(droppedImmature).toBe(3);
    for (const g of GROUP_ORDER) expect(segments.combined[g].deliveries).toBe(0);
  });

  it('is the core regression: a SCHEDULED delivery is judged on scheduled_for, not sent_at', () => {
    // Sent 4 days ago (mature by sent_at) but only released 12h ago — it has
    // NOT had a fair chance to be opened, and counting it is exactly what
    // dragged the `personal` open rate down.
    const doc = deliveryDoc({
      campaignId: CAMPAIGN,
      email: 'delayed@x.com',
      sentAt: new Date('2026-08-01T00:00:00.000Z'),
      scheduledFor: new Date('2026-08-04T12:00:00.000Z'),
      sendTimeSource: 'personal',
    });
    const { segments, droppedImmature } = aggregate([doc], [], null, { maturityCutoff: cutoff });
    expect(droppedImmature).toBe(1);
    expect(segments.combined.personal.deliveries).toBe(0);
    // ...and with the filter off, the old confounded behaviour is reproducible.
    const off = aggregate([doc], [], null, {});
    expect(off.segments.combined.personal.deliveries).toBe(1);
    expect(off.droppedImmature).toBe(0);
  });

  it('keeps a delivery released exactly at the cutoff (>= is fresh, > is dropped)', () => {
    const atCutoff = deliveryDoc({ campaignId: CAMPAIGN, email: 'edge@x.com', sentAt: new Date(cutoff), sendTimeSource: 'global' });
    const { segments, droppedImmature } = aggregate([atCutoff], [], null, { maturityCutoff: cutoff });
    expect(droppedImmature).toBe(0);
    expect(segments.combined.global.deliveries).toBe(1);
  });

  it('an unscheduled delivery is unaffected: sent_at and delivery instant coincide', () => {
    const mature = deliveryDoc({ campaignId: CAMPAIGN, email: 'old@x.com', sentAt: new Date('2026-07-30T00:00:00.000Z'), sendTimeSource: null });
    const { segments, droppedImmature } = aggregate([mature], [], null, { maturityCutoff: cutoff });
    expect(droppedImmature).toBe(0);
    expect(segments.combined[IMMEDIATE_LABEL].deliveries).toBe(1);
  });
});

describe('aggregate — pre/post split anchored to delivery, and the window floor', () => {
  const since = new Date('2026-07-12T00:00:00.000Z');

  it('a message SENT before the split but DELIVERED after lands in "after"', () => {
    // Under the old sent_at bucketing this landed in "before", crediting the
    // pre-feature baseline with a delivery the feature actually produced.
    const doc = deliveryDoc({
      campaignId: CAMPAIGN,
      email: 'straddle@x.com',
      sentAt: new Date('2026-07-11T22:00:00.000Z'),
      scheduledFor: new Date('2026-07-12T08:00:00.000Z'),
      sendTimeSource: 'personal',
    });
    const { segments } = aggregate([doc], [], since);
    expect(segments.after.personal.deliveries).toBe(1);
    expect(segments.before.personal.deliveries).toBe(0);
  });

  it('trims the lookahead over-fetch: delivered before the window floor is excluded', () => {
    const windowFloor = new Date('2026-07-12T00:00:00.000Z');
    const tooOld = deliveryDoc({ campaignId: CAMPAIGN, email: 'old@x.com', sentAt: new Date('2026-07-10T00:00:00.000Z'), sendTimeSource: 'global' });
    const inWindow = deliveryDoc({
      campaignId: CAMPAIGN,
      email: 'kept@x.com',
      sentAt: new Date('2026-07-11T20:00:00.000Z'), // fetched only thanks to the widened floor
      scheduledFor: new Date('2026-07-12T06:00:00.000Z'),
      sendTimeSource: 'personal',
    });
    const { segments, droppedBeforeWindow } = aggregate([tooOld, inWindow], [], null, { windowFloor });
    expect(droppedBeforeWindow).toBe(1);
    expect(segments.combined.global.deliveries).toBe(0);
    expect(segments.combined.personal.deliveries).toBe(1);
  });

  it('computeFetchFloor reaches back one full max lookahead before the logical floor', () => {
    const floor = new Date('2026-07-12T00:00:00.000Z');
    expect(computeFetchFloor(floor).getTime()).toBe(floor.getTime() - MAX_SCHEDULE_LOOKAHEAD_MS);
    // Without the widening, `inWindow` above is never fetched at all — a
    // silent left-edge truncation that only ever hits the scheduled cohort.
    expect(computeFetchFloor(floor).getTime()).toBeLessThan(new Date('2026-07-11T20:00:00.000Z').getTime());
  });
});

describe('aggregate — treatment coverage (how much of `personal` was really treated)', () => {
  const sentAt = new Date('2026-07-20T03:33:00.000Z');

  it('counts only deliveries with a real scheduled_for as treated, and their opens/clicks separately', () => {
    const deliveries = [
      // Treated + opened.
      deliveryDoc({ campaignId: CAMPAIGN, email: 't1@x.com', sentAt, scheduledFor: new Date('2026-07-20T18:00:00Z'), sendTimeSource: 'personal', opened: true }),
      // Treated, not opened.
      deliveryDoc({ campaignId: CAMPAIGN, email: 't2@x.com', sentAt, scheduledFor: new Date('2026-07-20T18:00:00Z'), sendTimeSource: 'personal' }),
      // Labelled personal but the cascade fell through to Mailjet v3.1 / Mailtrap /
      // Cloudflare — no native scheduled-send, so it went out immediately and
      // never received the treatment. It still opens, inflating the ITT row.
      deliveryDoc({ campaignId: CAMPAIGN, email: 'u1@x.com', sentAt, scheduledFor: null, sendTimeSource: 'personal', opened: true, clicked: true }),
    ];
    const { segments } = aggregate(deliveries, [], null);
    const cell = segments.combined.personal;
    expect(cell).toEqual({ deliveries: 3, opens: 2, clicks: 1, scheduled: 2, scheduledOpens: 1, scheduledClicks: 0 });
    // The treated-only projection is a strict subset, never a different denominator.
    expect(treatedCell(cell)).toEqual({ deliveries: 2, opens: 1, clicks: 0 });
  });

  it('formatSegmentTable exposes coverage as a sched% column', () => {
    const cells = newSegment();
    cells.personal = { deliveries: 4, opens: 2, clicks: 0, scheduled: 1, scheduledOpens: 1, scheduledClicks: 0 };
    expect(formatSegmentTable('t', cells)).toContain('sched%');
    expect(formatSegmentTable('t', cells)).toMatch(/25\.0%/);
  });

  it('formatSegmentTable still renders cells built without the treated sub-counts', () => {
    // Legacy/hand-built cells (and the significance tests below) omit them.
    const cells = newSegment();
    cells.personal = { deliveries: 42, opens: 10, clicks: 2 } as never;
    expect(() => formatSegmentTable('t', cells)).not.toThrow();
    expect(formatSegmentTable('t', cells)).toContain('0.0%');
  });

  it('formatCoverageNote warns loudly when the personal cohort is diluted', () => {
    const cells = newSegment();
    cells.personal = { deliveries: 100, opens: 10, clicks: 1, scheduled: 30, scheduledOpens: 5, scheduledClicks: 1 };
    const note = formatCoverageNote(cells);
    expect(note).toContain('30/100');
    expect(note).toContain('⚠️');
    expect(note).toContain('scheduled only');
  });

  it('formatCoverageNote stays quiet when coverage is high', () => {
    const cells = newSegment();
    cells.personal = { deliveries: 100, opens: 10, clicks: 1, scheduled: 95, scheduledOpens: 9, scheduledClicks: 1 };
    const note = formatCoverageNote(cells);
    expect(note).toContain('95/100');
    expect(note).not.toContain('⚠️');
  });

  it('formatCoverageNote does not divide by zero on an empty cohort', () => {
    const note = formatCoverageNote(newSegment());
    expect(note).not.toContain('NaN');
    expect(note).toContain('no `personal` deliveries');
  });
});

describe('parseMaturityHoursArg / computeMaturityCutoff', () => {
  it('defaults to DEFAULT_MATURITY_HOURS when the flag is absent', () => {
    expect(parseMaturityHoursArg(null)).toEqual({ hours: DEFAULT_MATURITY_HOURS, warning: null });
  });

  it('accepts 0 as an explicit "disable the filter" — unlike --days, which rejects it', () => {
    expect(parseMaturityHoursArg('0')).toEqual({ hours: 0, warning: null });
    expect(computeMaturityCutoff(new Date(), 0)).toBeNull();
  });

  it('rejects a negative value, which would put the cutoff in the FUTURE and drop everything', () => {
    const { hours, warning } = parseMaturityHoursArg('-12');
    expect(hours).toBe(DEFAULT_MATURITY_HOURS);
    expect(warning).toMatch(/>= 0/);
  });

  it('rejects non-numeric input with a warning', () => {
    expect(parseMaturityHoursArg('soon').hours).toBe(DEFAULT_MATURITY_HOURS);
    expect(parseMaturityHoursArg('soon').warning).toMatch(/>= 0/);
  });

  it('computes the cutoff N hours before now', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    expect(computeMaturityCutoff(now, 48)?.toISOString()).toBe('2026-08-03T12:00:00.000Z');
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
