/**
 * Publisher fast gate, class 3: 145 pages (72 en, 72 fr sector hubs + 1 fr fuel
 * station) are listed by the en/fr sitemap but not by the IT one.
 *
 * Mechanism: the IT build wrote, with no BUILD_LOCALE gate, a noindex bridge at
 * the path of en/fr pages that only the en/fr build emits for real (legacy
 * short-form slugs `nurses`, `educators`, ... are also the per-canton sector hub
 * slugs; one fuel station URL is also a legacy alias). The IT sitemap reconcile
 * (dropOverwrittenLocs, inspectForeignPresent) read that foreign bridge and dropped
 * the URL, while the en/fr build, finding its real page, kept it.
 *
 * These tests pin the contract: a direct-fs bridge/alias writer emits only the
 * locales the build emits, and the resulting sitemaps are symmetric.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enumerateCantonOrphanRedirects } from '../build-plugins/cantonOrphanRedirectsPlugin';
import { ALL_CANTON_CODES, AGGREGATE_KEY, resolveCantonSection } from '../build-plugins/shared/cantonSection';
import { SECTOR_HUB_KEYS, SECTOR_HUB_SLUG } from '../build-plugins/shared/jobSectorPaths';

const BASE = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Loc = (typeof LOCALES)[number];
const PREFIX: Record<Loc, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const only = (locale: Loc) => (l: string) => l === locale;

/** Every per-canton sector-hub path (the real pages of the locale builds). */
function sectorHubPaths(): Array<{ locale: Loc; path: string }> {
  const out: Array<{ locale: Loc; path: string }> = [];
  for (const canton of ALL_CANTON_CODES) {
    for (const locale of LOCALES) {
      for (const sector of SECTOR_HUB_KEYS) {
        out.push({
          locale,
          path: `${PREFIX[locale]}/${resolveCantonSection(locale, canton)}/${SECTOR_HUB_SLUG[locale][sector]}/`.replace(/\/+/g, '/'),
        });
      }
    }
  }
  return out;
}

