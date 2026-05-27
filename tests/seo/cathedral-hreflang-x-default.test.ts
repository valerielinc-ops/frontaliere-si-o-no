import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

function walkHtml(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

describe('every page with hreflang ALSO emits x-default', () => {
  // 60s ceiling: cathedral expansion → ~200k dist files; reading 1k of
  // them I/O-bound takes 8-15s on cold cache. Tight default (15s) would
  // race on slower CI runners.
  it('checks dist for hreflang completeness', { timeout: 60_000 }, () => {
    if (!fs.existsSync(DIST)) return;
    // Bounded sample — large enough to catch regressions across all
    // emitters (job-detail, hubs, landings, bridges) without walking
    // the whole tree, which would dominate the test wall time.
    const sample = walkHtml(DIST).slice(0, 1500);
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
