import { describe, expect, it } from 'vitest';

const { pickWinner, twoProportionTest, DEFAULT_WINNER_GATES, resolveWinnersByProvider } = await import('@/services/newsletter-ab-stats.mjs');
const { DEFAULT_EPSILON, listVariantIds } = await import('@/services/newsletter-subject-variants.mjs');
const { assignSubjectVariant } = await import('@/services/newsletter-subject-assign.mjs');
const {
  previousCampaignIds,
  aggregateSegmentReport,
  unsubscribeGuardBreaches,
  UNSUB_RATE_CAP_PCT,
  MIN_SENDS_FOR_UNSUB_GUARD,
  loadCampaignSegmentReport,
  MissingIndexError,
} = await import('@/scripts/lib/newsletter-ab-data.mjs');
const { buildDeliveryDocId } = await import('@/functions/src/lib/deliveryDocId.js');
const { toMillis } = await import('@/scripts/lib/firestoreTimestamp.mjs');

describe('buildDeliveryDocId', () => {
  it('builds the canonical double-underscore send-doc id (email lowercased)', () => {
    expect(buildDeliveryDocId('weekly_2026-06-15', 'User@Example.com')).toBe('weekly_2026-06-15__user@example.com');
  });
  it('differs from a webhook single-underscore id (so the report can dedup)', () => {
    const canonical = buildDeliveryDocId('weekly_2026-06-15', 'a@b.com');
    const webhookId = 'weekly_2026-06-15_a@b.com'; // single underscore (non-Resend webhook form)
    expect(canonical).not.toBe(webhookId);
    expect(canonical.includes('__')).toBe(true);
  });
});

