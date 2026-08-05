import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  sweepDistBlogImageRefs,
  rewriteBlogImageRefs,
  hasBlogImageLeak,
} from '../build-plugins/blogImageCdnFinalizePlugin';
import { collectHtml } from '../build-plugins/shared/distHtmlWalk';
import { shouldEmitPath } from '../build-plugins/shared/localeEmitFilter';

/**
 * Output-invariance guard for the build-time reductions of issue #5130.
 *
 * Every optimisation there is a SKIP: work that used to run and no longer
 * does. The failure mode of a skip is a page missing from `dist/` — a 404 on
 * an indexed URL. These tests pin the two claims the skips rest on:
 *
 *   1. blogImageCdnFinalize's byte-marker fast path + concurrent sweep produce
 *      byte-identical dist content, the same counters and the same leak set as
 *      the original sequential `readFileSync(utf8) → rewrite → guard` walk.
 *      The reference implementation below IS that original loop.
 *   2. Skipping non-owned-locale work (postWalkCoordinator, cfHot404Bridge) can
 *      never drop a shipped file, because the set skipped is exactly the set
 *      `scripts/ci/prune-locale-shard.mjs` deletes in the next workflow step.
 *      Proven by running the real prune script over a fixture tree and
 *      comparing survivors against `shouldEmitPath`.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

afterEach(() => {
  vi.resetModules();
});

// ── Fixture tree ─────────────────────────────────────────────────────────────

const ORIGIN = 'https://frontaliereticino.ch';

/** Files chosen to exercise every branch of the three blog-image regexes. */
const FIXTURE: ReadonlyArray<readonly [string, string | Buffer]> = [
  // Rewritten: site-relative full hero.
  ['index.html', `<html><img src="/images/blog/hero-a.webp"></html>`],
  // Rewritten: origin-absolute full hero.
  ['blog/post-1/index.html', `<html><meta property="og:image" content="${ORIGIN}/images/blog/hero-b.png"></html>`],
  // Rewritten: several refs in one file, mixed forms.
  [
    'blog/post-2/index.html',
    `<img src="/images/blog/c.jpg"><img src="${ORIGIN}/images/blog/d.avif"><img src="/images/blog/e.jpeg">`,
  ],
  // NOT rewritten: thumbnails keep an extra path segment.
  ['blog/post-3/index.html', `<img src="/images/blog/thumbnails/x-480w.webp">`],
  // NOT rewritten: already-CDN and raw@SHA URLs are preceded by a word char.
  [
    'blog/post-4/index.html',
    `<img src="https://cdn.frontaliereticino.ch/images/blog/f.webp">` +
      `<img src="https://raw.githubusercontent.com/o/r/main/public/images/blog/f.webp">`,
  ],
  // Contains the marker but is NOT a rewrite target and IS a leak: a bare
  // extensionless ref cannot match FILE, so the sweep must leave it and the
  // guard must NOT fire (no extension → reLeak cannot match either).
  ['sitemap-blog.xml', `<loc>${ORIGIN}/images/blog/</loc>`],
  // No marker at all — the fast path's whole population.
  ['cerca-lavoro-ticino/job-1/index.html', '<html>a job page, no images</html>'.repeat(50)],
  ['robots.txt', 'User-agent: *\nAllow: /\n'],
  ['404.html', '<html>not found</html>'],
  // Non-scanned extension (must never be read or rewritten).
  ['blog/post-1/data.json', `{"img":"/images/blog/hero-a.webp"}`],
  // Invalid UTF-8 bytes AROUND a real marker: the byte fast path must still
  // see it, and the decoded string must still be rewritten identically.
  [
    'blog/post-5/index.html',
    Buffer.concat([
      Buffer.from('<html>'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from(`<img src="/images/blog/g.webp">`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('</html>'),
    ]),
  ],
  // Invalid UTF-8 with NO marker — must take the fast path and stay byte-identical.
  ['blog/post-6/index.html', Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e])],
  // Empty file.
  ['empty.html', ''],
  // Locale subtrees (also used by the prune-equivalence test).
  ['en/blog/post-1/index.html', `<img src="/images/blog/hero-a.webp">`],
  ['de/blog/post-1/index.html', `<img src="${ORIGIN}/images/blog/hero-b.png">`],
  ['fr/index.html', '<html>fr root</html>'],
  // Top-level dirs the walk must skip entirely.
  ['assets/app.html', `<img src="/images/blog/never-scanned.webp">`],
  ['data/x.html', `<img src="/images/blog/never-scanned.webp">`],
  ['images/blog/hero-a.webp', 'binary-ish'],
  // A NESTED dir sharing a skipped name must still be walked (see the plugin's
  // `dir === root` gate — a content slug called `data` is not the asset dir).
  ['en/data/deep/index.html', `<img src="/images/blog/nested.webp">`],
];

