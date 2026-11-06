import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCAN_TEST_TIMEOUT_MS } from '../helpers/distHtmlScan';

const DIST = path.resolve(__dirname, '../../dist');

// Bounded sample size — large enough to catch regressions across the early
// emitters without walking the whole tree.
const SAMPLE_LIMIT = 1500;

// Walk dist for .html files but STOP as soon as `limit` are collected. The
// previous impl walked the ENTIRE tree and only THEN sliced to 1500 — fine when
// dist was small, but after the cathedral + locale-shard expansion dist holds
// ~2M files (locale shards are rehydrated into dist for validate-dist), so
// enumerating all of them blew the 60s ceiling and the test TIMED OUT (gate:
// seo-source red, no assertion ever reached). Short-circuiting yields the SAME
// first-N depth-first sample without the full-tree enumeration — O(limit)
// readdir/reads instead of O(all files).
function walkHtml(dir: string, out: string[] = [], limit = SAMPLE_LIMIT): string[] {
  if (out.length >= limit || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out, limit);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

describe('every page with hreflang ALSO emits x-default', () => {
  // 60s ceiling kept as a safety margin; with the short-circuited walk the test
  // reads only SAMPLE_LIMIT files (~seconds) regardless of total dist size.
  it('checks dist for hreflang completeness', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    if (!fs.existsSync(DIST)) return;
    // Bounded sample — the walk already stops at SAMPLE_LIMIT (see walkHtml).
    const sample = walkHtml(DIST);
    const offenders: string[] = [];
    for (const file of sample) {
      const html = fs.readFileSync(file, 'utf-8');
      const hreflangs = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]+)"/gi)].map((m) => m[1]);
      if (hreflangs.length === 0) continue;
      const set = new Set(hreflangs);
      if (set.size > 0 && !set.has('x-default')) {
        offenders.push(path.relative(DIST, file));
      }
    }
    expect(offenders, `Pages with hreflang but no x-default (sample): ${offenders.slice(0, 5).join(', ')}`).toEqual([]);
  });
});
