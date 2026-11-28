// A deterministic collision alias is a DIFFERENT URL: a record holding `<stem>-<hex8>` does not serve
// `<stem>`. `absorb` once treated the alias as proof that the stem was served and dropped it with the
// incoming payload, so the original URL had no holder left (28 Nov 2026 crawler wave: concordia
// cb10374597a, etat-de-fribourg 52966495dd9, coop-ticino 1b1cc654b7a).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveRemovedJobsToSlice,
  createSameIdentityArchiveIndex,
  localeRouteKeys,
  readExpiredSlice,
  repairExpiredRoutesAgainstActive,
} from '../scripts/lib/expired-jobs-archive.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const STEM = 'sachbearbeiter-musterfirma-musterort';

const posting = (url = 'https://jobs.example/musterfirma/posting-a') => ({
  slug: STEM,
  slugByLocale: Object.fromEntries(LOCALES.map((l) => [l, STEM])),
  url,
  title: 'Sachbearbeiter', company: 'Musterfirma', companyKey: 'musterfirma',
});
/** Another posting that owns the stem while it is still published. */
const stemOwner = () => posting('https://jobs.example/musterfirma/posting-b');
const stemKeys = LOCALES.map((l) => `${l}:${STEM}`);
const servedBy = (rows: any[]) => new Set(rows.flatMap((row) => [...localeRouteKeys(row)]));

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorb-stem-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = () => readExpiredSlice('musterfirma', { dir }) as any[];

/** Archive the posting while another one owns the stem: the record moves to the alias. */
const seedAliasOnlyRecord = () => {
  archiveRemovedJobsToSlice([posting()], 'musterfirma', { dir, activeJobs: [stemOwner()] });
  const rows = read();
  expect(rows).toHaveLength(1);
  for (const key of stemKeys) expect(servedBy(rows).has(key), key).toBe(false);
  return [...localeRouteKeys(rows[0])];
};

describe('absorb: holding an alias of a route is not serving the route', () => {
  it.each([
    ['the caller knows the active set and the stem owner is gone', { activeJobs: [] as any[] }],
    ['the caller passes no active set', {}],
  ])('keeps the original URL when nobody else serves it (%s)', (_name, opts) => {
    const aliasRoutes = seedAliasOnlyRecord();
    expect(archiveRemovedJobsToSlice([posting()], 'musterfirma', { dir, ...opts })).toBe(0);
    const rows = read();
    expect(rows).toHaveLength(1);
    // the stem is back, and the aliases the record already served are all still there
    for (const key of [...stemKeys, ...aliasRoutes]) expect(servedBy(rows).has(key), key).toBe(true);
    // the same call again changes nothing
    const settled = JSON.stringify(rows);
    expect(archiveRemovedJobsToSlice([posting()], 'musterfirma', { dir, ...opts })).toBe(0);
    expect(JSON.stringify(read())).toBe(settled);
  });

  it('does not copy the stem while an active posting serves it', () => {
    seedAliasOnlyRecord();
    const before = JSON.stringify(read());
    expect(archiveRemovedJobsToSlice([posting()], 'musterfirma', { dir, activeJobs: [stemOwner()] })).toBe(0);
    expect(JSON.stringify(read())).toBe(before);
  });

  it('does not copy the stem while another record of the slice serves it', () => {
    seedAliasOnlyRecord();
    const record = read()[0];
    const holder = {
      ...stemOwner(),
      sourceIdentity: 'url:https://jobs.example/musterfirma/posting-b',
    };
    const index = createSameIdentityArchiveIndex([record, holder]);
    const result = index.absorb({ ...posting(), sourceIdentity: record.sourceIdentity });
    expect(result).toEqual({ record, changed: false });
  });
});

describe('absorb: the master slug of the payload is one of its URLs', () => {
  // The master differs from every locale slug, so `localeRouteKeys` does not list it.
  const MASTER = `${STEM}-0a1b2c3d4e`;
  const withOwnMaster = () => ({ ...posting(), slug: MASTER });

  it('keeps it when the posting is already archived under another slug', () => {
    archiveRemovedJobsToSlice([posting()], 'musterfirma', { dir });
    expect(servedBy(read()).has(`it:${MASTER}`)).toBe(false);
    expect(archiveRemovedJobsToSlice([withOwnMaster()], 'musterfirma', { dir })).toBe(0);
    const rows = read();
    expect(rows).toHaveLength(1);
    expect(servedBy(rows).has(`it:${MASTER}`)).toBe(true);
    const settled = JSON.stringify(rows);
    expect(archiveRemovedJobsToSlice([withOwnMaster()], 'musterfirma', { dir })).toBe(0);
    expect(JSON.stringify(read())).toBe(settled);
  });
});

describe('absorb: record and payload share a master slug that is not their Italian route', () => {
  const MASTER = `${STEM}-master`;
  const sharedMaster = () => ({
    ...posting(),
    slug: MASTER,
    slugByLocale: Object.fromEntries(LOCALES.map((l) => [l, `${STEM}-localized-${l}`])),
    sourceIdentity: 'url:https://jobs.example/musterfirma/posting-a',
  });

  it('adds the Italian master route once', () => {
    const record: any = sharedMaster();
    expect(localeRouteKeys(record).has(`it:${MASTER}`)).toBe(false);
    const index = createSameIdentityArchiveIndex([record]);
    expect(index.absorb(sharedMaster())).toEqual({ record, changed: true });
    expect(localeRouteKeys(record).has(`it:${MASTER}`)).toBe(true);
    const settled = JSON.stringify(record);
    expect(index.absorb(sharedMaster())).toEqual({ record, changed: false });
    expect(JSON.stringify(record)).toBe(settled);
  });

  it('when a distinct active posting owns it, every later cycle reuses one alias and grows nothing', () => {
    const record: any = sharedMaster();
    const owner = { ...stemOwner(), slug: MASTER, slugByLocale: { it: MASTER } };
    const states: string[] = [];
    const routes: string[] = [];
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      expect(createSameIdentityArchiveIndex([record]).absorb(sharedMaster())).not.toBeNull();
      repairExpiredRoutesAgainstActive([record], [owner]);
      states.push(JSON.stringify(record));
      routes.push([...localeRouteKeys(record)].sort().join());
    }
    expect(new Set(routes).size).toBe(1);
    expect(new Set(states.slice(1)).size).toBe(1);
  });
});
