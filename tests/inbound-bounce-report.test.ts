import { describe, expect, it } from 'vitest';
import {
  handleInboundBounceReport,
  normalizeRecipient,
  buildBounceReason,
  RECENT_SEND_WINDOW_MS,
} from '../functions/src/inboundBounceReport.js';
import { SOFT_ESCALATION_THRESHOLD } from '../functions/src/lib/bounceClassification.js';

/**
 * The endpoint the Cloudflare Email Worker POSTs a parsed delivery report to.
 *
 * What is worth testing here is not the happy path but the three limits that
 * keep a PUBLIC inbox from becoming a suppression API: no doc is ever created,
 * a report about mail we did not send is dropped, and a report with no
 * machine-readable status is soft (so it takes SOFT_ESCALATION_THRESHOLD of
 * them to suppress anyone).
 */

const SECRET = 'shared-test-secret';
const NOW = Date.parse('2026-08-21T11:41:04Z');

type DocState = { exists: boolean; data: Record<string, unknown>; deliveries?: string[] };

function fakeDb(state: Record<string, Record<string, DocState>>) {
  const events: Array<{ collection: string; email: string; event: Record<string, unknown> }> = [];
  const writes: Array<{ collection: string; email: string; update: Record<string, unknown> }> = [];

  const makeRef = (collection: string, email: string) => {
    const doc: any = state[collection]?.[email] || { exists: false, data: {} };
    if (typeof doc.__softCount !== 'number') {
      doc.__softCount = typeof doc.data.soft_bounce_count === 'number' ? doc.data.soft_bounce_count : 0;
    }
    const ref: any = {
      id: email,
      get: async () => ({ exists: doc.exists, data: () => ({ ...doc.data }) }),
      set: async (update: Record<string, unknown>, opts?: { merge?: boolean }) => {
        doc.data = opts?.merge ? { ...doc.data, ...update } : { ...update };
        // FieldValue.increment is an opaque sentinel here, so resolve it by
        // hand — the escalation path reads the post-write count back and would
        // otherwise compare against an object.
        if ('soft_bounce_count' in update) {
          doc.__softCount = typeof update.soft_bounce_count === 'number'
            ? update.soft_bounce_count
            : doc.__softCount + 1;
          doc.data.soft_bounce_count = doc.__softCount;
        }
        writes.push({ collection, email, update });
      },
      collection: (sub: string) => {
        if (sub === 'events') {
          return { add: async (event: Record<string, unknown>) => { events.push({ collection, email, event }); } };
        }
        if (sub === 'campaign_deliveries') {
          return { doc: (key: string) => ({ get: async () => ({ exists: (doc.deliveries || []).includes(key) }) }) };
        }
        throw new Error(`unexpected subcollection ${sub}`);
      },
      firestore: {
        runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
          get: async () => ({ data: () => ({ ...doc.data }) }),
          set: async (_r: unknown, update: Record<string, unknown>, opts?: { merge?: boolean }) => {
            doc.data = opts?.merge ? { ...doc.data, ...update } : { ...update };
            writes.push({ collection, email, update });
          },
          update: async (_r: unknown, update: Record<string, unknown>) => {
            doc.data = { ...doc.data, ...update };
            writes.push({ collection, email, update });
          },
        }),
      },
    };
    return ref;
  };

  return {
    db: { collection: (name: string) => ({ doc: (email: string) => makeRef(name, email) }) },
    events,
    writes,
    state,
  };
}

const recentlyMailed = (extra: Record<string, unknown> = {}) => ({
  exists: true,
  data: {
    status: 'confirmed',
    last_sent_at: { toMillis: () => NOW - 6 * 60 * 60 * 1000 },
    ...extra,
  },
});

const baseReport = {
  recipient: 'jorgeromero@bluewin.ch',
  campaignId: 'weekly_2026-08-17',
  originalMessageId: '<667058770223026165899480@frontaliereticino.ch>',
  reportingMta: 'mailin-012.p.bluenet.ch',
  secret: SECRET,
  providedSecret: SECRET,
  nowMs: NOW,
};

describe('normalizeRecipient', () => {
  it('strips the RFC 3464 address-type prefix and the display name', () => {
    expect(normalizeRecipient('rfc822; Mario.Rossi@Example.net')).toBe('mario.rossi@example.net');
    expect(normalizeRecipient('Mario Rossi <mario.rossi@example.net>')).toBe('mario.rossi@example.net');
    expect(normalizeRecipient('not an address')).toBe('');
  });
});

describe('buildBounceReason', () => {
  it('says plainly when the report carried no machine-readable status', () => {
    // The recovery scripts fall back to regexes over this text, so an absent
    // code must not read as a hard failure.
    const reason = buildBounceReason({ status: '', diagnosticCode: '', reportingMta: 'mailin-012.p.bluenet.ch', campaignId: 'weekly_2026-08-17' });
    expect(reason).toContain('without a machine-readable status');
    expect(reason).toContain('mailin-012.p.bluenet.ch');
  });
});

