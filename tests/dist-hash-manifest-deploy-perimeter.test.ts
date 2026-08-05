/**
 * Regression coverage for issue #4894 — `matrix-equivalence-check.yml` red since
 * 2026-06-18.
 *
 * The check compared a raw `dist/` against the `github-pages` artifact, which is
 * NOT the same tree: `scripts/lib/deploy-it-pages-prep.sh` offloads
 * assets/data/og/images to the CDN, DELETES those trees from the artifact, and
 * `scripts/offload-generated-images-cdn.mjs` rewrites every same-origin
 * reference in every static HTML file to `https://cdn.frontaliereticino.ch/…`.
 *
 * Measured on run 27749079114: `only-in-matrix: 38049` (all of `assets/`) and
 * `content-mismatch: 445753` — 99.967 % of the shared paths. The check has
 * therefore verified nothing for two months.
 *
 * `scripts/offload-generated-images-cdn.mjs` also INJECTS an inline
 * `<script>window.__CDN_DATA_BASE__="…"</script>` (+ an optional
 * `<link rel="preconnect">`/`dns-prefetch` hint pair) right after `<head>` in
 * every HTML page — unconditionally, not gated on the URL rewrite happening.
 * That tag does not exist in a raw `dist/` at all, so undoing the URL rewrite
 * alone still leaves every HTML page mismatching.
 *
 * `--deploy-artifact-perimeter` normalises BOTH sides. These tests pin the
 * properties the fix depends on:
 *   1. a CDN-rewritten + data-base-injected page hashes IDENTICALLY to its
 *      same-origin, non-injected original (this is what collapses the 445753
 *      mismatches);
 *   2. the offloaded trees are skipped, at the dist root AND under a locale
 *      prefix (`en/data/…`);
 *   3. the offload perimeter is read from the canonical constant and FAILS LOUD
 *      if it ever disappears — a silently empty perimeter would make the whole
 *      equivalence check pass vacuously, which is worse than a red one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'dist-hash-manifest.mjs');
const CDN = 'https://cdn.frontaliereticino.ch';
const DATA_CDN_ORIGIN = 'https://valerielinc-ops.github.io';
const DATA_CDN_BASE = `${DATA_CDN_ORIGIN}/frontaliere-cdn`;

let distDir = '';
let outDir = '';

function write(rel: string, body: string) {
  const p = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function manifest(...flags: string[]): Map<string, string> {
  const out = path.join(outDir, `m-${flags.join('_') || 'plain'}-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync('node', [SCRIPT, distDir, out, ...flags], { cwd: ROOT, encoding: 'utf-8' });
  const map = new Map<string, string>();
  for (const line of fs.readFileSync(out, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const sp = line.indexOf('  ');
    map.set(line.slice(sp + 2), line.slice(0, sp));
  }
  return map;
}

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-hash-perimeter-'));
  distDir = path.join(base, 'dist');
  outDir = path.join(base, 'out');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // The SAME page, as the build emits it and as the deploy rewrites + injects it.
  const body = (base: string) =>
    `<body><img src="${base}/og/card.png"><script src="${base}/assets/app.js"></script></body>`;
  const inject =
    `<link rel="preconnect" href="${DATA_CDN_ORIGIN}" crossorigin><link rel="dns-prefetch" href="${DATA_CDN_ORIGIN}">` +
    `<script>window.__CDN_DATA_BASE__=${JSON.stringify(DATA_CDN_BASE)}</script>`;
  write('same-origin/index.html', `<!doctype html><html><head></head>${body('')}</html>`);
  write('rewritten/index.html', `<!doctype html><html><head>${inject}</head>${body(CDN)}</html>`);

  // Idempotent inject form: a build-shipped preconnect for the SAME origin
  // already exists, so offload-generated-images-cdn.mjs omits the hint pair and
  // injects only the `<script>` (offload-generated-images-cdn.mjs:340-342).
  write(
    'rewritten-preexisting-preconnect/index.html',
    `<!doctype html><html><head><link rel="preconnect" href="${DATA_CDN_ORIGIN}" crossorigin><script>window.__CDN_DATA_BASE__=${JSON.stringify(DATA_CDN_BASE)}</script></head>${body(CDN)}</html>`,
  );
  write(
    'same-origin-preexisting-preconnect/index.html',
    `<!doctype html><html><head><link rel="preconnect" href="${DATA_CDN_ORIGIN}" crossorigin></head>${body('')}</html>`,
  );

  // Trees the deploy drops from the artifact — at the root and under a locale.
  write('assets/app.js', 'console.log(1)');
  write('data/jobs.json', '{"a":1}');
  write('og/card.png', 'PNG');
  write('job-canon/x.json', '{}');
  write('images/brands/acme.svg', '<svg/>');
  write('images/blog/thumbnails/t.webp', 'WEBP');
  write('en/data/jobs.json', '{"a":1}');

  // Trees that must SURVIVE: not offloaded.
  write('images/places/lugano.webp', 'WEBP');
  write('sitemap.xml', '<urlset/>');
});

afterAll(() => {
  if (distDir) fs.rmSync(path.resolve(distDir, '..'), { recursive: true, force: true });
});

describe('dist-hash-manifest --deploy-artifact-perimeter (#4894)', () => {
  it('makes a CDN-rewritten + data-base-injected page hash identically to its same-origin original', () => {
    const plain = manifest();
    const perim = manifest('--deploy-artifact-perimeter');

    // Without normalisation the deploy rewrite + inject alone make the two pages
    // differ — this is the 445753-mismatch mechanism, reproduced.
    expect(plain.get('same-origin/index.html')).not.toBe(plain.get('rewritten/index.html'));

    // With it, they are byte-equal for comparison purposes.
    expect(perim.get('rewritten/index.html')).toBe(perim.get('same-origin/index.html'));
  });

  it('strips the idempotent inject form (pre-existing preconnect, hint pair omitted) the same way', () => {
    const perim = manifest('--deploy-artifact-perimeter');
    expect(perim.get('rewritten-preexisting-preconnect/index.html')).toBe(
      perim.get('same-origin-preexisting-preconnect/index.html'),
    );
  });

  it('skips every tree the deploy offloads, at the root and under a locale prefix', () => {
    const perim = manifest('--deploy-artifact-perimeter');
    for (const gone of [
      'assets/app.js',
      'data/jobs.json',
      'og/card.png',
      'job-canon/x.json',
      'images/brands/acme.svg',
      'images/blog/thumbnails/t.webp',
      'en/data/jobs.json',
    ]) {
      expect(perim.has(gone), `${gone} should be outside the deploy-artifact perimeter`).toBe(false);
    }
  });

  it('keeps the page surface and the non-offloaded image trees in scope', () => {
    const perim = manifest('--deploy-artifact-perimeter');
    // `/images/places/` is deliberately NOT offloaded (blog hero places) — see
    // services/cdnImageBase.ts. Dropping it would be a silent coverage loss.
    expect(perim.has('images/places/lugano.webp')).toBe(true);
    expect(perim.has('sitemap.xml')).toBe(true);
    expect(perim.has('same-origin/index.html')).toBe(true);
  });

  it('leaves the default (no-flag) behaviour untouched', () => {
    const plain = manifest();
    expect(plain.has('assets/app.js')).toBe(true);
    expect(plain.has('data/jobs.json')).toBe(true);
    expect(plain.has('en/data/jobs.json')).toBe(true);
  });

  it('reads the offload perimeter from the canonical constant, and fails loud if it moves', () => {
    // AGENTS.md #6: offload-generated-images-cdn.mjs, deploy-it-pages-prep.sh and
    // ensure-image-cdn-redirect.mjs each keep their own copy and each names
    // services/cdnImageBase.ts as the one to stay in sync with. The manifest
    // script parses that one instead of adding a fifth copy — so a rename must
    // break the run, never silently empty the perimeter.
    const src = fs.readFileSync(path.join(ROOT, 'services', 'cdnImageBase.ts'), 'utf-8');
    const block = src.match(/export const CDN_OFFLOADED_IMAGE_PREFIXES\s*=\s*\[([\s\S]*?)\]\s*as const/);
    expect(block, 'CDN_OFFLOADED_IMAGE_PREFIXES must stay parseable by dist-hash-manifest.mjs').not.toBeNull();
    const prefixes = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const p of prefixes) expect(p).toMatch(/^\/images\/[a-z-]+\/$/);

    const script = fs.readFileSync(SCRIPT, 'utf-8');
    expect(script).toContain('CDN_OFFLOADED_IMAGE_PREFIXES');
    expect(script).toContain('Refusing to hash with an unknown offload perimeter');
    expect(script).toContain('Refusing to hash with an empty offload perimeter');
  });
});
