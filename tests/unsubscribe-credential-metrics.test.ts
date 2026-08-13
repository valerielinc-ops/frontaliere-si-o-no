// #5757 item 3 — the deferred monitor for the unsubscribe `credential` field
// (#5719: 'autologin_code' | 'email_token'). Twin of
// tests/autologin-refusal-metrics.test.ts, same split: pure arithmetic here
// (scripts/lib/unsubscribeCredentialMetrics.mjs), the Firestore-reading shell
// exercised separately below with a synthetic fake db so no test ever touches
// production, matching the task's own instruction ("con un input sintetico,
// senza toccare la produzione").
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCredential,
  aggregate,
  fallbackRate,
  evaluate,
  pct,
  FALLBACK_RATE_WARN,
  FALLBACK_RATE_URGENT,
  MIN_SAMPLE,
} from '../scripts/lib/unsubscribeCredentialMetrics.mjs';
import { runCheck } from '../scripts/check-unsubscribe-credential-rate.mjs';

describe('unsubscribeCredentialMetrics — classifyCredential', () => {
  it('recognizes both real values', () => {
    expect(classifyCredential('autologin_code')).toBe('autologin_code');
    expect(classifyCredential('email_token')).toBe('email_token');
  });

  it('folds anything else (undefined, null, unknown string) into "missing"', () => {
    expect(classifyCredential(undefined)).toBe('missing');
    expect(classifyCredential(null)).toBe('missing');
    expect(classifyCredential('')).toBe('missing');
    expect(classifyCredential('something_else')).toBe('missing');
  });
});

function records(spec: { autologin?: number; email?: number; missing?: number }) {
  const out: Array<{ credential: string | null }> = [];
  for (let i = 0; i < (spec.autologin || 0); i++) out.push({ credential: 'autologin_code' });
  for (let i = 0; i < (spec.email || 0); i++) out.push({ credential: 'email_token' });
  for (let i = 0; i < (spec.missing || 0); i++) out.push({ credential: null });
  return out;
}

describe('unsubscribeCredentialMetrics — aggregate / fallbackRate', () => {
  it('counts each family and computes graded/total correctly', () => {
    const agg = aggregate(records({ autologin: 2, email: 18, missing: 5 }));
    expect(agg.counts).toEqual({ autologin_code: 2, email_token: 18, missing: 5 });
    expect(agg.graded).toBe(20);
    expect(agg.total).toBe(25);
  });

  it('fallbackRate is autologin_code / (autologin_code + email_token), excluding "missing" from the denominator', () => {
    const agg = aggregate(records({ autologin: 5, email: 15, missing: 1000 }));
    expect(agg.fallbackRate).toBeCloseTo(0.25, 10);
  });

  it('fallbackRate is null (not 0) when nothing is graded — an all-missing or empty window is not a perfect score', () => {
    expect(fallbackRate({ counts: { autologin_code: 0, email_token: 0 } })).toBeNull();
    expect(aggregate(records({ missing: 40 })).fallbackRate).toBeNull();
    expect(aggregate([]).fallbackRate).toBeNull();
  });
});