describe('handleInboundBounceReport', () => {
  it('rejects a request without the shared secret', async () => {
    const { db, writes } = fakeDb({});
    const res = await handleInboundBounceReport({ ...baseReport, providedSecret: 'wrong', db });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('classifies a report with no status as SOFT and only counts it', async () => {
    // The Swisscom report measured 2026-08-21: empty message/delivery-status,
    // prose listing "inesistente / piena / temporaneo" as alternatives. Nothing
    // there proves permanence, so the subscriber must stay mailable.
    const { db, writes, events } = fakeDb({
      newsletter_subscribers: { 'jorgeromero@bluewin.ch': recentlyMailed() },
    });
    const res = await handleInboundBounceReport({ ...baseReport, status: '', diagnosticCode: '', db });

    expect(res.status).toBe(200);
    expect(res.result?.severity).toBe('soft');
    expect(res.result?.applied).toEqual(['newsletter_subscribers']);
    const merged = Object.assign({}, ...writes.map((w) => w.update));
    expect(merged.bounce_severity).toBe('soft');
    expect(merged.status).toBeUndefined(); // never suppressed on one ambiguous report
    expect(events).toHaveLength(1);
    expect(events[0].event.provider).toBe('dsn');
    expect(events[0].event.campaign_id).toBe('weekly_2026-08-17');
  });

  it('classifies an RFC 3463 5.x.x status as HARD and suppresses', async () => {
    const { db, writes } = fakeDb({
      newsletter_subscribers: { 'mario.rossi@example.net': recentlyMailed() },
    });
    const res = await handleInboundBounceReport({
      ...baseReport,
      recipient: 'rfc822; mario.rossi@example.net',
      status: '5.1.1',
      action: 'failed',
      diagnosticCode: 'smtp; 550 5.1.1 User unknown',
      db,
    });

    expect(res.result?.severity).toBe('hard');
    const merged = Object.assign({}, ...writes.map((w) => w.update));
    expect(merged.status).toBe('bounced');
    expect(merged.bounce_severity).toBe('hard');
  });

  it('treats a 4.x.x status as soft', async () => {
    const { db } = fakeDb({ newsletter_subscribers: { 'mario.rossi@example.net': recentlyMailed() } });
    const res = await handleInboundBounceReport({
      ...baseReport, recipient: 'mario.rossi@example.net', status: '4.2.2', diagnosticCode: 'smtp; 452 mailbox full', db,
    });
    expect(res.result?.severity).toBe('soft');
  });

  it('never creates a subscriber from inbound mail', async () => {
    const { db, writes, events } = fakeDb({ newsletter_subscribers: {} });
    const res = await handleInboundBounceReport({ ...baseReport, recipient: 'stranger@example.org', db });
    expect(res.body).toContain('unknown recipient');
    expect(writes).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('drops a report about mail we did not recently send', async () => {
    // abuse@ is a public inbox: without this, anyone could suppress any
    // subscriber by hand-writing a bounce for them.
    const { db, writes } = fakeDb({
      newsletter_subscribers: {
        'jorgeromero@bluewin.ch': {
          exists: true,
          data: { status: 'confirmed', last_sent_at: { toMillis: () => NOW - RECENT_SEND_WINDOW_MS - 1000 } },
        },
      },
    });
    const res = await handleInboundBounceReport({ ...baseReport, campaignId: '', db });
    expect(res.body).toContain('unsolicited');
    expect(writes).toHaveLength(0);
  });

  it('accepts a stale last_sent_at when the quoted campaign matches a real delivery', async () => {
    const { db, writes } = fakeDb({
      newsletter_subscribers: {
        'jorgeromero@bluewin.ch': {
          exists: true,
          data: { status: 'confirmed', last_sent_at: { toMillis: () => NOW - RECENT_SEND_WINDOW_MS - 1000 } },
          deliveries: ['weekly_2026-08-17_jorgeromero@bluewin.ch'],
        },
      },
    });
    const res = await handleInboundBounceReport({ ...baseReport, db });
    expect(res.status).toBe(200);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('applies to both channels when the address is on both lists', async () => {
    // A dead mailbox is dead for every list: reputation is a property of the
    // mailbox, not of the campaign that happened to hit it.
    const { db } = fakeDb({
      newsletter_subscribers: { 'jorgeromero@bluewin.ch': recentlyMailed() },
      job_alert_subscribers: { 'jorgeromero@bluewin.ch': recentlyMailed() },
    });
    const res = await handleInboundBounceReport({ ...baseReport, status: '5.1.1', db });
    expect(res.result?.applied).toEqual(['newsletter_subscribers', 'job_alert_subscribers']);
  });

  it('escalates a soft report once the threshold is reached', async () => {
    const { db } = fakeDb({
      newsletter_subscribers: {
        'jorgeromero@bluewin.ch': recentlyMailed({ soft_bounce_count: SOFT_ESCALATION_THRESHOLD }),
      },
    });
    const res = await handleInboundBounceReport({ ...baseReport, status: '', db });
    expect(res.result?.severity).toBe('soft');
    expect(res.result?.escalated).toBe(true);
  });
});
