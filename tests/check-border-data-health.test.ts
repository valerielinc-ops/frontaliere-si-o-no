/**
 * Unit tests for the pure decision logic in
 * scripts/check-border-data-health.mjs (the border live-data watchdog).
 *
 * No network and no IO: the staleness / all-mock / broken-webcam decisions are
 * exercised through injected fixtures. Per the repo test rules, all timestamps
 * are RELATIVE to now (Date.now() - N) — never absolute literals — so the suite
 * never time-bombs on a calendar boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateStaleness,
  evaluateAllMockSource,
  evaluateWebcamResult,
  collectWebcamUrls,
  isStalenessCheckActive,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/check-border-data-health.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('evaluateStaleness', () => {
  const now = Date.now();

  it('is fresh when updatedAt is within the threshold', () => {
    const doc = { updatedAt: isoAgo(30 * MIN), perCrossing: {} };
    const r = evaluateStaleness(doc, now, 6);
    expect(r.stale).toBe(false);
    expect(r.ageMinutes).toBeGreaterThanOrEqual(29);
    expect(r.ageMinutes).toBeLessThanOrEqual(31);
  });

  it('is stale when updatedAt is older than the threshold', () => {
    const doc = { updatedAt: isoAgo(7 * HOUR), perCrossing: {} };
    const r = evaluateStaleness(doc, now, 6);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/snapshot is \d+ min old/i);
  });

  it('honors a custom threshold (default 6h would pass, 1h fails)', () => {
    const doc = { updatedAt: isoAgo(2 * HOUR) };
    expect(evaluateStaleness(doc, now, 6).stale).toBe(false);
    expect(evaluateStaleness(doc, now, 1).stale).toBe(true);
  });

  it('falls back to the newest per-crossing lastUpdate when updatedAt is absent', () => {
    const doc = {
      perCrossing: {
        a: { lastUpdate: isoAgo(5 * HOUR) },
        b: { lastUpdate: isoAgo(20 * MIN) }, // newest → drives freshness
      },
    };
    const r = evaluateStaleness(doc, now, 6);
    expect(r.stale).toBe(false);
    expect(r.ageMinutes).toBeLessThanOrEqual(21);
  });

  it('flags stale when there is no usable timestamp at all', () => {
    expect(evaluateStaleness({ perCrossing: {} }, now, 6).stale).toBe(true);
    expect(evaluateStaleness(null, now, 6).stale).toBe(true);
    expect(evaluateStaleness({ updatedAt: 'not-a-date' }, now, 6).stale).toBe(true);
  });
});

describe('evaluateAllMockSource', () => {
  it('trips only when EVERY crossing source is mock', () => {
    const doc = {
      perCrossing: {
        a: { source: 'mock' },
        b: { source: 'mock' },
      },
    };
    const r = evaluateAllMockSource(doc);
    expect(r.allMock).toBe(true);
    expect(r.total).toBe(2);
    expect(r.mock).toBe(2);
    expect(r.reason).toMatch(/live routing provider failed/i);
  });

  it('tolerates a partial mock fallback (some live)', () => {
    const doc = {
      perCrossing: {
        a: { source: 'here' },
        b: { source: 'mock' },
      },
    };
    const r = evaluateAllMockSource(doc);
    expect(r.allMock).toBe(false);
    expect(r.mock).toBe(1);
    expect(r.total).toBe(2);
  });

  it('does not trip on an empty / missing perCrossing', () => {
    expect(evaluateAllMockSource({ perCrossing: {} }).allMock).toBe(false);
    expect(evaluateAllMockSource({}).allMock).toBe(false);
    expect(evaluateAllMockSource(null).allMock).toBe(false);
  });
});

describe('evaluateWebcamResult', () => {
  it('passes a full-size 200 response', () => {
    const r = evaluateWebcamResult({ ok: true, status: 200, bytes: 250 * 1024 });
    expect(r.broken).toBe(false);
  });

  it('treats an IP-discriminating block (401/403/406/407/415/429/451) as INDETERMINATE, not broken', () => {
    // A 403 from the monitor's single cloud IP does NOT prove the feed is broken
    // for end users: access-control / geo / rate-limit layers routinely block
    // datacenter ranges while serving residential browsers a healthy 200.
    // (lagomaggiorexperience.it canneroriviera case, issue #2336: 200/147KB from a
    // residential IP, stable 403 from the GitHub Actions runner.)
    // 406 + 415 are the anti-bot/WAF content-negotiation replies reused from the
    // shared WAF_IP_BLOCK_STATUS (lib/transient-fetch.mjs). #3098: a LiteSpeed 415
    // from comune.cannobio.vb.it (Cannobio-Brissago webcam) mis-paged as broken
    // while it served a healthy 200/62KB webp to real users.
    for (const status of [401, 403, 406, 407, 415, 429, 451]) {
      const r = evaluateWebcamResult({ ok: false, status, bytes: 0 });
      expect(r.broken, `status ${status}`).toBe(false);
      expect(r.indeterminate, `status ${status}`).toBe(true);
      expect(r.reason).toMatch(/cloud-IP block|blocked from monitor/i);
    }
  });

  it('flags a genuinely-gone (404/410) or server-fault (5xx) response as broken', () => {
    for (const status of [404, 410, 500, 502, 503]) {
      const r = evaluateWebcamResult({ ok: false, status, bytes: 0 });
      expect(r.broken, `status ${status}`).toBe(true);
      expect(r.reason).toMatch(new RegExp(`HTTP ${status}`));
    }
  });

  it('flags a tiny body (error/placeholder page) as broken', () => {
    const r = evaluateWebcamResult({ ok: true, status: 200, bytes: 2 * 1024 });
    expect(r.broken).toBe(true);
    expect(r.reason).toMatch(/too small/i);
  });

  it('honors a custom minBytes floor', () => {
    expect(evaluateWebcamResult({ ok: true, status: 200, bytes: 5 * 1024 }, 1024).broken).toBe(false);
    expect(evaluateWebcamResult({ ok: true, status: 200, bytes: 5 * 1024 }, 8 * 1024).broken).toBe(true);
  });

  it('treats a connection-level failure (networkError) as INDETERMINATE, not broken', () => {
    // A feed unreachable from the monitor's single cloud IP may still serve end
    // users fine — must not page. (Gandria/scceresio.ch case: 200 for users, fetch-failed from CI.)
    const r = evaluateWebcamResult({ ok: false, status: 'error: fetch failed', bytes: 0, networkError: true });
    expect(r.broken).toBe(false);
    expect(r.indeterminate).toBe(true);
    expect(r.reason).toMatch(/unreachable from monitor/i);
  });

  it('treats a malformed/empty result (no networkError flag) as broken', () => {
    expect(evaluateWebcamResult(null).broken).toBe(true);
    expect(evaluateWebcamResult({ ok: false, status: 500, bytes: 0 }).broken).toBe(true);
  });
});

describe('collectWebcamUrls', () => {
  it('dedups shared image URLs and tracks every crossing served', () => {
    const crossings = [
      { name: 'Chiasso Centro', webcams: [{ imageUrl: 'https://x/a.gif', label: 'A' }] },
      { name: 'Chiasso Strada', webcams: [{ imageUrl: 'https://x/a.gif', label: 'A' }] }, // shared
      { name: 'Gaggiolo', webcams: [{ imageUrl: 'https://x/b.gif', label: 'B' }] },
      { name: 'No webcam' },
    ];
    const map = collectWebcamUrls(crossings);
    expect(map.size).toBe(2);
    expect(map.get('https://x/a.gif')!.crossings).toEqual(['Chiasso Centro', 'Chiasso Strada']);
    expect(map.get('https://x/b.gif')!.crossings).toEqual(['Gaggiolo']);
  });

  it('returns an empty map for no crossings / no webcams', () => {
    expect(collectWebcamUrls([]).size).toBe(0);
    expect(collectWebcamUrls(undefined as unknown as []).size).toBe(0);
  });

  it('carries a per-webcam minBytes override through to the map entry (issue #3438)', () => {
    const crossings = [
      { name: 'Zenna-Dirinella', webcams: [{ imageUrl: 'https://x/small.jpg', label: 'Small', minBytes: 4000 }] },
      { name: 'Chiasso Centro', webcams: [{ imageUrl: 'https://x/a.gif', label: 'A' }] },
    ];
    const map = collectWebcamUrls(crossings);
    expect(map.get('https://x/small.jpg')!.minBytes).toBe(4000);
    expect(map.get('https://x/a.gif')!.minBytes).toBeUndefined();
  });
});

describe('isStalenessCheckActive (active-window gate)', () => {
  // Only the UTC HOUR matters; the calendar date is irrelevant and this is NOT
  // a stale-vs-now comparison, so a fixed date here is not a time-bomb.
  const atUtcHour = (hour: number): number => Date.UTC(2026, 0, 5, hour, 30, 0);

  it('is INACTIVE at the 00:00 UTC watchdog run (overnight false-positive guard)', () => {
    expect(isStalenessCheckActive(atUtcHour(0))).toBe(false);
  });

  it('is INACTIVE before 11:00 UTC — overnight guard (#2587) + morning scheduling gap (#4229)', () => {
    expect(isStalenessCheckActive(atUtcHour(4))).toBe(false);
    // 05:00–07:00: delayed overnight watchdog (00:00 cron at 05:05, #2587) must
    // not arm while the prior evening's snapshot is still the freshest one.
    expect(isStalenessCheckActive(atUtcHour(5))).toBe(false);
    expect(isStalenessCheckActive(atUtcHour(6))).toBe(false);
    expect(isStalenessCheckActive(atUtcHour(7))).toBe(false);
    // 08:00–10:59: traffic-scheduler morning peak ends at 07:30 UTC; next run is
    // midday at 11:00. Data is EXPECTED to be stale here (3.5h gap > 90-min
    // threshold). Self-heal dispatches but must not page (issue #4229 false page).
    expect(isStalenessCheckActive(atUtcHour(8))).toBe(false);
    expect(isStalenessCheckActive(atUtcHour(9))).toBe(false);
    expect(isStalenessCheckActive(atUtcHour(10))).toBe(false);
  });

  it('is ACTIVE from 11:00 UTC — midday run has fired; stale data is a real freeze', () => {
    expect(isStalenessCheckActive(atUtcHour(11))).toBe(true);
    expect(isStalenessCheckActive(atUtcHour(12))).toBe(true);
    expect(isStalenessCheckActive(atUtcHour(18))).toBe(true);
  });

  it('is INACTIVE at/after 20:00 UTC', () => {
    expect(isStalenessCheckActive(atUtcHour(20))).toBe(false);
    expect(isStalenessCheckActive(atUtcHour(23))).toBe(false);
  });
});

describe('staleness page-gate (issue #2587 regression)', () => {
  // Reproduces the orchestration's `stale.stale && stalenessActive` page
  // condition: the 00:00 UTC watchdog cron delivered late at 05:05 Mon, with the
  // freshest snapshot being the prior Sunday 19:14 collection (591 min old).
  // Before the fix this paged a false "degraded"; now the gate is inactive at
  // 05:05 so it does NOT page, while a genuine daytime freeze still does.
  const PAGE = (snapshotIso: string, nowMs: number): boolean => {
    const stale = evaluateStaleness({ updatedAt: snapshotIso }, nowMs, 6);
    return stale.stale && isStalenessCheckActive(nowMs);
  };

  it('does NOT page for the overnight-aged snapshot seen by a delayed 05:05 run', () => {
    const now = Date.UTC(2026, 5, 22, 5, 5, 20); // Mon 05:05:20 UTC
    const snapshot = '2026-06-21T19:14:05Z'; // Sun 19:14 — 591 min old
    expect(evaluateStaleness({ updatedAt: snapshot }, now, 6).ageMinutes).toBe(591);
    expect(PAGE(snapshot, now)).toBe(false);
  });

  it('DOES page for a genuine freeze during the active window (11:00+)', () => {
    const now = Date.UTC(2026, 5, 22, 12, 0, 0); // Mon 12:00 UTC, in-window
    const snapshot = '2026-06-22T02:00:00Z'; // 10h old — pipeline truly frozen
    expect(PAGE(snapshot, now)).toBe(true);
  });

  it('does NOT page during the morning scheduling gap (08:00–10:59 UTC) even when data is stale — regression for issue #4229', () => {
    // traffic-scheduler morning peak ends at 07:30 UTC; next run is 11:00 UTC.
    // Data from 08:43 is 124 min old at 10:47 — stale for the 90-min check but
    // EXPECTED (not a real freeze). Self-heal dispatches; no issue should open/promote.
    const now = Date.UTC(2026, 6, 15, 10, 47, 0); // Tue 10:47 UTC (issue #4229)
    const snapshot = '2026-07-15T08:43:00Z'; // 124 min old — within morning gap
    expect(evaluateStaleness({ updatedAt: snapshot }, now, 6).stale).toBe(false); // fine for 6h backstop
    expect(PAGE(snapshot, now)).toBe(false); // must NOT page: morning gap, not a real freeze
  });
});
