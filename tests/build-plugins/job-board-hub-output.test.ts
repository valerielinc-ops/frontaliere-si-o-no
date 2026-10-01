import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { jobsSeoPagesPlugin } from '../../build-plugins/jobsSeoPagesPlugin';
import { emitSeoHubs } from '../../build-plugins/seoHubsPlugin';
import { hubSlugFor } from '../../build-plugins/seoHubsData';
import { employerProfilePagesPlugin } from '../../build-plugins/employerProfilePagesPlugin';
import { localeJobsSplitPlugin } from '../../build-plugins/localeJobsSplitPlugin';
import { getActiveJobCountsByLocale } from '../../build-plugins/jobBoardSeo';
import { resolveCantonSection as buildCantonAwareSection } from '../../build-plugins/shared/cantonSection';
import { writeAllKnownJobSlugs } from '../../scripts/lib/all-known-job-slugs-store.mjs';
import { selectJobBoardInventory } from '../../services/jobBoardInventory';
import { buildJobBoardListingMetadata } from '../../services/seo/jobBoardListingMetadata';

const locales = ['it', 'en', 'de', 'fr'] as const;
const prefix = (locale: string) => locale === 'it' ? '' : `/${locale}`;
const hubPath = (locale: typeof locales[number], canton: string) => `${prefix(locale)}/${buildCantonAwareSection(locale, canton)}/`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const description = 'La posizione prevede la collaborazione con il gruppo di lavoro e la gestione delle attività quotidiane. Cerchiamo una persona con esperienza professionale, precisione e capacità organizzative, interessata a crescere in un ambiente qualificato. Offriamo formazione continua, un contratto stabile e condizioni di lavoro trasparenti. Le candidature complete vengono esaminate dal responsabile delle risorse umane.';
let root: string;
const jobs = Array.from({ length: 8 }, (_, i) => ({
  id: `audit-position-${i}`, slug: `audit-position-${i}`, title: `Specialista amministrativo ${i}`,
  titleByLocale: { it: `Specialista amministrativo ${i}`, en: `Administrative specialist ${i}`, de: `Verwaltungsspezialist ${i}`, fr: `Spécialiste administratif ${i}` },
  company: 'Audit Example SA', companyKey: 'audit-example', canton: i < 6 ? 'ZH' : 'TI',
  location: i < 6 ? 'Zürich' : 'Lugano', addressLocality: i < 6 ? 'Zürich' : 'Lugano',
  description, descriptionByLocale: Object.fromEntries(locales.map((locale) => [locale, description])),
  datePosted: daysAgo(2), postedDate: daysAgo(2), crawledAt: daysAgo(1),
  employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
  url: `https://example.test/careers/${i}/`,
}));

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-board-hub-output-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>');
  fs.copyFileSync(path.resolve('data/canton-url-slugs.json'), path.join(root, 'data/canton-url-slugs.json'));
  // One duplicate and a short translation reproduce the difference between the
  // visible inventory and the smaller sitemap-eligible subset.
  const listingOnly = Array.from({ length: 120 }, (_, i) => ({ id: `listing-only-${i}`, slug: `listing-only-${i}`, title: `Posizione ${i}`, company: 'Audit Example SA', canton: 'ZH', location: 'Zürich' }));
  const sgJobs = Array.from({ length: 6 }, (_, i) => ({ ...jobs[0], id: `sg-position-${i}`, slug: `sg-position-${i}`, canton: 'SG', location: 'St. Gallen' }));
  fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([...jobs, ...listingOnly, ...sgJobs, jobs[0], { ...jobs[1], id: 'short-translation', slug: 'short-translation', descriptionByLocale: { it: 'Testo breve' } }]));
  // The archive emitter consumes its historical snapshot, independently of
  // current listing counts: ZH has one archive page and SG has two.
  fs.mkdirSync(path.join(root, 'data/jobs-snapshots-history'));
  fs.writeFileSync(path.join(root, 'data/jobs-snapshots-history/2026-10-01.json'), JSON.stringify({ jobs: [
    ...Array.from({ length: 80 }, (_, i) => ({ slug: `snapshot-zh-${i}`, role: `Ruolo ${i}`, employer: 'Audit Example SA', employerKey: 'audit-example', canton: 'ZH', city: 'Zürich' })),
    ...Array.from({ length: 120 }, (_, i) => ({ slug: `snapshot-sg-${i}`, role: `Ruolo ${i}`, employer: 'Audit Example SA', employerKey: 'audit-example', canton: 'SG', city: 'St. Gallen' })),
  ] }));
  const expiredSlug = 'archived-audit-position';
  writeAllKnownJobSlugs({ [expiredSlug]: Object.fromEntries(locales.map((locale) => [locale, `${hubPath(locale, 'TI')}${expiredSlug}`])) }, root);
  fs.writeFileSync(path.join(root, 'data/expired-jobs.json'), JSON.stringify([{ ...jobs[7], id: 'archived-audit', slug: expiredSlug, expiredAt: daysAgo(1) }]));
  await (employerProfilePagesPlugin(root).closeBundle as () => Promise<void>)();
  (localeJobsSplitPlugin(root).closeBundle as () => void)();
  await (jobsSeoPagesPlugin(root).closeBundle as () => Promise<void>)();
  emitSeoHubs({ rootDir: root, distDir: path.join(root, 'dist'), fs, np: path, entryJs: '/assets/index-test.js', entryCss: '', hasSpaBundle: false, qw: (file, html) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  } });
}, 120000);

afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function htmlDoc(relative: string): Document {
  return new JSDOM(fs.readFileSync(path.join(root, 'dist', relative, 'index.html'), 'utf8')).window.document;
}
function structured(document: Document): any[] {
  return [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((script) => JSON.parse(script.textContent || '{}'));
}
function allTypes(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value['@type'] === 'string' ? [value['@type']] : []), ...Object.values(value).flatMap(allTypes)];
}

describe('job-board emitted output', () => {
  it('uses the loaded listing snapshot for all hub counts and geographic metadata', () => {
    for (const locale of locales) {
      const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/data', `jobs-${locale}-index.json`), 'utf8'));
      for (const canton of ['ZH', '_AGGREGATE_']) {
        const count = selectJobBoardInventory(index, canton).length;
        const document = htmlDoc(hubPath(locale, canton));
        expect(document.title).toBe(buildJobBoardListingMetadata(locale, canton, count).title);
        const collection = structured(document).find((entry) => entry['@type'] === 'CollectionPage');
        expect(collection.mainEntity.numberOfItems).toBe(count);
        expect(document.body.textContent).toContain(String(count));
        expect(document.title).not.toContain('Swiss Italy');
        expect(structured(document).flatMap(allTypes)).not.toContain('JobPosting');
      }
      expect(getActiveJobCountsByLocale(root)[locale]).toBe(selectJobBoardInventory(index, 'TI').length);
    }
  });

  it('links only archive pages emitted from the historical snapshot', () => {
    for (const locale of locales) {
      const zurichBase = hubSlugFor('ZH', locale, 'tutti');
      const zurichDoc = htmlDoc(hubPath(locale, 'ZH'));
      expect(zurichDoc.querySelector(`[data-canton-editorial] a[href="${zurichBase}page-2/"]`)).toBeNull();
      expect(fs.existsSync(path.join(root, 'dist', zurichBase, 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'dist', zurichBase, 'page-2/index.html'))).toBe(false);

      const sgBase = hubSlugFor('SG', locale, 'tutti');
      const sgDoc = htmlDoc(hubPath(locale, 'SG'));
      const archiveLinks = [...sgDoc.querySelectorAll('[data-canton-editorial] a[href]')]
        .map((link) => link.getAttribute('href')!).filter((href) => href.startsWith(sgBase));
      expect(archiveLinks).toContain(`${sgBase}page-2/`);
      for (const href of archiveLinks) expect(fs.existsSync(path.join(root, 'dist', href, 'index.html')), href).toBe(true);
    }
  });

  it('emits reciprocal HTML and sitemap alternates for the actual national/canton hubs', () => {
    for (const [canton, shard] of [['ZH', 'zurigo'], ['_AGGREGATE_', 'svizzera']] as const) {
      const xml = new JSDOM(fs.readFileSync(path.join(root, 'dist', `sitemap-jobs-${shard}.xml`), 'utf8'), { contentType: 'text/xml' }).window.document;
      for (const locale of locales) {
        const relative = hubPath(locale, canton);
        const expected = [...locales.map((language) => [language, `https://frontaliereticino.ch${hubPath(language, canton)}`]), ['x-default', `https://frontaliereticino.ch${hubPath('it', canton)}`]];
        const alternates = [...htmlDoc(relative).querySelectorAll('link[hreflang]')].map((link) => [link.getAttribute('hreflang'), link.getAttribute('href')]);
        expect(alternates).toEqual(expected);
        const entry = [...xml.querySelectorAll('url')].find((url) => url.querySelector('loc')?.textContent === `https://frontaliereticino.ch${relative}`);
        expect(entry).toBeTruthy();
        const sitemapAlternates = [...entry!.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'link')].map((link) => [link.getAttribute('hreflang'), link.getAttribute('href')]);
        expect(sitemapAlternates).toEqual(expected);
      }
    }
  });

  it('keeps every mandatory field on active details in all four locales', () => {
    for (const locale of locales) {
      const document = htmlDoc(`${hubPath(locale, 'ZH')}audit-position-0/`);
      const posting = structured(document).find((entry) => entry['@type'] === 'JobPosting');
      expect(posting).toBeTruthy();
      for (const field of ['title', 'description', 'datePosted', 'employmentType', 'baseSalary', 'jobLocation']) expect(posting[field]).toBeTruthy();
      expect(posting.hiringOrganization.name).toBe('Audit Example SA');
      expect(posting.jobLocation.address.postalCode).toBeTruthy();
      expect(posting.jobLocation.address.streetAddress).toBeTruthy();
    }
  });

  it('keeps archived pages useful without presenting closed positions as JobPosting', () => {
    for (const locale of locales) {
      const document = htmlDoc(`${hubPath(locale, 'TI')}archived-audit-position/`);
      expect(structured(document).flatMap(allTypes)).not.toContain('JobPosting');
      expect(structured(document).flatMap(allTypes)).toContain('WebPage');
      expect(document.querySelector('h1')).toBeTruthy();
    }
  });
});
