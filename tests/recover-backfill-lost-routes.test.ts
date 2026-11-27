import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST_PATH,
  assertAdditiveRecovery,
  recoverCrawlerRows,
  runRecovery,
} from '../scripts/recover-backfill-lost-routes.mjs';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';

const OWNER = 'url:https://jobs.example.test/postings/1111';
const OTHER = 'url:https://jobs.example.test/postings/2222';

const record = (slug: string, sourceIdentity: string, extra: Record<string, unknown> = {}) => ({
  slug,
  companyKey: 'acme',
  sourceIdentity,
  title: slug,
  slugByLocale: { it: slug },
  previousSlugsByLocale: { de: [`${slug}-alt`] },
  previousSlugCantonByLocale: { de: { [`${slug}-alt`]: 'ZH' } },
  expiredAt: '2025-01-01T00:00:00.000Z',
  ...extra,
});

const target = (routes: Record<string, string[]>, extra: Record<string, unknown> = {}) => ({
  crawlerKey: 'acme',
  slug: 'cuoco-acme',
  companyKey: 'acme',
  sourceIdentity: OWNER,
  routes,
  cantons: { it: { 'cuoco-acme-perso': 'TI' } },
  ...extra,
});

const keys = (rows: object[]) => rows.flatMap((row) => [...localeRouteKeys(row)]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('recoverCrawlerRows', () => {
  it('adds the lost routes to the proven record only, with their canton', () => {
    const rows = [record('cuoco-acme', OWNER), record('sarto-acme', OTHER)];
    const result = recoverCrawlerRows(rows, [target({ it: ['cuoco-acme-perso'] })], new Set(keys(rows)));

    expect(result.added).toEqual(['it:cuoco-acme-perso']);
    expect([...localeRouteKeys(result.rows[0])]).toContain('it:cuoco-acme-perso');
    expect(result.rows[0].previousSlugCantonByLocale.it['cuoco-acme-perso']).toBe('TI');
    expect(result.rows[1]).toEqual(rows[1]);
    expect(rows[0].previousSlugsByLocale).toEqual({ de: ['cuoco-acme-alt'] });
  });

  it('restores a stem although the record holds a collision alias of it', () => {
    const rows = [record('cuoco-acme', OWNER, {
      previousSlugsByLocale: { it: ['cuoco-acme-perso-0a1b2c3d'] },
    })];
    const result = recoverCrawlerRows(rows, [target({ it: ['cuoco-acme-perso'] })], new Set(keys(rows)));

    expect(result.rows[0].previousSlugsByLocale.it).toEqual(['cuoco-acme-perso-0a1b2c3d', 'cuoco-acme-perso']);
  });

  it('leaves a route that any record already serves where it is', () => {
    const rows = [record('cuoco-acme', OWNER)];
    const held = new Set([...keys(rows), 'it:cuoco-acme-perso']);
    const result = recoverCrawlerRows(rows, [target({ it: ['cuoco-acme-perso'] })], held);

    expect(result.added).toEqual([]);
    expect(result.rows).toEqual(rows);
    expect(result.skipped).toEqual([{ key: 'it:cuoco-acme-perso', reason: 'already-served' }]);
  });

  it.each([
    ['another source identity', [record('cuoco-acme', OTHER)], 0],
    ['another company', [record('cuoco-acme', OWNER, { companyKey: 'globex' })], 0],
    ['two matching records', [record('cuoco-acme', OWNER), record('cuoco-acme', OWNER)], 2],
  ])('writes nothing when the target has %s', (_label, rows, matches) => {
    const result = recoverCrawlerRows(rows, [target({ it: ['cuoco-acme-perso'] })], new Set(keys(rows)));

    expect(result.added).toEqual([]);
    expect(result.rows).toEqual(rows);
    expect(result.skipped[0].reason).toBe(`target-matches-${matches}`);
  });
});

describe('assertAdditiveRecovery', () => {
  const rows = [record('cuoco-acme', OWNER)];
  const options = { allowed: new Set(['it:nuovo']), heldKeys: new Set<string>() };
  const mutate = (change: (copy: any[]) => void) => {
    const copy = structuredClone(rows) as any[];
    change(copy);
    return () => assertAdditiveRecovery(rows, copy, options);
  };

  it('refuses every non-additive change', () => {
    expect(mutate((copy) => copy.pop())).toThrow('record count');
    expect(mutate((copy) => { copy[0].title = 'x'; })).toThrow('field title');
    expect(mutate((copy) => { copy[0].previousSlugsByLocale.de = []; })).toThrow('stored route removed');
    expect(mutate((copy) => { copy[0].previousSlugCantonByLocale.de['cuoco-acme-alt'] = 'TI'; })).toThrow('route canton');
    expect(mutate((copy) => { copy[0].previousSlugsByLocale.it = ['altro']; })).toThrow('unexpected route');
  });

  it('refuses a route that is held elsewhere', () => {
    const copy = structuredClone(rows) as any[];
    copy[0].previousSlugsByLocale.it = ['nuovo'];
    expect(() => assertAdditiveRecovery(rows, copy, { ...options, heldKeys: new Set(['it:nuovo']) }))
      .toThrow('already held');
  });
});

describe('runRecovery on a sharded archive', () => {
  it('keeps every record in its file, leaves clean files byte-identical and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-routes-'));
    dirs.push(dir);
    // `sarto-acme` sits in both files: the store writer would re-home the copy.
    const monolith = [record('sarto-acme', OTHER)];
    const shard = [record('sarto-acme', OTHER), record('cuoco-acme', OWNER)];
    const write = (name: string, rows: object[]) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(rows, null, 2)}\n`);
    write('acme.json', monolith);
    write('acme.shard-001.json', shard);
    const monolithBytes = fs.readFileSync(path.join(dir, 'acme.json'), 'utf8');
    const manifest = { targets: [target({ it: ['cuoco-acme-perso'] })] };
    const heldKeys = new Set(keys([...monolith, ...shard]));

    expect(runRecovery({ manifest, expiredDir: dir, heldKeys }).added).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'acme.shard-001.json'), 'utf8')).toBe(`${JSON.stringify(shard, null, 2)}\n`);

    runRecovery({ manifest, expiredDir: dir, heldKeys, write: true });
    expect(fs.readFileSync(path.join(dir, 'acme.json'), 'utf8')).toBe(monolithBytes);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'acme.shard-001.json'), 'utf8'));
    expect(written.map((row: { slug: string }) => row.slug)).toEqual(['sarto-acme', 'cuoco-acme']);
    expect(keys(written)).toContain('it:cuoco-acme-perso');

    const second = runRecovery({
      manifest, expiredDir: dir, heldKeys: new Set(keys([...monolith, ...written])), write: true,
    });
    expect(second.added).toEqual([]);
  });
});

describe('committed manifest', () => {
  it('assigns each route to one target that declares a source identity', () => {
    const { targets } = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'));
    const routes = targets.flatMap((entry: any) => Object.entries(entry.routes)
      .flatMap(([locale, slugs]) => (slugs as string[]).map((slug) => `${locale}:${slug}`)));

    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes).size).toBe(routes.length);
    for (const entry of targets) {
      expect(entry.sourceIdentity).toMatch(/^(url|id):/);
      expect(entry.slug && entry.companyKey && entry.crawlerKey).toBeTruthy();
    }
  });
});