describe('pickWinner', () => {
  it('returns no winner when a sample is below the gate', () => {
    const r = pickWinner({ concreto: { sends: 50, opens: 30 }, curioso: { sends: 50, opens: 10 } });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe('insufficient sample');
  });

  it('returns no winner when the difference is not significant', () => {
    // 300 vs 300 sends, 90 vs 96 opens → close rates, not significant
    const r = pickWinner({ concreto: { sends: 300, opens: 90 }, curioso: { sends: 300, opens: 96 } });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe('not significant');
  });

  it('picks the higher-open-rate arm when significant and well-sampled', () => {
    // 1000 each: 320 vs 200 opens → 32% vs 20%, clearly significant
    const r = pickWinner({ concreto: { sends: 1000, opens: 320 }, curioso: { sends: 1000, opens: 200 } });
    expect(r.winner).toBe('concreto');
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('honors custom gates', () => {
    const tight = pickWinner({ a: { sends: 100, opens: 40 }, b: { sends: 100, opens: 20 } }, { minSendsPerArm: 500 });
    expect(tight.winner).toBeNull(); // 100 < 500
  });
});

describe('resolveWinnersByProvider', () => {
  it('picks a winner per provider and a global fallback', () => {
    const cells = {
      // mailjet: curioso clearly wins (significant, well sampled)
      mailjet: { concreto: { sends: 1000, opens: 200 }, curioso: { sends: 1000, opens: 320 } },
      // mailgun: concreto clearly wins
      mailgun: { concreto: { sends: 1000, opens: 340 }, curioso: { sends: 1000, opens: 210 } },
      // mailtrap: thin → no per-provider winner
      mailtrap: { concreto: { sends: 30, opens: 12 }, curioso: { sends: 25, opens: 6 } },
    };
    const { byProvider, global } = resolveWinnersByProvider(cells);
    expect(byProvider.mailjet).toBe('curioso');
    expect(byProvider.mailgun).toBe('concreto');
    expect(byProvider.mailtrap).toBeNull(); // insufficient sample
    // global pools everything; both arms are close once pooled → may be null,
    // but must be one of the known values or null (never throws / undefined)
    expect([null, 'concreto', 'curioso']).toContain(global);
  });

  it('returns empty winners for empty cells', () => {
    expect(resolveWinnersByProvider({})).toEqual({ byProvider: {}, global: null });
  });

  it('global fallback covers a provider with no significant winner', () => {
    const cells = {
      // global signal: concreto wins big when pooled
      mailjet: { concreto: { sends: 2000, opens: 700 }, curioso: { sends: 2000, opens: 400 } },
      // thin provider → null locally, should rely on global at send time
      maileroo: { concreto: { sends: 10, opens: 5 }, curioso: { sends: 10, opens: 1 } },
    };
    const { byProvider, global } = resolveWinnersByProvider(cells);
    expect(byProvider.maileroo).toBeNull();
    expect(global).toBe('concreto'); // the send pipeline uses byProvider[p] ?? global
  });
});

describe('twoProportionTest', () => {
  it('is null when an arm has no sends', () => {
    expect(twoProportionTest({ sends: 0, opens: 0 }, { sends: 10, opens: 5 })).toBeNull();
  });
});

describe('assignSubjectVariant epsilon-greedy promotion', () => {
  const N = 6000;
  const ids = listVariantIds();
  const promoted = ids[0];

  it('stays a ~even split with no promotion (baseline)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`b${i}@x.com`, 'weekly_2026-06-15');
      counts[v] = (counts[v] || 0) + 1;
    }
    expect(counts[promoted] / N).toBeGreaterThan(0.4);
    expect(counts[promoted] / N).toBeLessThan(0.6);
  });

  it('biases toward the promoted variant (~1-epsilon+epsilon/k) but still explores', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`p${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: promoted, epsilon: DEFAULT_EPSILON });
      counts[v] = (counts[v] || 0) + 1;
    }
    const share = counts[promoted] / N;
    const expected = (1 - DEFAULT_EPSILON) + DEFAULT_EPSILON / ids.length; // k=2 → 0.9
    expect(share).toBeGreaterThan(expected - 0.05);
    expect(share).toBeLessThan(expected + 0.05);
    // the losing arm still gets meaningful traffic (test stays live)
    const loser = ids.find((x) => x !== promoted)!;
    expect(counts[loser] / N).toBeGreaterThan(0.04);
  });

  it('is deterministic with promotion (stable per subscriber within a campaign)', () => {
    const a = assignSubjectVariant('Same@x.com', 'weekly_2026-06-15', { promotedVariant: promoted });
    const b = assignSubjectVariant('same@x.com', 'weekly_2026-06-15', { promotedVariant: promoted });
    expect(a).toBe(b);
  });

  it('ignores an unknown promoted variant (falls back to even split)', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`u${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: 'nope' });
      counts[v] = (counts[v] || 0) + 1;
    }
    expect(counts[promoted] / N).toBeGreaterThan(0.4);
    expect(counts[promoted] / N).toBeLessThan(0.6);
  });

  it('epsilon=0 promotes the winner to (almost) everyone', () => {
    let promotedCount = 0;
    for (let i = 0; i < N; i++) {
      if (assignSubjectVariant(`z${i}@x.com`, 'weekly_2026-06-15', { promotedVariant: promoted, epsilon: 0 }) === promoted) promotedCount++;
    }
    expect(promotedCount).toBe(N);
  });

  it('backward compatible: a plain 2-arg call is the uniform baseline', () => {
    expect(typeof assignSubjectVariant('x@y.com', 'weekly_2026-06-15')).toBe('string');
  });
});

describe('previousCampaignIds', () => {
  it('returns the prior Mondays, most recent first', () => {
    expect(previousCampaignIds('weekly_2026-06-15', 2)).toEqual(['weekly_2026-06-08', 'weekly_2026-06-01']);
  });
  it('returns [] for a malformed campaign id', () => {
    expect(previousCampaignIds('not-a-campaign', 2)).toEqual([]);
  });
});

