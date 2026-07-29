/**
 * Wiring test for `scripts/ci/check-orphan-article-meta.mjs`.
 *
 * Locks the gate that catches the production incident where
 * `/articoli-frontaliere/` (and its svizzera mirror) rendered raw
 * `blog.article.<id>.title` i18n keys instead of real titles for three
 * registry ids (permesso-g-pro-contro-2026, cantieri-traffico-a9-ticino,
 * iniziativa-salari-ticino) that had no `blog.article.<id>.*` entry in the
 * IT meta file. The article PAGE recovers via
 * build-plugins/articleSeoFallback.ts; the LIST does not — it calls `t()`
 * directly, so an orphan registry id is visible on the live site.
 *
 * An unwired script is not a gate (see scripts/ci/check-blog-slugs-sitemap-sync.mjs,
 * which has no test and is not referenced by any workflow — it never runs).
 * This test is what makes `check-orphan-article-meta.mjs` run under `npm test`.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-orphan-article-meta.mjs');

// Matches the REAL multi-line object-literal shape (each field on its own
// line) used by data/blog-articles-data.ts / data/swiss-articles-data.ts —
// idsOf()'s `/^\s*id:\s*'([^']+)'/gm` requires `id:` to start its own line,
// so a single-line `{ id: 'x', category: 'x' }` fixture would silently
// match zero ids and hide every case behind a false "0 registry ids" pass.
const cleanRegistry = [
  "export const RAW_ARTICLES = [",
  "  {",
  "    id: 'article-a',",
  "    category: 'x',",
  "    date: '2026-01-01',",
  "  },",
  "  {",
  "    id: 'article-b',",
  "    category: 'x',",
  "    date: '2026-01-01',",
  "  },",
  "];",
  "",
].join('\n');

const cleanMeta = [
  "export const blogMetaIt = {",
  "  'blog.article.article-a.title': 'Titolo A',",
  "  'blog.article.article-a.excerpt': 'Estratto A',",
  "  'blog.article.article-a.imageAlt': 'Alt A',",
  "  'blog.article.article-b.title': 'Titolo B',",
  "  'blog.article.article-b.excerpt': 'Estratto B',",
  "  'blog.article.article-b.imageAlt': 'Alt B',",
  "};",
  "",
].join('\n');

let tmpDir: string | null = null;

/** Minimal fixture tree covering both section registries + IT meta files. */
function makeFixture(overrides: {
  blogRegistry?: string;
  blogMeta?: string;
  swissRegistry?: string;
  swissMeta?: string;
} = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orphan-article-meta-fixture-'));
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  mkdirSync(path.join(dir, 'services', 'locales'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'blog-articles-data.ts'), overrides.blogRegistry ?? cleanRegistry);
  writeFileSync(path.join(dir, 'services', 'locales', 'blog-meta-it.ts'), overrides.blogMeta ?? cleanMeta);
  writeFileSync(path.join(dir, 'data', 'swiss-articles-data.ts'), overrides.swissRegistry ?? cleanRegistry);
  writeFileSync(path.join(dir, 'services', 'locales', 'blog-meta-ch-it.ts'), overrides.swissMeta ?? cleanMeta);
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

describe('check-orphan-article-meta — real repo tree', () => {
  it('exits 0 on the current clean tree and checks BOTH sections', () => {
    const { status, output } = runCli(ROOT);
    expect(status).toBe(0);
    expect(output).toMatch(/frontaliere: all \d+ registry ids have complete IT meta/);
    expect(output).toMatch(/svizzera: all \d+ registry ids have complete IT meta/);
  });
});

describe('check-orphan-article-meta — fixtures', () => {
  it('exits 0 on a clean fixture', () => {
    tmpDir = makeFixture();
    const { status } = runCli(tmpDir);
    expect(status).toBe(0);
  });

  it('catches a frontaliere registry id with no IT meta entry at all (the production shape)', () => {
    const registryWithOrphan = [
      "export const RAW_ARTICLES = [",
      "  {",
      "    id: 'article-a',",
      "    category: 'x',",
      "    date: '2026-01-01',",
      "  },",
      "  {",
      "    id: 'orphan-article',",
      "    category: 'x',",
      "    date: '2026-01-01',",
      "  },",
      "];",
      "",
    ].join('\n');
    tmpDir = makeFixture({ blogRegistry: registryWithOrphan });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/frontaliere .*blog-articles-data\.ts.*blog-meta-it\.ts/);
    expect(output).toMatch(/orphan-article: missing title, excerpt, imageAlt/);
  });

  it('catches a partial IT meta entry (title present, excerpt/imageAlt missing)', () => {
    const partialMeta = [
      "export const blogMetaIt = {",
      "  'blog.article.article-a.title': 'Titolo A',",
      "  'blog.article.article-a.excerpt': 'Estratto A',",
      "  'blog.article.article-a.imageAlt': 'Alt A',",
      "  'blog.article.article-b.title': 'Titolo B senza il resto',",
      "};",
      "",
    ].join('\n');
    tmpDir = makeFixture({ blogMeta: partialMeta });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/article-b: missing excerpt, imageAlt/);
  });

  it('catches an orphan in the svizzera section independently of frontaliere', () => {
    const registryWithOrphan = [
      "export const RAW_SWISS_ARTICLES = [",
      "  {",
      "    id: 'swiss-a',",
      "    category: 'x',",
      "    date: '2026-01-01',",
      "  },",
      "  {",
      "    id: 'swiss-orphan',",
      "    category: 'x',",
      "    date: '2026-01-01',",
      "  },",
      "];",
      "",
    ].join('\n');
    const swissMeta = [
      "export const blogMetaChIt = {",
      "  'blog.article.swiss-a.title': 'Titolo Svizzero A',",
      "  'blog.article.swiss-a.excerpt': 'Estratto Svizzero A',",
      "  'blog.article.swiss-a.imageAlt': 'Alt Svizzero A',",
      "};",
      "",
    ].join('\n');
    tmpDir = makeFixture({ swissRegistry: registryWithOrphan, swissMeta });
    const { status, output } = runCli(tmpDir);
    expect(status).toBe(1);
    expect(output).toMatch(/svizzera .*swiss-articles-data\.ts.*blog-meta-ch-it\.ts/);
    expect(output).toMatch(/swiss-orphan: missing title, excerpt, imageAlt/);
    // frontaliere section (clean fixture data) must still report OK, not be
    // swallowed by the svizzera failure.
    expect(output).toMatch(/frontaliere: all \d+ registry ids have complete IT meta/);
  });
});