describe('unsubscribeCredentialMetrics — evaluate', () => {
  it('total === 0 → no_signal, alerting, priority 2 (an empty window is a broken query, not a healthy one)', () => {
    const agg = aggregate([]);
    const v = evaluate(agg, { baselineIsZero: true });
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(2);
    expect(v.findings.map((f) => f.code)).toContain('no_signal');
  });

  it('graded below MIN_SAMPLE → insufficient_sample, NOT alerting', () => {
    const agg = aggregate(records({ autologin: 1, email: MIN_SAMPLE - 3, missing: 2 }));
    const v = evaluate(agg, { baselineIsZero: true });
    expect(v.alert).toBe(false);
    expect(v.findings.map((f) => f.code)).toContain('insufficient_sample');
  });

  it('healthy rate (well under WARN) with a non-zero baseline → no findings, no alert', () => {
    const agg = aggregate(records({ autologin: 0, email: 40 }));
    const v = evaluate(agg, { baselineIsZero: false });
    expect(v.alert).toBe(false);
    expect(v.findings).toEqual([]);
  });

  it('rate ≥ FALLBACK_RATE_WARN (and < URGENT) → fallback_rate_warn, priority 2, alerting', () => {
    const total = 40;
    const autologin = Math.ceil(total * (FALLBACK_RATE_WARN + 0.01));
    const agg = aggregate(records({ autologin, email: total - autologin }));
    const v = evaluate(agg, { baselineIsZero: false });
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(2);
    expect(v.findings.map((f) => f.code)).toContain('fallback_rate_warn');
  });

  it('rate ≥ FALLBACK_RATE_URGENT → fallback_rate_urgent, priority 1, outranks warn', () => {
    const total = 40;
    const autologin = Math.ceil(total * (FALLBACK_RATE_URGENT + 0.01));
    const agg = aggregate(records({ autologin, email: total - autologin }));
    const v = evaluate(agg, { baselineIsZero: false });
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(1);
    expect(v.findings.map((f) => f.code)).toContain('fallback_rate_urgent');
    expect(v.findings.map((f) => f.code)).not.toContain('fallback_rate_warn');
  });

  it('first-ever autologin_code (rate under WARN) with a zero baseline → first_fallback_after_zero_baseline, low priority but alerting', () => {
    const agg = aggregate(records({ autologin: 1, email: MIN_SAMPLE + 20 }));
    const v = evaluate(agg, { baselineIsZero: true });
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(3);
    expect(v.findings.map((f) => f.code)).toContain('first_fallback_after_zero_baseline');
  });

  it('same low rate but baseline is ALREADY non-zero → no finding (already known, not a state change)', () => {
    const agg = aggregate(records({ autologin: 1, email: MIN_SAMPLE + 20 }));
    const v = evaluate(agg, { baselineIsZero: false });
    expect(v.alert).toBe(false);
    expect(v.findings).toEqual([]);
  });
});

describe('unsubscribeCredentialMetrics — pct', () => {
  it('formats a ratio as a percentage string', () => {
    expect(pct(0.1)).toBe('10.00%');
    expect(pct(FALLBACK_RATE_URGENT)).toBe('25.00%');
  });

  it('renders null/undefined as "n/d"', () => {
    expect(pct(null)).toBe('n/d');
    expect(pct(undefined)).toBe('n/d');
  });
});

// ── Synthetic Firestore fake — mirrors the .collection().where().limit().get()
// then per-doc .ref.collection().where().get() chain that
// readUnsubscribeLinkEvents() actually calls. No network, no credentials,
// no production access — exactly the "input sintetico" the task calls for. ──

type FakeEvent = Record<string, unknown>;

