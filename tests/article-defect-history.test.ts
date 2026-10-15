/**
 * Tests for scripts/lib/article-defect-history.mjs — the rejection ledger, the
 * second link of the article learning loop (docs/ARTICLE-LEARNING-LOOP.md).
 *
 * The ledger's safety argument is not "it computes the right averages", it is
 * "it cannot act". This repo already shipped a feedback loop that degenerated
 * (2026-07-28, run 30350429920: the fact-checker's own false positives became
 * rewrite instructions until the surviving draft had abandoned its source), so
 * the tests below are weighted towards the properties that keep this one inert
 * and honest rather than towards the arithmetic:
 *
 *   §5.9  the ledger has no code path into any defence  → the import-edge tests
 *   §5.10 a model's opinion is never admissible evidence → the quarantine tests
 *   §5.11 bounded, and convergent under `merge=union`    → the retention tests
 *   §5.12 no silent loss, no confident nonsense          → the malformed-line
 *                                                          and thin-sample tests
 *
 * Every behaviour is pinned with the case that must NOT happen alongside the
 * one that must: a trend detector that fires on any wobble is as useless as one
 * that never fires, and a retention policy that eats the row it was given is
 * worse than no retention at all.
 *
 * All timestamps are derived from an explicit `now` passed into the functions
 * under test — never calendar literals, which turn into time bombs the moment a
 * TTL crosses them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HISTORY_RETENTION,
  HISTORY_SCHEMA_VERSION,
  MIN_RUNS_FOR_TREND,
  SERIES_KIND,
  buildHistoryRow,
  readHistory,
  appendHistoryRow,
  applyRetention,
  summarizeHistory,
  formatHistorySummary,
} from '../scripts/lib/article-defect-history.mjs';

const NOW = '2026-07-29T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

/** ISO timestamp `d` days before the test's `now`. Never a calendar literal. */
const daysAgo = (d: number, hours = 0) =>
  new Date(NOW_MS - d * 86_400_000 - hours * 3_600_000).toISOString();

function row(overrides: Record<string, unknown> = {}) {
  return {
    v: HISTORY_SCHEMA_VERSION,
    at: NOW,
    runId: 'r1',
    section: 'frontaliere',
    status: 'generated',
    attempts: 1,
    articleId: 'a1',
    sourceDomain: 'tio.ch',
    gateRejections: {},
    duplicateRejections: {},
    verifierOpinion: {},
    sourceSupport: { present: 0, absent: 0, unknown: 0 },
    ...overrides,
  };
}

