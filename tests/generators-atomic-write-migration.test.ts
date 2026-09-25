import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// Regression guard for issue #6538 (follow-up to #6532): five named
// generators plus five siblings the sibling-pattern gate surfaced on push
// (same construct: `fs.mkdirSync(path.dirname(OUT_PATH)...)` +
// `fs.writeFileSync(OUT_PATH, ...)` writing straight to a committed JSON
// dataset) all now route through the shared `writeJsonAtomic` — a
// SIGKILL/OOM mid-write can no longer leave the target truncated. Some of
// these are fetched over HTTP at runtime (journalist-image-catalog.json,
// border-wait-ranking-window.json — a truncated write would be SERVED, not
// caught at build); the rest are read at Node build/script time, where a
// truncated file fails loudly instead — atomic writes close both cases
// with the same one-line change, so there is no reason to special-case
// either group.
describe('generators write their committed JSON datasets atomically', () => {
  const migrated = [
    { file: 'generate-journalist-image-catalog.mjs', call: 'writeJsonAtomic(OUT_PATH, catalog' },
    { file: 'fetch-fso-rental-medians.mjs', call: 'writeJsonAtomic(OUT_PATH, payload)' },
    { file: 'fetch-istat-cost-basket.mjs', call: 'writeJsonAtomic(OUT_PATH, payload)' },
    { file: 'publish-border-wait-window.mjs', call: 'writeJsonAtomic(OUT_PATH, payload)' },
    { file: 'refresh-indexed-cluster-urls.mjs', call: 'writeJsonAtomic(OUT_PATH, output)' },
    { file: 'refresh-noslash-keep.mjs', call: 'writeJsonAtomic(OUT_PATH, output)' },
    { file: 'scrape-concorsi-ti.mjs', call: 'writeJsonAtomic(OUT_PATH, payload)' },
    { file: 'scrape-seco-staffing.mjs', call: 'writeJsonAtomic(OUT_PATH, payload)' },
    { file: 'snapshot-exchange-history.mjs', call: 'writeJsonAtomic(OUT_PATH, snapshot)' },
  ];

  for (const { file, call } of migrated) {
    it(`${file} routes its dataset write through writeJsonAtomic`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      expect(src).toContain("from './lib/atomic-write-json.mjs'");
      expect(src).toContain(call);
      // The direct write this replaces is exactly what must never come
      // back — if it does, the atomicity guarantee is silently lost again.
      expect(src).not.toMatch(/fs\.writeFileSync\(\s*OUT_PATH\b/);
    });
  }
});
