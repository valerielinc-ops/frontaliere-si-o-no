import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { emitSeoHubs } from '../../build-plugins/seoHubsPlugin';
import { COMPANIES_PAGE_SIZE, HUB_LOCALES, HUB_SLUGS, JOBS_PAGE_SIZE,
  PAGINATION_INDEX_THRESHOLD, paginatedPath, paginationIndexPath, paginationIndexCount } from '../../build-plugins/seoHubsData';
import { COMPANY_ROUTE_PREFIX, legacyTiSectionRoot } from '../../build-plugins/shared/cantonSection';
import { BASE_URL, countHtmlBodyWords, MIN_INDEXABLE_WORDS } from '../../build-plugins/constants';
import { writeAllKnownJobSlugs } from '../../scripts/lib/all-known-job-slugs-store.mjs';
import { PAGINATION_NOINDEX_FROM_PAGE } from '../../build-plugins/shared/paginationIndexPolicy';

let root = '';
let dist: string;
let xml: string;
const companies = Array.from({ length: COMPANIES_PAGE_SIZE * 3 + 47 }, (_, i) => `company-fixture-${String(i).padStart(4, '0')}`);
const read = (url: string) => fs.readFileSync(path.join(dist, url.slice(1), 'index.html'), 'utf8');

function writeEmittedCompanyPages(distDir: string, slugs: readonly string[]): void {
  for (const locale of HUB_LOCALES) {
    for (const slug of slugs) {
      const url = `${legacyTiSectionRoot(locale)}/${COMPANY_ROUTE_PREFIX[locale]}-${slug}/`;
      const file = path.join(distDir, url.slice(1), 'index.html');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<!doctype html><title>Company fixture</title>');
    }
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-archive-pagination-'));
  dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services'));
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, 'data/jobs.json'), '[]');
  fs.writeFileSync(path.join(root, 'data/known-company-slugs.json'), JSON.stringify(companies));
  writeEmittedCompanyPages(dist, companies);
  fs.writeFileSync(path.join(root, 'services/jobDataNormalization.ts'), 'export const CRAWLED_COMPANY_LOGOS = {};');
  const jobs = Object.fromEntries(Array.from({ length: JOBS_PAGE_SIZE * 2 + 1 }, (_, i) => {
    const slug = `archive-job-fixture-${i}`;
    const paths = Object.fromEntries(HUB_LOCALES.map(locale => {
      const url = `${legacyTiSectionRoot(locale)}/${slug}/`;
      const file = path.join(dist, url.slice(1), 'index.html');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<!doctype html><title>Historical job fixture</title>');
      return [locale, url];
    }));
    return [slug, paths];
  }));
  writeAllKnownJobSlugs(jobs, root);
  emitSeoHubs({ rootDir: root, distDir: dist, fs, np: path, hasSpaBundle: false,
    entryJs: '', entryCss: '', qw: (file, html) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
    },
  });
  xml = fs.readFileSync(path.join(dist, 'sitemap-seo-hubs.xml'), 'utf8');
});

afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('company archives remain paginated in every locale', () => {
  it.each(HUB_LOCALES)('emits ordered company pages and discovery for %s without uncapping job archives', locale => {
    const base = HUB_SLUGS[locale].companiesAll;
    for (let page = 1; page <= 4; page++) {
      const url = paginatedPath(base, page);
      expect(fs.existsSync(path.join(dist, url.slice(1), 'index.html')), url).toBe(true);
      const html = read(url);
      const dom = new JSDOM(html);
      const document = dom.window.document;
      expect(document.documentElement.lang).toBe(locale);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(BASE_URL + url);
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).not.toMatch(/noindex/);
      expect(countHtmlBodyWords(html)).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
      const prefix = `${legacyTiSectionRoot(locale)}/${COMPANY_ROUTE_PREFIX[locale]}-company-fixture-`;
      const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')!)
        .filter(href => href.startsWith(prefix));
      const expected = companies.slice((page - 1) * COMPANIES_PAGE_SIZE, page * COMPANIES_PAGE_SIZE)
        .map(slug => `${legacyTiSectionRoot(locale)}/${COMPANY_ROUTE_PREFIX[locale]}-${slug}/`);
      expect(hrefs).toEqual(expected);
      expect(document.querySelector('link[rel="prev"]')?.getAttribute('href') ?? null)
        .toBe(page === 1 ? null : BASE_URL + paginatedPath(base, page - 1));
      expect(document.querySelector('link[rel="next"]')?.getAttribute('href') ?? null)
        .toBe(page === 4 ? null : BASE_URL + paginatedPath(base, page + 1));
      const block = xml.match(/<url>[\s\S]*?<\/url>/g)?.find(block => block.includes(`<loc>${BASE_URL}${url}</loc>`));
      // P1 noindex plan: only page 1 of a listing is advertised in a sitemap;
      // pages 2+ stay 200 + indexable (below page 11) and reachable via the pager.
      if (page === 1) expect(block, url).toBeTruthy();
      else expect(block, url).toBeUndefined();
      dom.window.close();
    }
    expect(read(base)).toContain(`href="${paginatedPath(base, 2)}"`);
    expect(fs.existsSync(path.join(dist, paginatedPath(base, 5).slice(1), 'index.html'))).toBe(false);
    const jobPage2 = paginatedPath(HUB_SLUGS[locale].jobsAll, 2);
    expect(fs.existsSync(path.join(dist, jobPage2.slice(1), 'index.html'))).toBe(locale === 'it');
  });

  it('emits the range indexes advertised by a larger company directory in every locale', () => {
    const fixture = path.join(root, 'range-fixture');
    const rangeDist = path.join(fixture, 'dist');
    fs.mkdirSync(path.join(fixture, 'data'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'services'));
    fs.mkdirSync(rangeDist);
    const count = COMPANIES_PAGE_SIZE * PAGINATION_INDEX_THRESHOLD + 1;
    const totalPages = Math.ceil(count / COMPANIES_PAGE_SIZE);
    fs.writeFileSync(path.join(fixture, 'data/jobs.json'), '[]');
    fs.writeFileSync(path.join(fixture, 'data/known-company-slugs.json'), JSON.stringify(
      Array.from({ length: count }, (_, i) => `range-company-fixture-${i}`),
    ));
    writeEmittedCompanyPages(rangeDist,
      Array.from({ length: count }, (_, i) => `range-company-fixture-${i}`));
    fs.writeFileSync(path.join(fixture, 'services/jobDataNormalization.ts'), 'export const CRAWLED_COMPANY_LOGOS = {};');
    const outputs = new Map<string, string>();
    emitSeoHubs({ rootDir: fixture, distDir: rangeDist, fs, np: path,
      entryJs: '', entryCss: '', hasSpaBundle: false,
      qw: (file, html) => outputs.set(file, html),
    });
    for (const locale of HUB_LOCALES) {
      const base = HUB_SLUGS[locale].companiesAll;
      const htmlAt = (url: string) => outputs.get(path.join(rangeDist, url.slice(1), 'index.html'));
      const pageLinks = new Set<string>();
      for (let i = 1; i <= paginationIndexCount(totalPages); i++) {
        const indexUrl = paginationIndexPath(base, i);
        expect(htmlAt(base)).toContain(`href="${indexUrl}"`);
        const index = htmlAt(indexUrl);
        expect(index, indexUrl).toBeTruthy();
        const dom = new JSDOM(index);
        expect(dom.window.document.querySelector('link[rel="canonical"]')?.getAttribute('href'))
          .toBe(BASE_URL + indexUrl);
        for (const anchor of dom.window.document.querySelectorAll('a[href]')) {
          pageLinks.add(anchor.getAttribute('href')!);
        }
        dom.window.close();
      }
      for (let page = 1; page <= totalPages; page++) {
        const url = paginatedPath(base, page);
        expect(pageLinks.has(url), url).toBe(true);
        expect(htmlAt(url), url).toBeTruthy();
        // P1 noindex plan: pages 1-10 indexable, 11+ `noindex,follow` (still
        // 200 and linked from the pager and the range indexes above).
        const robots = htmlAt(url)!.match(/<meta name="robots" content="([^"]+)"/)?.[1];
        if (page >= PAGINATION_NOINDEX_FROM_PAGE) expect(robots, url).toBe('noindex,follow');
        else expect(robots, url).not.toMatch(/noindex/);
      }
      expect(htmlAt(paginatedPath(base, totalPages + 1))).toBeUndefined();
    }
    expect(totalPages).toBeGreaterThanOrEqual(PAGINATION_NOINDEX_FROM_PAGE);
    const rangeXml = fs.readFileSync(path.join(rangeDist, 'sitemap-seo-hubs.xml'), 'utf8');
    const pagedLocs = [...rangeXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((loc) => /\/(?:page|pagina|seite)-\d+\/$/.test(loc));
    expect(pagedLocs).toEqual([]);
  });
});