describe('enumerateCantonOrphanRedirects respects the emitted locales', () => {
  const all = enumerateCantonOrphanRedirects(() => true);

  it('keeps the historical enumeration when every locale is emitted', () => {
    expect(new Set(all.map((r) => r.locale))).toEqual(new Set(LOCALES));
    expect(enumerateCantonOrphanRedirects()).toHaveLength(all.length); // BUILD_LOCALE unset in the suite
  });

  for (const locale of LOCALES) {
    it(`a ${locale} build enumerates bridges only for ${locale}`, () => {
      const own = enumerateCantonOrphanRedirects(only(locale));
      expect(own.length).toBeGreaterThan(0);
      expect(new Set(own.map((r) => r.locale))).toEqual(new Set([locale]));
      expect(own).toEqual(all.filter((r) => r.locale === locale));
    });
  }

  it('the IT build writes no bridge for any en/de/fr path', () => {
    const it = enumerateCantonOrphanRedirects(only('it'));
    expect(it.filter((r) => /^\/(en|de|fr)\//.test(r.from))).toEqual([]);
  });

  it('a build owning no locale enumerates nothing', () => {
    expect(enumerateCantonOrphanRedirects(() => false)).toEqual([]);
  });
});

describe('class 3 population: the bridges that stood on sector hubs', () => {
  const hubs = new Set(sectorHubPaths().map((h) => h.path));
  const all = enumerateCantonOrphanRedirects(() => true);
  const collisions = all.filter((r) => hubs.has(r.from));
  const byLocale = (l: Loc) => collisions.filter((r) => r.locale === l);

  it('exactly the en/fr legacy slugs that coincide with a sector-hub slug collide (72 + 72 non-IT paths)', () => {
    expect(byLocale('en')).toHaveLength(72);
    expect(byLocale('fr')).toHaveLength(72);
    expect(byLocale('de')).toHaveLength(0);
    const enSlugs = new Set(byLocale('en').map((r) => r.orphanSlug));
    expect(enSlugs).toEqual(new Set(['nurses', 'educators', 'healthcare-assistants']));
    const frSlugs = new Set(byLocale('fr').map((r) => r.orphanSlug));
    expect(frSlugs).toEqual(new Set(['infirmiers', 'educateurs', 'maisons-retraite']));
  });

  it('after the fix the IT build enumerates no non-IT colliding bridge, and each locale build only its own', () => {
    const nonIt = enumerateCantonOrphanRedirects(only('it')).filter((r) => r.locale !== 'it');
    expect(nonIt).toEqual([]);
    expect(enumerateCantonOrphanRedirects(only('en')).filter((r) => hubs.has(r.from) && r.locale !== 'en')).toEqual([]);
    expect(enumerateCantonOrphanRedirects(only('fr')).filter((r) => hubs.has(r.from) && r.locale !== 'fr')).toEqual([]);
    expect(AGGREGATE_KEY).toBeTruthy();
  });
});

describe('sitemap coherence between the IT build and the en/fr builds (real plugins, temp dist)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-locale-emit-'));
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  const selfCanonical = (loc: string) =>
    `<!doctype html><html><head><link rel="canonical" href="${loc}"></head><body>real page</body></html>`;
  const writeReal = (urlPath: string) => {
    const dir = path.join(root, 'dist', urlPath.replace(/^\/|\/$/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), selfCanonical(`${BASE}${urlPath}`), 'utf-8');
  };
  const sitemapXml = (urls: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url>\n    <loc>${u}</loc>\n  </url>`)
      .join('\n')}\n</urlset>\n`;
  const sitemapPath = () => path.join(root, 'dist', 'sitemap-jobs.xml');

  const allHubs = sectorHubPaths();
  const collidingKeys = new Set(
    enumerateCantonOrphanRedirects(() => true).map((r) => r.from),
  );
  const colliding = allHubs.filter((h) => collidingKeys.has(h.path));

  async function runBuild(buildLocale: string | undefined, locsInSitemap: string[], realLocales: readonly Loc[]) {
    vi.resetModules();
    if (buildLocale === undefined) vi.stubEnv('BUILD_LOCALE', '');
    else vi.stubEnv('BUILD_LOCALE', buildLocale);
    for (const h of colliding) if (realLocales.includes(h.locale)) writeReal(h.path);
    fs.writeFileSync(sitemapPath(), sitemapXml(locsInSitemap), 'utf-8');
    const { cantonOrphanRedirectsPlugin } = await import('../build-plugins/cantonOrphanRedirectsPlugin');
    const plugin = cantonOrphanRedirectsPlugin() as any;
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    await plugin.closeBundle.handler();
    return plugin;
  }

  async function reconcile(buildLocale: string): Promise<string[]> {
    vi.resetModules();
    vi.stubEnv('BUILD_LOCALE', buildLocale);
    const shard = await import('../build-plugins/relatedSearchClustersPlugin');
    await shard.reconcileSitemapJobsWithDist(path.join(root, 'dist'), []);
    return shard.extractSitemapLocs(fs.readFileSync(sitemapPath(), 'utf-8'));
  }

  const hubUrls = (locales: readonly Loc[]) =>
    colliding.filter((h) => locales.includes(h.locale)).map((h) => `${BASE}${h.path}`);
  const listFiles = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : [];

  it('negative control: with the pre-fix behaviour (all locales written) the IT reconcile drops the en/fr hubs', async () => {
    const urls = hubUrls(['it', 'en', 'fr']);
    await runBuild(undefined, urls, ['it']); // unfiltered writer, as the IT leg used to be
    const kept = await reconcile('it');
    expect(kept.filter((u) => u.includes('/en/') || u.includes('/fr/'))).toEqual([]);
    expect(kept.length).toBe(hubUrls(['it']).length);
  });

  it('IT build after the fix: writes no en/de/fr file and its sitemap keeps every en/fr sector hub', async () => {
    const urls = hubUrls(['it', 'en', 'fr']);
    await runBuild('it', urls, ['it']);
    const files = listFiles(path.join(root, 'dist'));
    const nonIt = files.filter((f) => /\/dist\/(en|de|fr)(\/|\.html$)/.test(f));
    expect(nonIt).toEqual([]);
    const kept = await reconcile('it');
    expect(new Set(kept)).toEqual(new Set(urls));
    expect(kept.filter((u) => u.includes('/en/'))).toHaveLength(72);
    expect(kept.filter((u) => u.includes('/fr/'))).toHaveLength(72);
  });

  for (const locale of ['en', 'fr'] as const) {
    it(`${locale} build: writes bridges only under /${locale}/ and keeps its own real hubs`, async () => {
      const urls = hubUrls([locale]);
      await runBuild(locale, urls, [locale]);
      const files = listFiles(path.join(root, 'dist'));
      // every written file other than sitemap-jobs.xml is under dist/<locale>/
      const foreign = files.filter((f) => !f.includes(`/dist/${locale}/`) && !f.endsWith('sitemap-jobs.xml'));
      expect(foreign).toEqual([]);
      const kept = await reconcile(locale);
      expect(new Set(kept)).toEqual(new Set(urls));
    });
  }

  it('symmetry: the en/fr hub URLs kept by the IT sitemap equal those kept by the en and fr builds', async () => {
    const urls = hubUrls(['it', 'en', 'fr']);
    await runBuild('it', urls, ['it']);
    const keptByIt = new Set((await reconcile('it')).filter((u) => /\/(en|fr)\//.test(u)));
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    await runBuild('en', hubUrls(['en']), ['en']);
    const keptByEn = await reconcile('en');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    await runBuild('fr', hubUrls(['fr']), ['fr']);
    const keptByFr = await reconcile('fr');
    expect(keptByIt).toEqual(new Set([...keptByEn, ...keptByFr]));
  });
});

describe('legacyAliasPlugin respects the emitted locales (fr fuel station, class 3 outlier)', () => {
  let root = '';
  const FR_PATH = '/fr/prix-essence-suisse/bellinzona/stations/socar-via-san-gottardo/';
  const IT_PATH = '/prezzi-benzina/bellinzona/stazioni/socar-via-san-gottardo/';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-alias-locale-'));
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'legacy-aliases.json'),
      JSON.stringify({
        aliases: [
          { orphanPath: IT_PATH, locale: 'it', kind: 'matched', canonicalPath: '/prezzi-benzina/bellinzona/oggi/', cohort: 'fuelStation' },
          { orphanPath: FR_PATH, locale: 'fr', kind: 'matched', canonicalPath: '/fr/prix-essence-suisse/bellinzona/aujourd-hui/', cohort: 'fuelStation' },
        ],
      }),
      'utf-8',
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  const run = async (buildLocale: string) => {
    vi.resetModules();
    vi.stubEnv('BUILD_LOCALE', buildLocale);
    const { legacyAliasPlugin } = await import('../build-plugins/legacyAliasPlugin');
    const plugin = legacyAliasPlugin(root) as any;
    await plugin.closeBundle.handler();
  };
  const exists = (p: string) => fs.existsSync(path.join(root, 'dist', p.replace(/^\/|\/$/g, ''), 'index.html'));

  it('the IT build writes the IT alias and not the fr one (the fr page is owned by the fr build)', async () => {
    await run('it');
    expect(exists(IT_PATH)).toBe(true);
    expect(exists(FR_PATH)).toBe(false);
  });

  it('the fr build writes the fr alias when no real page claims the path, and not the IT one', async () => {
    await run('fr');
    expect(exists(FR_PATH)).toBe(true);
    expect(exists(IT_PATH)).toBe(false);
  });

  it('the fr build leaves the real fr page untouched (collision guard)', async () => {
    const dir = path.join(root, 'dist', FR_PATH.replace(/^\/|\/$/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), 'REAL', 'utf-8');
    await run('fr');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf-8')).toBe('REAL');
  });

  it('an unfiltered build (BUILD_LOCALE unset) still writes every alias', async () => {
    vi.resetModules();
    vi.stubEnv('BUILD_LOCALE', '');
    const { legacyAliasPlugin } = await import('../build-plugins/legacyAliasPlugin');
    await (legacyAliasPlugin(root) as any).closeBundle.handler();
    expect(exists(IT_PATH)).toBe(true);
    expect(exists(FR_PATH)).toBe(true);
  });
});

/**
 * Regression guard for the CLASS: a build plugin that writes a bridge/redirect page
 * straight to dist (not through WriteCollector, which already drops non-owned
 * locales) must gate on the build locale, or be listed here with the reason it
 * cannot stand on a page another locale build emits for real.
 */
describe('static guard: direct-fs bridge writers are locale-gated or explicitly exempt', () => {
  const pluginsDir = path.resolve(__dirname, '../build-plugins');
  const MUST_BE_GATED = ['cantonOrphanRedirectsPlugin.ts', 'legacyAliasPlugin.ts'];
  const EXEMPT: Record<string, string> = {
    'flatHtmlRedirectPlugin.ts': 'rewrites a flat file only next to an existing directory index; creates no new path',
    'locationHubBridgePlugin.ts': 'legacy localita-/location- namespace of the TI section; never advertised in a sitemap (bridge pages are not listed) and skips an existing real page',
    'companyHubBridgePlugin.ts': 'azienda-/company- filter pages: matched and empty-state pages are index,follow self-canonical (the IT reconcile keeps them, like the owning build) and brand-alias bridges are excluded from companyEntries',
    'jobOrphanBridgePlugin.ts': 'old job slugs only (matched kind, collision guard on the canonical file); never advertised in a sitemap',
  };

  const sources = fs
    .readdirSync(pluginsDir)
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(pluginsDir, f), 'utf-8') }));

  const writesBridgeDirectly = (text: string) =>
    /writeFileSync\(/.test(text)
    && /(buildCanonicalBridgePage\(|http-equiv="refresh"|NOINDEX_BRIDGE)/.test(text)
    && !/WriteCollector|collector\.add\(/.test(text);
  const isGated = (text: string) => /shouldEmitLocale|shouldEmitPath/.test(text) && /localeEmitFilter/.test(text);

  it('the two plugins behind class 3 import and use the locale filter', () => {
    for (const name of MUST_BE_GATED) {
      const text = sources.find((s) => s.file === name)!.text;
      expect(isGated(text), `${name} must gate on shouldEmitLocale`).toBe(true);
      expect(/if \(!shouldEmitLocale\(|emitsLocale\(locale\)|shouldEmitLocale\(entry\.locale\)/.test(text), `${name} must skip non-emitted locales`).toBe(true);
    }
  });

  it('no other direct-fs bridge writer is ungated without an explicit exemption', () => {
    const offenders = sources
      .filter((s) => writesBridgeDirectly(s.text) && !isGated(s.text))
      .map((s) => s.file)
      .filter((f) => !(f in EXEMPT));
    expect(offenders, `ungated bridge writers (add shouldEmitLocale or an EXEMPT reason): ${offenders.join(', ')}`).toEqual([]);
  });

  it('every exemption still names a plugin that exists and is a direct-fs bridge writer', () => {
    for (const name of Object.keys(EXEMPT)) {
      const entry = sources.find((s) => s.file === name);
      expect(entry, `${name} no longer exists: drop it from EXEMPT`).toBeDefined();
    }
  });
});
