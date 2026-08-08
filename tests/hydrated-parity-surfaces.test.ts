// Which urls the gate reads is the decision that failed on 2026-08-08 — not
// how it compares what it read.
//
// The run that published `salario-medio-professioni-svizzera-2026-basilea`
// closed green in every step, the article was live at its own url, and it was
// absent from `/articoli-svizzera/`. The gate passed too, because it read the
// overlay ONLY under the five-minute rotating key, reasoning that the rotating
// key is never the stale variant. That is true. What it assumed is that the
// client doing the requesting is the one in this repo — and the edge was
// serving a chunk from three days earlier that asks for the BARE url:
//
//   assets/runtimeArticleResolution.js  Origin sent → 2026-08-05T11:35:07Z (age 37h)
//                                       no Origin   → 2026-08-07T02:43:20Z
//
// So the gate read a cache entry no visitor requested. The entry every visitor
// DID request held 637 articles against the corpus's 647, on six of the eight
// blog-index files, 12 to 16 hours old.
//
// These pin the two decisions that close that hole: read the bare url as well,
// and build the client's id set from THAT read.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { missingFromClient } from '../scripts/lib/hydratedParity.mjs';

const SRC = readFileSync(resolve(__dirname, '../scripts/ci/check-hydrated-article-parity.mjs'), 'utf8');

describe('the surfaces the gate reads', () => {
  it('reads the overlay at the bare url, not only under the rotating key', () => {
    // Non-vacuity: both names must exist, or the assertions below pass by
    // matching nothing after a rename.
    expect(SRC).toContain('const OVERLAY_BASE');
    expect(SRC).toContain('const OVERLAY_ROTATED');
    expect(SRC).toMatch(/\[\s*\['bare', OVERLAY_BASE\],\s*\['rotated', OVERLAY_ROTATED\]\s*\]/);
  });

  it('builds the bare url without a `v=` key — that is the whole point of reading it', () => {
    const base = SRC.match(/const OVERLAY_BASE = flag\('overlay', `([^`]+)`\)/)?.[1];
    expect(base).toBeDefined();
    expect(base).not.toContain('v=');
    expect(base).toContain('blog-index-');
  });

  it("feeds clientIds from the bare read, so a green verdict covers both clients", () => {
    expect(SRC).toMatch(/for \(const id of overlayIds\.bare\) clientIds\.add\(id\)/);
    // The rotated read must NOT widen the set — that is what hid the defect.
    expect(SRC).not.toMatch(/for \(const id of overlayIds\.rotated\) clientIds\.add\(id\)/);
  });

  it('reads the chunks that carry the overlay mechanism, so a stale client is visible', () => {
    expect(SRC).toContain('assets/runtimeArticleResolution.js');
    expect(SRC).toContain('assets/BlogArticles.js');
    // They are code: read for the divergence check, never parsed for ids.
    expect(SRC).toMatch(/for \(const url of CODE_SURFACES\)/);
    expect(SRC).not.toMatch(/idsInRegistryChunk\([^)]*\)[\s\S]{0,80}CODE_SURFACES/);
  });
});

describe('why the bare read is the one that decides the verdict', () => {
  // Recorded from the live edge on 2026-08-08, same url within the same second.
  const RENDERED = ['salario-medio-professioni-svizzera-2026-basilea', 'salari-medi-zurigo-2026-confronto'];
  const reverse = Object.fromEntries(RENDERED.map((s) => [s, s]));

  const bareRead = new Set(['salari-medi-zurigo-2026-confronto']); // 637-article copy
  const rotatedRead = new Set(RENDERED); // 647-article copy

  it('names the lost article when the copy the served client requests is stale', () => {
    expect(missingFromClient(RENDERED, reverse, bareRead)).toEqual([
      'salario-medio-professioni-svizzera-2026-basilea',
    ]);
  });

  it('is exactly what the rotating-key-only read hid', () => {
    // Same hub, same corpus, same second — and a clean bill of health. This is
    // the green run of 2026-08-08 reproduced.
    expect(missingFromClient(RENDERED, reverse, rotatedRead)).toEqual([]);
  });
});