// #4299 per-segment report + unsubscribe-rate guard
describe('aggregateSegmentReport', () => {
  it('buckets sends/opens/clicks by segment and computes rates', () => {
    const deliveries = [
      { email: 'a@x.com', segment: 'hot_jobs', openedAt: 1000, clickedAt: 2000 },
      { email: 'b@x.com', segment: 'hot_jobs', openedAt: null, clickedAt: null },
      { email: 'c@x.com', segment: 'dormant', openedAt: null, clickedAt: null },
      { email: 'd@x.com', segment: 'dormant', openedAt: 1000, clickedAt: null },
    ];
    const report = aggregateSegmentReport(deliveries);
    expect(report.totalSends).toBe(4);
    expect(report.bySegment.hot_jobs).toMatchObject({ sends: 2, opens: 1, clicks: 1 });
    expect(report.bySegment.hot_jobs.openRate).toBeCloseTo(50, 5);
    expect(report.bySegment.dormant).toMatchObject({ sends: 2, opens: 1, clicks: 0 });
  });

  it('falls back to "unsegmented" when segment is missing (older sends predating #4299)', () => {
    const report = aggregateSegmentReport([{ email: 'a@x.com', segment: null }]);
    expect(Object.keys(report.bySegment)).toEqual(['unsegmented']);
  });

  it('counts an open/click via the cross-provider event fallback, not just the delivery-doc field', () => {
    const deliveries = [{ email: 'a@x.com', segment: 'warm_articles', messageId: 'm1', openedAt: null, clickedAt: null }];
    const report = aggregateSegmentReport(deliveries, {
      openedEmails: new Set(['a@x.com']),
      clickedMsgIds: new Set(['m1']),
    });
    expect(report.bySegment.warm_articles.opens).toBe(1);
    expect(report.bySegment.warm_articles.clicks).toBe(1);
  });

  it('attributes an unsubscribe to its segment and computes the overall rate', () => {
    const deliveries = [
      { email: 'a@x.com', segment: 'dormant' },
      { email: 'b@x.com', segment: 'dormant' },
    ];
    const report = aggregateSegmentReport(deliveries, { unsubscribedEmails: new Set(['a@x.com']) });
    expect(report.bySegment.dormant.unsubscribes).toBe(1);
    expect(report.bySegment.dormant.unsubscribeRate).toBeCloseTo(50, 5);
    expect(report.overallUnsubscribeRate).toBeCloseTo(50, 5);
  });

  it('returns zeroed totals for an empty campaign (no throw)', () => {
    const report = aggregateSegmentReport([]);
    expect(report.totalSends).toBe(0);
    expect(report.overallUnsubscribeRate).toBe(0);
    expect(report.bySegment).toEqual({});
  });
});