function makeFixture(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dist = path.join(root, 'dist');
  for (const [rel, content] of FIXTURE) {
    const fp = path.join(dist, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content as never);
  }
  return dist;
}

function snapshotTree(dist: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else out.set(path.relative(dist, fp).split(path.sep).join('/'), fs.readFileSync(fp).toString('base64'));
    }
  };
  walk(dist);
  return out;
}

// ── 1. blogImageCdnFinalize: sweep is byte-identical to the original loop ────

const SCAN_EXT = new Set(['.html', '.xml', '.txt']);

/**
 * The PRE-#5130 implementation, verbatim: sync recursive walk, utf8 read of
 * EVERY scanned file, rewrite, write-if-changed, in-memory leak guard.
 * Kept here (not imported) precisely so the test still compares against the
 * old behaviour after the plugin changed.
 */
function referenceSweep(dist: string): { scanned: number; rewritten: number; leaks: string[] } {
  let scanned = 0;
  let rewritten = 0;
  const leaks: string[] = [];
  const walk = (dir: string, root: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === root && (e.name === 'assets' || e.name === 'data' || e.name === 'images')) continue;
        walk(fp, root);
      } else if (SCAN_EXT.has(path.extname(e.name))) {
        scanned++;
        const orig = fs.readFileSync(fp, 'utf8');
        const out = rewriteBlogImageRefs(orig);
        if (out !== orig) {
          fs.writeFileSync(fp, out);
          rewritten++;
        }
        if (hasBlogImageLeak(out)) leaks.push(path.relative(root, fp));
      }
    }
  };
  walk(dist, dist);
  return { scanned, rewritten, leaks };
}