function createFakeDb(subscriberEvents: FakeEvent[][]) {
  return {
    collection(name: string) {
      if (name !== 'newsletter_subscribers') throw new Error(`unexpected top-level collection: ${name}`);
      return {
        where() {
          return {
            limit() {
              return {
                async get() {
                  return {
                    size: subscriberEvents.length,
                    docs: subscriberEvents.map((events, i) => ({
                      id: `sub-${i}`,
                      ref: {
                        collection(subName: string) {
                          if (subName !== 'events') throw new Error(`unexpected subcollection: ${subName}`);
                          return {
                            where() {
                              return {
                                async get() {
                                  return { docs: events.map((ev) => ({ data: () => ev })) };
                                },
                              };
                            },
                          };
                        },
                      },
                    })),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function unsubEvent(credential: string | null, occurredAt: string, overrides: FakeEvent = {}) {
  return {
    event_type: 'unsubscribe',
    source_channel: 'unsubscribe_link',
    credential,
    occurred_at: occurredAt,
    ...overrides,
  };
}

function withTmpOutDir(fn: (outDir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'unsub-credential-monitor-test-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const NOW = new Date('2026-08-14T00:00:00.000Z');

describe('check-unsubscribe-credential-rate — runCheck (synthetic Firestore, no production access)', () => {
  it('healthy window (0 autologin_code, plenty of email_token) never writes alert.json', async () => withTmpOutDir(async (outDir) => {
    const subs: FakeEvent[][] = Array.from({ length: 40 }, (_, i) => [
      unsubEvent('email_token', '2026-08-13T10:00:00.000Z', { email: `u${i}@example.com` }),
    ]);
    const db = createFakeDb(subs);
    const result = await runCheck({ db, hours: 168, outDir, now: NOW });
    expect(result.verdict.alert).toBe(false);
    expect(result.alertWritten).toBe(false);
    expect(existsSync(result.alertPath)).toBe(false);
  }));

  it('THE MUTATION-KILLING CASE: fallback rate over URGENT actually writes an alert.json whose title matches the workflow\'s own closer prefix', async () => withTmpOutDir(async (outDir) => {
    // 30 graded events, 40% autologin_code — well over FALLBACK_RATE_URGENT (25%).
    const events: FakeEvent[][] = [];
    for (let i = 0; i < 12; i++) events.push([unsubEvent('autologin_code', '2026-08-13T12:00:00.000Z')]);
    for (let i = 0; i < 18; i++) events.push([unsubEvent('email_token', '2026-08-13T12:00:00.000Z')]);
    const db = createFakeDb(events);

    const result = await runCheck({ db, hours: 168, outDir, now: NOW });

    expect(result.verdict.alert).toBe(true);
    expect(result.verdict.priority).toBe(1);
    expect(result.alertWritten).toBe(true);
    expect(existsSync(result.alertPath)).toBe(true);

    const alert = JSON.parse(readFileSync(result.alertPath, 'utf8'));
    // The workflow's bespoke closer step greps for this exact prefix
    // (`^\[unsub-credential\] `) — a title drift here would mean the issue
    // this monitor opens can never be auto-closed.
    expect(alert.title).toMatch(/^\[unsub-credential\] /);
    expect(alert.title).toContain('fallback_rate_urgent');
    // Discriminant-first, dedup-safe: the finding code must survive a 60-char cut.
    expect(alert.title.slice(0, 60)).toContain('fallback_rate_urgent');
    expect(alert.priority).toBe(1);
    expect(alert.body).toContain('fallback_rate_urgent');
  }));

  it('zero unsubscribe_link events in the window → no_signal alert, not a silent "0% fallback" pass', async () => withTmpOutDir(async (outDir) => {
    const db = createFakeDb([[]]); // one candidate doc, but its events subcollection is empty
    const result = await runCheck({ db, hours: 168, outDir, now: NOW });
    expect(result.verdict.alert).toBe(true);
    expect(result.verdict.findings.map((f: { code: string }) => f.code)).toContain('no_signal');
    expect(result.alertWritten).toBe(true);
  }));

  it('an alert from a prior run is cleared once the window is healthy again (alert.json removed, not left stale)', async () => withTmpOutDir(async (outDir) => {
    const badEvents: FakeEvent[][] = [];
    for (let i = 0; i < 12; i++) badEvents.push([unsubEvent('autologin_code', '2026-08-13T12:00:00.000Z')]);
    for (let i = 0; i < 18; i++) badEvents.push([unsubEvent('email_token', '2026-08-13T12:00:00.000Z')]);
    const first = await runCheck({ db: createFakeDb(badEvents), hours: 168, outDir, now: NOW });
    expect(first.alertWritten).toBe(true);
    expect(existsSync(first.alertPath)).toBe(true);

    const healthyEvents: FakeEvent[][] = Array.from({ length: 40 }, () => [unsubEvent('email_token', '2026-08-13T12:00:00.000Z')]);
    const second = await runCheck({ db: createFakeDb(healthyEvents), hours: 168, outDir, now: NOW });
    expect(second.alertWritten).toBe(false);
    expect(existsSync(second.alertPath)).toBe(false);
  }));

  it('excludes events from other source_channels (e.g. bulk LPD requests) from the graded population', async () => withTmpOutDir(async (outDir) => {
    const events: FakeEvent[][] = [
      ...Array.from({ length: 25 }, () => [unsubEvent('email_token', '2026-08-13T12:00:00.000Z')]),
      // These carry no `credential` and a different channel — must not dilute
      // the denominator or trip insufficient_sample by inflating `total`
      // while `graded` stays the same.
      ...Array.from({ length: 100 }, () => [{
        event_type: 'unsubscribe',
        source_channel: 'richiesta_diretta_lpd',
        occurred_at: '2026-08-13T12:00:00.000Z',
      }]),
    ];
    const result = await runCheck({ db: createFakeDb(events), hours: 168, outDir, now: NOW });
    expect(result.agg.graded).toBe(25);
    expect(result.agg.total).toBe(25);
    expect(result.verdict.alert).toBe(false);
  }));

  it('excludes events outside the requested window even when the candidate doc itself is in range', async () => withTmpOutDir(async (outDir) => {
    const events: FakeEvent[][] = [
      // 25 recent (inside a 24h window)
      ...Array.from({ length: 25 }, () => [unsubEvent('email_token', '2026-08-13T20:00:00.000Z')]),
      // 25 stale (well before a 24h window, still inside a 7-day one)
      ...Array.from({ length: 25 }, () => [unsubEvent('email_token', '2026-08-07T00:00:00.000Z')]),
    ];
    const result = await runCheck({ db: createFakeDb(events), hours: 24, outDir, now: NOW });
    expect(result.agg.graded).toBe(25);
  }));
});
