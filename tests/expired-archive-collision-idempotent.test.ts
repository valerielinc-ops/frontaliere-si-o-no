// The expired-archive collision repair must be idempotent. #14030 (f9d7a234, 19 Oct 2026) added
// `collisionRouteSuffix`: a record whose route collides with a distinct posting gets a deterministic
// hex8 alias. The loop treated the record's OWN alias as "reserved", discarded it and coined a new
// one, so every time the route re-entered the record (a fresh payload, a history merge) it gained one
// more alias: 197 aliases of one stem inside one Denner record, 73% of the expired sitemap slugs with
// an 8-hex suffix, +30 000 expired pages a day since 20 Oct (build 43673117365).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveRemovedJobsToSlice,
  collapseDuplicateRouteEntries,
  readExpiredSlice,
  repairExpiredRoutesAgainstActive,
  repairExpiredRoutesWithinArchive,
} from '../scripts/lib/expired-jobs-archive.mjs';
import { clear as clearJournal, replaceSlugRouteEverywhere, summarize } from '../scripts/lib/slug-history-journal.mjs';
import { isValidJobSlug } from '../scripts/mine-all-job-slugs.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const HEX8 = /-[0-9a-f]{8}$/;
const PASSES = 5;

// Denner shape: the stem carries NO city, so many distinct postings derive the same route.
const stemsOf = (n: number) => Array.from({ length: n }, (_, i) => `verkaufer-in-denner${i === 0 ? '' : `-${i}`}`);

function expiredRecord(over: Record<string, unknown> = {}) {
  const stems = stemsOf(6);
  return {
    slug: 'verkaeufer-denner-horgen',
    slugByLocale: { it: 'venditore-denner-horgen', en: 'salesperson-denner-horgen', de: 'verkaufer-denner-horgen', fr: 'vendeur-denner-horgen' },
    title: 'Verkäufer/in',
    company: 'Denner AG',
    companyKey: 'denner',
    expiredAt: '2026-11-01T00:00:00.000Z',
    sourceIdentity: 'url:https://jobs.example/denner/expired-a',
    // inherited flat history: served under EVERY locale
    previousSlugs: [...stems],
    ...over,
  };
}

/** One distinct active posting per stem and locale: all of them collide with the expired record. */
function activeOwners() {
  return stemsOf(6).map((stem, i) => ({
    slug: stem,
    slugByLocale: { it: stem, en: stem, de: stem, fr: stem },
    url: `https://jobs.example/denner/active-${i}`,
    company: 'Denner AG',
    companyKey: 'denner',
  }));
}

