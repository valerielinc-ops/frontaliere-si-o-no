// @vitest-environment node
/**
 * The history backfill must never lose a served expired route and never mint a
 * second record (or alias) for a posting the archive already represents.
 * Every case runs the real `processSlice` over a throwaway git history.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processSlice } from '../scripts/backfill-expired-from-history.mjs';
import { carryReplacedExpiredEntry, localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';

type Row = Record<string, any>;

const FILE = 'acme.json';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

let root: string;
let clock: number;

function git(args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...env,
    },
  });
}

const activePath = () => path.join(root, 'data', 'jobs', 'by-crawler', FILE);
const expiredPath = () => path.join(root, 'data', 'jobs', 'expired', 'by-crawler', FILE);
const readArchive = (): Row[] => JSON.parse(readFileSync(expiredPath(), 'utf8'));

function commit({ active, expired }: { active?: Row[]; expired?: Row[] }) {
  if (active) writeFileSync(activePath(), `${JSON.stringify(active, null, 2)}\n`);
  if (expired) writeFileSync(expiredPath(), `${JSON.stringify(expired, null, 2)}\n`);
  clock += 60;
  const date = `${clock} +0000`;
  git(['add', '-A']);
  git(['commit', '--allow-empty', '-qm', `step ${clock}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/**
 * An unrelated vanished posting. A real run almost always adds one, which is what
 * makes it write the archive (and persist whatever else it did to other rows).
 */
const unrelatedDrop = () => activeJob('acme-unrelated', 'custode-airolo', 999);

const run = () => processSlice(FILE, { rootDir: root });

const routesOf = (rows: Row[]) => new Set(rows.flatMap((row) => [...localeRouteKeys(row)]));
const missing = (before: Set<string>, rows: Row[]) => {
  const after = routesOf(rows);
  return [...before].filter((key) => !after.has(key)).sort();
};
const hex8Routes = (rows: Row[]) => [...routesOf(rows)].filter((key) => /-[0-9a-f]{8}$/.test(key));

// A detail URL: its leaf carries a posting token.
const sourceUrl = (n: number) => `https://jobs.example.invalid/vacancy/${7_000_000 + n}`;

function record(slug: string, source: number, extra: Row = {}): Row {
  return {
    slug,
    title: `Posting ${source}`,
    company: 'Acme',
    companyKey: 'acme',
    location: 'Chiasso',
    slugByLocale: { it: slug },
    descriptionByLocale: {},
    expiredAt: daysAgo(30),
    sourceIdentity: `url:${sourceUrl(source)}`,
    ...extra,
  };
}