/** `n` runs in the window ending `endDaysAgo` days back, one per hour. */
function runs(n: number, endDaysAgo: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) =>
    row({ runId: `run-${endDaysAgo}-${i}`, at: daysAgo(endDaysAgo, i), ...overrides }));
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'defect-history-'));
  file = join(dir, 'article-defect-history.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildHistoryRow', () => {
  it('carries the run outcome, its cost, and what rejected it', () => {
    const r = buildHistoryRow({
      runId: '30361707533',
      section: 'svizzera',
      status: 'generated',
      article: { id: 'caldo-cantieri', sourceDomain: 'tio.ch' },
      duplicateReasonBreakdown: { 'semantic-near-duplicate': 2 },
      factuality: {
        attempts: 4,
        gateRejectionsByCode: { 'tax-exceeds-income': 2, 'fabricated-institution': 1 },
        factCheckRejectionsByCategory: { unsupported_claim: 3 },
        institutionObservations: [
          { acronym: 'USTRA', support: 'present' },
          { acronym: 'UFI', support: 'absent' },
          { acronym: 'UQJ', support: 'absent' },
        ],
      },
    }, { now: NOW });

    expect(r.runId).toBe('30361707533');
    expect(r.section).toBe('svizzera');
    expect(r.attempts).toBe(4);
    expect(r.gateRejections).toEqual({ 'tax-exceeds-income': 2, 'fabricated-institution': 1 });
    expect(r.duplicateRejections).toEqual({ 'semantic-near-duplicate': 2 });
    expect(r.verifierOpinion).toEqual({ unsupported_claim: 3 });
    expect(r.sourceSupport).toEqual({ present: 1, absent: 2, unknown: 0 });
  });

  it('records the status verbatim instead of collapsing it to published/not', () => {
    // `deferred` (quota exhausted) and `error` (crash) look identical under a
    // boolean, and they mean opposite things about whether a defence is at
    // fault. The interpretation belongs in the reader, where it can change
    // without invalidating six months of rows.
    for (const status of ['generated', 'skipped', 'deferred', 'error']) {
      expect(buildHistoryRow({ status, factuality: {} }, { now: NOW }).status).toBe(status);
    }
  });

  it('still produces a usable row from a report a crashed run left half-written', () => {
    // The run that dies hardest is the run whose row we most want. Throwing
    // here would drop exactly those from the ledger and make the outage look
    // like a quiet week.
    const r = buildHistoryRow({}, { now: NOW });
    expect(r.status).toBe('unknown');
    expect(r.attempts).toBe(0);
    expect(r.gateRejections).toEqual({});
    expect(() => buildHistoryRow(null as any, { now: NOW })).not.toThrow();
  });

  it('caps a runaway code map and says how much it dropped, never silently', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < HISTORY_RETENTION.maxCodesPerRow + 7; i++) wide[`code-${i}`] = i + 1;
    const r = buildHistoryRow({ factuality: { gateRejectionsByCode: wide } }, { now: NOW });
    // maxCodesPerRow real codes + the truncation marker.
    expect(Object.keys(r.gateRejections)).toHaveLength(HISTORY_RETENTION.maxCodesPerRow + 1);
    expect(r.gateRejections.__truncated).toBe(7);
    // The ones kept are the loudest, not an arbitrary slice.
    expect(r.gateRejections['code-18']).toBe(19);
    expect(r.gateRejections['code-0']).toBeUndefined();
  });

  it('does not add a truncation marker when nothing was truncated', () => {
    const r = buildHistoryRow({ factuality: { gateRejectionsByCode: { a: 1, b: 2 } } }, { now: NOW });
    expect(r.gateRejections.__truncated).toBeUndefined();
  });
});

describe('readHistory — no silent loss, no double counting', () => {
  it('treats a missing file as cold start, not as degradation', () => {
    const res = readHistory(join(dir, 'nope.jsonl'));
    expect(res.rows).toEqual([]);
    expect(res.degraded).toBeNull();
  });

  it('drops one malformed line and COUNTS it instead of blinding the file', () => {
    writeFileSync(file, [
      JSON.stringify(row({ runId: 'a' })),
      '{"at": "truncated mid-writ',
      JSON.stringify(row({ runId: 'b', at: daysAgo(0, 1) })),
    ].join('\n') + '\n');
    const res = readHistory(file);
    expect(res.rows).toHaveLength(2);
    expect(res.malformed).toBe(1);
  });

  it('rejects a row without a parseable timestamp — every reader keys on `at`', () => {
    writeFileSync(file, [
      JSON.stringify({ runId: 'x', at: 'not-a-date' }),
      JSON.stringify(row({ runId: 'ok' })),
    ].join('\n') + '\n');
    const res = readHistory(file);
    expect(res.rows.map((r: any) => r.runId)).toEqual(['ok']);
    expect(res.malformed).toBe(1);
  });

  it('collapses rows a union merge resurrected, so no count can be inflated', () => {
    // This is the property that lets retention (a rewrite) coexist with the
    // `merge=union` driver: a union keeps both sides' lines, so a compaction on
    // one side and an append on the other can leave the same row twice.
    const dup = row({ runId: 'r1', at: daysAgo(1) });
    writeFileSync(file, [JSON.stringify(dup), JSON.stringify(dup), JSON.stringify(dup)].join('\n') + '\n');
    const res = readHistory(file);
    expect(res.rows).toHaveLength(1);
    expect(res.duplicates).toBe(2);
  });

  it('keeps two genuinely different runs that share a timestamp', () => {
    // Identity is `runId|at`, not `at` alone: the frontaliere and svizzera
    // pipelines can finalize in the same millisecond and both rows are real.
    writeFileSync(file, [
      JSON.stringify(row({ runId: 'r1', at: daysAgo(1), section: 'frontaliere' })),
      JSON.stringify(row({ runId: 'r2', at: daysAgo(1), section: 'svizzera' })),
    ].join('\n') + '\n');
    expect(readHistory(file).rows).toHaveLength(2);
  });
});

