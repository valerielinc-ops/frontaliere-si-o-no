/**
 * Tests for the webcam-only collection fallback in
 * functions/src/trafficSchedulerCore.js.
 *
 * Why this exists:
 * The HERE free-tier monthly budget guard returns early from
 * runTrafficCollection WITHOUT running the per-crossing loop once the budget is
 * exhausted, freezing data/border-wait-current.json for the rest of the month
 * and forcing the SPA onto its statistical mock. runWebcamOnlyCollection closes
 * that gap: it derives a PRIMARY wait estimate from the FREE road-facing webcams
 * and persists it through the SAME Firestore path the normal collection uses, so
 * the on-disk JSON mirror (scripts/collect-traffic.mjs) refreshes off it.
 *
 * Covers:
 *  1. runWebcamOnlyCollection — produces source:'webcam' results for
 *     good-visibility crossings, skips night/poor/no-feed, persists via
 *     saveTrafficToFirestore, derives status from the estimated minutes.
 *  2. runTrafficCollection — routes to the webcam-only fallback when the HERE
 *     budget is exhausted, and when no routing provider is configured; preserves
 *     the original skip-and-return-0 behavior when webcam analysis is disabled.
 *
 * All network/sharp/Firestore I/O is mocked — NO real fetches, NO real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── firebase-admin mock ──────────────────────────────────────────
// Captures every saveTrafficToFirestore write (trafficCurrent + trafficHistory)
// and serves a controllable HERE-budget transaction document. Pure in-memory;
// no real Firestore connection.

const { adminState } = vi.hoisted(() => ({
  adminState: {
    // Records pushed to saveTrafficToFirestore via batch.set on trafficCurrent.
    savedCurrent: [] as Array<Record<string, unknown>>,
    // Controls reserveHereTransactionBudget: { month, count } stored doc.
    budgetDoc: undefined as { month?: string; count?: number } | undefined,
  },
}));

vi.mock('firebase-admin', () => {
  const Timestamp = { now: () => ({ __ts: Date.now() }) };
  const firestore = Object.assign(
    () => ({
      // saveTrafficToFirestore: db.batch() then batch.set(currentRef|historyRef)
      batch: () => ({
        set: (ref: { __collection?: string }, data: Record<string, unknown>) => {
          if (ref && ref.__collection === 'trafficCurrent') {
            adminState.savedCurrent.push(data);
          }
        },
        commit: async () => {},
      }),
      // reserveHereTransactionBudget: db.collection('meta').doc(...).
      // saveTrafficToFirestore: db.collection('trafficCurrent'|'trafficHistory').
      collection: (name: string) => ({
        doc: () => ({
          __collection: name,
          // trafficHistory chains .collection('snapshots').doc(id)
          collection: () => ({ doc: () => ({ __collection: 'trafficHistorySnapshot' }) }),
        }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          get: async () => ({
            exists: adminState.budgetDoc != null,
            data: () => adminState.budgetDoc ?? {},
          }),
          set: (_ref: unknown, data: { month?: string; count?: number }) => {
            adminState.budgetDoc = { month: data.month, count: data.count };
          },
        }),
    }),
    { Timestamp },
  );
  return {
    default: {
      apps: [{}], // pretend an app already exists → ensureAdminApp() no-ops
      initializeApp: vi.fn(),
      credential: { applicationDefault: vi.fn() },
      firestore,
    },
  };
});

// ─── webcam module mock ───────────────────────────────────────────
// Maps a crossing slug → its aggregated verdict. Anything not in the map
// returns null (crossing has no CV feed), matching analyzeWebcamForCrossing.

const { webcamBySlug } = vi.hoisted(() => ({
  webcamBySlug: new Map<string, unknown>(),
}));

vi.mock('../scripts/analyze-webcam-frame.mjs', () => ({
  analyzeWebcamForCrossing: vi.fn(async (slug: string) =>
    webcamBySlug.has(slug) ? webcamBySlug.get(slug) : null,
  ),
}));

// ─── helpers ──────────────────────────────────────────────────────

import { slugifyCrossingName, BORDER_CROSSINGS } from '../functions/src/borderCrossingsData.js';

interface CrossingResult {
  crossingName: string;
  waitTimeMinutes: number;
  approachMinutes: number;
  totalCrossingMinutes: number;
  status: string;
  direction: string;
  source: string;
}

interface CollectionResult {
  collected: number;
  errors: number;
  source?: string;
  skipped?: string;
}

type CoreModule = {
  runWebcamOnlyCollection: (options?: Record<string, unknown>) => Promise<CollectionResult>;
  runTrafficCollection: (options?: Record<string, unknown>) => Promise<CollectionResult>;
};

function resetState() {
  adminState.savedCurrent.length = 0;
  adminState.budgetDoc = undefined;
  webcamBySlug.clear();
}

beforeEach(() => {
  vi.resetModules();
  resetState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── runWebcamOnlyCollection ──────────────────────────────────────

describe('runWebcamOnlyCollection', () => {
  it('produces source:"webcam" results for good-visibility crossings and persists them', async () => {
    const first = BORDER_CROSSINGS[0];
    const second = BORDER_CROSSINGS[1];
    webcamBySlug.set(slugifyCrossingName(first.name), {
      congestionScore: 0.85, // heavy → 22 min → red
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });
    webcamBySlug.set(slugifyCrossingName(second.name), {
      congestionScore: 0.45, // light → 8 min → yellow
      queueDetected: true,
      visibility: 'good',
      feeds: ['01.2S'],
    });

    const { runWebcamOnlyCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runWebcamOnlyCollection({ enableWebcam: true });

    expect(result.collected).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.source).toBe('webcam-only');

    // Both crossings persisted via the normal Firestore path.
    expect(adminState.savedCurrent).toHaveLength(2);
    const saved = adminState.savedCurrent as unknown as CrossingResult[];
    for (const r of saved) {
      expect(r.source).toBe('webcam');
      expect(r.approachMinutes).toBe(0);
      expect(r.totalCrossingMinutes).toBe(r.waitTimeMinutes);
    }

    const byName = new Map(saved.map((r) => [r.crossingName, r]));
    expect(byName.get(first.name)?.waitTimeMinutes).toBe(22);
    expect(byName.get(first.name)?.status).toBe('red');
    expect(byName.get(second.name)?.waitTimeMinutes).toBe(8);
    expect(byName.get(second.name)?.status).toBe('yellow');
  });

  it('skips crossings with no CV feed (analyzeWebcamForCrossing → null)', async () => {
    // No entries in webcamBySlug → every crossing returns null.
    const { runWebcamOnlyCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runWebcamOnlyCollection({ enableWebcam: true });

    expect(result.collected).toBe(0);
    expect(result.errors).toBe(0);
    expect(adminState.savedCurrent).toHaveLength(0);
  });

  it('skips night and poor visibility crossings', async () => {
    const nightCrossing = BORDER_CROSSINGS[0];
    const poorCrossing = BORDER_CROSSINGS[1];
    webcamBySlug.set(slugifyCrossingName(nightCrossing.name), {
      congestionScore: null,
      queueDetected: false,
      visibility: 'night',
      feeds: [],
    });
    webcamBySlug.set(slugifyCrossingName(poorCrossing.name), {
      congestionScore: null,
      queueDetected: false,
      visibility: 'poor',
      feeds: [],
    });

    const { runWebcamOnlyCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runWebcamOnlyCollection({ enableWebcam: true });

    expect(result.collected).toBe(0);
    expect(adminState.savedCurrent).toHaveLength(0);
  });

  it('maps a clear road (low score) to a green 0-minute estimate', async () => {
    const crossing = BORDER_CROSSINGS[0];
    webcamBySlug.set(slugifyCrossingName(crossing.name), {
      congestionScore: 0.1, // below the 0.40 trust floor → 0 min
      queueDetected: false,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const { runWebcamOnlyCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runWebcamOnlyCollection({ enableWebcam: true });

    expect(result.collected).toBe(1);
    const saved = adminState.savedCurrent as unknown as CrossingResult[];
    expect(saved[0].waitTimeMinutes).toBe(0);
    expect(saved[0].status).toBe('green');
    expect(saved[0].source).toBe('webcam');
  });

  it('counts a thrown webcam analysis as an error and keeps going', async () => {
    const good = BORDER_CROSSINGS[0];
    webcamBySlug.set(slugifyCrossingName(good.name), {
      congestionScore: 0.7,
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const { runWebcamOnlyCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    // Make the webcam analyzer throw for one specific crossing.
    const webcamModule = await import('../scripts/analyze-webcam-frame.mjs');
    const throwingSlug = slugifyCrossingName(BORDER_CROSSINGS[1].name);
    vi.mocked(webcamModule.analyzeWebcamForCrossing).mockImplementation(async (slug: string) => {
      if (slug === throwingSlug) throw new Error('sharp boom');
      return webcamBySlug.has(slug) ? webcamBySlug.get(slug) : null;
    });

    const result = await runWebcamOnlyCollection({ enableWebcam: true });

    // One good crossing collected, one threw → 1 error, the rest skipped.
    expect(result.collected).toBe(1);
    expect(result.errors).toBe(1);
  });
});

// ─── runTrafficCollection routing into the fallback ───────────────

describe('runTrafficCollection — routes to webcam-only fallback', () => {
  it('falls back to webcam-only when the HERE monthly budget is exhausted', async () => {
    // Pre-load the budget doc so reserveHereTransactionBudget rejects this run.
    const month = new Date()
      .toLocaleDateString('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      .slice(0, 7);
    adminState.budgetDoc = { month, count: 4500 }; // at budget → any callsThisRun > 0 rejects

    const crossing = BORDER_CROSSINGS[0];
    webcamBySlug.set(slugifyCrossingName(crossing.name), {
      congestionScore: 0.85,
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const { runTrafficCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runTrafficCollection({ hereApiKey: 'here-key', enableWebcam: true });

    expect(result.source).toBe('webcam-only');
    expect(result.collected).toBe(1);
    const saved = adminState.savedCurrent as unknown as CrossingResult[];
    expect(saved[0].source).toBe('webcam');
    expect(saved[0].waitTimeMinutes).toBe(22);
  });

  it('keeps the original skip-and-return-0 behavior when webcam is disabled and budget is exhausted', async () => {
    const month = new Date()
      .toLocaleDateString('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      .slice(0, 7);
    adminState.budgetDoc = { month, count: 4500 };

    const crossing = BORDER_CROSSINGS[0];
    webcamBySlug.set(slugifyCrossingName(crossing.name), {
      congestionScore: 0.85,
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const { runTrafficCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runTrafficCollection({ hereApiKey: 'here-key', enableWebcam: false });

    expect(result.collected).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe('here-budget');
    expect(result.source).toBeUndefined();
    // Nothing persisted: the budget guard short-circuited before any webcam work.
    expect(adminState.savedCurrent).toHaveLength(0);
  });

  it('falls back to webcam-only when no routing provider key is configured', async () => {
    const crossing = BORDER_CROSSINGS[0];
    webcamBySlug.set(slugifyCrossingName(crossing.name), {
      congestionScore: 0.65, // moderate → 15 min → red (>=15)
      queueDetected: true,
      visibility: 'good',
      feeds: ['02.0N'],
    });

    const { runTrafficCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    // No hereApiKey/tomtomApiKey/googleApiKey → provider is null.
    const result = await runTrafficCollection({ enableWebcam: true });

    expect(result.source).toBe('webcam-only');
    expect(result.collected).toBe(1);
    const saved = adminState.savedCurrent as unknown as CrossingResult[];
    expect(saved[0].waitTimeMinutes).toBe(15);
    expect(saved[0].status).toBe('red');
  });

  it('keeps returning 0 (no webcam work) when no provider AND webcam disabled', async () => {
    const { runTrafficCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    const result = await runTrafficCollection({ enableWebcam: false });

    expect(result.collected).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.source).toBeUndefined();
    expect(adminState.savedCurrent).toHaveLength(0);
  });

  it('falls back to TomTom (free tier) live routing when HERE budget is exhausted and a TomTom key is set', async () => {
    const month = new Date()
      .toLocaleDateString('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      .slice(0, 7);
    adminState.budgetDoc = { month, count: 4500 }; // HERE budget exhausted

    // Mock the TomTom routing fetch: a summary with a small traffic delay (5 min,
    // not <5, so the flow sanity check is skipped). Any non-route URL gets a benign body.
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('calculateRoute')) {
        return {
          ok: true,
          json: async () => ({ routes: [{ summary: { travelTimeInSeconds: 600, noTrafficTravelTimeInSeconds: 300 } }] }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runTrafficCollection } = (await import(
      '../functions/src/trafficSchedulerCore.js'
    )) as CoreModule;

    // hereApiKey present (would normally win) but budget exhausted → must fall back
    // to TomTom, NOT to webcam-only or a skip. TomTom routing rate-limits itself
    // with a real 1s inter-batch setTimeout (25 crossings / batch size 2 = 12
    // delays = ~12s) to stay under the free-tier QPS cap — fake timers let this
    // real production delay resolve instantly against the fully-mocked fetch
    // below, without touching Date (the budget-month check above depends on it).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const resultPromise = runTrafficCollection({
      hereApiKey: 'here-key',
      tomtomApiKey: 'tt-key',
      enableWebcam: false,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.skipped).toBeUndefined(); // did NOT skip the run
    expect(result.source).not.toBe('webcam-only'); // did NOT degrade to webcam-only
    expect(result.collected).toBeGreaterThan(0); // real routing collection ran
    expect(fetchMock).toHaveBeenCalled(); // TomTom routing was actually queried
    const saved = adminState.savedCurrent as Array<{ source?: string }>;
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.source === 'tomtom')).toBe(true);
  });
});
