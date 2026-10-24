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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobsSeoPagesPlugin } from '../../build-plugins/jobsSeoPagesPlugin';
import { employerProfilePagesPlugin } from '../../build-plugins/employerProfilePagesPlugin';
import { localeJobsSplitPlugin } from '../../build-plugins/localeJobsSplitPlugin';

const locales = ['it', 'en', 'de', 'fr'] as const;
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
const jobs = fixtures.map((f, i) => ({
  id: f.slug, slug: f.slug, title: `Posizione ${i}`,
  titleByLocale: { it: `Posizione ${i}`, en: `Position ${i}`, de: `Stelle ${i}`, fr: `Poste ${i}` },
  company: `Contract Example ${i} SA`, companyKey: `contract-example-${i}`, canton: f.canton,
  location: f.location, addressLocality: f.location,
  description, descriptionByLocale: Object.fromEntries(locales.map((l) => [l, description])),
  employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
  url: `https://example.test/careers/${f.slug}/`,
  ...f.dates,
}));

let root: string;
let dist: string;

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

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-sitemap-contract-'));
  dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.symlinkSync(path.resolve('scripts'), path.join(root, 'scripts'), 'dir');
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>');
  fs.copyFileSync(path.resolve('data/canton-url-slugs.json'), path.join(root, 'data/canton-url-slugs.json'));
  fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(jobs));
  await (employerProfilePagesPlugin(root).closeBundle as () => Promise<void>)();
  (localeJobsSplitPlugin(root).closeBundle as () => void)();
  await (jobsSeoPagesPlugin(root).closeBundle as () => Promise<void>)();
}, 300_000);

afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('job sitemap generator contract', () => {
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

  it('never writes the build date as a <url> lastmod', () => {
    const today = new Date().toISOString().slice(0, 10);
    const stamped = sitemapFiles().flatMap(urlBlocks).filter((b) => b.lastmod?.slice(0, 10) === today);
    expect(stamped.map((b) => `${b.file} ${b.loc}`)).toEqual([]);
  });

  it('lists every URL in exactly one sitemap file', () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const file of sitemapFiles()) {
      for (const { loc } of urlBlocks(file)) {
        const previous = owner.get(loc);
        if (previous && previous !== file) duplicates.push(`${loc} in ${previous} and ${file}`);
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