describe('#5130 — blogImageCdnFinalize sweep keeps dist byte-identical', () => {
  // The shard filter is inactive here (no BUILD_LOCALE), so both walks cover
  // the whole tree — the comparison is over the full file population.
  it.each([1, 2, 8, 64])('concurrency=%i matches the sequential reference exactly', async (lanes) => {
    const refDist = makeFixture('bicdn-ref-');
    const newDist = makeFixture('bicdn-new-');
    expect(snapshotTree(refDist)).toEqual(snapshotTree(newDist)); // same starting point

    const ref = referenceSweep(refDist);
    const got = await sweepDistBlogImageRefs(newDist, lanes);

    expect(got.scanned).toBe(ref.scanned);
    expect(got.rewritten).toBe(ref.rewritten);
    expect(got.leaks).toEqual([...ref.leaks].sort());
    // The whole tree, byte for byte — this is the no-lost-page / no-stale-page
    // assertion, and it covers the files the sweep never touched too.
    expect(snapshotTree(newDist)).toEqual(snapshotTree(refDist));

    fs.rmSync(path.dirname(refDist), { recursive: true, force: true });
    fs.rmSync(path.dirname(newDist), { recursive: true, force: true });
  });

  it('actually rewrote something (the fixture would otherwise prove nothing)', async () => {
    const dist = makeFixture('bicdn-sanity-');
    const got = await sweepDistBlogImageRefs(dist, 4);
    expect(got.rewritten).toBeGreaterThan(0);
    expect(got.scanned).toBeGreaterThan(got.rewritten);
    // Skipped top-level asset dirs are untouched.
    expect(fs.readFileSync(path.join(dist, 'assets/app.html'), 'utf8')).toContain('/images/blog/never-scanned.webp');
    // Nested dir sharing a skipped name IS rewritten.
    expect(fs.readFileSync(path.join(dist, 'en/data/deep/index.html'), 'utf8')).toContain('cdn.frontaliereticino.ch');
    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  it('is idempotent — a second sweep rewrites nothing and changes no byte', async () => {
    const dist = makeFixture('bicdn-idem-');
    await sweepDistBlogImageRefs(dist, 4);
    const after = snapshotTree(dist);
    const second = await sweepDistBlogImageRefs(dist, 4);
    expect(second.rewritten).toBe(0);
    expect(snapshotTree(dist)).toEqual(after);
    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  it('BLOG_REF_MARKER fast path is exact: absence of the bytes implies both no-op and no-leak', () => {
    // The property the fast path relies on, asserted directly on the transforms.
    const samples = [
      '<html>plain</html>',
      '/images/places/x.webp',
      '/imagesblog/x.webp',
      'images/blog-archive/x.webp',
      Buffer.from([0xff, 0xfe, 0x80, 0x41]).toString('utf8'),
      '',
    ];
    for (const s of samples) {
      expect(s.includes('/images/blog/'), s).toBe(false);
      expect(rewriteBlogImageRefs(s)).toBe(s);
      expect(hasBlogImageLeak(s)).toBe(false);
    }
  });
});

// ── 2. postWalkCoordinator: collectHtml matches the old generator walk ───────

/** The PRE-#5130 generator, verbatim. */
function* referenceWalkHtml(dir: string): Iterable<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* referenceWalkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield p;
    }
  }
}

describe('#5130 — postWalkCoordinator collectHtml enumerates exactly as before', () => {
  it('returns the same paths in the same order as the generator walk', () => {
    const dist = makeFixture('pwc-walk-');
    expect(collectHtml(dist, [])).toEqual([...referenceWalkHtml(dist)]);
    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  it('skips assets/data/images at ANY depth (the pre-existing contract) and finds nested .html', () => {
    const dist = makeFixture('pwc-walk2-');
    const found = collectHtml(dist, []).map((p) => path.relative(dist, p).split(path.sep).join('/'));
    expect(found).toContain('en/blog/post-1/index.html');
    expect(found).not.toContain('assets/app.html');
    expect(found).not.toContain('data/x.html');
    // .json / .txt are not HTML.
    expect(found.some((p) => p.endsWith('.json') || p.endsWith('.txt'))).toBe(false);
    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });
});

// ── 3. The skip set is exactly what prune-locale-shard.mjs deletes ───────────

describe('#5130 — non-owned-locale skips can never drop a shipped file', () => {
  /**
   * The load-bearing invariant behind BOTH the postWalkCoordinator skip and the
   * cfHot404Bridge skip: for every BUILD_LOCALE, a file with
   * `shouldEmitPath === false` is deleted by the prune step that runs
   * immediately after the build, and a file with `shouldEmitPath === true`
   * survives it. So skipping work on the former cannot change what ships.
   */
  it.each(['it', 'en', 'de', 'fr'])('BUILD_LOCALE=%s: survivors === shouldEmitPath', async (locale) => {
    const dist = makeFixture(`prune-${locale}-`);
    const before = [...snapshotTree(dist).keys()].sort();

    vi.resetModules();
    const prev = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = locale;
    let predicted: string[];
    try {
      const filter = await import('../build-plugins/shared/localeEmitFilter');
      predicted = before.filter((rel) => filter.shouldEmitPath(path.join(dist, rel), dist)).sort();
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/ci/prune-locale-shard.mjs'), dist], {
        env: { ...process.env, BUILD_LOCALE: locale },
        stdio: 'pipe',
      });
    } finally {
      if (prev === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = prev;
      vi.resetModules();
    }

    const survivors = [...snapshotTree(dist).keys()].sort();
    expect(survivors).toEqual(predicted);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(before.length); // the prune really pruned

    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  /**
   * Behavioural half of the same claim, on the plugin that does the most
   * direct `fs.writeFileSync` in the post phase (403,693 pages on the `it`
   * shard of run 31036546298): the shard gate must drop exactly the non-owned
   * emits and keep every owned one byte-identical to the ungated build.
   */
  it('cfHot404Bridge: shard gate drops only what prune would delete, owned output unchanged', async () => {
    const hot = {
      generatedAt: '2026-08-05T00:00:00.000Z',
      source: 'cloudflare',
      paths: [
        { path: '/cerca-lavoro-argovia/gated-role-acme-aarau', hits: 9 },
        { path: '/en/find-jobs-zurich/gated-role-acme-zurich', hits: 7 },
        { path: '/de/jobs-im-zurich/gated-role-acme-zuerich', hits: 6 },
        { path: '/fr/trouver-emploi-geneve/gated-role-acme-geneve', hits: 5 },
      ],
    };
    const build = async (buildLocale: string | undefined): Promise<Map<string, string>> => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-gate-'));
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'cf-hot-404s.json'), JSON.stringify(hot));
      // Section listing roots the pagination/fallback gap-fill probes.
      for (const r of ['cerca-lavoro-argovia', 'en/find-jobs-zurich', 'de/jobs-im-zurich', 'fr/trouver-emploi-geneve']) {
        fs.mkdirSync(path.join(root, 'dist', r), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', r, 'index.html'), '<html>SECTION ROOT</html>');
      }
      vi.resetModules();
      const prev = process.env.BUILD_LOCALE;
      if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = buildLocale;
      try {
        const { cfHot404BridgePlugin } = await import('../build-plugins/cfHot404BridgePlugin');
        const hook = cfHot404BridgePlugin(root).closeBundle;
        if (!hook || typeof hook !== 'object' || !('handler' in hook)) throw new Error('object hook expected');
        await hook.handler.call({} as never);
      } finally {
        if (prev === undefined) delete process.env.BUILD_LOCALE;
        else process.env.BUILD_LOCALE = prev;
        vi.resetModules();
      }
      const tree = snapshotTree(path.join(root, 'dist'));
      fs.rmSync(root, { recursive: true, force: true });
      return tree;
    };

    const all = await build(undefined);
    const itShard = await build('it');

    // Every file the gated `it` build produced is byte-identical to the
    // ungated one — the gate never changes an owned page, only omits others.
    for (const [rel, bytes] of itShard) expect([rel, bytes]).toEqual([rel, all.get(rel)]);
    // And what it omitted is exactly the non-owned set (= what prune deletes):
    // the three en/de/fr bridges, and nothing else. The pre-seeded section
    // roots exist in both trees, so they are not in the diff.
    // (The real committed cluster-recovery map contributes thousands of extra
    // non-owned paths on top of the four fixture ones, which is exactly the
    // volume this gate exists to skip.)
    const omitted = [...all.keys()].filter((r) => !itShard.has(r)).sort();
    expect(omitted.every((r) => /^(en|de|fr)\//.test(r))).toBe(true);
    expect(omitted.length).toBeGreaterThan(0);
    // Nothing OWNED was omitted: every non-en/de/fr key of the ungated build
    // is present in the gated one (already implied by the byte check above,
    // asserted explicitly so a future gate widening is caught here).
    expect([...all.keys()].filter((r) => !/^(en|de|fr)\//.test(r) && !itShard.has(r))).toEqual([]);
    // The IT bridge still lands.
    expect(itShard.has('cerca-lavoro-argovia/gated-role-acme-aarau/index.html')).toBe(true);
  });

  it('is a pure no-op without BUILD_LOCALE (the default all-locale build)', () => {
    const dist = makeFixture('prune-none-');
    const before = snapshotTree(dist);
    for (const rel of before.keys()) {
      expect(shouldEmitPath(path.join(dist, rel), dist), rel).toBe(true);
    }
    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });
});
