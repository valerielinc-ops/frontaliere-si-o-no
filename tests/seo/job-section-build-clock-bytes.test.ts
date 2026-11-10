/**
 * Observer: the static pages of a job section must not change bytes when only
 * the build clock moves. Every byte that differs between two daily builds over
 * the SAME data is uploaded again by the per-section shard push. Two
 * per-build tokens rewrote most pages of every section at every build, and
 * the zurigo push ran into its 3600 s timeout: the "Pagina generata · <build
 * day>" hero kicker of every city, sector and editorial listing page, and the
 * archived JobPosting of an expired offer's soft landing, whose validThrough
 * fell back to "build clock − 1 day" (soft landings are ~90% of the berna and
 * zurigo sections).
 *
 * One fixture — active offers, listing-only offers, expired offers served as
 * soft landings, city, sector, company and editorial pages, plus the canton
 * bridges the emitter writes for every other canton — is built twice, with
 * build clocks three days apart and fresh module state each time. The data
 * is frozen before the first build: a page whose bytes differ depends on the
 * clock.
 *
 * Held fixed on purpose, each with its reason:
 * - `STATIC_BUILD_ID_META=off`, as production sets it (repository variable,
 *   deploy.yml): with the flag on, `<meta name=ft-build-id>` is a declared
 *   per-build marker, not page content.
 * - The events crosslink (`shared/jobEventsCrosslink.ts`) reads the real
 *   `data/events.json` and keeps only UPCOMING events, deliberately agreeing
 *   with the dated event pages on "today": it changes when an event passes,
 *   which is a fact of that dataset, not a build token. It is frozen here so
 *   this observer cannot turn red when a real event ends.
 * - Every posting date is older than the 7-day "Nuovo" / "Nuove · 7gg"
 *   windows at both clocks. Those flags change a page once, when an offer
 *   leaves the window — a property of the offer's age, not of every build.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeAllKnownJobSlugs } from '../../scripts/lib/all-known-job-slugs-store.mjs';
import { resolveCantonSection } from '../../build-plugins/shared/cantonSection';
import { findRelativePostedText } from '../helpers/relativePostedText';

const DAY = 86400000;
// Data and clocks are anchored to the start of the real current day: the
// fixture stays recent for every pipeline that prunes old offers, and both
// builds read exactly the same records.
const ANCHOR = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const FIRST_BUILD = new Date(ANCHOR + 10 * 3600000);
const LATER_BUILD = new Date(FIRST_BUILD.getTime() + 3 * DAY);
const ago = (days: number) => new Date(ANCHOR - days * DAY).toISOString();

const LOCALE = 'it';
const description = 'La posizione prevede la collaborazione con il gruppo di lavoro e la gestione delle attività quotidiane. Cerchiamo una persona con esperienza professionale, precisione e capacità organizzative, interessata a crescere in un ambiente qualificato. Offriamo formazione continua, un contratto stabile e condizioni di lavoro trasparenti. Le candidature complete vengono esaminate dal responsabile delle risorse umane.';

function fixtureJobs() {
  const base = (i: number, canton: string, location: string) => ({
    id: `clock-position-${canton.toLowerCase()}-${i}`, slug: `clock-position-${canton.toLowerCase()}-${i}`,
    title: `Specialista amministrativo ${i}`,
    titleByLocale: { it: `Specialista amministrativo ${i}`, en: `Administrative specialist ${i}`, de: `Verwaltungsspezialist ${i}`, fr: `Spécialiste administratif ${i}` },
    company: i % 2 ? 'Clock Example SA' : 'Orologio Esempio AG', companyKey: i % 2 ? 'clock-example' : 'orologio-esempio',
    canton, location, addressLocality: location, postalCode: canton === 'ZH' ? '8001' : '6900',
    streetAddress: 'Bahnhofstrasse 1', streetAddressSource: 'listing-source',
    description, descriptionByLocale: { it: description },
    requirements: ['Esperienza', 'Precisione'],
    // 11+ days old at the first clock: outside every 7-day window at both.
    postingDateSource: 'reported', datePosted: ago(11 + i), postedDate: ago(11 + i), crawledAt: ago(1), firstSeenAt: ago(11 + i),
    tags: i % 3 === 0 ? ['infermiere'] : [],
    employmentType: 'FULL_TIME', contract: 'full-time', salaryMin: 70000, salaryMax: 90000,
    url: `https://example.test/careers/${canton}/${i}/`,
  });
  const active = [
    ...Array.from({ length: 12 }, (_, i) => base(i, 'ZH', 'Zürich')),
    ...Array.from({ length: 8 }, (_, i) => base(i, 'TI', 'Lugano')),
  ];
  const listingOnly = Array.from({ length: 40 }, (_, i) => ({
    id: `clock-listing-${i}`, slug: `clock-listing-${i}`, title: `Posizione ${i}`, company: 'Clock Example SA',
    canton: 'ZH', location: 'Zürich', crawledAt: ago(1),
  }));
  const expired = [
    ...Array.from({ length: 6 }, (_, i) => ({
      ...base(100 + i, i % 2 ? 'ZH' : 'TI', i % 2 ? 'Zürich' : 'Lugano'),
      datePosted: ago(40 + i), postedDate: ago(40 + i), crawledAt: ago(20), expiredAt: ago(10 + i),
    })),
    // No expiry, observation or publication date: the archived JobPosting
    // used to take "build clock − 1 day" as its validThrough.
    { ...base(110, 'ZH', 'Zürich'), postingDateSource: 'unknown', datePosted: undefined, postedDate: undefined, crawledAt: undefined, firstSeenAt: undefined, expiredAt: undefined },
    // Only the last observation survives: it bounds validThrough.
    { ...base(111, 'TI', 'Lugano'), postingDateSource: 'unknown', datePosted: undefined, postedDate: undefined, firstSeenAt: undefined, expiredAt: undefined, crawledAt: ago(15) },
  ];
  return { active: [...active, ...listingOnly], expired };
}

function walkHtml(dir: string, out: Map<string, string> = new Map(), rel = ''): Map<string, string> {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) walkHtml(dir, out, child);
    else if (entry.name.endsWith('.html')) out.set(child, fs.readFileSync(path.join(dir, child), 'utf8'));
  }
  return out;
}

const softLandingPath = (job: { slug: string; canton: string }) => `${resolveCantonSection(LOCALE, job.canton)}/${job.slug}/index.html`;

async function buildAt(now: Date, data: ReturnType<typeof fixtureJobs>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-section-clock-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  // The canton emitter imports its ESM helpers relative to rootDir.
  fs.symlinkSync(path.resolve('scripts'), path.join(root, 'scripts'), 'dir');
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-test.js"></script></head><body><div id="root"></div></body></html>');
  fs.copyFileSync(path.resolve('data/canton-url-slugs.json'), path.join(root, 'data/canton-url-slugs.json'));
  fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(data.active));
  fs.writeFileSync(path.join(root, 'data/expired-jobs.json'), JSON.stringify(data.expired));
  // The soft-landing emitter serves the URLs the slug registry has published.
  writeAllKnownJobSlugs(Object.fromEntries(data.expired.map((job) => [job.slug, { [LOCALE]: `/${resolveCantonSection(LOCALE, job.canton)}/${job.slug}/` }])), root);

  vi.useFakeTimers({ toFake: ['Date'], now });
  // Fresh module state per build: no memo computed under the first clock
  // (BUILD_ID, BUILD_DATE_STAMP, per-build caches) leaks into the second.
  vi.resetModules();
  vi.doMock('../../build-plugins/shared/jobEventsCrosslink', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../build-plugins/shared/jobEventsCrosslink')>()),
    nearbyEventsBlockForJobPage: () => '',
  }));
  try {
    const { employerProfilePagesPlugin } = await import('../../build-plugins/employerProfilePagesPlugin');
    const { localeJobsSplitPlugin } = await import('../../build-plugins/localeJobsSplitPlugin');
    const { jobsSeoPagesPlugin } = await import('../../build-plugins/jobsSeoPagesPlugin');
    const { emitSeoHubs } = await import('../../build-plugins/seoHubsPlugin');
    await (employerProfilePagesPlugin(root).closeBundle as () => Promise<void>)();
    (localeJobsSplitPlugin(root).closeBundle as () => void)();
    await (jobsSeoPagesPlugin(root).closeBundle as () => Promise<void>)();
    emitSeoHubs({ rootDir: root, distDir: path.join(root, 'dist'), fs, np: path, entryJs: '/assets/index-test.js', entryCss: '', hasSpaBundle: false, qw: (file, html) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
    } });
  } finally {
    vi.doUnmock('../../build-plugins/shared/jobEventsCrosslink');
    vi.useRealTimers();
  }
  return root;
}

let roots: string[] = [];
let first: Map<string, string>;
let later: Map<string, string>;
let data: ReturnType<typeof fixtureJobs>;
const ENV_KEYS = ['BUILD_LOCALE', 'JOBS_SEO_FALLBACK_WORKERS', 'JOBPOSTING_COVERAGE_OUT', 'STATIC_BUILD_ID_META'] as const;
const envBefore = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  // One locale keeps the double build affordable; the kicker and the date
  // helpers are locale-parametric and covered per locale in unit tests.
  process.env.BUILD_LOCALE = LOCALE;
  // Worker threads would not see the faked clock.
  process.env.JOBS_SEO_FALLBACK_WORKERS = '0';
  process.env.STATIC_BUILD_ID_META = 'off';
  data = fixtureJobs();
  for (const now of [FIRST_BUILD, LATER_BUILD]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-section-clock-cov-'));
    roots.push(root);
    process.env.JOBPOSTING_COVERAGE_OUT = path.join(root, 'coverage.json');
    roots.push(await buildAt(now, data));
  }
  first = walkHtml(path.join(roots[1], 'dist'));
  later = walkHtml(path.join(roots[3], 'dist'));
}, 900000);

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key];
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('job section static HTML is independent of the build clock', () => {
  it('emits the same pages, soft landings and listing pages included', () => {
    expect([...later.keys()].sort()).toEqual([...first.keys()].sort());
    for (const job of data.expired) expect(first.has(softLandingPath(job)), softLandingPath(job)).toBe(true);
    expect(first.has(`${resolveCantonSection(LOCALE, 'ZH')}/zurich/index.html`)).toBe(true);
    expect(first.size).toBeGreaterThan(500);
  });

  it('changes no page bytes when only the clock moves by three days', () => {
    const changed = [...first.keys()].filter((rel) => later.get(rel) !== first.get(rel));
    // eslint-disable-next-line no-console
    console.log(`[build-clock-bytes] pages=${first.size} changed=${changed.length}`);
    expect(changed).toEqual([]);
  });

  it('never prints the build day as the page generation date', () => {
    const generated = /Pagina generata|Page generated|Seite erstellt|Page générée/;
    const offenders = [...first.entries()]
      .filter(([, html]) => generated.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it('carries no relative publication age', () => {
    const offenders = [...first.entries()].filter(([, html]) => findRelativePostedText(html)).map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it('dates the expired JobPosting from the archived record, never from the build', () => {
    const posting = (rel: string) => {
      const html = first.get(rel) || '';
      const blocks = [...html.matchAll(/<script type="?application\/ld\+json"?>([\s\S]*?)<\/script>/g)]
        .map((match) => JSON.parse(match[1]))
        .filter((value) => value['@type'] === 'JobPosting');
      expect(blocks.length, rel).toBeLessThanOrEqual(1);
      return blocks[0];
    };
    const [withExpiry] = data.expired;
    expect(posting(softLandingPath(withExpiry))?.validThrough).toBe(new Date(withExpiry.expiredAt!).toISOString());
    const noEvidence = data.expired.find((job) => job.slug.endsWith('-110'))!;
    expect(posting(softLandingPath(noEvidence))).toBeUndefined();
    const observedOnly = data.expired.find((job) => job.slug.endsWith('-111'))!;
    expect(posting(softLandingPath(observedOnly))?.validThrough).toBe(new Date(observedOnly.crawledAt!).toISOString());
    for (const job of data.expired) {
      const validThrough = posting(softLandingPath(job))?.validThrough;
      if (validThrough && job.expiredAt) expect(Date.parse(validThrough)).toBeLessThanOrEqual(Date.parse(job.expiredAt));
    }
  });

  it('dates the listing kicker from the newest listed offer', () => {
    const city = first.get(`${resolveCantonSection(LOCALE, 'ZH')}/zurich/index.html`) || '';
    // The newest ZH offer is base(0): 11 days before the anchor.
    expect(city).toMatch(new RegExp(`<p class="?s-zNiFzy sx-kick"?><time datetime="?${ago(11).slice(0, 10)}"?>Offerta più recente pubblicata`));
  });
});
