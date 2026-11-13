/**
 * Contract of the job sitemap generator (jobsSeoPagesPlugin), run end-to-end
 * on a small fixture:
 *
 *  - every job-detail `<url>` carries the listing's real `<lastmod>` (latest of
 *    reported publication date and first observation), never the build date
 *    and never the crawl heartbeat;
 *  - no URL is listed in two sitemap files (sitemap-jobs.xml vs the canton
 *    shards: 22,384 duplicates live on 2026-10-24);
 *  - the nested shard index references exactly the shard files on disk;
 *  - every file respects the sitemaps.org limits (50,000 URLs, 50 MB).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getJobTodayLandingSlug } from '../../build-plugins/jobEditorialLanding';
import { resolveCantonSection } from '../../build-plugins/shared/cantonSection';

const locales = ['it', 'en', 'de', 'fr'] as const;
const todayPath = (locale: (typeof locales)[number], canton: string) =>
  `/${locale === 'it' ? '' : `${locale}/`}${resolveCantonSection(locale, canton)}/${getJobTodayLandingSlug(locale, canton)}/`;
const expiredOwnerSlug = 'expired-owner-split-build';
const expiredOwnerPaths = {
  it: '/cerca-lavoro-argovia/expired-owner-split-build-it/',
  en: '/en/jobs-in-aargau/expired-owner-split-build-en/',
  de: todayPath('de', 'BASILEA'),
  fr: '/fr/trouver-emploi-argovie/expired-owner-split-build-fr/',
} as const;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const description = 'La posizione prevede la collaborazione con il gruppo di lavoro e la gestione delle attività quotidiane. Cerchiamo una persona con esperienza professionale, precisione e capacità organizzative, interessata a crescere in un ambiente qualificato. Offriamo formazione continua, un contratto stabile e condizioni di lavoro trasparenti. Le candidature complete vengono esaminate dal responsabile delle risorse umane.';

type Fixture = { slug: string; canton: string; location: string; dates: Record<string, unknown>; expectedLastmod: string | null };
const reposted = daysAgo(3);
const firstSeenOld = daysAgo(25);
const firstSeenOnly = daysAgo(6);
const fixtures: Fixture[] = [
  // Re-published by the employer after the first observation.
  { slug: 'contabile-reposted-zurigo', canton: 'ZH', location: 'Zürich', expectedLastmod: reposted.slice(0, 10),
    dates: { postingDateSource: 'reported', datePosted: reposted, postedDate: reposted, firstSeenAt: firstSeenOld, crawledAt: daysAgo(0) } },
  // No employer date: the first observation is the only real date.
  { slug: 'magazziniere-first-seen-zurigo', canton: 'ZH', location: 'Zürich', expectedLastmod: firstSeenOnly.slice(0, 10),
    dates: { postingDateSource: 'unknown', firstSeenAt: firstSeenOnly, crawledAt: daysAgo(0) } },
  // Ticino detail: lives in sitemap-jobs.xml, must not be repeated in the TI shard.
  { slug: 'impiegato-lugano', canton: 'TI', location: 'Lugano', expectedLastmod: daysAgo(4).slice(0, 10),
    dates: { postingDateSource: 'reported', datePosted: daysAgo(4), postedDate: daysAgo(4), firstSeenAt: daysAgo(5), crawledAt: daysAgo(0) } },
  // Only a crawl heartbeat: no <lastmod> rather than an invented one.
  { slug: 'operaio-heartbeat-zurigo', canton: 'ZH', location: 'Zürich', expectedLastmod: null,
    dates: { postingDateSource: 'unknown', crawledAt: daysAgo(0) } },
];
const detailJobs = fixtures.map((f, i) => ({
  id: f.slug, slug: f.slug, title: `Posizione ${i}`,
  titleByLocale: { it: `Posizione ${i}`, en: `Position ${i}`, de: `Stelle ${i}`, fr: `Poste ${i}` },
  company: `Contract Example ${i} SA`, companyKey: `contract-example-${i}`, canton: f.canton,
  location: f.location, addressLocality: f.location,
  description, descriptionByLocale: Object.fromEntries(locales.map((l) => [l, description])),
  employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
  url: `https://example.test/careers/${f.slug}/`,
  ...f.dates,
}));
const editorialJobs = Array.from({ length: 5 }, (_, i) => ({
  id: `baden-editorial-${i}`, slug: `baden-editorial-${i}`,
  title: `Specialista amministrativo Baden ${i}`,
  titleByLocale: { it: `Specialista amministrativo Baden ${i}`, en: `Administrative specialist Baden ${i}`, de: `Verwaltungsspezialist Baden ${i}`, fr: `Spécialiste administratif Baden ${i}` },
  company: `Baden Editorial Example ${i} SA`, companyKey: `baden-editorial-example-${i}`,
  canton: 'AG', location: 'Baden', addressLocality: 'Baden',
  description, descriptionByLocale: Object.fromEntries(locales.map((l) => [l, description])),
  employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
  datePosted: daysAgo(1), postedDate: daysAgo(1), crawledAt: daysAgo(1),
}));
const keywordJobs = Array.from({ length: 3 }, (_, i) => ({
  id: `collision-keyword-${i}`,
  slug: i === 0 ? 'ricerca-collision-marker' : `collision-keyword-${i}`,
  title: `Collision marker position ${i}`,
  titleByLocale: { it: `Collision marker posizione ${i}`, en: `Collision marker position ${i}`, de: `Collision marker Stelle ${i}`, fr: `Collision marker poste ${i}` },
  company: `Collision Marker Example ${i} SA`, companyKey: `collision-marker-example-${i}`,
  canton: 'TI', location: 'Lugano', addressLocality: 'Lugano',
  description: `${description} Collision marker.`,
  descriptionByLocale: Object.fromEntries(locales.map((l) => [l, `${description} Collision marker.`])),
  employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
  datePosted: daysAgo(1), postedDate: daysAgo(1), crawledAt: daysAgo(1),
}));
const jobs = [...detailJobs, ...editorialJobs, ...keywordJobs];

// An older record of the same vacancy (same id and slugs): only the most
// recent one may own the URLs, so every locale <loc> must appear exactly once.
const olderDuplicate = { ...detailJobs[0], firstSeenAt: daysAgo(40), datePosted: daysAgo(40), postedDate: daysAgo(40) };

let root: string;
let dist: string;
let monolithicItPageHashes: Map<string, string> | null = null;
let monolithicSitemapJobsBlocks: Array<Omit<UrlBlock, 'file'>> | null = null;
let monolithicExpiredOwnerIndexableLocales: ReadonlySet<(typeof locales)[number]> | null = null;

function snapshotItPages(): Map<string, string> {
  const hashes = new Map<string, string>();
  const visit = (dir: string, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!relative && ['en', 'de', 'fr'].includes(entry.name)) continue;
        visit(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        hashes.set(rel, createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex'));
      }
    }
  };
  visit(dist);
  return hashes;
}

type UrlBlock = { file: string; loc: string; lastmod: string | null; priority: string | null; alternates: string[] };
function sitemapFiles(): string[] {
  return fs.readdirSync(dist).filter((f) => /^sitemap-[a-z0-9-]+\.xml$/.test(f) && f !== 'sitemap-index.xml');
}
function urlBlocks(file: string): UrlBlock[] {
  const xml = fs.readFileSync(path.join(dist, file), 'utf8');
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    file,
    loc: /<loc>([^<]+)<\/loc>/.exec(m[1])?.[1] ?? '',
    lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(m[1])?.[1] ?? null,
    priority: /<priority>([^<]+)<\/priority>/.exec(m[1])?.[1] ?? null,
    alternates: [...m[1].matchAll(/<xhtml:link[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/g)].map((a) => `${a[1]}=${a[2]}`).sort(),
  }));
}

function sitemapJobsSnapshot(): Array<Omit<UrlBlock, 'file'>> {
  return urlBlocks('sitemap-jobs.xml')
    .map(({ loc, lastmod, priority, alternates }) => ({ loc, lastmod, priority, alternates }))
    .sort((a, b) => a.loc.localeCompare(b.loc));
}

async function runGenerator(buildLocale: string | undefined): Promise<void> {
  const previous = process.env.BUILD_LOCALE;
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  try {
    // shouldEmitLocale reads BUILD_LOCALE at module load.
    vi.resetModules();
    const { jobsSeoPagesPlugin } = await import('../../build-plugins/jobsSeoPagesPlugin');
    const { employerProfilePagesPlugin } = await import('../../build-plugins/employerProfilePagesPlugin');
    const { localeJobsSplitPlugin } = await import('../../build-plugins/localeJobsSplitPlugin');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-sitemap-contract-'));
    dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.symlinkSync(path.resolve('scripts'), path.join(root, 'scripts'), 'dir');
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>');
    fs.copyFileSync(path.resolve('data/canton-url-slugs.json'), path.join(root, 'data/canton-url-slugs.json'));
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([...jobs, olderDuplicate]));
    fs.writeFileSync(path.join(root, 'data/all-known-job-slugs.json'), JSON.stringify({
      [expiredOwnerSlug]: expiredOwnerPaths,
    }));
    fs.writeFileSync(path.join(root, 'data/expired-jobs.json'), JSON.stringify([{
      id: expiredOwnerSlug,
      slug: expiredOwnerSlug,
      title: 'Expired owner split-build fixture',
      titleByLocale: { it: 'Annuncio archiviato', en: 'Archived listing', de: 'Archivierte Stelle', fr: 'Offre archivée' },
      company: 'Expired Owner Example AG',
      canton: 'AG',
      location: 'Baden',
      expiredAt: daysAgo(1),
      description,
      descriptionByLocale: Object.fromEntries(locales.map((locale) => [locale, description])),
    }]));
    fs.writeFileSync(path.join(root, 'data/keyword-pages-config.json'), JSON.stringify({
      pages: [{
        slug: 'collision-marker',
        query: 'collision marker',
        filterKeywords: ['collision'],
        copy: { it: { title: 'Offerte collision marker', heading: 'Offerte collision marker' } },
      }],
    }));
    await (employerProfilePagesPlugin(root).closeBundle as () => Promise<void>)();
    (localeJobsSplitPlugin(root).closeBundle as () => void)();
    await (jobsSeoPagesPlugin(root).closeBundle as () => Promise<void>)();
  } finally {
    if (previous === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = previous;
  }
}

// `undefined` = monolithic build (all locales); 'it' = the production IT leg,
// which renders only IT pages but writes the sitemaps for all four locales.
describe.each([undefined, 'it'] as const)('job sitemap generator contract (BUILD_LOCALE=%s)', (buildLocale) => {
  beforeAll(async () => {
    await runGenerator(buildLocale);
    if (buildLocale === undefined) {
      monolithicItPageHashes = snapshotItPages();
      monolithicSitemapJobsBlocks = sitemapJobsSnapshot();
      monolithicExpiredOwnerIndexableLocales = new Set(locales.filter((locale) => {
        const file = path.join(dist, expiredOwnerPaths[locale].slice(1), 'index.html');
        if (!fs.existsSync(file)) return false;
        return !/name=["']?robots["']? content=["']?noindex,follow/.test(fs.readFileSync(file, 'utf8'));
      }));
    }
  }, 300_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); }, 120_000);

  it('gives every job detail the listing date as <lastmod>, never the crawl heartbeat', () => {
    const blocks = sitemapFiles().filter((f) => f.startsWith('sitemap-jobs')).flatMap(urlBlocks);
    for (const fixture of fixtures) {
      const itBlock = blocks.filter((b) => b.loc.endsWith(`/${fixture.slug}/`));
      expect(itBlock.length, fixture.slug).toBeGreaterThan(0);
      for (const block of itBlock) expect(block.lastmod, `${block.file} ${block.loc}`).toBe(fixture.expectedLastmod);
    }
  });

  it('lists the EN/DE/FR variants in per-locale canton shards with the same hreflang group and lastmod', () => {
    const blocks = sitemapFiles().filter((f) => f.startsWith('sitemap-jobs')).flatMap(urlBlocks);
    const byLoc = new Map(blocks.map((b) => [b.loc, b]));
    for (const fixture of fixtures) {
      const itBlock = blocks.find((b) => b.file === 'sitemap-jobs.xml' && b.loc.endsWith(`/${fixture.slug}/`));
      expect(itBlock, fixture.slug).toBeTruthy();
      const variants = itBlock!.alternates
        .map((a) => a.split('=') as [string, string])
        .filter(([lang]) => lang !== 'it' && lang !== 'x-default');
      expect(variants.map(([lang]) => lang).sort(), fixture.slug).toEqual(['de', 'en', 'fr']);
      for (const [lang, href] of variants) {
        const variant = byLoc.get(href);
        expect(variant, `${fixture.slug} ${lang}`).toBeTruthy();
        expect(variant!.file).toMatch(new RegExp(`^sitemap-jobs-[a-z0-9-]+-${lang}\\.xml$`));
        expect(variant!.lastmod).toBe(fixture.expectedLastmod);
        expect(variant!.alternates).toEqual(itBlock!.alternates);
      }
    }
  });

  it('keeps sibling-locale company hubs in the IT-owned sitemap when their files live in other shards', () => {
    const blocks = sitemapFiles().flatMap(urlBlocks);
    const companyHubBlocks = blocks.filter((block) =>
      block.file === 'sitemap-jobs.xml'
      && block.loc.includes('contract-example-2')
      && block.alternates.length === 5,
    );
    const locales = companyHubBlocks.map(({ loc }) => {
      const pathname = new URL(loc).pathname;
      return /^\/en\//.test(pathname) ? 'en'
        : /^\/de\//.test(pathname) ? 'de'
          : /^\/fr\//.test(pathname) ? 'fr' : 'it';
    }).sort();

    expect(locales).toEqual(['de', 'en', 'fr', 'it']);
  });

  it('keeps reciprocal city and editorial entries when the IT sitemap build has no sibling pages', () => {
    if (buildLocale !== 'it') return;
    const blocks = sitemapFiles()
      .filter((file) => file.startsWith('sitemap-jobs'))
      .flatMap(urlBlocks);
    const cityPaths = {
      it: '/cerca-lavoro-argovia/baden/',
      en: '/en/find-jobs-aargau/baden/',
      de: '/de/jobs-im-aargau/baden/',
      fr: '/fr/trouver-emploi-argovie/baden/',
    };
    const cityGroup = blocks.filter(({ loc }) => Object.values(cityPaths).some((route) => loc.endsWith(route)));
    expect(cityGroup.map(({ loc }) => loc).sort()).toEqual(
      Object.values(cityPaths).map((route) => `https://frontaliereticino.ch${route}`).sort(),
    );
    const expectedCityAlternates = [
      ...Object.entries(cityPaths).map(([locale, route]) => `${locale}=https://frontaliereticino.ch${route}`),
      `x-default=https://frontaliereticino.ch${cityPaths.it}`,
    ].sort();
    const cityFiles = {
      it: 'sitemap-jobs.xml',
      en: 'sitemap-jobs-argovia-en.xml',
      de: 'sitemap-jobs-argovia-de.xml',
      fr: 'sitemap-jobs-argovia-fr.xml',
    };
    for (const block of cityGroup) {
      expect(block.alternates).toEqual(expectedCityAlternates);
      expect(block.priority).toBe('0.85');
      const locale = Object.entries(cityPaths).find(([, route]) => block.loc.endsWith(route))?.[0] as keyof typeof cityFiles;
      expect(block.file).toBe(cityFiles[locale]);
    }
    for (const locale of ['en', 'de', 'fr'] as const) {
      expect(fs.existsSync(path.join(dist, cityPaths[locale].slice(1), 'index.html'))).toBe(false);
    }

    const todayRoutes = Object.fromEntries(locales.map((locale) => [
      locale,
      `https://frontaliereticino.ch${todayPath(locale, 'AG')}`,
    ])) as Record<(typeof locales)[number], string>;
    const todayGroup = blocks.filter(({ loc }) => Object.values(todayRoutes).includes(loc));
    expect(todayGroup.map(({ loc }) => loc).sort()).toEqual(Object.values(todayRoutes).sort());
    for (const block of todayGroup) expect(block.alternates).toEqual([
      ...Object.entries(todayRoutes).map(([locale, href]) => `${locale}=${href}`),
      `x-default=${todayRoutes.it}`,
    ].sort());
    for (const block of todayGroup) expect(block.file).toBe('sitemap-jobs.xml');
    for (const locale of ['en', 'de', 'fr'] as const) {
      expect(fs.existsSync(path.join(dist, todayPath(locale, 'AG').slice(1), 'index.html'))).toBe(false);
    }

    const belowFloorPaths = Object.fromEntries(locales.map((locale) => [locale, todayPath(locale, 'BASILEA')])) as Record<(typeof locales)[number], string>;
    for (const locale of locales) {
      const belowFloorPath = belowFloorPaths[locale];
      const belowFloorFile = path.join(dist, belowFloorPath.slice(1), 'index.html');
      expect(blocks.some(({ loc }) => loc.endsWith(belowFloorPath)), locale).toBe(false);
      if (buildLocale === undefined || locale === 'it') {
        expect(fs.readFileSync(belowFloorFile, 'utf8')).toMatch(/name=["']?robots["']? content=["']?noindex,follow["']?/);
      } else {
        expect(fs.existsSync(belowFloorFile), locale).toBe(false);
      }
    }

    const allBlocks = sitemapFiles().flatMap(urlBlocks);
    expect(monolithicExpiredOwnerIndexableLocales).not.toBeNull();
    for (const locale of locales) {
      expect(allBlocks.some(({ loc }) => loc.endsWith(expiredOwnerPaths[locale])), locale)
        .toBe(monolithicExpiredOwnerIndexableLocales!.has(locale));
    }

    const keywordLocs = blocks.filter(({ loc }) => /\/(?:search|suche|recherche)-collision-marker\/$/.test(new URL(loc).pathname));
    expect(keywordLocs.map(({ loc }) => new URL(loc).pathname.split('/')[1]).sort()).toEqual(['de', 'en', 'fr']);
    expect(keywordLocs.every(({ alternates }) => alternates.map((alt) => alt.split('=')[0]).sort().join(',') === 'de,en,fr')).toBe(true);
    expect(blocks.some(({ loc }) => loc.endsWith('/cerca-lavoro-ticino/ricerca-collision-marker/'))).toBe(true);

    expect(monolithicItPageHashes).not.toBeNull();
    expect(snapshotItPages()).toEqual(monolithicItPageHashes);
    expect(monolithicSitemapJobsBlocks).not.toBeNull();
    expect(sitemapJobsSnapshot()).toEqual(monolithicSitemapJobsBlocks);
  });

  it('never writes the build date as a <url> lastmod', () => {
    const today = new Date().toISOString().slice(0, 10);
    const stamped = sitemapFiles().flatMap(urlBlocks).filter((b) => b.lastmod?.slice(0, 10) === today);
    expect(stamped.map((b) => `${b.file} ${b.loc}`)).toEqual([]);
  });

  it('lists every URL exactly once across all sitemap files', () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const file of sitemapFiles()) {
      for (const { loc } of urlBlocks(file)) {
        const previous = owner.get(loc);
        if (previous) duplicates.push(`${loc} in ${previous} and ${file}`);
        else owner.set(loc, file);
      }
    }
    expect(duplicates).toEqual([]);
    // The IT job details stay in sitemap-jobs.xml, the file the cache-hit
    // allowlist is rebuilt from.
    for (const fixture of fixtures) {
      const it = [...owner.entries()].find(([loc]) => !/\/(en|de|fr)\//.test(loc) && loc.endsWith(`/${fixture.slug}/`));
      expect(it?.[1], fixture.slug).toBe('sitemap-jobs.xml');
    }
  });

  it('keeps the nested shard index coherent with the files on disk', () => {
    const shards = sitemapFiles().filter((f) => /^sitemap-jobs-[a-z0-9-]+\.xml$/.test(f) && f !== 'sitemap-jobs-expired.xml');
    const indexXml = fs.readFileSync(path.join(dist, 'sitemap-index.xml'), 'utf8');
    const referenced = [...indexXml.matchAll(/<loc>[^<]*\/(sitemap-[^<]+\.xml)<\/loc>/g)].map((m) => m[1]).sort();
    expect(referenced).toEqual([...shards].sort());
    for (const file of shards) expect(urlBlocks(file).length, file).toBeGreaterThan(0);
  });

  it('respects the 50,000 URL / 50 MB per-file limits', () => {
    for (const file of sitemapFiles()) {
      expect(urlBlocks(file).length, file).toBeLessThanOrEqual(50_000);
      expect(fs.statSync(path.join(dist, file)).size, file).toBeLessThanOrEqual(50 * 1024 * 1024);
    }
  });
});
