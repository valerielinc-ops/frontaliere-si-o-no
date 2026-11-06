import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { cdnDataHydrationUrlExpr } from '../build-plugins/shared/cdnDataHydrationUrl';

/**
 * Guards the ONE invariant that keeps generated `/data/**` reachable in
 * production: after `scripts/offload-generated-images-cdn.mjs` runs, the apex
 * serves NO `/data/**` — every file is pushed to the CDN and deleted from
 * `dist/`. Verified live 2026-08-08: all 13 tracked `public/data/*` files plus
 * `weather-snapshot.json` and `jobs-salary-aggregate.csv` return 404 on
 * `frontaliereticino.ch` and 200 on `cdn.frontaliereticino.ch`.
 *
 * So a same-origin `/data/x.json` that survives into shipped code is a
 * guaranteed 404 — and every call site swallows it (`.catch(() => {})`,
 * `if (!res.ok) return null`), so it fails silently and forever.
 *
 * Two mechanisms keep it reachable, and this file pins both:
 *   1. runtime — client code fetches through `cdnDataUrl()`
 *      (services/cdnDataBase.ts);
 *   2. static HTML — build plugins emit through `cdnDataHydrationUrlExpr()`
 *      (build-plugins/shared/cdnDataHydrationUrl.ts).
 *
 * The offload's own HTML rewrite is NOT a third mechanism: its authority
 * (`distDataRel`) is per-shard while the served site is the union of shards, so
 * it silently no-ops on any shard that does not itself carry the file. That is
 * exactly how `/fr/meteo-frontaliers/` shipped `fetch('/data/weather-snapshot.json')`
 * while `/meteo-frontalieri/` shipped the rewritten CDN URL.
 */

const ROOT = resolve(__dirname, '..');

// Directories whose output reaches a browser: client bundles + emitted static HTML.
// Every entry must EXIST — `walk()` returns [] for an absent path, so a renamed
// or moved directory would silently gut this gate instead of failing. Asserted
// below rather than left to trust.
const SCAN_DIRS = ['build-plugins', 'services', 'components', 'hooks'];
const SCAN_EXT = /\.(ts|tsx)$/;

// `fetch(` followed directly by a string literal starting with /data/ — the bare
// same-origin form, with no resolver between the path and the call.
const BARE_FETCH_RX = /\bfetch\(\s*(['"`])\/data\//g;

// Comment lines are excluded so the defect can still be DOCUMENTED verbatim —
// cdnDataHydrationUrl.ts quotes the exact bad call in its docblock, and the
// first run of this test flagged it. Line-based (not a full comment parser):
// a trailing comment on a code line still counts, which fails closed.
const COMMENT_LINE_RX = /^\s*(\/\/|\/\*|\*)/;

function codeLines(src: string): { text: string; line: number }[] {
  return src
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter((l) => !COMMENT_LINE_RX.test(l.text));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = resolve(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === 'dist') continue;
      walk(full, out);
    } else if (SCAN_EXT.test(e)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(resolve(ROOT, d)));

describe('cdnDataHydrationUrlExpr', () => {
  // The emitted expression must be correct in all three deploy states. The
  // first is the one a naive `base + path` concatenation gets wrong: it would
  // double-prefix the shards where the offload rewrite DID land, breaking the
  // pages that currently work.
  const evalExpr = (path: string, base: string | undefined): string => {
    const expr = cdnDataHydrationUrlExpr(path);
    return new Function('window', `return ${expr};`)(base === undefined ? {} : { __CDN_DATA_BASE__: base }) as string;
  };

  it('prefixes a same-origin path with the injected base', () => {
    expect(evalExpr('/data/weather-snapshot.json', 'https://cdn.frontaliereticino.ch')).toBe(
      'https://cdn.frontaliereticino.ch/data/weather-snapshot.json',
    );
  });

  it('leaves an already-rewritten absolute CDN URL untouched (no double prefix)', () => {
    // This is what the offload rewrite produces on shards that carry the file.
    expect(
      evalExpr('https://cdn.frontaliereticino.ch/data/weather-snapshot.json', 'https://cdn.frontaliereticino.ch'),
    ).toBe('https://cdn.frontaliereticino.ch/data/weather-snapshot.json');
  });

  it('falls back to same-origin when no base is injected (dev / skipped offload)', () => {
    expect(evalExpr('/data/weather-snapshot.json', undefined)).toBe('/data/weather-snapshot.json');
  });

  it('keeps the path as a bare literal so the offload rewrite can still upgrade it', () => {
    // Belt-and-braces: the static rewrite remains a valid optimisation on the
    // shards that do carry the file. If the literal were split or encoded, the
    // rewrite would stop matching and those shards would lose the CDN URL.
    expect(cdnDataHydrationUrlExpr('/data/weather-snapshot.json')).toContain('"/data/weather-snapshot.json"');
  });
});

describe('no same-origin /data/** fetch reaches a browser', () => {
  it('every scanned directory exists (a rename must not silently empty the gate)', () => {
    const missing = SCAN_DIRS.filter((d) => {
      try {
        return !statSync(resolve(ROOT, d)).isDirectory();
      } catch {
        return true;
      }
    });
    expect(missing, `SCAN_DIRS entries not found: ${missing.join(', ')}`).toEqual([]);
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('no bare fetch("/data/…") in client code or emitted static HTML', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const { text, line } of codeLines(readFileSync(f, 'utf-8'))) {
        BARE_FETCH_RX.lastIndex = 0;
        if (BARE_FETCH_RX.test(text)) offenders.push(`${relative(ROOT, f)}:${line}`);
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Same-origin /data/** fetch — the apex serves no /data/** after the offload, so this 404s ` +
          `silently in production. Wrap it: client code → cdnDataUrl(path) from services/cdnDataBase.ts; ` +
          `emitted static HTML → cdnDataHydrationUrlExpr(path) from build-plugins/shared/cdnDataHydrationUrl.ts. ` +
          `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every /data/** path in client code is passed through cdnDataUrl()', () => {
    // Complements the check above: catches the two-step form
    //   const u = `/data/x.json`;  fetch(u)
    // by requiring that any file naming a /data/** path AND calling fetch()
    // also imports the resolver. Heuristic on purpose — a candidate is not a
    // verdict; read the file before acting on a failure.
    const offenders: string[] = [];
    for (const f of FILES) {
      const rel = relative(ROOT, f);
      if (rel.startsWith('build-plugins')) continue; // covered by the emit-side check + resolver
      const code = codeLines(readFileSync(f, 'utf-8'))
        .map((l) => l.text)
        .join('\n');
      if (!/['"`]\/data\//.test(code)) continue;
      if (!/\bfetch\(/.test(code)) continue;
      if (/\bcdnDataUrl\b/.test(code)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `File names a /data/** path and calls fetch() but never imports cdnDataUrl(). ` +
          `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