function activeJob(id: string, slug: string, source: number, extra: Row = {}): Row {
  return {
    id,
    slug,
    title: `Posting ${source}`,
    company: 'Acme',
    companyKey: 'acme',
    location: 'Chiasso',
    slugByLocale: { it: slug },
    url: sourceUrl(source),
    crawledAt: daysAgo(5),
    ...extra,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  root = mkdtempSync(path.join(tmpdir(), 'backfill-expired-routes-'));
  clock = Math.floor((NOW - 90 * DAY) / 1000);
  mkdirSync(path.dirname(activePath()), { recursive: true });
  mkdirSync(path.dirname(expiredPath()), { recursive: true });
  git(['init', '-q', '-b', 'main']);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('history backfill: served expired routes', () => {
  it('keeps every route when a newer lost job reuses the slug under another source identity', () => {
    const archived = record('magazziniere-chiasso', 1, {
      slugByLocale: { it: 'magazziniere-chiasso', de: 'lagerist-chiasso' },
      previousSlugsByLocale: { it: ['addetto-magazzino-chiasso'], fr: ['magasinier-chiasso'] },
      previousSlugs: ['vecchio-magazziniere-chiasso'],
      expiredAt: daysAgo(40),
    });
    const lost = activeJob('acme-2', 'magazziniere-chiasso', 2, {
      slugByLocale: { it: 'magazziniere-chiasso', de: 'logistiker-chiasso' },
      crawledAt: daysAgo(3),
    });
    commit({ active: [lost, unrelatedDrop()], expired: [archived] });
    commit({ active: [] });
    const before = routesOf([archived]);

    run();

    const rows = readArchive();
    expect(missing(before, rows)).toEqual([]);
    expect(routesOf(rows).has('de:logistiker-chiasso')).toBe(true);
    expect(rows.map((row) => row.slug).sort()).toEqual(['custode-airolo', 'magazziniere-chiasso']);
    expect(rows.find((row) => row.slug === 'magazziniere-chiasso')?.sourceIdentity)
      .toBe(`url:${sourceUrl(2)}`);
  });

  it('keeps the routes of an older lost job that it does not let replace the record', () => {
    const lost = activeJob('acme-2', 'autista-lugano', 2, {
      slugByLocale: { it: 'autista-lugano', en: 'driver-lugano' },
      crawledAt: daysAgo(60),
    });
    commit({ active: [lost] });
    commit({ active: [], expired: [record('autista-lugano', 1, { expiredAt: daysAgo(10) })] });

    run();

    const rows = readArchive();
    expect(routesOf(rows).has('en:driver-lugano')).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIdentity).toBe(`url:${sourceUrl(1)}`);
  });

  it.each([
    ['a lost active job', 'active'],
    ['a vanished archive entry', 'expired'],
  ])('creates neither a record nor an alias for a pre-rename slug recovered from %s', (_label, side) => {
    const renamed = record('contabile-senior-mendrisio', 7, {
      previousSlugsByLocale: { it: ['contabile-mendrisio'] },
    });
    if (side === 'active') {
      commit({ active: [activeJob('acme-old-id', 'contabile-mendrisio', 7)] });
    } else {
      commit({ active: [], expired: [record('contabile-mendrisio', 7, { expiredAt: daysAgo(50) })] });
    }
    commit({ active: [], expired: [renamed] });

    run();

    const rows = readArchive();
    expect(rows.map((row) => row.slug)).toEqual(['contabile-senior-mendrisio']);
    expect(hex8Routes(rows)).toEqual([]);
    expect(missing(routesOf([renamed]), rows)).toEqual([]);
  });

  it('merges an unserved historical slug into the record of the same posting', () => {
    commit({ active: [activeJob('acme-old-id', 'cuoco-locarno', 7, { slugByLocale: { it: 'cuoco-locarno', de: 'koch-locarno' } })] });
    commit({ active: [], expired: [record('chef-locarno', 7)] });

    run();

    const rows = readArchive();
    expect(rows.map((row) => row.slug)).toEqual(['chef-locarno']);
    expect(routesOf(rows).has('it:cuoco-locarno')).toBe(true);
    expect(routesOf(rows).has('de:koch-locarno')).toBe(true);
  });

  it('keeps separate records for postings that only share a listing-page identity', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    commit({
      active: [
        { ...activeJob('acme-a', 'venditore-bellinzona', 0), url: `${listing}#job=a` },
        { ...activeJob('acme-b', 'cassiere-bellinzona', 0), url: `${listing}#job=b` },
      ],
    });
    commit({ active: [] });

    run();

    expect(readArchive().map((row) => row.slug).sort())
      .toEqual(['cassiere-bellinzona', 'venditore-bellinzona']);
  });

  it('restores a historical entry that names no source posting', () => {
    const legacy = record('stagista-biasca', 9, { expiredAt: daysAgo(50) });
    delete legacy.sourceIdentity;
    commit({ active: [], expired: [legacy] });
    commit({ active: [], expired: [record('apprendista-biasca', 9)] });

    run();

    expect(readArchive().map((row) => row.slug).sort())
      .toEqual(['apprendista-biasca', 'stagista-biasca']);
  });

  it('is a fixed point when the history already contains the output of the previous run', () => {
    // `other` owns the slug the lost posting used before its rename.
    const other = record('infermiere-bellinzona', 1, { expiredAt: daysAgo(45) });
    const renamed = record('infermiere-bellinzona-0a1b2c3d', 2, { expiredAt: daysAgo(20) });
    commit({
      active: [
        activeJob('acme-2', 'infermiere-bellinzona', 2, { crawledAt: daysAgo(2) }),
        unrelatedDrop(),
      ],
    });
    commit({ active: [], expired: [other, renamed] });
    const before = routesOf([other, renamed]);

    run();
    const first = readArchive();
    commit({});
    run();
    const second = readArchive();

    expect(missing(before, first)).toEqual([]);
    expect(first.map((row) => row.slug).sort())
      .toEqual(['custode-airolo', 'infermiere-bellinzona', 'infermiere-bellinzona-0a1b2c3d']);
    // The owner of the reused slug must not be turned into the other posting.
    expect(first.find((row) => row.slug === 'infermiere-bellinzona')?.sourceIdentity)
      .toBe(`url:${sourceUrl(1)}`);
    expect(hex8Routes(first)).toEqual(hex8Routes([other, renamed]));
    expect(second).toEqual(first);
  });

  it('keeps the complete route set of a deep record whose slug is absorbed (planzer shape)', () => {
    const depth = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
    // A flat slug that also sits in some buckets is served only by those buckets.
    const holder = record('addetto-al-trasbordo-dintikon', 4088386, {
      slugByLocale: {
        it: 'addetto-al-trasbordo-dintikon',
        en: 'employee-envelope-dintikon-33c84872',
      },
      previousSlugs: ['employee-envelope-dintikon', 'umschlag-dintikon', ...depth('flat', 40)],
      previousSlugsByLocale: {
        it: ['employee-envelope-dintikon', ...depth('it', 20)],
        de: ['employee-envelope-dintikon', ...depth('de', 3)],
        fr: ['employee-envelope-dintikon', ...depth('fr', 20)],
        en: ['umschlag-dintikon', ...depth('en', 20)],
      },
      expiredAt: daysAgo(40),
    });
    const current = record('busta-dipendenti-dintikon', 4104005, {
      previousSlugs: ['employee-envelope-dintikon'],
      previousSlugsByLocale: { en: ['employee-envelope-dintikon'] },
      expiredAt: daysAgo(4),
    });
    const newerPayload = activeJob('acme-busta', 'busta-dipendenti-dintikon', 4104005, {
      slugByLocale: { it: 'busta-dipendenti-dintikon', de: 'mitarbeiter-umschlag-dintikon' },
      crawledAt: daysAgo(1),
    });
    commit({ active: [newerPayload, unrelatedDrop()], expired: [holder, current] });
    commit({ active: [] });
    const before = routesOf([holder, current]);

    run();
    const first = readArchive();
    commit({});
    run();

    expect(missing(before, first)).toEqual([]);
    expect(routesOf(first).has('de:mitarbeiter-umschlag-dintikon')).toBe(true);
    expect(missing(before, readArchive())).toEqual([]);
  });
});

