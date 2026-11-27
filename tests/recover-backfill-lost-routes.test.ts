import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST_PATH,
  assertAdditiveRecovery,
  main,
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

describe('--write takes ownership evidence from committable files only', () => {
  const ACTIVE = 'data/jobs/by-crawler/acme.json';
  const EXPIRED = 'data/jobs/expired/by-crawler/acme.json';
  const SHARD = 'data/jobs/expired/by-crawler/acme.shard-001.json';
  const holder = record('attivo-acme', OTHER, { previousSlugsByLocale: { it: ['cuoco-acme-perso'] } });
  const text = (rows: object[]) => `${JSON.stringify(rows, null, 2)}\n`;

  // A real index: the script decides what is committable by asking git.
  const repo = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-routes-git-'));
    dirs.push(root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
    const put = (file: string, rows: object[]) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text(rows));
    };
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ targets: [target({ it: ['cuoco-acme-perso'] })] }));
    git('init', '-q');
    put(EXPIRED, [record('cuoco-acme', OWNER)]);
    put(ACTIVE, [record('commesso-acme', OTHER)]);
    git('add', '--', 'data');
    const run = () => main(['--write'], { rootDir: root, manifestPath });
    return { root, git, put, read, run, original: read(EXPIRED) };
  };

  it.each([
    ['an untracked active slice', 'data/jobs/by-crawler/nuovo.json'],
    ['an untracked expired slice', 'data/jobs/expired/by-crawler/altro.json'],
    ['an untracked shard of a target crawler', SHARD],
  ])('fails before writing when %s serves a manifest route', (_label, file) => {
    const { put, read, run, original } = repo();
    put(file, [holder]);

    expect(run).toThrow(`untracked job slice: ${file}`);
    expect(read(EXPIRED)).toBe(original);
    expect(read(file)).toBe(text([holder]));
  });

  it.each([
    ['an active slice', ACTIVE, [holder]],
    ['a target slice', EXPIRED, [record('cuoco-acme', OWNER, { title: 'ritoccato' })]],
    ['a target slice that gained the route by hand', EXPIRED, [record('cuoco-acme', OWNER), holder]],
  ])('fails before writing when %s has an unstaged edit', (_label, file, rows) => {
    const { put, read, run } = repo();
    put(file, rows);
    const expired = read(EXPIRED);

    expect(run).toThrow(`uncommittable local change: ${file}`);
    expect(read(EXPIRED)).toBe(expired);
  });

  it('stays idempotent over its own unstaged output, then over the staged one', () => {
    const { git, read, run, original } = repo();
    run();
    const written = read(EXPIRED);
    expect(written).not.toBe(original);
    expect(keys(JSON.parse(written))).toContain('it:cuoco-acme-perso');

    run();
    expect(read(EXPIRED)).toBe(written);
    git('add', '--', 'data');
    run();
    expect(read(EXPIRED)).toBe(written);
  });

  it('reads a slice that the checkout left out from the index', () => {
    const { root, git, put, read, run, original } = repo();
    put(ACTIVE, [holder]);
    git('add', '--', ACTIVE);
    fs.rmSync(path.join(root, ACTIVE));
    run();

    expect(read(EXPIRED)).toBe(original);
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
