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

describe('hreflangGuard — x-default is existence-checked on the owning (it) shard', () => {
  it('drops x-default when the IT root target is MISSING on the it shard', async () => {
    // The it shard OWNS the x-default target (IT root). If that page failed to
    // emit, x-default is a real broken link and must be dropped — not kept by
    // the cross-shard short-circuit (item 1 of #2462).
    const g = await loadGuard('it');
    const alts = [
      { locale: 'x-default', url: `${BASE}/cerca-lavoro-ticino/` }, // IT-owned, absent → drop
      { locale: 'en', url: `${BASE}/en/find-jobs-ticino/` }, // other shard → keep
    ];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['en']);
  });

  it('keeps x-default when the IT root target exists on the it shard', async () => {
    fs.mkdirSync(path.join(dist, 'cerca-lavoro-ticino'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'cerca-lavoro-ticino', 'index.html'), '<html></html>');
    const g = await loadGuard('it');
    const alts = [{ locale: 'x-default', url: `${BASE}/cerca-lavoro-ticino/` }];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['x-default']);
  });
});

describe('hreflangGuard — region-tagged locale is existence-checked on the owning shard', () => {
  it('drops a region-tagged value (de-CH) whose page is MISSING on the de shard', async () => {
    // de-CH normalises to de, owned by the de shard → real existence check,
    // not the unconditional keep (item 3 of #2462).
    const g = await loadGuard('de');
    const alts = [
      { locale: 'de-CH', url: `${BASE}/de/does-not-exist/` }, // de-owned, absent → drop
      { locale: 'it', url: `${BASE}/cerca-lavoro-ticino/` }, // other shard → keep
    ];
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['it']);
  });

  it('keeps a region-tagged value owned by ANOTHER shard unconditionally', async () => {
    const g = await loadGuard('it');
    const alts = [{ locale: 'de-CH', url: `${BASE}/de/jobs-im-tessin/` }]; // de-owned, it shard → keep
    const kept = g.filterExistingAlternates(alts, dist, BASE).map((a) => a.locale);
    expect(kept).toEqual(['de-CH']);
  });
});
