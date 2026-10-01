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


const archiveDates = { posted: daysAgo(10), crawled: daysAgo(5), expired: daysAgo(2), future: daysAgo(-2) };
const historicalEstimate = (deadline: string) => new Date(Date.parse(deadline) - 30 * 86400000).toISOString();
const archiveRecord = (slug: string, overrides: Record<string, unknown> = {}) => ({
  ...jobs[7], id: slug, slug, datePosted: archiveDates.posted, postedDate: archiveDates.posted,
  crawledAt: archiveDates.crawled, expiredAt: archiveDates.expired, ...overrides,
});
const noPostingDates = { datePosted: undefined, postedDate: undefined, crawledAt: undefined, expiredAt: undefined };
const archivedJobs = [
  archiveRecord('archived-audit-position'),
  archiveRecord('archived-crawl-only', { ...noPostingDates, crawledAt: archiveDates.crawled }),
  archiveRecord('archived-first-seen', { datePosted: undefined, postedDate: undefined, firstSeenAt: archiveDates.posted }),
  archiveRecord('archived-source-on-expiry', { ...noPostingDates, datePosted: archiveDates.expired, expiredAt: archiveDates.expired }),
  archiveRecord('archived-posted-only', { ...noPostingDates, postedDate: archiveDates.posted }),
  archiveRecord('archived-expiry-only', { ...noPostingDates, expiredAt: archiveDates.expired }),
  archiveRecord('archived-future-expiry', { expiredAt: archiveDates.future }),
  archiveRecord('archived-late-posting', { datePosted: archiveDates.future, postedDate: archiveDates.future }),
  archiveRecord('archived-sparse', { ...noPostingDates, crawledAt: archiveDates.crawled,
    description: '', descriptionByLocale: {}, salaryMin: undefined, salaryMax: undefined, contract: undefined }),
  archiveRecord('archived-short-description', { description: 'Reparto dati.', descriptionByLocale: {} }),
  archiveRecord('archived-medium-description', { description: 'Esperienza in analisi dati e report.', descriptionByLocale: {} }),
  archiveRecord('archived-markup-short', { description: '<div class="source-role-description"><strong>Reparto dati.</strong></div>', descriptionByLocale: {} }),
  archiveRecord('archived-no-dates', noPostingDates),
  archiveRecord('archived-invalid-dates', { datePosted: 'not-a-date', postedDate: 'not-a-date', crawledAt: 'not-a-date', expiredAt: 'not-a-date' }),
  archiveRecord('archived-future-only', { datePosted: archiveDates.future, postedDate: archiveDates.future, crawledAt: archiveDates.future, expiredAt: archiveDates.future }),
  archiveRecord('archived-no-employer', { company: '', companyKey: '' }),
  archiveRecord('archived-no-title', { title: '', titleByLocale: {} }),
];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-board-hub-output-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  // The canton emitter imports its ESM helpers relative to rootDir.
  fs.symlinkSync(path.resolve('scripts'), path.join(root, 'scripts'), 'dir');
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
  writeAllKnownJobSlugs(Object.fromEntries(archivedJobs.map(({ slug }) => [slug,
    Object.fromEntries(locales.map((locale) => [locale, `${hubPath(locale, 'TI')}${slug}`])),
  ])), root);
  fs.writeFileSync(path.join(root, 'data/expired-jobs.json'), JSON.stringify(archivedJobs));
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

  it.each([
    ['archived-audit-position', archiveDates.posted, archiveDates.expired],
    ['archived-crawl-only', historicalEstimate(archiveDates.crawled), archiveDates.crawled],
    ['archived-first-seen', archiveDates.posted, archiveDates.expired],
    ['archived-source-on-expiry', historicalEstimate(archiveDates.expired), archiveDates.expired],
    ['archived-posted-only', historicalEstimate(archiveDates.posted), archiveDates.posted],
    ['archived-expiry-only', historicalEstimate(archiveDates.expired), archiveDates.expired],
    ['archived-future-expiry', archiveDates.posted, archiveDates.crawled],
    ['archived-late-posting', archiveDates.crawled, archiveDates.expired],
    ['archived-sparse', historicalEstimate(archiveDates.crawled), archiveDates.crawled],
    ['archived-short-description', archiveDates.posted, archiveDates.expired],
    ['archived-medium-description', archiveDates.posted, archiveDates.expired],
    ['archived-markup-short', archiveDates.posted, archiveDates.expired],
  ])('keeps complete expired schema with source dates or a bounded historical estimate for %s', (slug, datePosted, validThrough) => {
    for (const locale of locales) {
      const document = htmlDoc(`${hubPath(locale, 'TI')}${slug}/`);
      const entries = structured(document);
      const postings = entries.filter((entry) => entry['@type'] === 'JobPosting');
      expect(postings).toHaveLength(1);
      const posting = postings[0];
      for (const field of ['title', 'description', 'datePosted', 'employmentType', 'baseSalary', 'jobLocation']) expect(posting[field]).toBeTruthy();
      expect(posting.title).toBe(jobs[7].titleByLocale[locale]);
      if (['archived-short-description', 'archived-markup-short'].includes(slug)) expect(posting.description).toContain('Reparto dati.');
      if (slug === 'archived-medium-description') expect(posting.description).toContain('Esperienza in analisi dati e report.');
      if (['archived-sparse', 'archived-short-description', 'archived-medium-description', 'archived-markup-short'].includes(slug)) {
        const unavailable = { it: 'non è più disponibile', en: 'no longer available', de: 'nicht mehr verfügbar', fr: "n'est plus disponible" };
        expect(posting.description).toContain(unavailable[locale]);
      }
      expect(posting.description).not.toMatch(/Candidatura diretta|Apply directly through|Direkte Bewerbung|Candidature directe/);
      expect(posting.description).not.toContain('source-role-description');
      expect(posting.hiringOrganization.name).toBe('Audit Example SA');
      expect(posting.jobLocation.address.postalCode).toBeTruthy();
      expect(posting.jobLocation.address.streetAddress).toBeTruthy();
      expect(posting.baseSalary.value.minValue).toBeGreaterThan(0);
      expect(posting.datePosted).toBe(datePosted);
      expect(posting.validThrough).toBe(validThrough);
      expect(posting.directApply).toBe(false);
      expect(Date.parse(posting.validThrough)).toBeLessThan(Date.now());
      expect(Date.parse(posting.datePosted)).toBeLessThan(Date.parse(posting.validThrough));
      if (['archived-crawl-only', 'archived-expiry-only', 'archived-sparse', 'archived-source-on-expiry', 'archived-posted-only'].includes(slug)) {
        expect(Date.parse(posting.validThrough) - Date.parse(posting.datePosted)).toBe(30 * 86400000);
      }
      expect(entries.flatMap(allTypes)).toEqual(expect.arrayContaining(['WebPage', 'BreadcrumbList']));
      expect(document.querySelector('h1')).toBeTruthy();
    }
  });

  it.each(['archived-no-dates', 'archived-invalid-dates', 'archived-future-only', 'archived-no-employer', 'archived-no-title'])(
    'keeps only archive metadata when real identity or past dates are unavailable: %s', (slug) => {
      for (const locale of locales) {
        const entries = structured(htmlDoc(`${hubPath(locale, 'TI')}${slug}/`));
        expect(entries.flatMap(allTypes)).not.toContain('JobPosting');
        expect(entries.flatMap(allTypes)).toEqual(expect.arrayContaining(['WebPage', 'BreadcrumbList']));
      }
    },
  );
});
