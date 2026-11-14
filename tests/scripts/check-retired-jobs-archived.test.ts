// @vitest-environment node
/**
 * Observer contract (scripts/ci/check-retired-jobs-archived.mjs): between two
 * revisions, a posting that leaves the active set must be served at head by an
 * active row or by an expired entry WITH a title; an archive record with a
 * title must not vanish. Either gap is a job URL the build turns into the
 * noindex «Offerta non verificata» stub.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { measureRetiredArchiveCoverage } from '../../scripts/ci/check-retired-jobs-archived.mjs';

type Row = Record<string, any>;
const job = (slug: string, extra: Row = {}): Row => ({
  slug,
  slugByLocale: { it: slug },
  title: `T ${slug}`,
  canton: 'TI',
  ...extra,
});
const map = (entries: Record<string, Row[]>) => new Map(Object.entries(entries));

describe('measureRetiredArchiveCoverage()', () => {
  it('flags a posting that left the active set without an archive record (Locarno shape)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ 'citta-di-locarno': [job('impiegata-ii-50-70'), job('giardiniere')] }),
      baseExpired: map({}),
      headActive: map({ 'citta-di-locarno': [job('giardiniere')] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(1);
    expect(result.retiredUnarchived.map((row) => row.slug)).toEqual(['impiegata-ii-50-70']);
    expect(result.retiredUnarchivedByCrawler).toEqual({ 'citta-di-locarno': 1 });
  });

  it('accepts a retired posting archived with a title, not one archived without', () => {
    const titled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [job('x')] }),
    });
    expect(titled.retiredUnarchived).toEqual([]);

    const untitled = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('x')] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({ a: [{ slug: 'x', slugByLocale: { it: 'x' }, title: '', titleByLocale: {} }] }),
    });
    expect(untitled.retiredUnarchived.map((row) => row.slug)).toEqual(['x']);
  });

  it('accepts a renamed posting whose old slug is in its history, and one moved to another crawler', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('old-slug'), job('moved')] }),
      baseExpired: map({}),
      headActive: map({ a: [job('new-slug', { previousSlugs: ['old-slug'] })], b: [job('moved')] }),
      headExpired: map({}),
    });
    expect(result.retiredUnarchived).toEqual([]);
  });

  it('flags an archive that shrinks between two revisions (Rittmeyer shape: 12 records -> [])', () => {
    const records = Array.from({ length: 12 }, (_, n) => job(`sales-engineer-${n}`));
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ 'rittmeyer-ag': records }),
      headActive: map({}),
      headExpired: map({ 'rittmeyer-ag': [] }),
    });
    expect(result.archiveLost).toHaveLength(12);
    expect(result.archiveLostByCrawler).toEqual({ 'rittmeyer-ag': 12 });
  });

  it('does not count an archive record whose posting is active again (ghost reconciliation)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({}),
      baseExpired: map({ a: [job('back-again')] }),
      headActive: map({ a: [job('back-again')] }),
      headExpired: map({ a: [] }),
    });
    expect(result.archiveLost).toEqual([]);
  });

  it('skips a posting held out of publication (never had a public URL)', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('held', { heldFromPublication: true })] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({}),
    });
    expect(result.retired).toBe(0);
    expect(result.retiredUnarchived).toEqual([]);
  });

  it('reports lost explicit it/de paths while the base row remains active', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('canonical', { slugByLocale: { it: 'old-it', de: 'old-de' } })] }),
      baseExpired: map({}),
      headActive: map({ a: [job('canonical', { slugByLocale: { it: 'new-it', de: 'new-de' } })] }),
      headExpired: map({}),
    });

    expect(result.retired).toBe(0);
    expect(result.activeLocaleSlugLost.map(({ locale, slug }) => [locale, slug])).toEqual([
      ['it', 'old-it'],
      ['de', 'old-de'],
    ]);
    expect(result.activeLocaleSlugLostByCrawler).toEqual({ a: 2 });
    expect(result.activeLocaleSlugLost.find(({ locale }) => locale === 'de')).toMatchObject({
      crawlerKey: 'a',
      baseIdentifier: 'canonical',
      baseSlug: 'canonical',
      path: expect.stringContaining('/de/'),
    });
  });

  it('uses the canonical slug fallback for head coverage and ignores locales absent at base', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('fallback-de', { slugByLocale: { it: 'it-route', de: 'fallback-de' } })] }),
      baseExpired: map({}),
      headActive: map({ a: [job('fallback-de', { slugByLocale: { it: 'it-route' } })] }),
      headExpired: map({}),
    });

    expect(result.activeLocaleSlugLost).toEqual([]);
  });

  it('covers locale-specific history only in its locale and flat legacy history in every locale', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({
        a: [job('canonical', {
          slugByLocale: { it: 'current-it', de: 'old-de', en: 'legacy-flat', fr: 'old-de' },
        })],
      }),
      baseExpired: map({}),
      headActive: map({
        a: [job('canonical', {
          slugByLocale: { it: 'current-it', de: 'new-de' },
          previousSlugsByLocale: { de: ['old-de'] },
          previousSlugs: ['legacy-flat'],
        })],
      }),
      headExpired: map({}),
    });

    expect(result.activeLocaleSlugLost.map(({ locale, slug }) => [locale, slug])).toEqual([
      ['fr', 'old-de'],
    ]);
  });

  it('covers an equal route owned by another row and a titled expired entry, but not another canton', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({
        a: [
          job('row-one', { slugByLocale: { de: 'shared-route' }, canton: 'TI' }),
          job('row-two', { slugByLocale: { de: 'shared-route' }, canton: 'ZH' }),
          job('row-three', { slugByLocale: { fr: 'expired-route' }, canton: 'ZH' }),
        ],
      }),
      baseExpired: map({}),
      headActive: map({ b: [job('different-id', { slugByLocale: { de: 'shared-route' }, canton: 'TI' })] }),
      headExpired: map({ c: [job('archived', { slugByLocale: { fr: 'expired-route' }, canton: 'ZH' })] }),
    });

    expect(result.activeLocaleSlugLost.map(({ baseSlug, locale, slug }) => [baseSlug, locale, slug])).toEqual([
      ['row-two', 'de', 'shared-route'],
    ]);
  });

  it('ignores held base rows for locale-slug loss', () => {
    const result = measureRetiredArchiveCoverage({
      baseActive: map({ a: [job('held-base', { slugByLocale: { it: 'it', de: 'held-de' }, heldFromPublication: true })] }),
      baseExpired: map({}),
      headActive: map({ a: [] }),
      headExpired: map({}),
    });

    expect(result.activeLocaleSlugLost).toEqual([]);
  });

  it('deduplicates identical paths deterministically without merging locales', () => {
    const row = (id: string) => job('canonical', { id, slugByLocale: { it: 'same-route', de: 'same-route' } });
    const first = measureRetiredArchiveCoverage({
      baseActive: map({ z: [row('row-z')], a: [row('row-a')] }),
      baseExpired: map({}),
      headActive: map({}),
      headExpired: map({}),
    });
    const reversed = measureRetiredArchiveCoverage({
      baseActive: map({ a: [row('row-a')], z: [row('row-z')] }),
      baseExpired: map({}),
      headActive: map({}),
      headExpired: map({}),
    });

    expect(first.activeLocaleSlugLost).toHaveLength(2);
    expect(first.activeLocaleSlugLost.map(({ locale }) => locale).sort()).toEqual(['de', 'it']);
    expect(first.activeLocaleSlugLost).toEqual(reversed.activeLocaleSlugLost);
    expect(first.activeLocaleSlugLost.every(({ crawlerKey, baseIdentifier }) => crawlerKey === 'a' && baseIdentifier === 'row-a')).toBe(true);
  });
});

// ── CLI on a real (temporary) git history ─────────────────────────────────
// The observer reads slices from git revisions. A slice whose root is neither
// an array nor {jobs: [...]} is malformed, and counting it as empty would
// pass exactly the data the observer cannot judge (review 5884475292).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/ci/check-retired-jobs-archived.mjs';
let repo = '';
let reportDir = '';

function copyClosure(rel: string, seen = new Set<string>()) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = path.join(REPO_ROOT, rel);
  const text = fs.readFileSync(src, 'utf8');
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
  for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g)) {
    copyClosure(path.relative(REPO_ROOT, path.resolve(path.dirname(src), match[1])), seen);
  }
}

function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function copyRouteResolverData() {
  for (const rel of ['data/canton-url-slugs.json', 'data/canton-municipalities.json']) {
    const destination = path.join(repo, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), destination);
  }
}

function commitSlices(active: unknown, expired: unknown, message: string) {
  fs.mkdirSync(path.join(repo, 'data/jobs/by-crawler'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data/jobs/expired/by-crawler'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data/jobs/by-crawler/acme.json'), JSON.stringify(active));
  fs.writeFileSync(path.join(repo, 'data/jobs/expired/by-crawler/acme.json'), JSON.stringify(expired));
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

function observe(base: string, head: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', head, ...extraArgs], { cwd: repo, encoding: 'utf8' });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-observer-'));
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test Runner');
  git('config', 'user.email', 'test@example.invalid');
  copyClosure(SCRIPT);
  copyRouteResolverData();
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  if (reportDir) fs.rmSync(reportDir, { recursive: true, force: true });
});

describe('check-retired-jobs-archived CLI', () => {
  it('exits 0 when the retired posting is archived with its title', () => {
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base');
    const head = commitSlices({ jobs: [job('kept')] }, [job('gone')], 'archived');
    const result = observe(base, head);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('retired WITHOUT an archive record with title: 0');
  });

  it('exits 1 when a retired posting has no archive record', () => {
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base again');
    const head = commitSlices({ jobs: [job('kept')] }, [], 'dropped');
    const result = observe(base, head);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('retired acme: gone');
  });

  it('reports locale-slug findings as JSON and fails at the default zero threshold', () => {
    const base = commitSlices({ jobs: [job('canonical', { slugByLocale: { it: 'it-route', de: 'lost-de' }, canton: 'ZH' })] }, [], 'locale base');
    const head = commitSlices({ jobs: [job('canonical', { slugByLocale: { it: 'it-route', de: 'new-de' }, canton: 'ZH' })] }, [], 'locale changed');
    reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-observer-report-'));
    const reportPath = path.join(reportDir, 'report.json');
    const failed = observe(base, head, ['--json', reportPath]);

    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('active locale slugs lost: 1 (max 0)');
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({
      activeLocaleSlugLost: 1,
      activeLocaleSlugLostByCrawler: { acme: 1 },
      thresholds: { activeLocaleSlugLost: 0 },
      activeLocaleSlugLostSample: [{ crawlerKey: 'acme', locale: 'de', slug: 'lost-de' }],
    });

    const allowed = observe(base, head, ['--max-active-locale-slug-lost', '1']);
    expect(allowed.status, allowed.stderr).toBe(0);
  });

  it('reads an archive split into `<key>.shard-NNN.json` as the archive of `<key>`', () => {
    const shard = path.join(repo, 'data/jobs/expired/by-crawler/acme.shard-001.json');
    const base = commitSlices({ jobs: [job('kept'), job('gone')] }, [], 'base sharded');
    fs.writeFileSync(shard, JSON.stringify([job('gone')]));
    const head = commitSlices({ jobs: [job('kept')] }, [], 'archived into a shard');
    const archived = observe(base, head);
    expect(archived.status, archived.stderr).toBe(0);

    fs.rmSync(shard);
    const lost = observe(head, commitSlices({ jobs: [job('kept')] }, [], 'shard lost'));
    expect(lost.status).toBe(1);
    // Labelled with the crawler key, not the shard file name.
    expect(lost.stdout).toContain('lost acme: gone');
  });

  it('fails closed (exit 2, "cannot read") on a slice with an unsupported root', () => {
    const base = commitSlices({ jobs: [job('kept')] }, [], 'valid');
    const head = commitSlices({ unexpected: [] }, [], 'malformed');
    const result = observe(base, head);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read acme\.json .*unsupported slice root/);
  });
});

describe('retired jobs archive observer workflow checkout', () => {
  it('keeps cone mode narrow and materializes exactly the observer file dependencies', () => {
    const workflow = YAML.parse(readFileSync(
      new URL('../../.github/workflows/retired-jobs-archive-observer.yml', import.meta.url),
      'utf8',
    ));
    const steps = workflow.jobs.observe.steps as Array<Record<string, any>>;
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7');
    if (!checkout) throw new Error('Observer checkout step is missing');
    const sparsePaths = checkout.with['sparse-checkout']
      .split('\n')
      .map((value: string) => value.trim())
      .filter(Boolean);
    expect(sparsePaths).toEqual(['scripts']);
    expect(checkout.with['sparse-checkout-cone-mode']).toBe(true);

    const materialize = steps.find((step) => step.name === 'Materialize observer file dependencies');
    if (!materialize) throw new Error('Observer dependency materialization step is missing');
    const materializedFiles = [...materialize.run.matchAll(/git show "HEAD:([^"]+)" > ([^\s]+)/g)]
      .map((match) => [match[1], match[2]]);
    expect(materializedFiles).toEqual([
      ['build-plugins/shared/cantonResolvers.mjs', 'build-plugins/shared/cantonResolvers.mjs'],
      ['data/canton-url-slugs.json', 'data/canton-url-slugs.json'],
      ['data/canton-municipalities.json', 'data/canton-municipalities.json'],
    ]);
  });
});
