/**
 * Regression test for the `srcFiles is not defined` crash (surfaced 2026-08-15).
 *
 * THE INCIDENT
 * ────────────
 * The "preserve locally-only article ids" step shipped with PR #5357
 * (2026-08-08, the sync pin) and sat dormant: its snapshot loop referenced
 * `srcFiles` and `dstFiles` — two variables never declared anywhere in the
 * file — but only runs when `preserveIds.size > 0`. `node --check` cannot
 * catch this: it is a ReferenceError that only fires when the branch
 * executes at runtime, not a syntax error. The branch first executed on
 * 2026-08-15, after three retirements were bridged (between 08:50Z and
 * 13:26Z) and made three ids local-only; the earlier reds of
 * `sync-articles-sitemaps.yml` that morning (e.g. run 31871519636, 07:16Z)
 * were the registry gate refusing then-unledgered drops, not this crash.
 * The crash produced the false-positive issue #5618 ("Article sync skipped:
 * corpus mirror behind the published API") — the corpus itself was fine;
 * the sync script never got far enough to compare it.
 *
 * The fix extracts the loop into `collectPreserveSnapshots()` in
 * `scripts/lib/corpus-local-preserve.mjs`, which defines both variables from
 * real directory walks. This test exercises exactly that loop, with local
 * temp-directory fixtures — no network, no real corpus clone.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectPreserveSnapshots,
  dropLedgeredRetirements,
  listRelFiles,
} from '../scripts/lib/corpus-local-preserve.mjs';

function makeTree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'corpus-preserve-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe('listRelFiles', () => {
  it('walks nested directories and returns paths relative to the root', () => {
    const dir = makeTree({
      'routerBlogData.ts': 'a',
      'blog-body/it/foo.ts': 'b',
      'blog-body/de/foo.ts': 'c',
    });
    try {
      const rel = listRelFiles(dir);
      expect(rel).toEqual(new Set(['routerBlogData.ts', 'blog-body/it/foo.ts', 'blog-body/de/foo.ts']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectPreserveSnapshots (the srcFiles/dstFiles crash site)', () => {
  it('does not throw, and snapshots a shared file that mentions a locally-only id', () => {
    const preserveIds = new Set(['locally-only-article']);

    const src = makeTree({
      // Upstream has NOT heard of the id yet — same relative path as dest,
      // but its content does not mention it.
      'routerBlogData.ts': "export const BLOG_SLUGS = { 'upstream-article': {} };",
    });
    const dest = makeTree({
      // Local copy still carries the locally-only id inside the shared file.
      'routerBlogData.ts':
        "export const BLOG_SLUGS = { 'upstream-article': {}, 'locally-only-article': {} };",
    });

    try {
      // Pre-fix, this call site referenced undefined `srcFiles`/`dstFiles`
      // and threw `ReferenceError: srcFiles is not defined`.
      const snapshots = collectPreserveSnapshots({ src, dest, preserveIds });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].rel).toBe('routerBlogData.ts');
      expect(snapshots[0].ids).toEqual(['locally-only-article']);
      expect(snapshots[0].text).toContain('locally-only-article');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a file that only exists upstream — nothing local to lose', () => {
    const preserveIds = new Set(['locally-only-article']);
    const src = makeTree({ 'new-upstream-file.ts': 'locally-only-article mentioned here too' });
    const dest = makeTree({}); // empty — nothing shares this relative path

    try {
      const snapshots = collectPreserveSnapshots({ src, dest, preserveIds });
      expect(snapshots).toHaveLength(0);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips a shared file that mentions no locally-only id', () => {
    const preserveIds = new Set(['locally-only-article']);
    const src = makeTree({ 'routerBlogData.ts': "export const BLOG_SLUGS = { 'a': {} };" });
    const dest = makeTree({ 'routerBlogData.ts': "export const BLOG_SLUGS = { 'a': {} };" });

    try {
      const snapshots = collectPreserveSnapshots({ src, dest, preserveIds });
      expect(snapshots).toHaveLength(0);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('dropLedgeredRetirements (retired ids must not be resurrected)', () => {
  // A bridged retirement is "present local, absent upstream" exactly like a
  // locally-published article. Preserving it would put its registry entries
  // back while the mirror deletes its body — a registry row with no module —
  // and the id would stay local-only forever, re-preserved on every sync.
  // Measured on the real 2026-08-15 run: the three ids the registry gate
  // logged as "retired (bridged)" were the same three the preserve step
  // logged as "exist only downstream".
  it('drops ledgered removals from preserveIds and keeps everything else', () => {
    const preserveIds = new Set(['retired-and-bridged', 'locally-published']);
    const removals = [
      { id: 'retired-and-bridged', ledgered: true },
      { id: 'dropped-without-bridge', ledgered: false },
    ];
    const out = dropLedgeredRetirements(preserveIds, removals);
    expect(out).toBe(preserveIds); // mutates and returns the same Set
    expect([...out].sort()).toEqual(['locally-published']);
  });

  it('tolerates an empty or missing removals list', () => {
    const preserveIds = new Set(['locally-published']);
    expect([...dropLedgeredRetirements(preserveIds, [])]).toEqual(['locally-published']);
    expect([...dropLedgeredRetirements(preserveIds, undefined)]).toEqual(['locally-published']);
  });
});