describe('unsubscribeGuardBreaches', () => {
  it('flags a segment whose unsubscribe rate crosses the cap, once it has enough sends', () => {
    const deliveries = Array.from({ length: MIN_SENDS_FOR_UNSUB_GUARD }, (_, i) => ({ email: `u${i}@x.com`, segment: 'dormant' }));
    // 2 unsubs out of MIN_SENDS_FOR_UNSUB_GUARD sends > UNSUB_RATE_CAP_PCT
    const unsubCount = Math.ceil((UNSUB_RATE_CAP_PCT / 100) * MIN_SENDS_FOR_UNSUB_GUARD) + 1;
    const unsubscribedEmails = new Set(Array.from({ length: unsubCount }, (_, i) => `u${i}@x.com`));
    const report = aggregateSegmentReport(deliveries, { unsubscribedEmails });
    const breaches = unsubscribeGuardBreaches(report);
    expect(breaches.some((b) => b.scope === 'dormant')).toBe(true);
  });

  it('does not flag a thin segment below the minimum-sends floor, even at 100% unsubscribe', () => {
    const deliveries = [{ email: 'a@x.com', segment: 'new_niche' }];
    const report = aggregateSegmentReport(deliveries, { unsubscribedEmails: new Set(['a@x.com']) });
    const breaches = unsubscribeGuardBreaches(report);
    expect(breaches.some((b) => b.scope === 'new_niche')).toBe(false);
  });

  it('flags "overall" when the whole-campaign rate crosses the cap regardless of segment size', () => {
    const deliveries = [
      { email: 'a@x.com', segment: 'hot_jobs' },
      { email: 'b@x.com', segment: 'hot_jobs' },
    ];
    const report = aggregateSegmentReport(deliveries, { unsubscribedEmails: new Set(['a@x.com']) }); // 50%
    const breaches = unsubscribeGuardBreaches(report);
    expect(breaches.some((b) => b.scope === 'overall')).toBe(true);
  });

  it('returns no breaches for a clean campaign', () => {
    const deliveries = Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@x.com`, segment: 'hot_jobs' }));
    const report = aggregateSegmentReport(deliveries);
    expect(unsubscribeGuardBreaches(report)).toEqual([]);
  });

  it('honors a custom cap', () => {
    const deliveries = [
      { email: 'a@x.com', segment: 'cool_digest' },
      { email: 'b@x.com', segment: 'cool_digest' },
    ];
    const report = aggregateSegmentReport(deliveries, { unsubscribedEmails: new Set(['a@x.com']) }); // 50%
    expect(unsubscribeGuardBreaches(report, 60)).toEqual([]); // below a looser 60% cap
  });
});

// The unsubscribe window query is the one query in this module that combines an
// equality filter with a range filter, so it is the only one that needs a
// composite index. firestore.indexes.json declares events(event_type ASC,
// timestamp DESC) and nothing else, so the direction is not a style choice.
describe('loadCampaignSegmentReport — unsubscribe window query', () => {
  const CAMPAIGN = 'weekly_2026-06-15';
  const EMAIL = 'a@b.com';

  function stubDb(recorded: any[]) {
    const makeQuery = (group: string) => {
      const calls: any = { group, wheres: [] as any[], orderBys: [] as any[] };
      recorded.push(calls);
      const q: any = {
        where(field: string, op: string, value: unknown) { calls.wheres.push({ field, op, value }); return q; },
        orderBy(field: string, dir?: string) { calls.orderBys.push({ field, dir }); return q; },
        get: async () => ({
          docs: group === 'campaign_deliveries'
            ? [{
                id: buildDeliveryDocId(CAMPAIGN, EMAIL),
                data: () => ({ email: EMAIL, sent_at: new Date('2026-06-15T08:00:00Z'), provider: 'resend', segment: 'hot_jobs' }),
                ref: { parent: { parent: { id: EMAIL } } },
              }]
            : [],
        }),
      };
      return q;
    };
    return { collectionGroup: (group: string) => makeQuery(group) };
  }

  it('orders the unsubscribe window explicitly, so it runs on the declared index', async () => {
    const recorded: any[] = [];
    await loadCampaignSegmentReport(stubDb(recorded), CAMPAIGN);

    const unsubQuery = recorded.find((c) => c.wheres.some((w: any) => w.field === 'event_type' && w.value === 'unsubscribe'));
    expect(unsubQuery).toBeDefined();
    expect(unsubQuery.wheres.filter((w: any) => w.field === 'timestamp')).toHaveLength(2);
    // Without this the implicit order is ascending, which no declared index serves.
    expect(unsubQuery.orderBys).toEqual([{ field: 'timestamp', dir: 'desc' }]);
  });
});

describe('MissingIndexError', () => {
  it('names the fields of the query that failed, not always campaign_id', () => {
    const err = new MissingIndexError('events', 'event_type + timestamp', new Error('original'));
    expect(err.message).toContain('events.event_type + timestamp');
    expect(err.message).not.toContain('campaign_id');
    expect(err.fields).toBe('event_type + timestamp');
    expect(err.original).toBeInstanceOf(Error);
  });
});

// Two ways this report told the reader the opposite of the truth, both found
// by reading production on 2026-08-18.
describe('loadCampaignSegmentReport — window and channel', () => {
  const CAMPAIGN = 'weekly_2026-06-15';
  const EMAIL = 'a@b.com';
  const SENT_AT = new Date('2026-06-15T08:00:00Z');

  function stubDb(unsubEvents: any[], sentAt: Date = SENT_AT) {
    const chain = (group: string) => {
      const q: any = {
        where: () => q,
        orderBy: () => q,
        limit: () => q,
        get: async () => ({
          docs: group === 'campaign_deliveries'
            ? [{
                id: buildDeliveryDocId(CAMPAIGN, EMAIL),
                data: () => ({ email: EMAIL, sent_at: sentAt, provider: 'resend', segment: 'hot_jobs' }),
                ref: { parent: { parent: { id: EMAIL } } },
              }]
            : unsubEvents.map((ev) => ({ data: () => ev, ref: { parent: { parent: { id: ev.email } } } })),
        }),
      };
      return q;
    };
    return { collectionGroup: (g: string) => chain(g) };
  }

  const unsub = (channel: string | null) => ({
    event_type: 'unsubscribe', email: EMAIL, source_channel: channel,
    timestamp: new Date('2026-06-16T08:00:00Z'), occurred_at: '2026-06-16T08:00:00.000Z',
  });

  it('counts an unsubscribe the visitor actually made', async () => {
    const r = await loadCampaignSegmentReport(stubDb([unsub('unsubscribe_link')]), CAMPAIGN);
    expect(r.totalUnsubscribes).toBe(1);
  });

  it('ignores a backfill written into the window by a repair job', async () => {
    // `ripristino_disiscrizione_persa` carries a historical occurred_at and a
    // write-time timestamp, so a repair run landing inside a campaign's window
    // used to read as that campaign driving people away. Measured on
    // production: 18 of 176 unsubscribes counted for weekly_2026-08-03.
    const r = await loadCampaignSegmentReport(stubDb([unsub('ripristino_disiscrizione_persa')]), CAMPAIGN);
    expect(r.totalUnsubscribes).toBe(0);
  });

  it('ignores an operator-driven LPD removal too', async () => {
    const r = await loadCampaignSegmentReport(stubDb([unsub('richiesta_diretta_lpd')]), CAMPAIGN);
    expect(r.totalUnsubscribes).toBe(0);
  });

  it('reports a long-past campaign as closed', async () => {
    const r = await loadCampaignSegmentReport(stubDb([], new Date('2026-01-01T08:00:00Z')), CAMPAIGN);
    expect(r.windowClosed).toBe(true);
    expect(r.windowDaysRemaining).toBe(0);
  });

  it('reports a campaign sent today as still open, with days left', async () => {
    // The newest campaign is the one an operator is most likely to read, and
    // the one whose numbers mean least.
    const r = await loadCampaignSegmentReport(stubDb([], new Date()), CAMPAIGN);
    expect(r.windowClosed).toBe(false);
    expect(r.windowDaysRemaining).toBeGreaterThan(5);
  });

  it('counts an unsubscribe whose source_channel is absent, instead of dropping it', async () => {
    // The guard reads `d.source_channel && d.source_channel !== CREDENTIAL_LINK_CHANNEL`,
    // and that leading conjunct is a decision, not a null-check habit: an event
    // with no channel at all is COUNTED. Measured on 2026-08-19 it guards no
    // live producer — both writers of `event_type: 'unsubscribe'` stamp the
    // field (functions/src/newsletterSubscriptionManagement.js:1207 and the SPA
    // path `unsubscribeNewsletterSubscriber` that landed with #5690), and the
    // Resend webhook writes `unsubscribed`, a spelling this query never reads.
    // It is a deliberate default in the one direction that is safe to be wrong
    // in: an opt-out we cannot attribute must inflate the rate, never vanish
    // from it. `sanitizeString` returns null rather than undefined, so both
    // shapes are pinned here. Dropping the conjunct leaves every other test in
    // this file green — which is the whole reason this one exists.
    const senzaCampo = {
      event_type: 'unsubscribe', email: EMAIL,
      timestamp: new Date('2026-06-16T08:00:00Z'), occurred_at: '2026-06-16T08:00:00.000Z',
    };
    expect((await loadCampaignSegmentReport(stubDb([senzaCampo]), CAMPAIGN)).totalUnsubscribes).toBe(1);
    expect((await loadCampaignSegmentReport(stubDb([unsub(null)]), CAMPAIGN)).totalUnsubscribes).toBe(1);
  });
});

// follow-up(#6062) item 1: toMillis(d.sent_at) was unverified on malformed/legacy
// timestamps — a null return could in principle contribute as 0/NaN and drag
// maxSentAt (hence windowClosed) below the real value.
describe('toMillis (scripts/lib/firestoreTimestamp.mjs) — malformed/legacy shapes', () => {
  it('returns null, never NaN, for a value it cannot parse', () => {
    expect(toMillis('not-a-real-timestamp')).toBeNull();
    expect(toMillis({})).toBeNull();
    expect(toMillis(NaN)).toBeNull();
  });

  it('returns null for falsy input instead of epoch 0', () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('')).toBeNull();
    expect(toMillis(0)).toBeNull();
  });

  it('still parses every legitimate Firestore/legacy shape', () => {
    expect(toMillis({ toMillis: () => 123 })).toBe(123);
    expect(toMillis({ toDate: () => new Date(456) })).toBe(456);
    expect(toMillis({ _seconds: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(toMillis(new Date('2026-06-15T08:00:00Z'))).toBe(Date.parse('2026-06-15T08:00:00Z'));
    expect(toMillis('2026-06-15T08:00:00Z')).toBe(Date.parse('2026-06-15T08:00:00Z'));
  });
});

describe('loadCampaignSegmentReport — a malformed sent_at cannot drag the window down', () => {
  const CAMPAIGN = 'weekly_2026-06-15';

  function stubDb(deliveryDocs: any[]) {
    const chain = (group: string) => {
      const q: any = {
        where: () => q,
        orderBy: () => q,
        limit: () => q,
        get: async () => ({
          docs: group === 'campaign_deliveries'
            ? deliveryDocs.map((d) => ({
                id: buildDeliveryDocId(CAMPAIGN, d.email),
                data: () => d,
                ref: { parent: { parent: { id: d.email } } },
              }))
            : [],
        }),
      };
      return q;
    };
    return { collectionGroup: (g: string) => chain(g) };
  }

  it('excludes an unparseable sent_at from min/max instead of letting it contribute 0/NaN, while still counting the send', async () => {
    const validSentAt = new Date('2026-06-15T08:00:00Z');
    const malformed = { email: 'malformed@x.com', sent_at: 'not-a-real-timestamp', provider: 'resend', segment: 'hot_jobs' };
    const valid = { email: 'valid@x.com', sent_at: validSentAt, provider: 'resend', segment: 'hot_jobs' };

    // Order matters for the regression this guards: if a null/NaN contribution
    // could win Math.min, it must lose to the malformed doc here (pushed first).
    const r = await loadCampaignSegmentReport(stubDb([malformed, valid]), CAMPAIGN);

    expect(r.totalSends).toBe(2); // the malformed doc is still a real send
    // The window is anchored on the one parseable timestamp (6-day default),
    // not on epoch 0 — which would have closed the window far too early.
    const expectedWindowEnd = validSentAt.getTime() + 6 * 24 * 60 * 60 * 1000;
    expect(r.windowClosed).toBe(Date.now() >= expectedWindowEnd);
    expect(r.windowClosed).toBe(true); // 2026-06-15 is long past, given today's date
  });
});

