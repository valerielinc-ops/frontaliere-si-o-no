import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keywordLandingPath } from '../scripts/lib/keyword-page-paths.mjs';

/**
 * Coverage gate for scripts/audit-keyword-landing-coverage.mjs (issue #5655
 * item 2). Builds a tmp dist/ + tmp keyword-pages-config.json so the check
 * runs against a real (tiny) filesystem instead of the production dist/,
 * matching the fixture pattern already used by
 * tests/audit-orphan-pages.test.ts.
 *
 * Dynamic import via file:// URL so the script's `main()` (guarded by an
 * `argv[1]` check) never runs — only the exported `__test` bundle is
 * exercised.
 */
const SCRIPT_PATH = join(process.cwd(), 'scripts/audit-keyword-landing-coverage.mjs');
const SCRIPT_URL_HREF = pathToFileURL(SCRIPT_PATH).href;

interface AuditExports {
  hasNoindex: (html: string) => boolean;
  extractCanonical: (html: string) => string | null;
  normalizeUrl: (u: string) => string;
  loadConfigSlugs: (configPath: string) => string[];
  candidatePaths: (slugs: string[]) => Array<{ slug: string; locale: string; path: string }>;
  loadSitemapPaths: (distRoot: string, sitemapFile?: string) => Set<string>;
  auditKeywordLandingCoverage: (opts: { distRoot: string; configPath: string; sitemapFile?: string }) => {
    candidateCount: number;
    checked: number;
    sitemappedNotGenuine: Array<{ slug: string; locale: string; path: string; reason: string }>;
    emittedNotSitemapped: Array<{ slug: string; locale: string; path: string }>;
  };
}

async function loadHelpers(): Promise<AuditExports> {
  const mod = (await import(SCRIPT_URL_HREF)) as { __test: AuditExports };
  return mod.__test;
}

const HOST = 'https://frontaliereticino.ch';
const SITEMAP_FILE = 'sitemap-jobs.xml';

function sitemapXml(locs: string[]): string {
  const urls = locs
    .map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function genuinePageHtml(canonicalUrl: string): string {
  return (
    `<html><head><link rel="canonical" href="${canonicalUrl}">` +
    `</head><body><h1>Keyword landing</h1></body></html>`
  );
}

function noindexBridgeHtml(canonicalUrl: string): string {
  return (
    `<html><head><meta name="robots" content="noindex,follow">` +
    `<link rel="canonical" href="${canonicalUrl}">` +
    `</head><body><p>Versione canonica disponibile altrove.</p></body></html>`
  );
}

function nonSelfCanonicalMirrorHtml(otherCanonicalUrl: string): string {
  return (
    `<html><head><link rel="canonical" href="${otherCanonicalUrl}">` +
    `</head><body><h1>Mirror page</h1></body></html>`
  );
}

async function writePage(distRoot: string, urlPath: string, html: string) {
  const rel = urlPath.replace(/^\/+/, '');
  const dir = join(distRoot, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), html, 'utf8');
}

async function writeConfig(configPath: string, slugs: string[]) {
  await writeFile(
    configPath,
    JSON.stringify({ pages: slugs.map((slug) => ({ slug })) }, null, 2),
    'utf8',
  );
}

describe('audit-keyword-landing-coverage: dist/ coverage for the GSC keyword-landing family', () => {
  let tmpDir: string;
  let distRoot: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kw-landing-coverage-'));
    distRoot = join(tmpDir, 'dist');
    configPath = join(tmpDir, 'keyword-pages-config.json');
    await mkdir(distRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('passes when the sitemap entry resolves to a genuine, self-canonical, indexable page', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'medico-ticino';
    const path = keywordLandingPath(slug, 'it');
    await writeConfig(configPath, [slug]);
    await writePage(distRoot, path, genuinePageHtml(HOST + path));
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([HOST + path]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(0);
    expect(result.emittedNotSitemapped).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it('THE HISTORICAL BUG (PR #5623): flags a sitemap entry answered by a noindex bridge', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'pittore-imbianchino-ticino';
    const path = keywordLandingPath(slug, 'it');
    await writeConfig(configPath, [slug]);
    // The bridge canonicalizes elsewhere AND is noindex — exactly the shape
    // named in the plugin's own doc comment for a URL this family never wrote.
    await writePage(distRoot, path, noindexBridgeHtml(HOST + '/cerca-lavoro-svizzera/ricerca-' + slug + '/'));
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([HOST + path]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(1);
    expect(result.sitemappedNotGenuine[0]).toMatchObject({ slug, locale: 'it', reason: 'noindex' });
  });

  it('flags a sitemap entry answered by a non-self-canonical mirror (no noindex)', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'infermiera-ticino';
    const path = keywordLandingPath(slug, 'it');
    const mirrorTarget = HOST + '/cerca-lavoro-svizzera/ricerca-' + slug + '/';
    await writeConfig(configPath, [slug]);
    await writePage(distRoot, path, nonSelfCanonicalMirrorHtml(mirrorTarget));
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([HOST + path]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(1);
    expect(result.sitemappedNotGenuine[0].reason).toMatch(/^canonical-mismatch:/);
  });

  it('flags a sitemap entry with no corresponding dist/ file at all', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'giardiniere-ticino';
    const path = keywordLandingPath(slug, 'it');
    await writeConfig(configPath, [slug]);
    // No writePage() call — the sitemap advertises a URL nothing built.
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([HOST + path]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(1);
    expect(result.sitemappedNotGenuine[0].reason).toBe('missing-html');
  });

  it('reports (non-blocking) a genuine page missing from the sitemap, without failing the gate', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'elettricista-ticino';
    const path = keywordLandingPath(slug, 'it');
    await writeConfig(configPath, [slug]);
    await writePage(distRoot, path, genuinePageHtml(HOST + path));
    // Sitemap is empty — the page was written but never advertised.
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(0); // does not block
    expect(result.emittedNotSitemapped).toHaveLength(1);
    expect(result.emittedNotSitemapped[0]).toMatchObject({ slug, locale: 'it' });
  });

  it('ignores a candidate that is neither built nor sitemapped', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'never-built-ticino';
    await writeConfig(configPath, [slug]);
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(0);
    expect(result.emittedNotSitemapped).toHaveLength(0);
    expect(result.checked).toBe(0);
  });

  it('checks all four locales per slug (it/en/de/fr), each with its own genuine/sitemap state', async () => {
    const { auditKeywordLandingCoverage } = await loadHelpers();
    const slug = 'infermiere-ticino';
    await writeConfig(configPath, [slug]);

    const itPath = keywordLandingPath(slug, 'it');
    const enPath = keywordLandingPath(slug, 'en');
    // IT: genuine + sitemapped → OK.
    await writePage(distRoot, itPath, genuinePageHtml(HOST + itPath));
    // EN: bridge (noindex) + sitemapped → offender.
    await writePage(distRoot, enPath, noindexBridgeHtml(HOST + '/en/somewhere-else/'));
    await writeFile(join(distRoot, SITEMAP_FILE), sitemapXml([HOST + itPath, HOST + enPath]), 'utf8');

    const result = auditKeywordLandingCoverage({ distRoot, configPath });
    expect(result.sitemappedNotGenuine).toHaveLength(1);
    expect(result.sitemappedNotGenuine[0].locale).toBe('en');
  });
});
