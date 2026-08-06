/**
 * Regression tests for the 5xx observability pipeline (scripts/lib/cf-error-surface.mjs +
 * scripts/ci/cf-5xx-snapshot.mjs).
 *
 * The defect these guard against is not a crash — it is a SILENT misattribution. On
 * 2026-08-05 the whole `cloudflare-5xx` family was read as one R2 problem, so a CDN-only
 * `serve_stale` mitigation was credited with covering apex 503s it cannot reach (#5082).
 * Nothing failed; the wrong conclusion just looked reasonable. So the tests below assert the
 * SPLIT and the refusal-to-guess, not merely that the functions return something.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifySurface,
  isSynthesizedByEdge,
  couldServeStaleHaveHelped,
  SURFACES,
  LOCALE_SHARD_PREFIXES,
  CACHE_HAD_COPY,
} from '../scripts/lib/cf-error-surface.mjs';
import {
  summarizeDiagnostics,
  summarizeSurfaces,
  buildSnapshot,
  appendSnapshot,
  loadHistory,
  renderReport,
} from '../scripts/ci/cf-5xx-snapshot.mjs';

describe('classifySurface — the split that was missing', () => {
  it('separates the three origins that shared one label', () => {
    expect(classifySurface({ host: 'cdn.frontaliereticino.ch', path: '/assets/it-core.js' })).toBe('cdn-r2');
    expect(classifySurface({ host: 'frontaliereticino.ch', path: '/de/jobs-im-jura/x/' })).toBe('worker-shard');
    expect(classifySurface({ host: 'frontaliereticino.ch', path: '/commit-hash.txt' })).toBe('apex-pages');
  });

  it('classifies every locale shard prefix as worker-shard, not apex', () => {
    for (const prefix of LOCALE_SHARD_PREFIXES) {
      expect(classifySurface({ host: 'frontaliereticino.ch', path: `${prefix}qualsiasi/pagina/` })).toBe('worker-shard');
    }
    // Shard ROOTS too — these are exact paths, not prefixes, and were a separate clause of
    // the cache-rule expression.
    for (const exact of ['/en', '/de', '/fr', '/de.html']) {
      expect(classifySurface({ host: 'frontaliereticino.ch', path: exact })).toBe('worker-shard');
    }
  });

  it('does NOT mistake an IT path that merely contains a locale token for a shard', () => {
    // `/cerca-lavoro-…` pages are IT/apex. A `.includes('/de/')`-style check would have
    // swallowed these into worker-shard and inflated the wrong surface.
    expect(classifySurface({ host: 'frontaliereticino.ch', path: '/cerca-lavoro-svizzera/ricerca-de-jong/' })).toBe(
      'apex-pages',
    );
    expect(classifySurface({ host: 'frontaliereticino.ch', path: '/guida-frontaliere/en-route/' })).toBe('apex-pages');
  });

  it('refuses to guess the apex split when the path is unknown', () => {
    // This is the important one. The hourly query carries no path; defaulting to `apex-pages`
    // would silently file every shard 503 under the wrong origin — the exact 2026-08-05 bug.
    expect(classifySurface({ host: 'frontaliereticino.ch' })).toBe('apex-unknown');
    expect(classifySurface({ host: 'frontaliereticino.ch', path: null })).toBe('apex-unknown');
    // The CDN has no such ambiguity: one host, one origin.
    expect(classifySurface({ host: 'cdn.frontaliereticino.ch' })).toBe('cdn-r2');
  });

  it('handles www and unknown hosts without throwing', () => {
    expect(classifySurface({ host: 'www.frontaliereticino.ch', path: '/' })).toBe('www-redirect');
    expect(classifySurface({ host: 'random.example.com', path: '/' })).toBe('other');
    expect(classifySurface({})).toBe('other');
    expect(classifySurface({ host: 'CDN.FrontaliereTicino.CH', path: '/a' })).toBe('cdn-r2');
  });

  it('marks serve_stale as present ONLY on the surface that actually has the rule', () => {
    // If this ever flips silently, the "could serve_stale have helped" metric starts lying.
    expect(SURFACES['cdn-r2'].serveStale).toBe(true);
    expect(SURFACES['worker-shard'].serveStale).toBe(false);
    expect(SURFACES['apex-pages'].serveStale).toBe(false);
  });
});

describe('isSynthesizedByEdge — origin dead vs origin erroring', () => {
  it('treats originResponseStatus 0 as synthesised', () => {
    expect(isSynthesizedByEdge({ edgeStatus: 502, originStatus: 0 })).toBe(true);
    expect(isSynthesizedByEdge({ edgeStatus: 503, originStatus: null })).toBe(true);
  });

  it('does not claim a real origin error was synthesised', () => {
    // Measured on the live zone: `edge=502 origin=502 cache=bypass`. Opposite remedy.
    expect(isSynthesizedByEdge({ edgeStatus: 502, originStatus: 502 })).toBe(false);
  });

  it('ignores non-5xx rows', () => {
    expect(isSynthesizedByEdge({ edgeStatus: 404, originStatus: 0 })).toBe(false);
  });
});

describe('couldServeStaleHaveHelped', () => {
  it('is null on surfaces without serve_stale, not false', () => {
    // null = "not applicable" vs false = "applicable but no copy". Collapsing them would make
    // apex 503s look like serve_stale failures.
    expect(couldServeStaleHaveHelped({ surface: 'worker-shard', cacheStatus: 'hit' })).toBeNull();
    expect(couldServeStaleHaveHelped({ surface: 'apex-pages', cacheStatus: 'none' })).toBeNull();
  });

  it('is false when the CDN had no cached copy to fall back on', () => {
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'none' })).toBe(false);
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'bypass' })).toBe(false);
  });

  it('is true when a copy existed — including when stale was already being served', () => {
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'stale' })).toBe(true);
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'expired' })).toBe(true);
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'HIT' })).toBe(true);
  });
});

describe('summarizeDiagnostics', () => {
  const rows = [
    { hour: '2026-08-05T14:00:00Z', edgeStatus: 502, originStatus: 0, cacheStatus: 'none', host: 'cdn.frontaliereticino.ch', count: 30 },
    { hour: '2026-08-05T15:00:00Z', edgeStatus: 502, originStatus: 0, cacheStatus: 'stale', host: 'cdn.frontaliereticino.ch', count: 4 },
    { hour: '2026-08-05T15:00:00Z', edgeStatus: 503, originStatus: 0, cacheStatus: 'hit', host: 'frontaliereticino.ch', count: 6 },
    { hour: '2026-08-05T15:00:00Z', edgeStatus: 502, originStatus: 502, cacheStatus: 'bypass', host: 'cdn.frontaliereticino.ch', count: 1 },
  ];

  it('totals, and counts synthesised separately from origin-reported errors', () => {
    const s = summarizeDiagnostics(rows);
    expect(s.total).toBe(41);
    expect(s.synthesized).toBe(40); // the origin=502 row is excluded
  });

  it('counts as stale-rescuable only the CDN rows that had a copy', () => {
    const s = summarizeDiagnostics(rows);
    // 4 (cdn + stale). The apex `hit` row does NOT count: that surface has no serve_stale,
    // and counting it would overstate the mitigation's reach — the 2026-08-05 error again.
    expect(s.staleRescuable).toBe(4);
  });

  it('buckets by hour so deploy-window clustering is visible', () => {
    const s = summarizeDiagnostics(rows);
    expect(s.byHour['2026-08-05T14:00:00Z']).toBe(30);
    expect(s.byHour['2026-08-05T15:00:00Z']).toBe(11);
  });

  it('survives empty and malformed input', () => {
    expect(summarizeDiagnostics([]).total).toBe(0);
    expect(summarizeDiagnostics(undefined as never).total).toBe(0);
    expect(summarizeDiagnostics([{ count: 0 } as never]).total).toBe(0);
  });
});

describe('summarizeSurfaces', () => {
  it('splits the apex by path and ranks the worst URLs', () => {
    const { bySurface, topPaths } = summarizeSurfaces([
      { status: 502, host: 'cdn.frontaliereticino.ch', path: '/assets/a.js', count: 10 },
      { status: 503, host: 'frontaliereticino.ch', path: '/de/x/', count: 7 },
      { status: 502, host: 'frontaliereticino.ch', path: '/favicon.svg', count: 3 },
    ]);
    expect(bySurface['cdn-r2'].total).toBe(10);
    expect(bySurface['worker-shard'].total).toBe(7);
    expect(bySurface['apex-pages'].total).toBe(3);
    expect(topPaths[0].url).toBe('cdn.frontaliereticino.ch/assets/a.js');
    expect(topPaths).toHaveLength(3);
  });
});

describe('history file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cf5xx-'));
    file = path.join(dir, 'nested', 'cf-5xx-history.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the directory, appends one line per snapshot, and round-trips', () => {
    const mk = (n: number) =>
      buildSnapshot({
        diagnostics: [
          { hour: '2026-08-05T14:00:00Z', edgeStatus: 502, originStatus: 0, cacheStatus: 'none', host: 'cdn.frontaliereticino.ch', count: n },
        ],
        paths: [{ status: 502, host: 'cdn.frontaliereticino.ch', path: '/assets/a.js', count: n }],
        windowHours: 23,
        until: new Date('2026-08-05T18:00:00Z'),
        zoneName: 'frontaliereticino.ch',
      });

    appendSnapshot(file, mk(5));
    appendSnapshot(file, mk(9));

    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    const history = loadHistory(file);
    expect(history).toHaveLength(2);
    expect(history[1].total5xx).toBe(9);
    expect(history[1].bySurface['cdn-r2'].total).toBe(9);
  });

  it('skips a truncated line instead of making the whole history unreadable', () => {
    // An append-only file that grows forever will eventually meet a runner killed mid-write.
    // One bad line must not blind every future report.
    writeFileSync(file.replace('/nested', ''), '');
    const flat = path.join(dir, 'h.jsonl');
    writeFileSync(flat, '{"ts":"a","total5xx":1}\n{"ts":"b",tronc\n{"ts":"c","total5xx":3}\n');
    const history = loadHistory(flat);
    expect(history.map((h) => h.ts)).toEqual(['a', 'c']);
  });

  it('reports an empty history without throwing', () => {
    expect(loadHistory(path.join(dir, 'assente.jsonl'))).toEqual([]);
    expect(renderReport([])).toContain('Nessuno snapshot');
  });

  it('renders a trend line per snapshot', () => {
    const history = loadHistory(file);
    expect(history).toEqual([]);
    const rendered = renderReport([
      { ts: '2026-08-05T18:00:00Z', total5xx: 41, synthesized5xx: 40, staleRescuable5xx: 4, bySurface: { 'cdn-r2': { total: 35 }, 'worker-shard': { total: 6 } }, byHour: { '2026-08-05T14:00:00Z': 41 } },
    ] as never);
    expect(rendered).toContain('cdn-r2=35');
    expect(rendered).toContain('worker-shard=6');
  });
});

describe('byHostStatusCache — the cross-tab that decides the next move', () => {
  const rows = [
    { hour: 'h', edgeStatus: 502, originStatus: 0, cacheStatus: 'none', host: 'cdn.frontaliereticino.ch', count: 235 },
    { hour: 'h', edgeStatus: 503, originStatus: 0, cacheStatus: 'hit', host: 'frontaliereticino.ch', count: 175 },
    { hour: 'h', edgeStatus: 503, originStatus: 0, cacheStatus: 'none', host: 'frontaliereticino.ch', count: 22 },
  ];

  it('keeps host, status and cache outcome together instead of as three marginals', () => {
    // The marginals cannot express this: byHost says 197 on the apex, byCacheStatus says 175
    // hits somewhere, and neither says the hits were on the apex. That gap forced a live
    // GraphQL query on 2026-08-06 to answer the question the reopened #5082 turns on.
    const s = summarizeDiagnostics(rows);
    expect(s.byHostStatusCache['frontaliereticino.ch|503|hit']).toBe(175);
    expect(s.byHostStatusCache['cdn.frontaliereticino.ch|502|none']).toBe(235);
    expect(s.byHostStatusCache['frontaliereticino.ch|503|none']).toBe(22);
  });

  it('does not disturb the marginals a prior snapshot already recorded', () => {
    // The one history line written before the cross-tab existed must stay readable.
    const s = summarizeDiagnostics(rows);
    expect(s.total).toBe(432);
    expect(s.byHost['frontaliereticino.ch']).toBe(197);
    expect(s.byCacheStatus.hit).toBe(175);
  });

  it('still counts staleRescuable only on the surface that HAS serve_stale', () => {
    // 175 cached-copy 5xx exist, but on the apex — where the rule is not configured. Counting
    // them would claim the mitigation was working when it demonstrably is not.
    expect(summarizeDiagnostics(rows).staleRescuable).toBe(0);
  });

  it('flags the servable rows in the report so the asymmetry is visible without jq', () => {
    const rendered = renderReport([
      {
        ts: '2026-08-06T06:18:00Z', total5xx: 432, synthesized5xx: 432, staleRescuable5xx: 0,
        bySurface: { 'cdn-r2': { total: 235 } },
        byHostStatusCache: summarizeDiagnostics(rows).byHostStatusCache,
      },
    ] as never);
    expect(rendered).toContain('copia servibile');
    expect(rendered).toMatch(/frontaliereticino\.ch\s+503\s+hit/);
  });
});

describe('CACHE_HAD_COPY is the single definition of "servable copy" (review nit)', () => {
  it('the report flag and staleRescuable read the same set', () => {
    // The renderer used to inline the five values verbatim. Two independent definitions of the
    // same notion is the exact ambiguity this module exists to remove — a new cacheStatus value
    // learned by only one of them would make the metric and the report disagree silently.
    for (const cache of CACHE_HAD_COPY) {
      expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: cache })).toBe(true);
      const rendered = renderReport([
        { ts: '2026-08-06T06:18:00Z', total5xx: 1, synthesized5xx: 1, staleRescuable5xx: 0,
          bySurface: {}, byHostStatusCache: { [`cdn.frontaliereticino.ch|502|${cache}`]: 1 } },
      ] as never);
      // The row marker, not the table header — the header names the concept for every snapshot.
      expect(rendered, `report must flag "${cache}" as servable`).toContain('<- copia servibile');
    }
  });

  it('a non-servable outcome is flagged by neither', () => {
    expect(couldServeStaleHaveHelped({ surface: 'cdn-r2', cacheStatus: 'none' })).toBe(false);
    const rendered = renderReport([
      { ts: '2026-08-06T06:18:00Z', total5xx: 1, synthesized5xx: 1, staleRescuable5xx: 0,
        bySurface: {}, byHostStatusCache: { 'cdn.frontaliereticino.ch|502|none': 1 } },
    ] as never);
    expect(rendered).not.toContain('<- copia servibile');
  });
});
