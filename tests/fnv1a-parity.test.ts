import { describe, expect, it } from 'vitest';

import { fnv1a32, fnv1a32Mod } from '../scripts/lib/fnv1a.mjs';
import { compatShardIndex, COMPAT_SHARD_COUNT } from '../scripts/lib/compat-paths-store.mjs';

// Guards the FNV-1a-32 dedup (AGENTS.md #6): scripts/lib/compat-paths-store.mjs,
// scripts/lib/send-schedule.mjs and scripts/lib/topic-sources/gscOrphans.mjs
// used to each hand-roll the same 32-bit FNV-1a core; they now all delegate to
// scripts/lib/fnv1a.mjs. This test protects two things:
//  (a) the algorithm itself (hardcoded expected hashes — breaks if anyone
//      changes the mixing step);
//  (b) CRITICAL for the SEO-facing 404-compat shard store: the new
//      `compatShardIndex` must still assign every path to the exact same
//      shard as the old hand-rolled formula did, or a routine data-refresh
//      would redistribute ~1M+ committed paths (huge diff, 404 risk).

// The exact formula every one of the three files used to hand-roll, kept
// here ONLY as an independent oracle for the parity checks below — never
// imported from production code.
function oldFnv1a32(input: string): number {
  const s = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

describe('fnv1a32 (shared util)', () => {
  // Expected values computed offline with the inline algorithm above and
  // hardcoded here, so this test breaks the moment the util's algorithm
  // changes — independent of whatever the util itself currently computes.
  const EXPECTED: Array<[string, number]> = [
    ['hello', 1335831723],
    ['world', 933488787],
    ['', 2166136261],
    ['a', 3826002220],
    ['frontaliereticino.ch', 923473831],
    ['/lavoro/ricerca-stipendio-ticino/', 1973606985],
    ['test@example.com', 2982314312],
    ['🙂 unicode', 2449005973],
    ['The quick brown fox jumps over the lazy dog', 76545936],
    ['0', 890022063],
  ];

  it.each(EXPECTED)('fnv1a32(%j) === %i', (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const [input] of EXPECTED) {
      const h = fnv1a32(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('coerces non-string input the same way String() does', () => {
    expect(fnv1a32(0 as unknown as string)).toBe(fnv1a32('0'));
    expect(fnv1a32(123 as unknown as string)).toBe(fnv1a32('123'));
  });
});

describe('fnv1a32Mod', () => {
  it('is fnv1a32(str) % count', () => {
    const samples = ['a@b.ch', 'stable@example.com', 'anyone@example.com', '', 'user42@example.com'];
    for (const s of samples) {
      expect(fnv1a32Mod(s, 60)).toBe(fnv1a32(s) % 60);
    }
  });
});

// ── CRITICAL: shard-assignment parity (SEO 404-compat store) ───────────────
// A representative sample of ~50 real-shaped compat paths (job/blog/canton
// slugs, with unicode, trailing slashes, query-less routes — the actual
// shapes `data/seo-404-compat/*.json` holds). If `compatShardIndex` ever
// diverges from the pre-dedup formula, every one of these would flip to a
// different shard on the next `writeCompatPaths` run.
function buildSamplePaths(): string[] {
  const bases = [
    '/lavoro/ricerca-stipendio-ticino/',
    '/lavoro/ricerca-stipendio-vallese/',
    '/lavoro/ricerca-stipendio-grigioni/',
    '/blog/frontalieri-permesso-g/',
    '/blog/tasse-frontalieri-italia-svizzera/',
    '/salario/infermiere-ticino/',
    '/salario/muratore-vallese/',
    '/aziende/manor-lugano/',
    '/aziende/migros-basilea/',
    '/offerte-lavoro/informatico-zurigo/',
    '/offerte-lavoro/autista-ginevra/',
    '/cantoni/ticino/comuni/lugano/',
    '/cantoni/vallese/comuni/sion/',
    '/faq/permesso-frontaliere/',
    '/calcolatore-stipendio-netto/',
    '/città/zürich/',
    '/città/genève/',
    '/lavoro/badante-a-domicilio/',
    '/assicurazioni/malattia-frontalieri/',
    '/guide/dichiarazione-dei-redditi/',
  ];
  const paths: string[] = [];
  for (const b of bases) {
    paths.push(b);
    paths.push(`${b}pagina-2/`);
    paths.push(`${b}?utm_source=old`);
  }
  // Pad/trim to exactly 50 distinct samples.
  while (paths.length < 50) paths.push(`/legacy/orphan-${paths.length}/`);
  return paths.slice(0, 50);
}

describe('compatShardIndex parity (zero shard redistribution)', () => {
  const samplePaths = buildSamplePaths();

  it('produced exactly 50 distinct sample paths (sanity check on the fixture itself)', () => {
    expect(samplePaths).toHaveLength(50);
    expect(new Set(samplePaths).size).toBe(50);
  });

  it.each(samplePaths)('compatShardIndex(%j, 16) matches the pre-dedup inline formula', (p) => {
    const expected = oldFnv1a32(String(p)) % 16;
    expect(compatShardIndex(p, 16)).toBe(expected);
  });

  it('also matches at the live COMPAT_SHARD_COUNT', () => {
    for (const p of samplePaths) {
      const expected = oldFnv1a32(String(p)) % COMPAT_SHARD_COUNT;
      expect(compatShardIndex(p)).toBe(expected);
    }
  });
});