describe('history backfill: one listing URL for successive postings', () => {
  // No posting token anywhere: the URL names the page that lists the vacancies.
  const listing = 'https://jobs.example.invalid/jobs';
  const onListing = (id: string, slug: string, extra: Row = {}) => (
    activeJob(id, slug, 0, { url: listing, title: `Posting ${id}`, ...extra })
  );
  const listingRecord = (slug: string, extra: Row = {}) => (
    record(slug, 0, { sourceIdentity: `url:${listing}`, ...extra })
  );
  const routesBySlug = (rows: Row[]) => Object.fromEntries(
    rows.filter((row) => row.slug !== 'custode-airolo')
      .map((row) => [row.slug, [...routesOf([row])].sort()]),
  );
  const runTwice = () => {
    run();
    const first = readArchive();
    commit({});
    run();
    return { first, second: readArchive() };
  };

  it('keeps two records when no single version shows both postings', () => {
    commit({ active: [onListing('a', 'old', { crawledAt: daysAgo(40), slugByLocale: { it: 'old', de: 'alt' } })] });
    commit({ active: [onListing('b', 'new', { slugByLocale: { it: 'new', de: 'neu' } })] });
    commit({ active: [] });

    const { first, second } = runTwice();

    expect(routesBySlug(first)).toEqual({
      old: ['de:alt', 'it:old'],
      new: ['de:neu', 'it:new'],
    });
    expect(second).toEqual(first);
  });

  it('keeps them apart while the second posting is still open', () => {
    commit({ active: [onListing('a', 'old', { crawledAt: daysAgo(40) }), unrelatedDrop()] });
    commit({ active: [onListing('b', 'new')] });

    const { first, second } = runTwice();

    expect(routesBySlug(first)).toEqual({ old: ['it:old'] });
    expect(second).toEqual(first);
  });

  it('keeps apart a posting known only from the archive and a later lost job', () => {
    commit({ active: [onListing('b', 'new')], expired: [listingRecord('old', { id: 'a' })] });
    commit({ active: [] });

    const { first, second } = runTwice();

    expect(routesBySlug(first)).toEqual({ old: ['it:old'], new: ['it:new'] });
    expect(second).toEqual(first);
  });

  it('still folds a rename that keeps the id into one record', () => {
    commit({ active: [], expired: [listingRecord('lattoniere-faido', { id: 'a' })] });
    commit({ active: [], expired: [listingRecord('lattoniere-esperto-faido', { id: 'a', expiredAt: daysAgo(10) })] });

    const { first, second } = runTwice();

    expect(first.map((row) => row.slug)).toEqual(['lattoniere-esperto-faido']);
    expect(routesOf(first).has('it:lattoniere-faido')).toBe(true);
    expect(hex8Routes(first)).toEqual([]);
    expect(second).toEqual(first);
  });

  it('folds a same-id rename into its own record on a page shared by other postings', () => {
    commit({ active: [onListing('c', 'gessatore-faido'), onListing('a', 'lattoniere-faido')] });
    commit({
      active: [],
      expired: [
        listingRecord('gessatore-faido', { id: 'c', expiredAt: daysAgo(2) }),
        listingRecord('lattoniere-faido', { id: 'a', expiredAt: daysAgo(40) }),
      ],
    });
    commit({
      active: [unrelatedDrop()],
      expired: [
        listingRecord('gessatore-faido', { id: 'c', expiredAt: daysAgo(2) }),
        listingRecord('lattoniere-esperto-faido', { id: 'a', expiredAt: daysAgo(10) }),
      ],
    });
    commit({ active: [] });

    const { first, second } = runTwice();

    expect(Object.keys(routesBySlug(first)).sort())
      .toEqual(['gessatore-faido', 'lattoniere-esperto-faido']);
    expect(routesBySlug(first)['lattoniere-esperto-faido'])
      .toEqual(['it:lattoniere-esperto-faido', 'it:lattoniere-faido']);
    expect(second).toEqual(first);
  });

  it('still folds a rename with a new id when the URL names one posting', () => {
    commit({ active: [activeJob('first-id', 'selciatore-olivone', 21, { crawledAt: daysAgo(40) })] });
    commit({ active: [activeJob('second-id', 'selciatore-esperto-olivone', 21)] });
    commit({ active: [] });

    const { first, second } = runTwice();

    expect(first.map((row) => row.slug)).toEqual(['selciatore-esperto-olivone']);
    expect(routesOf(first).has('it:selciatore-olivone')).toBe(true);
    expect(hex8Routes(first)).toEqual([]);
    expect(second).toEqual(first);
  });
});

describe('replacing an archived record with a newer payload (cleanup-jobs)', () => {
  it('carries the replaced routes and identities onto the newer payload', () => {
    const previous = record('fiorista-ascona', 1, {
      slugByLocale: { it: 'fiorista-ascona', de: 'florist-ascona' },
      previousSlugsByLocale: { fr: ['fleuriste-ascona'] },
    });
    const entry: Row = record('fiorista-ascona', 2, { expiredAt: daysAgo(1) });
    const before = routesOf([previous]);

    expect(carryReplacedExpiredEntry(entry, previous, 'test')).toBe(true);

    expect(missing(before, [entry])).toEqual([]);
    expect(entry.sourceIdentityHistory.map((h: Row) => h.sourceIdentity).sort())
      .toEqual([`url:${sourceUrl(1)}`, `url:${sourceUrl(2)}`]);
  });

  it('accepts a payload that replaces nothing', () => {
    expect(carryReplacedExpiredEntry(record('barista-ascona', 3), undefined, 'test')).toBe(true);
  });
});