const aliasesOf = (rows: any[]) => {
  const out = new Set<string>();
  for (const row of rows) {
    for (const value of [row.slug, ...Object.values(row.slugByLocale ?? {}), ...(row.previousSlugs ?? []), ...Object.values(row.previousSlugsByLocale ?? {}).flat()]) {
      if (HEX8.test(String(value))) out.add(String(value));
    }
  }
  return out;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

beforeEach(() => clearJournal());

describe('repairExpiredRoutesAgainstActive is idempotent', () => {
  it('first pass repairs, every later pass changes nothing and mints no alias', () => {
    const rows: any[] = [expiredRecord()];
    const active = activeOwners();
    const first = repairExpiredRoutesAgainstActive(rows, active);
    expect(first.changed).toBeGreaterThan(0);
    const settled = clone(rows);
    const settledAliases = aliasesOf(rows);
    expect(settledAliases.size).toBeGreaterThan(0);

    for (let pass = 2; pass <= PASSES; pass += 1) {
      const result = repairExpiredRoutesAgainstActive(rows, active);
      expect(result.changed, `pass ${pass}`).toBe(0);
      expect(rows, `pass ${pass}`).toEqual(settled);
      expect(aliasesOf(rows).size, `pass ${pass}`).toBe(settledAliases.size);
    }
  });

  it('a route that RE-ENTERS the record (fresh payload / history merge) reuses its alias instead of minting a new one', () => {
    const rows: any[] = [expiredRecord()];
    const active = activeOwners();
    repairExpiredRoutesAgainstActive(rows, active);
    const settledAliases = aliasesOf(rows);

    for (let crawl = 1; crawl <= PASSES; crawl += 1) {
      // what a re-archived payload / transferred history does: the colliding stem is back, flat
      rows[0].previousSlugs = [...(rows[0].previousSlugs ?? []), ...stemsOf(6)];
      const result = repairExpiredRoutesAgainstActive(rows, active);
      expect(result.changed, `crawl ${crawl}`).toBeGreaterThan(0); // the stem WAS moved again...
      expect([...aliasesOf(rows)].sort(), `crawl ${crawl}`).toEqual([...settledAliases].sort()); // ...onto the SAME aliases
    }
  });

  it('the old behaviour is gone: an owned alias is never discarded for attempt+1', () => {
    const rows: any[] = [expiredRecord()];
    const active = activeOwners();
    repairExpiredRoutesAgainstActive(rows, active);
    const perStem = (stem: string) => [...aliasesOf(rows)].filter((a) => a.startsWith(`${stem}-`) && a.length === stem.length + 9);
    for (let i = 0; i < 4; i += 1) {
      rows[0].previousSlugs = stemsOf(6);
      repairExpiredRoutesAgainstActive(rows, active);
    }
    // one alias per (stem, locale) at most — never the 197 per stem seen in production
    for (const stem of stemsOf(6)) expect(perStem(stem).length).toBeLessThanOrEqual(LOCALES.length);
  });

  it('still refuses to touch a route whose active owner is the same posting', () => {
    const rows: any[] = [expiredRecord({ sourceIdentity: 'url:https://jobs.example/denner/active-0' })];
    const before = clone(rows);
    const result = repairExpiredRoutesAgainstActive(rows, [activeOwners()[0]]);
    expect(result.changed).toBe(0);
    expect(rows).toEqual(before);
  });

  it('never reuses an alias another record holds', () => {
    const a: any = expiredRecord();
    const b: any = expiredRecord({ slug: 'verkaeufer-denner-zug', slugByLocale: { it: 'venditore-denner-zug', en: 'x-zug', de: 'y-zug', fr: 'z-zug' }, sourceIdentity: 'url:https://jobs.example/denner/expired-b' });
    const rows = [a, b];
    const active = activeOwners();
    repairExpiredRoutesAgainstActive(rows, active);
    repairExpiredRoutesAgainstActive(rows, active);
    for (const locale of LOCALES) {
      const keys = (row: any) => new Set<string>([
        ...(row.previousSlugsByLocale?.[locale] ?? []),
        ...(row.previousSlugs ?? []),
      ].filter((s: string) => HEX8.test(s)));
      const shared = [...keys(a)].filter((s) => keys(b).has(s));
      expect(shared, locale).toEqual([]);
    }
  });
});

describe('repairExpiredRoutesWithinArchive is idempotent', () => {
  const twin = (identity: string, slug: string) => expiredRecord({
    slug,
    slugByLocale: { it: slug, en: `${slug}-en`, de: `${slug}-de`, fr: `${slug}-fr` },
    sourceIdentity: identity,
    previousSlugs: ['verkaufer-in-denner', 'verkaufer-in-denner-2'],
  });

  it('two distinct expired postings sharing history: first pass separates them, then nothing changes', () => {
    const rows: any[] = [twin('url:https://jobs.example/a', 'denner-a'), twin('url:https://jobs.example/b', 'denner-b')];
    const first = repairExpiredRoutesWithinArchive(rows, {});
    expect(first.changed).toBeGreaterThan(0);
    const settled = clone(rows);
    const settledAliases = aliasesOf(rows);
    for (let pass = 2; pass <= PASSES; pass += 1) {
      expect(repairExpiredRoutesWithinArchive(rows, {}).changed, `pass ${pass}`).toBe(0);
      expect(rows).toEqual(settled);
      expect(aliasesOf(rows).size).toBe(settledAliases.size);
    }
  });

  it('with repairUnprovenCollisions, and when the shared route re-enters, the aliases stay the same set', () => {
    const rows: any[] = [twin('url:https://jobs.example/a', 'denner-a'), twin('url:https://jobs.example/b', 'denner-b')];
    repairExpiredRoutesWithinArchive(rows, { repairUnprovenCollisions: true });
    const settledAliases = [...aliasesOf(rows)].sort();
    for (let i = 0; i < PASSES; i += 1) {
      for (const row of rows) row.previousSlugs = [...(row.previousSlugs ?? []), 'verkaufer-in-denner', 'verkaufer-in-denner-2'];
      repairExpiredRoutesWithinArchive(rows, { repairUnprovenCollisions: true });
      expect([...aliasesOf(rows)].sort()).toEqual(settledAliases);
    }
  });
});

describe('the REAL sequence of passes of the pipeline, repeated', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-alias-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // crawl: a removed job is archived (archiveRemovedJobsToSlice, with the active set), then the assemble
  // step canonicalises the slice (collapseDuplicateRouteEntries) and repairs it against the active set.
  const removedJob = () => ({
    slug: 'verkaufer-in-denner',
    slugByLocale: { it: 'verkaufer-in-denner', en: 'verkaufer-in-denner', de: 'verkaufer-in-denner', fr: 'verkaufer-in-denner' },
    previousSlugs: stemsOf(6).slice(1),
    url: 'https://jobs.example/denner/removed-job',
    title: 'Verkäufer/in', company: 'Denner AG', companyKey: 'denner',
    location: 'Horgen', addressLocality: 'Horgen',
  });
  // the stem is now owned by another, still active, Denner posting
  const stillActive = () => activeOwners().map((job) => ({ ...job }));

  it('after the first pass: zero changes, no new record, no new alias — N=5', () => {
    const active = stillActive();
    let state: any[] = [];
    const snapshots: string[] = [];
    const aliasCounts: number[] = [];
    for (let pass = 1; pass <= PASSES; pass += 1) {
      archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: active });
      const collapsed = collapseDuplicateRouteEntries(readExpiredSlice('denner', { dir }), { source: 'test' });
      const repaired = repairExpiredRoutesAgainstActive(collapsed.entries, active);
      state = repaired.entries as any[];
      fs.writeFileSync(path.join(dir, 'denner.json'), JSON.stringify(state));
      snapshots.push(JSON.stringify(state));
      aliasCounts.push(aliasesOf(state).size);
      if (pass > 1) {
        expect(collapsed.collapsed + collapsed.repairedRoutes + repaired.changed, `pass ${pass}`).toBe(0);
      }
    }
    expect(aliasCounts[0]).toBeGreaterThan(0);
    expect(new Set(aliasCounts).size).toBe(1);
    expect(new Set(snapshots.slice(1)).size).toBe(1);
    expect(state).toHaveLength(1);
  });

  it('re-archiving a job whose record was already moved to an alias does not create a second record', () => {
    const active = stillActive();
    archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: active });
    const rows = readExpiredSlice('denner', { dir }) as any[];
    expect(rows[0].slug).toMatch(HEX8); // the repair moved the record's own slug to the alias
    for (let i = 0; i < PASSES; i += 1) {
      expect(archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: active })).toBe(0);
    }
    expect(readExpiredSlice('denner', { dir })).toHaveLength(1);
  });

  it('a route nobody serves any more is still archived (no URL becomes a 404)', () => {
    archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: [] });
    const other = { ...removedJob(), slug: 'a-route-only-the-new-job-had', slugByLocale: { it: 'a-route-only-the-new-job-had' }, previousSlugs: [] };
    // same posting, different slug, and its route is held by neither the archived record nor an active job
    expect(archiveRemovedJobsToSlice([other], 'denner', { dir, activeJobs: [] })).toBe(1);
  });
});

