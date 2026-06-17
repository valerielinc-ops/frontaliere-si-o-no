import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * filterExistingAlternates reads EMIT_ALL_LOCALES / shouldEmitLocale from
 * localeEmitFilter, which parses BUILD_LOCALE once at module load — so each
 * scenario sets the env var and re-imports via vi.resetModules().
 */
async function loadGuard(buildLocale: string | undefined) {
  vi.resetModules();
  const prev = process.env.BUILD_LOCALE;
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  try {
    return await import('../build-plugins/shared/hreflangGuard');
  } finally {
    if (prev === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = prev;
  }
}

const BASE = 'https://frontaliereticino.ch';
let dist: string;

const ALTS = [
  { locale: 'it', url: `${BASE}/cerca-lavoro-ticino/` },
  { locale: 'en', url: `${BASE}/en/find-jobs-ticino/` },
  { locale: 'de', url: `${BASE}/de/jobs-im-tessin/` },
  { locale: 'fr', url: `${BASE}/fr/trouver-emploi-tessin/` },
  { locale: 'x-default', url: `${BASE}/cerca-lavoro-ticino/` },
];

beforeEach(() => {
  // dist with ONLY the en page on disk (simulates an en-shard build output).
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-shard-'));
  fs.mkdirSync(path.join(dist, 'en', 'find-jobs-ticino'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'en', 'find-jobs-ticino', 'index.html'), '<html></html>');
});
afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
  vi.resetModules();
});

describe('hreflangGuard — default build (no BUILD_LOCALE) is unchanged', () => {
  it('drops alternates whose target file is absent on disk', async () => {
    const g = await loadGuard(undefined);
    const kept = g.filterExistingAlternates(ALTS, dist, BASE).map((a) => a.locale);
    // only en exists on disk → it/de/fr/x-default targets (it page) are dropped
    expect(kept).toEqual(['en']);
  });
});

describe('hreflangGuard — en shard keeps cross-shard alternates', () => {
  it('keeps it/de/fr/x-default (other shards) and the existing en self-ref', async () => {
    const g = await loadGuard('en');
    const kept = g.filterExistingAlternates(ALTS, dist, BASE).map((a) => a.locale);
    // en is real-checked (exists → kept); it/de/fr not emitted by this shard →
    // kept unconditionally (live on another shard); x-default kept too.
    expect(kept.sort()).toEqual(['de', 'en', 'fr', 'it', 'x-default']);
  });

  it('still drops a MISSING page of the emitted locale itself (real broken link)', async () => {
    const g = await loadGuard('en');
    const alts = [
      { locale: 'en', url: `${BASE}/en/does-not-exist/` }, // emitted locale, absent → drop
      { locale: 'de', url: `${BASE}/de/jobs-im-tessin/` }, // other shard → keep
    ];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['de']);
  });
});

// ── #2462 item 1: x-default must be existence-checked on the shard that owns
// its target (the IT root), not kept unconditionally everywhere. ──────────
describe('hreflangGuard — x-default is checked against the it-owning shard (#2462)', () => {
  it('it shard with MISSING it root drops a broken x-default (and the it self-ref)', async () => {
    // dist (from beforeEach) has ONLY the en page → no it root index.html.
    const g = await loadGuard('it');
    const alts = [
      { locale: 'it', url: `${BASE}/cerca-lavoro-ticino/` }, // owned by it shard, absent → drop
      { locale: 'en', url: `${BASE}/en/find-jobs-ticino/` }, // other shard → keep
      { locale: 'x-default', url: `${BASE}/cerca-lavoro-ticino/` }, // target = it, absent → drop
    ];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    // x-default → it ownership: its target is absent on the it shard → dropped.
    expect(kept).toEqual(['en']);
  });

  it('it shard with PRESENT it target keeps it + x-default', async () => {
    fs.mkdirSync(path.join(dist, 'cerca-lavoro-ticino'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'cerca-lavoro-ticino', 'index.html'), '<html></html>');
    const g = await loadGuard('it');
    const kept = g.filterExistingAlternates(ALTS, dist, BASE).map((a) => a.locale);
    // it target present → it + x-default kept (real-checked); en present (other
    // shard, the en page is on disk too) → kept; de/fr other shards → kept.
    expect(kept.sort()).toEqual(['de', 'en', 'fr', 'it', 'x-default']);
  });

  it('en shard keeps x-default unconditionally (target it lives on another shard)', async () => {
    const g = await loadGuard('en');
    const alts = [{ locale: 'x-default', url: `${BASE}/cerca-lavoro-ticino/` }];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['x-default']);
  });
});

// ── #2462 item 3: region-tagged values (de-CH, en-US) normalise to their base
// locale so a value the shard OWNS is still subject to the real check. ─────
describe('hreflangGuard — region-tagged locales normalise to base (#2462)', () => {
  it('en shard real-checks en-US (owned → present kept, absent dropped)', async () => {
    const g = await loadGuard('en');
    const alts = [
      { locale: 'en-US', url: `${BASE}/en/find-jobs-ticino/` }, // present → keep
      { locale: 'EN-us', url: `${BASE}/en/does-not-exist/` }, // absent → drop (case-insensitive)
      { locale: 'de-CH', url: `${BASE}/de/jobs-im-tessin/` }, // other shard → keep unconditionally
    ];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept.sort()).toEqual(['de-CH', 'en-US']);
  });
});
