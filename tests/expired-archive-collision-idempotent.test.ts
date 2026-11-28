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
  localeRouteKeys,
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

  // One production cycle. `assemble-jobs-dataset.mjs:1842` and the ~25 update-*.mjs archive WITHOUT
  // activeJobs; `crawler-template` / `assemble:2977` archive WITH them; then the assemble step collapses
  // and repairs the slice.
  type Step = 'archive-without-active' | 'archive-with-active';
  const cycle = (steps: Step[], active: any[]) => {
    for (const step of steps) {
      archiveRemovedJobsToSlice([removedJob()], 'denner', step === 'archive-with-active' ? { dir, activeJobs: active } : { dir });
    }
    const collapsed = collapseDuplicateRouteEntries(readExpiredSlice('denner', { dir }), { source: 'test' });
    const repaired = repairExpiredRoutesAgainstActive(collapsed.entries, active);
    fs.writeFileSync(path.join(dir, 'denner.json'), JSON.stringify(repaired.entries));
    return { state: repaired.entries as any[], churn: collapsed.collapsed + collapsed.repairedRoutes + repaired.changed };
  };

  // A writer without activeJobs cannot know that a still-active posting owns the stem: its input is the
  // same as when nobody serves it, so it restores the stem (tests/expired-absorb-alias-stem.test.ts).
  // When no later step of the cycle passes activeJobs, the assemble repair then moves the 6 stems x 4
  // locales back onto the aliases the record already holds: same moves, same bytes, every cycle.
  it.each([
    ['without activeJobs first, then with (assemble:1842 then crawler-template)', ['archive-without-active', 'archive-with-active'] as Step[], 0],
    ['with activeJobs first, then without (reverse order)', ['archive-with-active', 'archive-without-active'] as Step[], stemsOf(6).length * LOCALES.length],
    ['without activeJobs only (the ~25 update-*.mjs crawlers)', ['archive-without-active'] as Step[], stemsOf(6).length * LOCALES.length],
  ])('N=5 cycles, %s: after the first cycle zero new records, aliases or URLs', (_name, steps, repeatedMoves) => {
    const active = stillActive();
    const snapshots: string[] = [];
    const aliasCounts: number[] = [];
    const recordCounts: number[] = [];
    let firstCycleRoutes = new Set<string>();
    for (let n = 1; n <= PASSES; n += 1) {
      const { state, churn } = cycle(steps, active);
      const served = new Set(state.flatMap((row) => [...localeRouteKeys(row)]));
      if (n === 1) firstCycleRoutes = served;
      // every cycle serves exactly the URLs of the first one: none lost, none minted
      expect([...served].sort(), `cycle ${n}`).toEqual([...firstCycleRoutes].sort());
      snapshots.push(JSON.stringify(state));
      aliasCounts.push(aliasesOf(state).size);
      recordCounts.push(state.length);
      if (n > 1) expect(churn, `cycle ${n}`).toBe(repeatedMoves);
    }
    expect(aliasCounts[0]).toBeGreaterThan(0);
    expect(new Set(aliasCounts).size).toBe(1);
    expect(new Set(recordCounts)).toEqual(new Set([1]));
    // the stored bytes settle from the second cycle: moving a restored stem back onto the record's
    // current slug leaves that slug in the history once (tests/expired-active-route-collision.test.ts)
    expect(new Set(snapshots.slice(1)).size).toBe(1);
  });

  it('archiving without activeJobs a job whose original route a still-active posting holds does not create a second record', () => {
    const active = stillActive();
    cycle(['archive-with-active'], active); // the record's slug is now an alias
    expect((readExpiredSlice('denner', { dir }) as any[])[0].slug).toMatch(HEX8);
    for (let i = 0; i < PASSES; i += 1) {
      // no activeJobs: the writer cannot know the stem belongs to an active posting
      expect(archiveRemovedJobsToSlice([removedJob()], 'denner', { dir })).toBe(0);
      expect(readExpiredSlice('denner', { dir })).toHaveLength(1);
    }
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

  it('a route nobody serves is MERGED into the existing record, not into a second one, and is not lost', () => {
    archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: [] });
    const other = { ...removedJob(), slug: 'a-route-only-the-new-job-had', slugByLocale: { it: 'a-route-only-the-new-job-had' }, previousSlugs: [] };
    // same posting, different slug; the route is held by neither the record, an alias of it, nor anything else
    expect(archiveRemovedJobsToSlice([other], 'denner', { dir, activeJobs: [] })).toBe(0);
    const rows = readExpiredSlice('denner', { dir }) as any[];
    expect(rows).toHaveLength(1);
    expect(localeRouteKeys(rows[0]).has('it:a-route-only-the-new-job-had')).toBe(true);
    // and doing it again changes nothing
    const settled = clone(rows);
    expect(archiveRemovedJobsToSlice([other], 'denner', { dir, activeJobs: [] })).toBe(0);
    expect(readExpiredSlice('denner', { dir })).toEqual(settled);
  });

  describe('one call, one source identity, several slugs', () => {
    const sameJob = (slug: string, extra: Partial<Record<string, unknown>> = {}) => ({
      slug,
      slugByLocale: { it: slug, en: `${slug}-en`, de: `${slug}-de`, fr: `${slug}-fr` },
      previousSlugs: [`${slug}-old`],
      url: 'https://jobs.example/denner/one-posting',
      title: 'Verkäufer/in', company: 'Denner AG', companyKey: 'denner',
      ...extra,
    });
    const routesOf = (jobs: any[]) => new Set(jobs.flatMap((job) => [...localeRouteKeys(job)]));

    it.each([
      ['two entries', ['slug-a', 'slug-b']],
      ['three entries', ['slug-a', 'slug-b', 'slug-c']],
    ])('existing=[] and %s with one sourceIdentity: one persisted record, added === 1, no route lost', (_name, slugs) => {
      const jobs = slugs.map((slug) => sameJob(slug));
      expect(archiveRemovedJobsToSlice(jobs, 'denner', { dir })).toBe(1);
      const rows = readExpiredSlice('denner', { dir }) as any[];
      expect(rows).toHaveLength(1);
      const served = routesOf(rows);
      for (const route of routesOf(jobs)) expect(served.has(route), route).toBe(true);
      // repeating the call adds nothing and serves the same routes (a same-slug payload refreshes
      // `expiredAt`, which is the documented behaviour, so compare without it)
      const withoutClock = (list: any[]) => list.map(({ expiredAt: _expiredAt, ...rest }) => rest);
      expect(archiveRemovedJobsToSlice(jobs, 'denner', { dir })).toBe(0);
      const again = readExpiredSlice('denner', { dir }) as any[];
      expect(again).toHaveLength(1);
      expect(routesOf(again)).toEqual(served);
      expect(withoutClock(again)).toEqual(withoutClock(rows));
    });

    it('a distinct identity in the same call still gets its own record', () => {
      const jobs = [sameJob('slug-a'), sameJob('slug-b'), sameJob('slug-other', { url: 'https://jobs.example/denner/another-posting' })];
      expect(archiveRemovedJobsToSlice(jobs, 'denner', { dir })).toBe(2);
      expect(readExpiredSlice('denner', { dir })).toHaveLength(2);
    });

    it('a same-slug replacement inside the call keeps the index coherent: its identity history is indexed', () => {
      archiveRemovedJobsToSlice([sameJob('slug-a')], 'denner', { dir });
      // the replacement (same slug, newer payload, ANOTHER identity) inherits the old identity through
      // mergeSourceIdentityHistory, so a later job of the same call with the OLD identity joins it
      const replacement = sameJob('slug-a', { url: 'https://jobs.example/denner/replacement-posting' });
      const returning = sameJob('slug-z');
      expect(archiveRemovedJobsToSlice([replacement, returning], 'denner', { dir })).toBe(0);
      const rows = readExpiredSlice('denner', { dir }) as any[];
      expect(rows).toHaveLength(1);
      const served = routesOf(rows);
      for (const route of [...routesOf([replacement]), ...routesOf([returning])]) expect(served.has(route), route).toBe(true);
    });
  });

  it('a route another record of the slice serves is not copied into the existing record', () => {
    archiveRemovedJobsToSlice([removedJob()], 'denner', { dir, activeJobs: [] });
    const rows = readExpiredSlice('denner', { dir }) as any[];
    const stranger = expiredRecord({
      slug: 'the-stranger-slug',
      slugByLocale: { it: 'the-stranger-slug' },
      sourceIdentity: 'url:https://jobs.example/denner/stranger',
      previousSlugs: ['route-only-the-stranger-serves'],
    });
    fs.writeFileSync(path.join(dir, 'denner.json'), JSON.stringify([...rows, stranger]));
    const other = { ...removedJob(), slug: 'brand-new-slug-of-the-same-job', slugByLocale: { it: 'brand-new-slug-of-the-same-job' }, previousSlugs: ['route-only-the-stranger-serves'] };
    expect(archiveRemovedJobsToSlice([other], 'denner', { dir })).toBe(0);
    const after = readExpiredSlice('denner', { dir }) as any[];
    expect(after).toHaveLength(2);
    const owner = after.find((r) => r.sourceIdentity !== stranger.sourceIdentity)!;
    expect(localeRouteKeys(owner).has('it:brand-new-slug-of-the-same-job')).toBe(true); // its own route is kept
    expect(localeRouteKeys(owner).has('it:route-only-the-stranger-serves')).toBe(false); // the stranger's is not copied
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

  it('never removes a route: expanding a flat route past the cap keeps every entry and journals cap-exceeded', () => {
    const job = recordWith({ en: 20, de: 20, fr: 20 });
    const before = Object.fromEntries(['en', 'de', 'fr'].map((l) => [l, [...job.previousSlugsByLocale[l]]]));
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test', cap: 20 });
    for (const locale of ['en', 'de', 'fr']) {
      // 20 -> 21: the oldest entry (a served expired page) is still there, plus the preserved stem
      expect(job.previousSlugsByLocale[locale]).toEqual([...before[locale], 'stem']);
    }
    expect(job.previousSlugsByLocale.it).toEqual(['stem-aaaaaaaa']);
    expect(job.previousSlugs).toBeUndefined();
    const summary = summarize();
    expect(summary.capTrimmed).toBe(0);
    expect(summary.capExceeded).toBe(3);
    expect(summary.net).toBe(summary.captured + summary.restored - summary.dropped); // cap-exceeded is not a loss
  });

  it('a legacy list already over the cap is not touched either (only noted)', () => {
    const job = recordWith({ en: 40, de: 3, fr: 3 });
    const before = [...job.previousSlugsByLocale.en];
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test', cap: 20 });
    expect(job.previousSlugsByLocale.en).toEqual([...before, 'stem']);
    expect(summarize().capTrimmed).toBe(0);
    expect(summarize().capExceeded).toBeGreaterThan(0);
  });

  it('within the cap nothing is journaled', () => {
    const job = recordWith({ en: 3, de: 3, fr: 3 });
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test', cap: 20 });
    expect(summarize().capExceeded).toBe(0);
  });

  it('an alias the record already serves from the FLAT view stays served in every locale', () => {
    // A flat slug that also sits in one locale bucket is read as attributed to that bucket only
    // (getPreviousSlugsForLocale): copying the alias into `it` would drop it from en/de/fr.
    const job: any = { id: 'job-3', slug: 'x', previousSlugs: ['stem', 'stem-aaaaaaaa'] };
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test' });
    const served = localeRouteKeys(job);
    for (const locale of LOCALES) expect(served.has(`${locale}:stem-aaaaaaaa`), locale).toBe(true);
    expect(served.has('it:stem')).toBe(false); // moved away from the colliding locale
    for (const locale of ['en', 'de', 'fr']) expect(served.has(`${locale}:stem`), locale).toBe(true); // still served elsewhere
    expect(job.previousSlugsByLocale.it).not.toContain('stem-aaaaaaaa');
  });

  it('the same holds when the stem sits in a locale bucket and the alias in the flat view', () => {
    const job: any = { id: 'job-4', slug: 'x', previousSlugs: ['stem-aaaaaaaa'], previousSlugsByLocale: { it: ['stem'], en: ['stem'] } };
    replaceSlugRouteEverywhere(job, 'stem', 'stem-aaaaaaaa', { locale: 'it', source: 'test' });
    const served = localeRouteKeys(job);
    for (const locale of LOCALES) expect(served.has(`${locale}:stem-aaaaaaaa`), locale).toBe(true);
    expect(served.has('it:stem')).toBe(false);
    expect(served.has('en:stem')).toBe(true);
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
