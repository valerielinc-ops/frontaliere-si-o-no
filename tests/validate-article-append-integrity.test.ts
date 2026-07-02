/**
 * Regression lock for `scripts/ci/validate-article-append-integrity.mjs`
 * (follow-up #2837 of PR #2835).
 *
 * Covers:
 *  1. The CLI still passes on the real, clean repo tree (both SWISS_SLUGS and
 *     BLOG_SLUGS uniqueness, and url-sitemap <loc>/<url> balance).
 *  2. A duplicate localized slug in BLOG_SLUGS (routerBlogData.ts / FRONTALIERE
 *     section) is now caught — this is the corruption class that redded
 *     tests/blog/svizzera-section-routing for SWISS_SLUGS and, until #2837,
 *     had no equivalent gate for BLOG_SLUGS (36 such collisions were
 *     deduplicated on main in #3012; this test locks the gate that prevents
 *     recurrence).
 *  3. A duplicate localized slug in SWISS_SLUGS is still caught (no
 *     regression from the refactor into a shared `checkSlugUniqueness` helper).
 *  4. url-sitemap <loc>-per-<url> is checked PER BLOCK, not just in aggregate:
 *     a fixture where one <url> block has two <loc> and a sibling block has
 *     zero (aggregate counts coincidentally still balance) is caught.
 *
 * Fixtures run the CLI against an isolated temp directory (not the real repo
 * files) so the test never touches tracked sources.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'validate-article-append-integrity.mjs');

const cleanSwissData = [
  "export const SWISS_SLUGS = {",
  " 'swiss-a': { it: 'swiss-a-it', en: 'swiss-a-en', de: 'swiss-a-de', fr: 'swiss-a-fr' },",
  " 'swiss-b': { it: 'swiss-b-it', en: 'swiss-b-en', de: 'swiss-b-de', fr: 'swiss-b-fr' },",
  "};",
  "",
].join('\n');

const cleanBlogData = [
  "export const BLOG_SLUGS = {",
  " 'blog-a': { it: 'blog-a-it', en: 'blog-a-en', de: 'blog-a-de', fr: 'blog-a-fr' },",
  " 'blog-b': { it: 'blog-b-it', en: 'blog-b-en', de: 'blog-b-de', fr: 'blog-b-fr' },",
  "};",
  "",
].join('\n');

const cleanSitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset>',
  '<url><loc>https://frontaliereticino.ch/a/</loc></url>',
  '<url><loc>https://frontaliereticino.ch/b/</loc></url>',
  '</urlset>',
  '',
].join('\n');

let tmpDir: string | null = null;

/** Builds a minimal fixture tree the script can run against via `cwd`. */
function makeFixture(overrides: { swiss?: string; blog?: string; sitemap?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'article-integrity-fixture-'));
  mkdirSync(path.join(dir, 'services'), { recursive: true });
  mkdirSync(path.join(dir, 'public'), { recursive: true });
  writeFileSync(path.join(dir, 'services', 'routerSwissData.ts'), overrides.swiss ?? cleanSwissData);
  writeFileSync(path.join(dir, 'services', 'routerBlogData.ts'), overrides.blog ?? cleanBlogData);
  writeFileSync(path.join(dir, 'public', 'sitemap-test.xml'), overrides.sitemap ?? cleanSitemap);
  return dir;
}

function runCli(cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], { cwd, encoding: 'utf-8' });
    return { status: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('validate-article-append-integrity — real repo tree', () => {
  it('exits 0 on the current clean tree and checks BOTH SWISS_SLUGS and BLOG_SLUGS', () => {
    const { status, output } = runCli(ROOT);
    expect(status).toBe(0);
    expect(output).toMatch(/SWISS \+ BLOG slug-uniqueness/);
  });
});

describe('validate-article-append-integrity — BLOG_SLUGS duplicate slug (fixture)', () => {
  it('exits 0 on a clean fixture', () => {
    tmpDir = makeFixture();
    const { status } = runCli(tmpDir);
    expect(status).toBe(0);
  });

  it('catches a duplicate localized BLOG_SLUGS slug (routerBlogData.ts / FRONTALIERE)', () => {
    const dupBlog = [
      "export const BLOG_SLUGS = {",
      " 'blog-a': { it: 'blog-a-it', en: 'blog-a-en', de: 'blog-a-de', fr: 'blog-a-fr' },",
      // Same IT slug as 'blog-a' but a different article id — REVERSE_BLOG
      // last-write-wins collision (the #3012 corruption shape).
      " 'blog-b': { it: 'blog-a-it', en: 'blog-b-en', de: 'blog-b-de', fr: 'blog-b-fr' },",
      "};",
      "",
    ].join('\n');
    tmpDir = makeFixture({ blog: dupBlog });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/routerBlogData\.ts/);
    expect(output).toMatch(/duplicate IT slug "blog-a-it"/);
    expect(output).toMatch(/REVERSE_BLOG collides/);
  });
});

describe('validate-article-append-integrity — SWISS_SLUGS duplicate slug (fixture, no regression)', () => {
  it('still catches a duplicate localized SWISS_SLUGS slug after the shared-helper refactor', () => {
    const dupSwiss = [
      "export const SWISS_SLUGS = {",
      " 'swiss-a': { it: 'swiss-a-it', en: 'swiss-a-en', de: 'swiss-a-de', fr: 'swiss-a-fr' },",
      " 'swiss-b': { it: 'swiss-a-it', en: 'swiss-b-en', de: 'swiss-b-de', fr: 'swiss-b-fr' },",
      "};",
      "",
    ].join('\n');
    tmpDir = makeFixture({ swiss: dupSwiss });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/routerSwissData\.ts/);
    expect(output).toMatch(/REVERSE_SWISS collides/);
  });
});

describe('validate-article-append-integrity — per-block <loc> check (aggregate blind spot)', () => {
  it('catches a fused <url> block (two <loc>) even when a sibling block is missing its <loc> and the aggregate totals coincidentally balance', () => {
    // urlOpen=2, urlClose=2, loc=2 -> aggregate (loc !== urlOpen) check alone
    // would NOT fire here, since totals coincide. Only the per-block scan
    // catches the fused first block.
    const blindSpotSitemap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset>',
      '<url><loc>https://frontaliereticino.ch/fused-a/</loc><loc>https://frontaliereticino.ch/fused-b/</loc></url>',
      '<url></url>',
      '</urlset>',
      '',
    ].join('\n');
    tmpDir = makeFixture({ sitemap: blindSpotSitemap });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/sitemap-test\.xml/);
    expect(output).toMatch(/<url> block #1 has 2 <loc> entries/);
  });

  it('exits 0 when every <url> block has exactly one <loc>', () => {
    tmpDir = makeFixture();
    const { status } = runCli(tmpDir);
    expect(status).toBe(0);
  });
});