describe('replaceSlugRouteEverywhere: cap and dedupe', () => {
  const recordWith = (lengths: Record<string, number>) => {
    const job: any = { id: 'job-1', slug: 'x', previousSlugs: ['stem'], previousSlugsByLocale: {} };
    for (const [locale, n] of Object.entries(lengths)) {
      job.previousSlugsByLocale[locale] = Array.from({ length: n }, (_, i) => `${locale}-old-${i}`);
    }
    return job;
  };

  it('expands a flat route into the other locales through the shared cap and journals cap-trim', () => {
    const job = recordWith({ en: 20, de: 20, fr: 20 });
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test', cap: 20 });
    for (const locale of ['en', 'de', 'fr']) {
      expect(job.previousSlugsByLocale[locale]).toHaveLength(20);
      expect(job.previousSlugsByLocale[locale]).toContain('stem'); // the newest entries survive
    }
    expect(job.previousSlugsByLocale.it).toEqual(['stem-aaaaaaaa']);
    expect(job.previousSlugs).toBeUndefined();
    expect(summarize().capTrimmed).toBe(3);
  });

  it('never trims a legacy list that is ALREADY over the cap (that would 404 published routes)', () => {
    const job = recordWith({ en: 40, de: 3, fr: 3 });
    const before = [...job.previousSlugsByLocale.en];
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test', cap: 20 });
    expect(job.previousSlugsByLocale.en).toEqual([...before, 'stem']);
    expect(summarize().capTrimmed).toBe(0);
  });

  it('renaming into a route the record already holds leaves it once, so a second application is a no-op', () => {
    const job: any = { id: 'job-2', previousSlugsByLocale: { de: ['stem', 'stem-aaaaaaaa', 'other'] } };
    expect(replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'de', source: 'test' })).toBe(1);
    expect(job.previousSlugsByLocale.de).toEqual(['stem-aaaaaaaa', 'other']);
    const settled = clone(job);
    expect(replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'de', source: 'test' })).toBe(0);
    expect(job).toEqual(settled);
  });
});

describe('isValidJobSlug', () => {
  it.each(['0-0-0-0-0', '0', '00-11', '1234-5678', '---', '123'])('rejects a slug without any letter: %s', (slug) => {
    expect(isValidJobSlug(slug)).toBe(false);
  });
  it.each(['verkaufer-in-denner', 'abc-0', 'mitarbeiter-123', 'ingénieur-2', 'verkaufer-in-denner-0cbeef4c', 'a-1-b'])('keeps a real slug: %s', (slug) => {
    expect(isValidJobSlug(slug)).toBe(true);
  });
  it('keeps the existing rules', () => {
    expect(isValidJobSlug('ab')).toBe(false);
    expect(isValidJobSlug('page/2')).toBe(false);
    expect(isValidJobSlug('undefined-job')).toBe(false);
  });
});