describe('appendHistoryRow — bounded by construction', () => {
  it('appends without rewriting when the file is already canonical', () => {
    writeFileSync(file, JSON.stringify(row({ runId: 'old', at: daysAgo(1) })) + '\n');
    const res = appendHistoryRow(row({ runId: 'new' }), file, { now: NOW });
    expect(res).toMatchObject({ appended: true, compacted: 0, duplicates: 0, malformed: 0, total: 2 });
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('creates the ledger on the first run instead of requiring a seed file', () => {
    expect(existsSync(file)).toBe(false);
    appendHistoryRow(row({ runId: 'first' }), file, { now: NOW });
    expect(readHistory(file).rows).toHaveLength(1);
  });

  it('drops rows past the retention window on the next append', () => {
    const stale = HISTORY_RETENTION.maxAgeDays + 5;
    writeFileSync(file, [
      JSON.stringify(row({ runId: 'ancient', at: daysAgo(stale) })),
      JSON.stringify(row({ runId: 'recent', at: daysAgo(2) })),
    ].join('\n') + '\n');
    const res = appendHistoryRow(row({ runId: 'now' }), file, { now: NOW });
    expect(res.compacted).toBe(1);
    expect(readHistory(file).rows.map((r: any) => r.runId)).toEqual(['recent', 'now']);
  });

  it('keeps a row that is inside the window by a day', () => {
    // The negative of the test above: retention must not shave the edge of the
    // window it advertises, or the 30-day comparison silently loses its tail.
    writeFileSync(file, JSON.stringify(row({ runId: 'edge', at: daysAgo(HISTORY_RETENTION.maxAgeDays - 1) })) + '\n');
    const res = appendHistoryRow(row({ runId: 'now' }), file, { now: NOW });
    expect(res.compacted).toBe(0);
    expect(readHistory(file).rows).toHaveLength(2);
  });

  it('enforces the row ceiling even when every row is inside the window', () => {
    // The TTL is the normal bound; the ceiling is the backstop for a cadence
    // change quietly turning 180 days into no bound at all.
    const retention = { ...HISTORY_RETENTION, maxRows: 5 };
    writeFileSync(file, runs(8, 1).map((r) => JSON.stringify(r)).join('\n') + '\n');
    const res = appendHistoryRow(row({ runId: 'now' }), file, { now: NOW, retention });
    expect(res.total).toBe(5);
    // The newest survive — a ledger that dropped the newest rows would answer
    // "what is happening now" with last month's data.
    expect(readHistory(file).rows.at(-1)!.runId).toBe('now');
  });

  it('never drops the row it was just handed, even at the ceiling', () => {
    const retention = { ...HISTORY_RETENTION, maxRows: 3 };
    writeFileSync(file, runs(10, 1).map((r) => JSON.stringify(r)).join('\n') + '\n');
    appendHistoryRow(row({ runId: 'must-survive' }), file, { now: NOW, retention });
    expect(readHistory(file).rows.map((r: any) => r.runId)).toContain('must-survive');
  });

  it('heals a file polluted by union-merge duplicates and stale rows in ONE append', () => {
    // The convergence property that makes retention safe under `merge=union`.
    // A union merge can put back rows a compaction dropped; the next append
    // must return the file to canonical form without anyone intervening.
    const dup = row({ runId: 'dup', at: daysAgo(3) });
    const stale = row({ runId: 'zombie', at: daysAgo(HISTORY_RETENTION.maxAgeDays + 30) });
    writeFileSync(file, [
      JSON.stringify(stale), JSON.stringify(dup), JSON.stringify(stale), JSON.stringify(dup),
      '{"broken":',
    ].join('\n') + '\n');

    const res = appendHistoryRow(row({ runId: 'now' }), file, { now: NOW });
    expect(res.duplicates).toBe(2);
    expect(res.malformed).toBe(1);
    expect(res.compacted).toBe(1);

    const after = readHistory(file);
    expect(after.rows.map((r: any) => r.runId)).toEqual(['dup', 'now']);
    // Canonical now: a second append takes the fast path.
    expect(appendHistoryRow(row({ runId: 'next', at: daysAgo(0) }), file, { now: NOW }).compacted).toBe(0);
    expect(readHistory(file)).toMatchObject({ duplicates: 0, malformed: 0 });
  });

  it('creates missing parent directories rather than dropping the run silently', () => {
    // The ledger path is configurable and the first run on a fresh checkout has
    // no data/ tree in the .tmp-style layouts the tooling uses.
    const nested = join(dir, 'sub', 'dir', 'x.jsonl');
    expect(() => appendHistoryRow(row(), nested, { now: NOW })).not.toThrow();
    expect(readHistory(nested).rows).toHaveLength(1);
  });

  it('throws rather than appending blind when the ledger cannot be read', () => {
    // Never fail open in silence: the caller turns this into a red CI step and
    // a "questo run non lascia traccia" line. Appending to a file we could not
    // read would mean appending past an unknown amount of unretained history.
    appendHistoryRow(row(), file, { now: NOW });
    expect(() => appendHistoryRow(row({ runId: 'x' }), dir, { now: NOW })).toThrow();
  });
});

describe('applyRetention', () => {
  it('is a no-op on a ledger already inside its bounds', () => {
    const rows = runs(5, 2);
    expect(applyRetention(rows, { now: NOW })).toHaveLength(5);
  });

  it('is idempotent — compacting twice equals compacting once', () => {
    const rows = [...runs(3, HISTORY_RETENTION.maxAgeDays + 10), ...runs(4, 1)];
    const once = applyRetention(rows, { now: NOW });
    expect(applyRetention(once, { now: NOW })).toEqual(once);
  });
});

describe('summarizeHistory — the §6 metrics', () => {
  const enough = MIN_RUNS_FOR_TREND + 5;

  it('reports a rising deterministic gate against the previous window', () => {
    const rows = [
      ...runs(enough, 10, { gateRejections: { 'fabricated-institution': 1 } }),
      ...runs(enough, 3, { gateRejections: { 'fabricated-institution': 3 } }),
    ];
    const s = summarizeHistory(rows, { now: NOW, windowDays: 7 });
    const series = s.series.find((x: any) => x.code === 'fabricated-institution');
    expect(series.kind).toBe(SERIES_KIND.GATE);
    expect(series.current).toBe(enough * 3);
    expect(series.previous).toBe(enough * 1);
    expect(series.direction).toBe('up');
  });

  it('compares per-run rates, so a short window is not mistaken for a fall', () => {
    // An outage halves the runs in a window. Raw counts would read as "the
    // defect halved"; the per-run rate says it did not move.
    const rows = [
      ...runs(enough * 2, 10, { gateRejections: { 'tax-exceeds-income': 1 } }),
      ...runs(enough, 3, { gateRejections: { 'tax-exceeds-income': 1 } }),
    ];
    const s = summarizeHistory(rows, { now: NOW, windowDays: 7 });
    const series = s.series.find((x: any) => x.code === 'tax-exceeds-income');
    expect(series.current).toBeLessThan(series.previous);          // raw count fell
    expect(series.currentPerRun).toBeCloseTo(series.previousPerRun); // nothing actually moved
  });

  it('refuses to call a direction on a sample too thin to support one', () => {
    // The fastest way to make a measurement untrustworthy is to print a
    // confident "+200%" computed over three runs.
    const rows = [
      ...runs(2, 10, { gateRejections: { x: 1 } }),
      ...runs(3, 3, { gateRejections: { x: 9 } }),
    ];
    const s = summarizeHistory(rows, { now: NOW, windowDays: 7 });
    expect(s.sampleAdequate).toBe(false);
    expect(s.series.every((x: any) => x.direction === 'unknown')).toBe(true);
    expect(s.warnings.join(' ')).toMatch(/Campione insufficiente/);
    // The counts themselves are still real and still reported.
    expect(s.series.find((x: any) => x.code === 'x').current).toBe(27);
  });

  it('reports a direction once both windows clear the floor', () => {
    const rows = [...runs(MIN_RUNS_FOR_TREND, 10, { gateRejections: { x: 1 } }),
      ...runs(MIN_RUNS_FOR_TREND, 3, { gateRejections: { x: 2 } })];
    const s = summarizeHistory(rows, { now: NOW, windowDays: 7 });
    expect(s.sampleAdequate).toBe(true);
    expect(s.series.find((x: any) => x.code === 'x').direction).toBe('up');
  });

  it('tracks cost as attempts per published article, and refuses to divide by zero', () => {
    const shipped = summarizeHistory(runs(enough, 3, { attempts: 4, status: 'generated' }), { now: NOW });
    expect(shipped.current.attemptsPerPublished).toBeCloseTo(4);

    const nothing = summarizeHistory(runs(enough, 3, { attempts: 4, status: 'deferred' }), { now: NOW });
    // null, not Infinity: "nothing shipped" is a fact, not a very large cost.
    expect(nothing.current.attemptsPerPublished).toBeNull();
    expect(nothing.current.publishRate).toBe(0);
  });
});

describe('summarizeHistory — the verifier quarantine', () => {
  it('marks deterministic series admissible and the verifier series NOT', () => {
    // The quarantine is worthless if it lives only in a field name nobody sees.
    const rows = runs(MIN_RUNS_FOR_TREND + 2, 3, {
      gateRejections: { 'tax-exceeds-income': 1 },
      duplicateRejections: { 'semantic-near-duplicate': 1 },
      verifierOpinion: { unsupported_claim: 1 },
    });
    const s = summarizeHistory(rows, { now: NOW });
    const byCode = Object.fromEntries(s.series.map((x: any) => [x.code, x]));
    expect(byCode['tax-exceeds-income'].admissible).toBe(true);
    expect(byCode['semantic-near-duplicate'].admissible).toBe(true);
    expect(byCode.unsupported_claim.admissible).toBe(false);
    expect(byCode.unsupported_claim.kind).toBe(SERIES_KIND.VERIFIER);
  });

  it('prints the two kinds under separate headings that state the difference', () => {
    const rows = runs(MIN_RUNS_FOR_TREND + 2, 3, {
      gateRejections: { 'tax-exceeds-income': 1 },
      verifierOpinion: { unsupported_claim: 1 },
    });
    const text = formatHistorySummary(summarizeHistory(rows, { now: NOW }));
    expect(text).toMatch(/deterministici.*ammissibile/i);
    expect(text).toMatch(/SOLO diagnostici/);
    expect(text).toMatch(/mai ammissibili come prova/);
  });

  it('never lets a verifier code be counted as a gate code', () => {
    const rows = runs(MIN_RUNS_FOR_TREND + 2, 3, { verifierOpinion: { 'fabricated-institution': 5 } });
    const s = summarizeHistory(rows, { now: NOW });
    // Same string, but it arrived from the model — so it stays inadmissible.
    expect(s.series.find((x: any) => x.code === 'fabricated-institution').admissible).toBe(false);
  });

  it('ignores the truncation marker instead of charting it as an error class', () => {
    const rows = runs(MIN_RUNS_FOR_TREND + 2, 3, { gateRejections: { real: 1, __truncated: 4 } });
    const s = summarizeHistory(rows, { now: NOW });
    expect(s.series.map((x: any) => x.code)).not.toContain('__truncated');
  });
});

describe('summarizeHistory — the 2026-07-28 detector', () => {
  /** The incident shape: verifier louder, retries costlier, less shipped. */
  const captured = () => summarizeHistory([
    ...runs(MIN_RUNS_FOR_TREND + 5, 10, { verifierOpinion: { unsupported_claim: 1 }, attempts: 2, status: 'generated' }),
    ...runs(MIN_RUNS_FOR_TREND + 5, 3, { verifierOpinion: { unsupported_claim: 6 }, attempts: 6, status: 'deferred' }),
  ], { now: NOW, windowDays: 7 });

  it('names the verifier-capture signature when all three signals move together', () => {
    expect(captured().warnings.join(' ')).toMatch(/cattura del verificatore/i);
  });

  it('does NOT fire when the verifier gets louder but articles still ship', () => {
    // The single most important negative here. Rejections rising while the
    // publish rate holds is a verifier doing its job on a worse writer — the
    // opposite diagnosis. A detector that cannot tell them apart would send
    // every reader to loosen the gates for the wrong reason.
    const s = summarizeHistory([
      ...runs(MIN_RUNS_FOR_TREND + 5, 10, { verifierOpinion: { unsupported_claim: 1 }, attempts: 2, status: 'generated' }),
      ...runs(MIN_RUNS_FOR_TREND + 5, 3, { verifierOpinion: { unsupported_claim: 6 }, attempts: 6, status: 'generated' }),
    ], { now: NOW, windowDays: 7 });
    expect(s.warnings.join(' ')).not.toMatch(/cattura del verificatore/i);
  });

  it('does NOT fire when publication falls without the verifier getting louder', () => {
    // Source outage, quota exhaustion, an over-tight deterministic gate — all
    // real, none of them verifier capture.
    const s = summarizeHistory([
      ...runs(MIN_RUNS_FOR_TREND + 5, 10, { verifierOpinion: { unsupported_claim: 2 }, attempts: 2, status: 'generated' }),
      ...runs(MIN_RUNS_FOR_TREND + 5, 3, { verifierOpinion: { unsupported_claim: 2 }, attempts: 6, status: 'deferred' }),
    ], { now: NOW, windowDays: 7 });
    expect(s.warnings.join(' ')).not.toMatch(/cattura del verificatore/i);
  });

  it('does NOT fire on a sample too thin to support any of the three claims', () => {
    const s = summarizeHistory([
      ...runs(2, 10, { verifierOpinion: { unsupported_claim: 1 }, attempts: 2, status: 'generated' }),
      ...runs(2, 3, { verifierOpinion: { unsupported_claim: 9 }, attempts: 9, status: 'deferred' }),
    ], { now: NOW, windowDays: 7 });
    expect(s.warnings.join(' ')).not.toMatch(/cattura del verificatore/i);
  });

  it('is advisory only — the warning changes no state anywhere', () => {
    // Pinning the intent: `summarizeHistory` is pure, so the detector cannot
    // become an actuator without someone deliberately wiring one.
    const rows = [
      ...runs(MIN_RUNS_FOR_TREND + 5, 10, { verifierOpinion: { unsupported_claim: 1 }, attempts: 2, status: 'generated' }),
      ...runs(MIN_RUNS_FOR_TREND + 5, 3, { verifierOpinion: { unsupported_claim: 6 }, attempts: 6, status: 'deferred' }),
    ];
    const snapshot = JSON.stringify(rows);
    captured();
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe('the ledger cannot act — structural separation from the defences', () => {
  // §5.9. The 2026-07-28 loop degenerated because a measurement was wired back
  // into the thing it measured. The ledger is safe to accumulate automatically
  // for exactly one reason: there is no code path from a row to a defence.
  // Convention would not survive the next refactor; an assertion might.
  const importsOf = (path: string) =>
    [...readFileSync(path, 'utf-8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

  it('does not import the defect memory — a row can never promote an entity', () => {
    expect(importsOf('scripts/lib/article-defect-history.mjs')
      .some((s) => s.includes('article-defect-memory'))).toBe(false);
  });

  it('is not imported BY the defect memory — the policy cannot read the ledger', () => {
    // The other direction matters just as much: a promotion policy that could
    // read rejection counts would be one commit away from "block whatever is
    // rejected most", which is frequency-as-evidence — the thing §4.1 exists
    // to forbid. USTRA, EOC and DECS are real AND frequent.
    expect(importsOf('scripts/lib/article-defect-memory.mjs')
      .some((s) => s.includes('article-defect-history'))).toBe(false);
  });

  it('is not read by the gates that decide whether an article ships', () => {
    expect(importsOf('scripts/lib/article-factuality-gates.mjs')
      .some((s) => s.includes('article-defect-history'))).toBe(false);
  });
});
