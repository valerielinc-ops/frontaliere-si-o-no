// @vitest-environment node
/**
 * The history backfill must never lose a served expired route and never mint a
 * second record (or alias) for a posting the archive already represents.
 * Every case runs the real `processSlice` over a throwaway git history.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStagedOutputs,
  backfillExitCode,
  createHistoricalExpiredOwnerCollector,
  createListingIdentityCollector,
  prepareAndApplySlices,
  processSlice,
} from '../scripts/backfill-expired-from-history.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import {
  ACTIVE_JOB_PAGE_LOCALES,
  localizedActiveJobSlug,
} from '../build-plugins/shared/activeJobPageSelection.ts';
import {
  carryReplacedExpiredEntry,
  localeRouteKeys,
} from '../scripts/lib/expired-jobs-archive.mjs';
import { readExpiredSliceRows } from '../scripts/lib/expired-slice-store.mjs';
import { resolveExpiredRouteCanton } from '../scripts/lib/expired-route-canton.mjs';
import { isHeldFromPublication } from '../scripts/lib/translation-publication-hold.mjs';

type Row = Record<string, any>;

const FILE = 'acme.json';
const SHARD_REL = 'data/jobs/expired/by-crawler/acme.shard-001.json';
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
const shardPath = () => path.join(root, SHARD_REL);
const activePathFor = (file: string) => path.join(root, 'data', 'jobs', 'by-crawler', file);
const expiredPathFor = (key: string) => path.join(root, 'data', 'jobs', 'expired', 'by-crawler', `${key}.json`);
const readArchive = (): Row[] => JSON.parse(readFileSync(expiredPath(), 'utf8'));
const readArchiveRows = (): Row[] => readExpiredSliceRows('acme', { dir: path.dirname(expiredPath()) });

function commit({ active, expired, shard }: { active?: Row[]; expired?: Row[]; shard?: Row[] }) {
  if (active) writeFileSync(activePath(), `${JSON.stringify(active, null, 2)}\n`);
  if (expired) writeFileSync(expiredPath(), `${JSON.stringify(expired, null, 2)}\n`);
  if (shard) writeFileSync(shardPath(), `${JSON.stringify(shard, null, 2)}\n`);
  finishCommit();
}

function commitRaw({ active, expired, shard }: { active?: string; expired?: string; shard?: string }) {
  if (active !== undefined) writeFileSync(activePath(), active);
  if (expired !== undefined) writeFileSync(expiredPath(), expired);
  if (shard !== undefined) writeFileSync(shardPath(), shard);
  finishCommit();
}

function finishCommit() {
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

const run = (options: Record<string, unknown> = {}) => processSlice(FILE, { rootDir: root, ...options });

const routesOf = (rows: Row[]) => new Set(rows.flatMap((row) => [...localeRouteKeys(row)]));
const missing = (before: Set<string>, rows: Row[]) => {
  const after = routesOf(rows);
  return [...before].filter((key) => !after.has(key)).sort();
};
const hex8Routes = (rows: Row[]) => [...routesOf(rows)].filter((key) => /-[0-9a-f]{8}$/.test(key));
const cantonResolvers = createCantonResolvers({
  cantonSlugFile: JSON.parse(readFileSync(new URL('../data/canton-url-slugs.json', import.meta.url), 'utf8')),
  municipalitiesFile: JSON.parse(readFileSync(new URL('../data/canton-municipalities.json', import.meta.url), 'utf8')),
});
const emittedPathsOf = (job: Row, { active = false }: { active?: boolean } = {}) => {
  const routeKeys = new Set(localeRouteKeys(job));
  for (const locale of ACTIVE_JOB_PAGE_LOCALES) {
    const slug = active
      ? localizedActiveJobSlug(job, locale)
      : job.slugByLocale?.[locale] || job.slug;
    if (slug) routeKeys.add(`${locale}:${slug}`);
  }
  return [...routeKeys].map((routeKey) => {
    const separator = routeKey.indexOf(':');
    const locale = routeKey.slice(0, separator);
    const slug = routeKey.slice(separator + 1);
    const canton = active
      ? job.canton
      : resolveExpiredRouteCanton(job, locale, slug) || job.canton;
    const prefix = locale === 'it' ? '' : `${locale}/`;
    return `${prefix}${cantonResolvers.resolveCantonSection(locale, canton)}/${slug}/`;
  });
};
const expectRouteDetailsRedacted = (diagnostic: string, jobs: Row[]) => {
  for (const job of jobs) {
    for (const emittedPath of [
      ...emittedPathsOf(job),
      ...emittedPathsOf(job, { active: true }),
    ]) {
      const parts = emittedPath.split('/').filter(Boolean);
      expect(diagnostic).not.toContain(parts.at(-2));
      expect(diagnostic).not.toContain(parts.at(-1));
    }
  }
};

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

describe('history backfill CLI exit status', () => {
  it('succeeds only when no archive slices were refused', () => {
    expect(backfillExitCode({ refusedArchives: 0 })).toBe(0);
    expect(backfillExitCode({ refusedArchives: 1 })).toBeGreaterThan(0);
    expect(backfillExitCode({ refusedArchives: 3 })).toBeGreaterThan(0);
  });
});

describe('history backfill staged output transaction', () => {
  it('restores replaced files and removes newly created targets after a mid-apply error', () => {
    const stageDir = path.join(root, 'transaction-stage');
    const targetDir = path.join(root, 'transaction-targets');
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const existingA = path.join(targetDir, 'a-existing.json');
    const newTarget = path.join(targetDir, 'b-new.json');
    const existingC = path.join(targetDir, 'c-existing.json');
    const stagedA = path.join(stageDir, 'a.json');
    const stagedB = path.join(stageDir, 'b.json');
    const stagedC = path.join(stageDir, 'c.json');
    writeFileSync(existingA, 'original-a\n');
    chmodSync(existingA, 0o640);
    writeFileSync(existingC, 'original-c\n');
    writeFileSync(stagedA, 'replacement-a\n');
    writeFileSync(stagedB, 'replacement-b\n');
    writeFileSync(stagedC, 'replacement-c\n');

    expect(() => applyStagedOutputs([
      { stagedPath: stagedA, targetPath: existingA },
      { stagedPath: stagedB, targetPath: newTarget },
      { stagedPath: stagedC, targetPath: existingC },
    ], {
      replaceStagedFile: (stagedPath, targetPath) => {
        if (targetPath === existingC) {
          const backupDirName = readdirSync(targetDir)
            .find((name) => name.startsWith('.a-existing.json.backfill-apply-'));
          expect(backupDirName).toBeDefined();
          const backupPath = path.join(targetDir, backupDirName!, 'original');
          expect(existsSync(backupPath)).toBe(true);
          expect(readFileSync(backupPath, 'utf8')).toBe('original-a\n');
          expect(readFileSync(existingA, 'utf8')).toBe('replacement-a\n');
          throw new Error('injected mid-apply failure');
        }
        renameSync(stagedPath, targetPath);
      },
    })).toThrow(/injected mid-apply failure/u);

    expect(readFileSync(existingA, 'utf8')).toBe('original-a\n');
    expect(statSync(existingA).mode & 0o7777).toBe(0o640);
    expect(readFileSync(existingC, 'utf8')).toBe('original-c\n');
    expect(existsSync(newTarget)).toBe(false);
    expect(readdirSync(targetDir).filter((name) => name.includes('.backfill-'))).toEqual([]);
  });

  it('reports cleanup failure after all staged outputs are applied without rolling them back', () => {
    const stageDir = path.join(root, 'cleanup-stage');
    const targetDir = path.join(root, 'cleanup-targets');
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const existingTarget = path.join(targetDir, 'existing.json');
    const newTarget = path.join(targetDir, 'new.json');
    const stagedExisting = path.join(stageDir, 'existing.json');
    const stagedNew = path.join(stageDir, 'new.json');
    writeFileSync(existingTarget, 'original\n');
    writeFileSync(stagedExisting, 'replacement\n');
    writeFileSync(stagedNew, 'new output\n');
    let failCleanup = true;

    expect(() => applyStagedOutputs([
      { stagedPath: stagedExisting, targetPath: existingTarget },
      { stagedPath: stagedNew, targetPath: newTarget },
    ], {
      removeTemporaryDirectory: (directory) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('injected cleanup failure');
        }
        rmSync(directory, { recursive: true, force: true });
      },
    })).toThrow(/All staged outputs were applied successfully, but transaction cleanup failed: injected cleanup failure/u);

    expect(readFileSync(existingTarget, 'utf8')).toBe('replacement\n');
    expect(readFileSync(newTarget, 'utf8')).toBe('new output\n');
  });

  it.each(['directory', 'symlink'])('rejects an unsafe %s target before replacing any file', (kind) => {
    const stageDir = path.join(root, `unsafe-${kind}-stage`);
    const targetDir = path.join(root, `unsafe-${kind}-targets`);
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const safeTarget = path.join(targetDir, 'a-safe.json');
    const unsafeTarget = path.join(targetDir, 'z-unsafe.json');
    const unsafeBacking = path.join(targetDir, 'unsafe-backing.json');
    const safeStage = path.join(stageDir, 'a-safe.json');
    const unsafeStage = path.join(stageDir, 'z-unsafe.json');
    writeFileSync(safeTarget, 'safe-original\n');
    writeFileSync(safeStage, 'safe-replacement\n');
    writeFileSync(unsafeStage, 'unsafe-replacement\n');
    if (kind === 'directory') mkdirSync(unsafeTarget);
    else {
      writeFileSync(unsafeBacking, 'symlink-target\n');
      symlinkSync(unsafeBacking, unsafeTarget);
    }

    expect(() => applyStagedOutputs([
      { stagedPath: safeStage, targetPath: safeTarget },
      { stagedPath: unsafeStage, targetPath: unsafeTarget },
    ])).toThrow(/unsafe destination target type/u);

    expect(readFileSync(safeTarget, 'utf8')).toBe('safe-original\n');
    expect(kind === 'directory' ? lstatSync(unsafeTarget).isDirectory() : lstatSync(unsafeTarget).isSymbolicLink())
      .toBe(true);
    expect(readdirSync(targetDir).filter((name) => name.includes('.backfill-'))).toEqual([]);
  });
});

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
  it('fails closed when an active historical blob exists but is unavailable', () => {
    const lost = activeJob('acme-unavailable-active-history', 'synthetic-unavailable-active-history', 607);
    commit({ active: [lost], expired: [] });
    const activeCommit = git(['rev-parse', 'HEAD']).trim();
    const blobOid = git(['rev-parse', `${activeCommit}:data/jobs/by-crawler/${FILE}`]).trim();
    commit({ active: [], expired: [] });

    const looseBlobPath = path.join(root, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2));
    rmSync(looseBlobPath);
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    expect(() => run()).toThrow(
      `Historical archive path exists but is unreadable: data/jobs/by-crawler/${FILE}`,
    );
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('skips an active path proven absent from an earlier archive commit', () => {
    const archived = record('synthetic-active-path-absent', 608);
    const lost = activeJob('acme-active-path-absent', 'synthetic-active-path-absent-job', 609);
    commit({ expired: [archived] });
    commit({ active: [lost], expired: [archived] });
    commit({ active: [], expired: [archived] });

    run();

    expect(readArchive().map(({ slug }) => slug)).toEqual(expect.arrayContaining([
      archived.slug,
      lost.slug,
    ]));
  });

  it('fails closed when a historical shard exists but its blob is unavailable', () => {
    const lost = activeJob('acme-unavailable-history', 'synthetic-unavailable-history', 601);
    const archived = record('synthetic-unavailable-archive', 602);
    commit({ active: [lost] });
    commit({ shard: [] });
    const shardCommit = git(['rev-parse', 'HEAD']).trim();
    const blobOid = git(['rev-parse', `${shardCommit}:${SHARD_REL}`]).trim();
    const treeEntry = git([
      'ls-tree', '-z', '--full-tree', shardCommit, '--', `:(literal)${SHARD_REL}`,
    ]);
    expect(treeEntry).toContain(`blob ${blobOid}\t${SHARD_REL}`);
    commit({ shard: [archived] });
    writeFileSync(activePath(), '[]\n');

    const looseBlobPath = path.join(root, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2));
    rmSync(looseBlobPath);

    // The same shard still exists later and in the current checkout. Its
    // earlier tree entry proves that a missing object is not an absent path.
    const activeBefore = readFileSync(activePath());
    const shardBefore = readFileSync(shardPath());
    let refused: unknown;
    try {
      run();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect([
      `Unable to read Git history for ${SHARD_REL}`,
      `Historical archive path exists but is unreadable: ${SHARD_REL}`,
    ]).toContain((refused as Error).message);

    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(shardPath())).toEqual(shardBefore);
  });

  it('skips a shard proven absent from an earlier commit while reading its later history', () => {
    const lost = activeJob('acme-absent-shard-history', 'synthetic-absent-shard-history', 603);
    const archived = record('synthetic-present-shard-history', 604);
    commit({ active: [lost] });
    commit({ shard: [archived] });
    writeFileSync(activePath(), '[]\n');

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const rows = JSON.parse(readFileSync(shardPath(), 'utf8')) as Row[];
    expect(rows.map(({ slug }) => slug).sort()).toEqual([archived.slug, lost.slug].sort());
  });

  it.each([
    ['invalid JSON', '{"jobs":'],
    ['unsupported root', '{"other": []}'],
    ['non-object row', '[null]'],
  ])('rejects %s in active history before either file is written', (_label, corrupt) => {
    const lost = activeJob('acme-corrupt-active-history', 'synthetic-corrupt-active-history', 610);
    commit({ active: [lost], expired: [] });
    commitRaw({ active: `${corrupt}\n` });
    commitRaw({ active: '[]\n' });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    expect(() => run()).toThrow(/Historical JSON/u);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it.each([
    ['invalid JSON', '{"jobs":'],
    ['unsupported root', '{"other": []}'],
    ['non-object row', '[null]'],
  ])('rejects %s in expired history before either file is written', (_label, corrupt) => {
    const lost = activeJob('acme-corrupt-expired-history', 'synthetic-corrupt-expired-history', 611);
    commit({ active: [lost], expired: [] });
    commitRaw({ expired: `${corrupt}\n` });
    commitRaw({ active: '[]\n', expired: '[]\n' });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    expect(() => run()).toThrow(/Historical JSON/u);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('accepts explicitly empty object snapshots in both history families', () => {
    commitRaw({ active: '{"jobs": []}\n', expired: '{"jobs": []}\n' });
    commitRaw({ active: '[]\n', expired: '[]\n' });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    expect(() => run()).not.toThrow();
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('rejects an ID-only active history row without changing either target file', () => {
    const lost = activeJob('acme-id-only-active-history', 'synthetic-id-only-active-history', 616);
    commit({ active: [lost], expired: [] });
    commitRaw({ active: '[{"id":"synthetic-only-id"}]\n' });
    const malformedSha = git(['rev-parse', 'HEAD']).trim();
    commitRaw({ active: '[]\n' });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('active crawler slice');
    expect(message).toContain('data/jobs/by-crawler/acme.json');
    expect(message).toContain(malformedSha);
    expect(message).toContain('row 0');
    expect(message).not.toContain('synthetic-only-id');
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('rejects an ID-only expired history row without changing either target file', () => {
    const lost = activeJob('acme-id-only-expired-history', 'synthetic-id-only-expired-history', 617);
    commit({ active: [lost], expired: [] });
    commitRaw({ expired: '[{"id":"synthetic-only-id"}]\n' });
    const malformedSha = git(['rev-parse', 'HEAD']).trim();
    commitRaw({ active: '[]\n', expired: '[]\n' });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());

    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('expired archive slice');
    expect(message).toContain('data/jobs/expired/by-crawler/acme.json');
    expect(message).toContain(malformedSha);
    expect(message).toContain('row 0');
    expect(message).not.toContain('synthetic-only-id');
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('prepares all selected crawlers before applying any active or expired output', () => {
    const betaActivePath = activePathFor('beta.json');
    const betaExpiredPath = expiredPathFor('beta');
    const acmeShard = path.join(root, 'data', 'jobs', 'expired', 'by-crawler', 'acme.shard-001.json');
    const betaShard = path.join(root, 'data', 'jobs', 'expired', 'by-crawler', 'beta.shard-001.json');
    mkdirSync(path.dirname(betaActivePath), { recursive: true });
    writeFileSync(betaActivePath, '[]\n');
    writeFileSync(betaExpiredPath, `${JSON.stringify([record('synthetic-beta-existing', 621)], null, 2)}\n`);
    writeFileSync(acmeShard, `${JSON.stringify([record('synthetic-acme-existing', 622)], null, 2)}\n`);
    writeFileSync(betaShard, `${JSON.stringify([record('synthetic-beta-shard', 623)], null, 2)}\n`);
    const lost = activeJob('acme-staged-drop', 'synthetic-acme-staged-drop', 624);
    const historicalCurrent = activeJob('acme-staged-current', 'synthetic-acme-staged-current', 625, {
      firstSeenAt: daysAgo(80),
    });
    const current = activeJob('acme-staged-current', 'synthetic-acme-staged-current', 625);
    commit({ active: [lost, historicalCurrent], expired: [] });
    commit({ active: [current], expired: [] });
    writeFileSync(betaActivePath, '{"unsupported": []}\n');
    finishCommit();
    writeFileSync(betaActivePath, '[]\n');
    finishCommit();

    const repositoryFiles = [
      activePath(),
      expiredPath(),
      acmeShard,
      betaActivePath,
      betaExpiredPath,
      betaShard,
    ];
    const before = repositoryFiles.map((file) => readFileSync(file));
    const stagingParentDir = path.join(root, 'staging-parent');
    const preparedResults: Array<{ added: number }> = [];

    expect(() => prepareAndApplySlices(['acme.json', 'beta.json'], {
      rootDir: root,
      stagingParentDir,
      onSliceResult: (result) => preparedResults.push(result),
    })).toThrow(/Historical JSON has an unsupported root shape/u);

    expect(preparedResults).toHaveLength(1);
    expect(preparedResults[0].added).toBeGreaterThan(0);
    expect(preparedResults[0].activeEnriched).toBeGreaterThan(0);
    expect(repositoryFiles.map((file) => readFileSync(file))).toEqual(before);
    expect(readdirSync(stagingParentDir)).toEqual([]);
  });

  it('applies none of the prepared slices when a later slice refuses routes', () => {
    const betaActivePath = activePathFor('beta.json');
    const betaExpiredPath = expiredPathFor('beta');
    mkdirSync(path.dirname(betaActivePath), { recursive: true });
    const sharedSlug = 'synthetic-batch-refusal-route';
    const acmeLost = activeJob('acme-batch-success', 'synthetic-batch-success', 618);
    const betaLost = activeJob('beta-batch-refused', sharedSlug, 619);
    const betaOwner = record(sharedSlug, 620);
    writeFileSync(betaActivePath, `${JSON.stringify([betaLost], null, 2)}\n`);
    writeFileSync(betaExpiredPath, `${JSON.stringify([betaOwner], null, 2)}\n`);
    commit({ active: [acmeLost], expired: [] });
    commit({ active: [] });
    writeFileSync(betaActivePath, '[]\n');
    finishCommit();

    const targets = [activePath(), expiredPath(), betaActivePath, betaExpiredPath];
    const before = targets.map((target) => readFileSync(target));
    const stagingParentDir = path.join(root, 'refusal-staging-parent');
    const results: Array<{ crawlerKey: string; added: number; refusedRoutes?: number }> = [];

    const summary = prepareAndApplySlices(['acme.json', 'beta.json'], {
      rootDir: root,
      dryRun: false,
      stagingParentDir,
      onSliceResult: (result) => results.push(result),
    });

    expect(results[0]?.crawlerKey).toBe('acme');
    expect(results[0]?.added).toBeGreaterThan(0);
    expect(results[1]?.crawlerKey).toBe('beta');
    expect(results[1]?.refusedRoutes).toBeGreaterThan(0);
    expect(summary.refusedArchives).toBe(1);
    expect(summary.refusedRoutesTotal).toBeGreaterThan(0);
    expect(summary.applySkippedDueToRefusals).toBe(true);
    expect(targets.map((target) => readFileSync(target))).toEqual(before);
    expect(readdirSync(stagingParentDir)).toEqual([]);
  });

  it('coalesces crawl-metadata snapshots of one posting but refuses a distinct posting reusing its route', () => {
    const sharedSlug = 'synthetic-repeated-crawl-route';
    const first = activeJob('acme-repeated-crawl-route', sharedSlug, 612, { crawledAt: daysAgo(6) });
    const refreshed = { ...first, crawledAt: daysAgo(4), crawlSequence: 2 };
    commit({ active: [first], expired: [] });
    commit({ active: [refreshed], expired: [] });
    commit({ active: [], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    expect(readArchive().filter(({ slug }) => slug === sharedSlug)).toHaveLength(1);
    expect(readArchive().find(({ slug }) => slug === sharedSlug)?.expiredAt).toBe(refreshed.crawledAt);
  });

  it('keeps one newest expired payload and the full route/canton union across repeated snapshots', () => {
    const revisions = Array.from({ length: 24 }, (_, index) => {
      const slug = `synthetic-expired-route-revision-${index}`;
      return record(slug, 628, {
        title: `Synthetic revision ${index}`,
        expiredAt: daysAgo(40 - index),
        canton: index % 2 === 0 ? 'TI' : 'ZH',
        slugByLocale: {
          it: slug,
          de: `de-${slug}`,
          en: `en-${slug}`,
          fr: `fr-${slug}`,
        },
      });
    });
    for (const revision of revisions) commit({ active: [], expired: [revision] });
    commit({ active: [], expired: [] });
    const expectedPaths = new Set(revisions.flatMap((revision) => emittedPathsOf(revision)));

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const rows = readArchive();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: revisions.at(-1)?.slug,
      title: revisions.at(-1)?.title,
    });
    const servedPaths = new Set(emittedPathsOf(rows[0]));
    expect([...expectedPaths].filter((route) => !servedPaths.has(route))).toEqual([]);
    for (const revision of revisions) {
      for (const [locale, slug] of Object.entries(revision.slugByLocale)) {
        expect(resolveExpiredRouteCanton(rows[0], locale, slug)).toBe(revision.canton);
      }
    }
  });

  it('refuses a distinct expired owner reusing a route from compacted history', () => {
    const sharedSlug = 'synthetic-compacted-history-route-collision';
    const historicalOwner = record(sharedSlug, 629, {
      slugByLocale: { it: sharedSlug, de: 'synthetic-compacted-history-de' },
    });
    const distinctOwner = record(sharedSlug, 630, {
      slugByLocale: { it: sharedSlug, de: 'synthetic-distinct-history-de' },
    });
    commit({ active: [], expired: [historicalOwner] });
    commit({ active: [], expired: [historicalOwner, distinctOwner] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    expect(error.mock.calls.map(([message]) => String(message)).join('\n'))
      .toContain('emitted route(s) have archive ownership or canton history');
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses distinct active postings that reuse one historical route', () => {
    const sharedSlug = 'synthetic-distinct-postings-shared-route';
    const first = activeJob('acme-distinct-route-owner-1', sharedSlug, 613);
    const second = activeJob('acme-distinct-route-owner-2', sharedSlug, 614);
    commit({ active: [first], expired: [] });
    commit({ active: [second], expired: [] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    expect(error.mock.calls.map(([message]) => String(message)).join('\n'))
      .toContain('emitted route(s) have archive ownership or canton history');
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a route when three owners overlap through non-transitive identity tokens', () => {
    const sharedSlug = 'synthetic-non-transitive-owner-route';
    const first = record(sharedSlug, 625, {
      sourceIdentity: 'id:owner-a',
      sourceIdentityHistory: [{ sourceIdentity: 'id:bridge-ab' }],
    });
    const middle = record(sharedSlug, 626, {
      sourceIdentity: 'id:bridge-ab',
      sourceIdentityHistory: [{ sourceIdentity: 'id:bridge-bc' }],
    });
    const last = record(sharedSlug, 627, {
      sourceIdentity: 'id:bridge-bc',
      sourceIdentityHistory: [{ sourceIdentity: 'id:owner-c' }],
    });
    commit({ active: [], expired: [first, middle, last] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    expect(error.mock.calls.map(([message]) => String(message)).join('\n'))
      .toContain('emitted route(s) have archive ownership or canton history');
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('caps each source path independently before deduplicating their commits', () => {
    const lost = activeJob('acme-independent-history-cap', 'synthetic-active-cap-history', 605);
    const archived = record('synthetic-expired-cap-history', 606);
    commit({ active: [lost] });
    commit({ shard: [archived] });
    writeFileSync(activePath(), '[]\n');
    rmSync(shardPath());

    const result = run({ maxCommits: 1 });

    expect(result?.lost).toBeGreaterThan(0);
    expect(result?.recovered).toBeGreaterThan(0);
    const rows = readArchive();
    expect(rows.map(({ slug }) => slug)).toEqual(expect.arrayContaining([lost.slug, archived.slug]));
  });

  it('archives a removed idless row by URL identity and keeps the historical title', () => {
    const idless = activeJob('', 'operatore-locarno', 41, {
      title: 'Operatore tecnico a Locarno',
    });
    commit({ active: [idless], expired: [] });
    commit({ active: [], expired: [] });

    run();

    expect(readArchive()).toEqual([
      expect.objectContaining({
        slug: idless.slug,
        title: idless.title,
        sourceIdentity: `url:${sourceUrl(41).toLowerCase()}`,
      }),
    ]);
    expect(readArchive()[0]).not.toHaveProperty('id');
  });

  it('does not archive an idless historical row while its URL remains active', () => {
    const historical = activeJob('', 'tecnico-mendrisio', 42);
    const active = { ...historical, id: 'acme-current-42' };
    commit({ active: [historical], expired: [] });
    commit({ active: [active], expired: [] });

    run();

    expect(readArchive()).toEqual([]);
  });

  it('uses the stable slug only when an idless row has no source identity', () => {
    const idless = activeJob('', 'impiegato-amministrativo-airolo', 45);
    delete idless.url;
    commit({ active: [idless], expired: [] });
    commit({ active: [], expired: [] });

    run();

    expect(readArchive()).toEqual([
      expect.objectContaining({
        slug: idless.slug,
        title: idless.title,
        sourceIdentity: `slug:${idless.slug}`,
      }),
    ]);
  });

  it('refuses to lose idless snapshot paths when only a localized fallback remains active', () => {
    const historical = activeJob('', 'assistente-commerciale-bellinzona', 48, {
      title: 'Assistente commerciale a Bellinzona',
    });
    delete historical.url;
    const active = activeJob('acme-current-49', 'assistente-commerciale-zurich', 49, {
      title: historical.title,
      slugByLocale: {
        it: 'assistente-commerciale-zurich',
        de: historical.slug,
        en: 'sales-assistant-zurich',
        fr: 'assistant-commercial-zurich',
      },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [active], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, active]);
    expect(readArchive()).toEqual([]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('keeps idless postings with an ambiguous shared URL unknown', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    const first = activeJob('', 'contabile-lugano', 46, { url: `${listing}#job=first` });
    const second = activeJob('', 'cassiere-lugano', 47, { url: `${listing}#job=second` });
    commit({ active: [first], expired: [] });
    commit({ active: [second], expired: [] });
    commit({ active: [], expired: [] });

    run();

    expect(readArchive()).toEqual([]);
  });

  it('preserves a historical route when a listing URL and reused IT slug belong to another canton', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    const historical = activeJob('', 'assistente-laboratorio-lugano', 46, {
      url: listing,
      title: 'Assistente di laboratorio a Lugano',
      canton: 'ZH',
      slugByLocale: {
        it: 'assistente-laboratorio-lugano',
        de: 'laborassistent-lugano',
        en: 'lab-assistant-lugano',
        fr: 'assistant-laboratoire-lugano',
      },
    });
    const active = activeJob('acme-current-47', historical.slug, 47, {
      url: listing,
      title: 'Assistente di laboratorio senior a Lugano',
      canton: 'TI',
      slugByLocale: {
        it: historical.slug,
        de: 'laborassistent-lugano-aktuell',
        en: 'lab-assistant-lugano-current',
        fr: 'assistant-laboratoire-lugano-actuel',
      },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [active], expired: [] });

    run();

    const archived = readArchive();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ slug: historical.slug, title: historical.title });
    expect(archived[0]).not.toHaveProperty('sourceIdentity');
    expect(localeRouteKeys(archived[0])).toContain(`de:${historical.slugByLocale.de}`);
    expect(localeRouteKeys(active)).toContain(`de:${active.slugByLocale.de}`);
    expect(localeRouteKeys(active)).not.toContain(`de:${historical.slugByLocale.de}`);
  });

  it('refuses a route-only row with an active primary route and uncovered localized routes', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    const sharedSlug = 'assistente-laboratorio-chiasso';
    const historical = activeJob('', sharedSlug, 0, {
      url: listing,
      canton: 'TI',
      slugByLocale: { it: sharedSlug, de: 'laborassistent-chiasso-storico' },
    });
    const active = activeJob('acme-current-listing', sharedSlug, 0, {
      url: listing,
      canton: 'TI',
      slugByLocale: { it: sharedSlug, de: 'laborassistent-chiasso-attuale' },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [active], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(3);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, active]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a route-only localized path that overlaps an active owner with another primary slug', () => {
    const sharedLocalizedSlug = 'synthetic-route-only-localized-overlap';
    const historical = activeJob('', 'synthetic-route-only-primary', 0, {
      url: 'https://jobs.example.invalid/open-positions',
      canton: 'TI',
      slugByLocale: { it: 'synthetic-route-only-primary', de: sharedLocalizedSlug },
    });
    const active = activeJob('acme-current-localized-owner', 'synthetic-current-primary', 191, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-current-primary', de: sharedLocalizedSlug },
    });
    const historicalPaths = new Set(emittedPathsOf(historical, { active: true }));
    const activePaths = new Set(emittedPathsOf(active, { active: true }));
    const italianSection = cantonResolvers.resolveCantonSection('it', 'TI');
    const germanSection = cantonResolvers.resolveCantonSection('de', 'TI');
    expect(historicalPaths.has(`${italianSection}/synthetic-route-only-primary/`)).toBe(true);
    expect(activePaths.has(`${italianSection}/synthetic-current-primary/`)).toBe(true);
    expect(historicalPaths.has(`de/${germanSection}/${sharedLocalizedSlug}/`)).toBe(true);
    expect(activePaths.has(`de/${germanSection}/${sharedLocalizedSlug}/`)).toBe(true);
    commit({ active: [historical], expired: [] });
    commit({ active: [active] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(1);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, active]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('keeps the latest idless payload and every localized route across snapshots of one specific URL', () => {
    const historical = activeJob('', 'ingenieurin-produktion-alt', 51, {
      title: 'Ingenieurin Produktion, vorherige Fassung',
      canton: 'ZH',
      slugByLocale: {
        it: 'ingenieurin-produktion-alt',
        de: 'produktionsingenieurin-alt',
        en: 'production-engineer-old',
        fr: 'ingenieure-production-ancienne',
      },
      crawledAt: daysAgo(12),
    });
    const latest = {
      ...historical,
      slug: 'ingenieurin-produktion-neu',
      title: 'Ingenieurin Produktion, aktuelle Fassung',
      canton: 'TI',
      slugByLocale: {
        it: 'ingenieurin-produktion-neu',
        de: 'produktionsingenieurin-neu',
        en: 'production-engineer-new',
        fr: 'ingenieure-production-nouvelle',
      },
      crawledAt: daysAgo(4),
    };
    commit({ active: [historical], expired: [] });
    commit({ active: [latest], expired: [] });
    commit({ active: [], expired: [] });

    run();

    const [archived] = readArchive();
    expect(archived).toMatchObject({ slug: latest.slug, title: latest.title, canton: 'TI' });
    const served = localeRouteKeys(archived);
    for (const [locale, slug] of Object.entries(historical.slugByLocale)) {
      expect(served.has(`${locale}:${slug}`)).toBe(true);
    }
    for (const [locale, slug] of Object.entries(latest.slugByLocale)) {
      expect(served.has(`${locale}:${slug}`)).toBe(true);
    }
    expect(resolveExpiredRouteCanton(archived, 'de', historical.slugByLocale.de)).toBe('ZH');
    expect(resolveExpiredRouteCanton(archived, 'de', latest.slugByLocale.de)).toBe('TI');
  });

  it('refuses same-slug snapshots whose old canton path the archive cannot represent', () => {
    const sharedSlug = 'synthetic-canton-transition-same-slug';
    const older = activeJob('', sharedSlug, 194, {
      canton: 'ZH',
      slugByLocale: {
        it: sharedSlug,
        de: 'synthetic-canton-transition-de',
        en: 'synthetic-canton-transition-en',
        fr: 'synthetic-canton-transition-fr',
      },
      crawledAt: daysAgo(12),
    });
    const newer = {
      ...older,
      canton: 'TI',
      crawledAt: daysAgo(4),
    };
    const olderPaths = new Set(emittedPathsOf(older, { active: true }));
    const newerPaths = new Set(emittedPathsOf(newer, { active: true }));
    expect([...olderPaths].some((route) => !newerPaths.has(route))).toBe(true);
    commit({ active: [older], expired: [] });
    commit({ active: [newer] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('historical routes cannot be represented by the merged archive candidate');
    expectRouteDetailsRedacted(diagnostic, [older, newer]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('keeps changed localized routes as active aliases while the posting stays active at its URL', () => {
    const firstSeenAt = daysAgo(80);
    const historical = activeJob('', 'specialista-dati-lugano-primo', 52, {
      title: 'Specialista dati, prima versione',
      firstSeenAt,
      sourceIdentity: `url:${sourceUrl(52)}`,
      slugByLocale: {
        it: 'specialista-dati-lugano-primo',
        de: 'datenspezialistin-lugano-prima',
        en: 'data-specialist-lugano-first',
        fr: 'specialiste-donnees-lugano-premiere',
      },
      descriptionByLocale: { it: 'Descrizione prima versione' },
      crawledAt: daysAgo(12),
    });
    const second = {
      ...historical,
      slug: 'specialista-dati-lugano-secondo',
      title: 'Specialista dati, seconda versione',
      slugByLocale: {
        it: 'specialista-dati-lugano-secondo',
        de: 'datenspezialistin-lugano-seconda',
        en: 'data-specialist-lugano-second',
        fr: 'specialiste-donnees-lugano-deuxieme',
      },
      descriptionByLocale: { it: 'Descrizione seconda versione' },
      crawledAt: daysAgo(7),
    };
    const current = {
      ...second,
      id: 'acme-current-52',
      slug: 'specialista-dati-lugano-attivo',
      title: 'Specialista dati, versione attiva',
      slugByLocale: {
        it: 'specialista-dati-lugano-attivo',
        de: 'datenspezialistin-lugano-aktuell',
        en: 'data-specialist-lugano-current',
        fr: 'specialiste-donnees-lugano-actuelle',
      },
      descriptionByLocale: { it: 'Descrizione attiva' },
      crawledAt: daysAgo(2),
    };
    commit({ active: [historical], expired: [] });
    commit({ active: [second], expired: [] });
    commit({ active: [current], expired: [] });

    const result = run();

    expect(readArchive()).toEqual([]);
    const [activeAfter] = JSON.parse(readFileSync(activePath(), 'utf8'));
    const served = localeRouteKeys(activeAfter);
    for (const routeKey of localeRouteKeys(historical)) expect(served.has(routeKey)).toBe(true);
    for (const routeKey of localeRouteKeys(second)) expect(served.has(routeKey)).toBe(true);
    for (const routeKey of localeRouteKeys(current)) expect(served.has(routeKey)).toBe(true);
    expect(activeAfter).toMatchObject({
      id: current.id,
      slug: current.slug,
      slugByLocale: current.slugByLocale,
      title: current.title,
      descriptionByLocale: current.descriptionByLocale,
      firstSeenAt,
      url: current.url,
    });
    expect(activeAfter.sourceIdentity).toBe(current.sourceIdentity);
    expect(result?.activeEnriched).toBe(1);

    commit({});
    const secondRun = run();
    expect(readArchive()).toEqual([]);
    expect(JSON.parse(readFileSync(activePath(), 'utf8'))).toEqual([activeAfter]);
    expect(secondRun?.activeEnriched).toBe(0);
  });

  it('keeps a representable transferred alias in the active owner canton when it later expires', () => {
    const oldGermanSlug = 'synthetic-historic-alias';
    const historical = activeJob('', 'synthetic-historic-canonical', 193, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-historic-canonical', de: oldGermanSlug },
      previousSlugCantonByLocale: { de: { [oldGermanSlug]: 'ZH' } },
      sourceIdentity: `url:${sourceUrl(193)}`,
      title: 'Historical synthetic title',
      descriptionByLocale: { it: 'Historical synthetic description' },
    });
    const activeOwner = activeJob('acme-current-193', 'synthetic-active-canonical', 193, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-active-canonical', de: 'synthetic-active-german' },
      sourceIdentity: `url:${sourceUrl(193)}`,
      title: 'Active synthetic title',
      descriptionByLocale: { it: 'Active synthetic description' },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [activeOwner] });

    const transfer = run();
    const [activeAfter] = JSON.parse(readFileSync(activePath(), 'utf8'));
    expect(activeAfter).toMatchObject(activeOwner);
    expect(activeAfter.canton).toBe('TI');
    expect(activeAfter.previousSlugCantonByLocale.de[oldGermanSlug]).toBe('TI');
    expect(transfer?.activeEnriched).toBe(1);
    expect(readArchive()).toEqual([]);

    commit({});
    run();
    commit({ active: [] });
    run();

    const archived = readArchive().find((entry) => entry.slug === activeOwner.slug);
    expect(archived).toBeDefined();
    expect(localeRouteKeys(archived)).toContain(`de:${oldGermanSlug}`);
    expect(resolveExpiredRouteCanton(archived, 'de', oldGermanSlug)).toBe('TI');
    const activeAliasPath = emittedPathsOf(activeAfter, { active: true })
      .find((route) => route.endsWith(`/${oldGermanSlug}/`));
    const expiredAliasPath = emittedPathsOf(archived)
      .find((route) => route.endsWith(`/${oldGermanSlug}/`));
    expect(expiredAliasPath).toBe(activeAliasPath);
    expect(archived).toMatchObject({
      slug: activeOwner.slug,
      slugByLocale: activeOwner.slugByLocale,
      title: activeOwner.title,
      descriptionByLocale: activeOwner.descriptionByLocale,
      canton: 'TI',
    });
  });

  it('refuses an active route whose same localized slug moved to another canton', () => {
    const sharedSlug = 'synthetic-active-canton-move-route';
    const historical = activeJob('', sharedSlug, 203, {
      canton: 'ZH',
      slugByLocale: { it: sharedSlug, de: sharedSlug, en: sharedSlug, fr: sharedSlug },
      sourceIdentity: `url:${sourceUrl(203)}`,
    });
    const activeOwner = activeJob('acme-current-203', sharedSlug, 203, {
      canton: 'TI',
      slugByLocale: { it: sharedSlug, de: sharedSlug, en: sharedSlug, fr: sharedSlug },
      sourceIdentity: `url:${sourceUrl(203)}`,
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [activeOwner] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const oldGermanPath = emittedPathsOf(historical, { active: true })
      .find((route) => route.startsWith('de/'));
    const currentGermanPath = emittedPathsOf(activeOwner, { active: true })
      .find((route) => route.startsWith('de/'));
    expect(oldGermanPath).not.toBe(currentGermanPath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('historical active route cannot be emitted by its current owner');
    expectRouteDetailsRedacted(diagnostic, [historical, activeOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses an active alias that collides with another active route in the same canton', () => {
    const historical = activeJob('', 'ingegnere-prodotto-primo', 86, {
      canton: 'TI',
      slugByLocale: { it: 'ingegnere-prodotto-primo', de: 'produktingenieur-chiasso-alt' },
    });
    const activeOwner = {
      ...historical,
      id: 'acme-current-86',
      slug: 'ingegnere-prodotto-attuale',
      slugByLocale: { it: 'ingegnere-prodotto-attuale', de: 'produktingenieur-chiasso-neu' },
    };
    const collidingActive = activeJob('acme-other-87', 'tecnico-altro', 87, {
      canton: 'TI',
      slugByLocale: { it: 'tecnico-altro', de: 'produktingenieur-chiasso-alt' },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [activeOwner, collidingActive], expired: [] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(1);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('::error::');
    expect(diagnostic).toContain('archive ownership or canton history');
    expect(diagnostic).not.toContain('jobs-im-tessin/');
    expect(diagnostic).not.toContain('produktingenieur-chiasso-alt');
    expect(diagnostic).not.toContain('produktingenieur-chiasso-neu');
    expect(diagnostic).not.toContain('ingegnere-prodotto-primo');
    expect(diagnostic).not.toContain('ingegnere-prodotto-attuale');
    expect(diagnostic).not.toContain('tecnico-altro');
    expect(readArchive()).toEqual([]);
    expect(JSON.parse(readFileSync(activePath(), 'utf8'))).toEqual([activeOwner, collidingActive]);
  });

  it('refuses duplicate aliases planned by two distinct active posting owners', () => {
    const sharedHistoricalAlias = 'synthetic-mutual-historical-alias';
    const historicalFirst = activeJob('', 'synthetic-historical-first', 189, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-historical-first', de: sharedHistoricalAlias },
    });
    const historicalSecond = activeJob('', 'synthetic-historical-second', 190, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-historical-second', de: sharedHistoricalAlias },
    });
    const activeFirst = activeJob('acme-current-189', 'synthetic-active-first', 189, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-active-first', de: 'synthetic-active-first-de' },
    });
    const activeSecond = activeJob('acme-current-190', 'synthetic-active-second', 190, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-active-second', de: 'synthetic-active-second-de' },
    });
    commit({ active: [historicalFirst, historicalSecond], expired: [] });
    commit({ active: [activeFirst, activeSecond] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(1);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('historical active alias collides with a different planned active owner');
    expectRouteDetailsRedacted(diagnostic, [historicalFirst, historicalSecond, activeFirst, activeSecond]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('does not confuse equal localized slugs that render under different canton sections', () => {
    const historical = activeJob('', 'analista-dati-zurigo-primo', 88, {
      canton: 'ZH',
      slugByLocale: { it: 'analista-dati-zurigo-primo', de: 'datenanalyst-zurich-alt' },
    });
    const activeOwner = {
      ...historical,
      id: 'acme-current-88',
      slug: 'analista-dati-zurigo-attuale',
      slugByLocale: { it: 'analista-dati-zurigo-attuale', de: 'datenanalyst-zurich-neu' },
    };
    const otherCanton = activeJob('acme-other-89', 'analista-dati-ticino', 89, {
      canton: 'TI',
      slugByLocale: { it: 'analista-dati-ticino', de: 'datenanalyst-zurich-alt' },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [activeOwner, otherCanton], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    expect(readArchive()).toEqual([]);
    const [activeAfter] = JSON.parse(readFileSync(activePath(), 'utf8'));
    expect(activeAfter.previousSlugsByLocale.de).toContain('datenanalyst-zurich-alt');
    expect(activeAfter.slug).toBe(activeOwner.slug);
  });

  it('refuses an active source identity with more than one current owner', () => {
    const historical = activeJob('', 'sviluppatore-mobile-primo', 90, {
      slugByLocale: { it: 'sviluppatore-mobile-primo', fr: 'developpeur-mobile-premier' },
    });
    const firstOwner = activeJob('acme-current-90-a', 'sviluppatore-mobile-attuale-a', 90, {
      slugByLocale: { it: 'sviluppatore-mobile-attuale-a', fr: 'developpeur-mobile-actuel-a' },
    });
    const secondOwner = activeJob('acme-current-90-b', 'sviluppatore-mobile-attuale-b', 90, {
      slugByLocale: { it: 'sviluppatore-mobile-attuale-b', fr: 'developpeur-mobile-actuel-b' },
    });
    commit({ active: [historical], expired: [] });
    commit({ active: [firstOwner, secondOwner], expired: [] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'source identity or active owner is ambiguous',
    ));
    expect(readArchive()).toEqual([]);
    expect(JSON.parse(readFileSync(activePath(), 'utf8'))).toEqual([firstOwner, secondOwner]);
  });

  it('keeps ID deduplication and excludes an idless translation-held posting', () => {
    const held = activeJob('', 'polymechaniker-zurich', 43, {
      companyKey: 'sta',
      sourceLang: 'de',
      titleByLocale: {
        de: 'Polymechaniker/in CNC Fertigung',
        it: 'Polymechaniker/in CNC Fertigung',
        en: 'Polymechaniker/in CNC Fertigung',
        fr: 'Polymechaniker/in CNC Fertigung',
      },
      translationHoldSince: daysAgo(2),
    });
    const previousPublished = activeJob('acme-published-44', 'assistente-bellinzona', 44, {
      title: 'Assistente di laboratorio a Bellinzona',
    });
    const published = { ...previousPublished, title: 'Assistente di laboratorio senior a Bellinzona' };
    expect(isHeldFromPublication(held)).toBe(true);
    commit({ active: [held, previousPublished], expired: [] });
    commit({ active: [published], expired: [] });
    commit({ active: [], expired: [] });

    run();

    expect(readArchive().map((entry) => entry.slug)).toEqual([published.slug]);
    expect(readArchive()[0]).toMatchObject({ id: published.id, title: published.title });
  });

  it('refuses a lost job that reuses an exact route owned by another archived posting', () => {
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
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(3);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [archived, lost]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses an older lost job that shares an exact route with a different archived posting', () => {
    const lost = activeJob('acme-2', 'autista-lugano', 2, {
      slugByLocale: { it: 'autista-lugano', en: 'driver-lugano' },
      crawledAt: daysAgo(60),
    });
    commit({ active: [lost] });
    commit({ active: [], expired: [record('autista-lugano', 1, { expiredAt: daysAgo(10) })] });
    const archived = readArchive()[0];
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(3);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [archived, lost]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
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

  it('refuses a route-only candidate whose slug is owned by a known archived posting', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    const sharedSlug = 'assistente-laboratorio-lugano';
    const archived = record(sharedSlug, 74, {
      slugByLocale: { it: sharedSlug, de: 'laborassistent-lugano-archiviert' },
    });
    const routeOnly = activeJob('', sharedSlug, 0, {
      url: listing,
      title: 'Assistente di laboratorio da annuncio condiviso',
      slugByLocale: { it: sharedSlug, de: 'laborassistent-lugano-annuncio' },
    });
    commit({ active: [routeOnly], expired: [archived] });
    commit({ active: [], expired: [archived] });
    const activeBeforeBytes = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(3);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('::error::');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expect(diagnostic).not.toContain('jobs-im-tessin/');
    expect(diagnostic).not.toContain('assistente-laboratorio-lugano');
    expect(diagnostic).not.toContain('laborassistent-lugano-annuncio');
    expect(diagnostic).not.toContain('laborassistent-lugano-archiviert');
    expect(readFileSync(activePath())).toEqual(activeBeforeBytes);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a posting-specific idless route whose archived slug belongs to another canton', () => {
    const sharedSlug = 'synthetic-idless-shared-slug';
    const historical = activeJob('', sharedSlug, 184, {
      canton: 'TI',
      slugByLocale: { it: sharedSlug },
    });
    const archiveOwner = record(sharedSlug, 185, {
      canton: 'ZH',
      slugByLocale: { it: sharedSlug },
    });
    commit({ active: [historical], expired: [archiveOwner] });
    commit({ active: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const historicalPath = emittedPathsOf(historical)[0];
    const archivePath = emittedPathsOf(archiveOwner)[0];
    expect(historicalPath).not.toBe(archivePath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(8);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, archiveOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('omits canton sections and slugs when archive ownership is ambiguous', () => {
    const sharedSlug = 'synthetic-route-loss-owner';
    const older = record(sharedSlug, 196, {
      canton: 'ZH',
      slugByLocale: { it: sharedSlug },
      expiredAt: daysAgo(40),
    });
    const newer = record(sharedSlug, 196, {
      canton: 'TI',
      slugByLocale: { it: sharedSlug },
      expiredAt: daysAgo(20),
    });
    commit({ active: [], expired: [older] });
    commit({ active: [], expired: [newer] });
    commit({ active: [], expired: [older] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(8);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [older, newer]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses exact emitted paths shared by distinct archive posting owners', () => {
    const sharedLocalizedSlug = 'synthetic-shared-archive-localized-route';
    const first = record('synthetic-archive-owner-first', 197, {
      company: 'Synthetic Company One',
      companyKey: 'synthetic-company-one',
      canton: 'TI',
      slugByLocale: { it: 'synthetic-archive-owner-first', de: sharedLocalizedSlug },
    });
    const second = record('synthetic-archive-owner-second', 198, {
      company: 'Synthetic Company Two',
      companyKey: 'synthetic-company-two',
      canton: 'TI',
      slugByLocale: { it: 'synthetic-archive-owner-second', de: sharedLocalizedSlug },
    });
    const firstPath = emittedPathsOf(first).find((route) => route.startsWith('de/'));
    const secondPath = emittedPathsOf(second).find((route) => route.startsWith('de/'));
    expect(firstPath).toBe(secondPath);
    commit({ active: [], expired: [first, second] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(1);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [first, second]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses same-posting historical routes that one locale slug cannot retain across cantons', () => {
    const sharedSlug = 'synthetic-same-posting-canton-history';
    const older = record(sharedSlug, 206, {
      canton: 'ZH',
      slugByLocale: { it: sharedSlug, de: 'synthetic-same-posting-de-route' },
      expiredAt: daysAgo(50),
    });
    const newer = record(sharedSlug, 206, {
      canton: 'TI',
      slugByLocale: { it: sharedSlug, de: 'synthetic-same-posting-de-route' },
      expiredAt: daysAgo(20),
    });
    const sentinelFirst = activeJob('acme-scan-sentinel', 'synthetic-scan-sentinel', 390, {
      title: 'Synthetic scan first',
    });
    const sentinelSecond = { ...sentinelFirst, title: 'Synthetic scan second' };
    commit({ active: [sentinelFirst], expired: [older] });
    commit({ active: [sentinelSecond], expired: [newer] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [older, newer]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('recovers routes from an expired shard deleted from the current tree', () => {
    const historical = record('synthetic-deleted-shard-history', 211, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-deleted-shard-history', de: 'synthetic-deleted-shard-de' },
    });
    const sentinel = activeJob('synthetic-shard-sentinel', 'synthetic-shard-sentinel', 393);
    const shardPath = path.join(root, 'data', 'jobs', 'expired', 'by-crawler', 'acme.shard-001.json');
    commit({ active: [sentinel], expired: [] });
    writeFileSync(shardPath, `${JSON.stringify([historical], null, 2)}\n`);
    commit({ active: [sentinel] });
    rmSync(shardPath);
    commit({ active: [sentinel], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const rows = readArchive();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: historical.slug, sourceIdentity: historical.sourceIdentity }),
    ]));
    const servedPaths = new Set(rows.flatMap((row) => emittedPathsOf(row)));
    for (const route of emittedPathsOf(historical)) expect(servedPaths.has(route)).toBe(true);
  });

  it('refuses an ID-bearing same-slug canton move with unchanged files', () => {
    const slug = 'synthetic-id-canton-move';
    const older = activeJob('synthetic-id-canton-owner', slug, 212, {
      canton: 'ZH',
      slugByLocale: { it: slug },
      crawledAt: daysAgo(35),
    });
    const newer = { ...older, canton: 'TI', crawledAt: daysAgo(5) };
    commit({ active: [older], expired: [] });
    commit({ active: [newer], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('previously served route(s) would be lost; route details are omitted');
    expectRouteDetailsRedacted(diagnostic, [older, newer]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a distinct expired owner that shares a current active localized path', () => {
    const sharedLocalizedSlug = 'synthetic-active-expired-localized-collision';
    const active = activeJob('synthetic-current-owner', 'synthetic-current-primary', 213, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-current-primary', en: sharedLocalizedSlug },
    });
    const expired = record('synthetic-expired-primary', 214, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-expired-primary', en: sharedLocalizedSlug },
    });
    expect(emittedPathsOf(active, { active: true }).some((route) => route === emittedPathsOf(expired)
      .find((candidate) => candidate.startsWith('en/')))).toBe(true);
    commit({ active: [active], expired: [expired] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [active, expired]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses same-company primary-slug reuse when the route union has different owners', () => {
    const sharedPrimarySlug = 'synthetic-historical-primary-reuse';
    const older = record(sharedPrimarySlug, 207, {
      company: 'Synthetic Company Alpha',
      companyKey: 'synthetic-company-alpha',
      canton: 'ZH',
      slugByLocale: { it: sharedPrimarySlug, de: 'synthetic-historical-de-alpha' },
      expiredAt: daysAgo(50),
    });
    const newer = record(sharedPrimarySlug, 208, {
      company: 'Synthetic Company Alpha',
      companyKey: 'synthetic-company-alpha',
      canton: 'TI',
      slugByLocale: { it: sharedPrimarySlug, de: 'synthetic-historical-de-beta' },
      expiredAt: daysAgo(20),
    });
    const sentinelFirst = activeJob('acme-scan-sentinel', 'synthetic-scan-sentinel', 391, {
      title: 'Synthetic scan first',
    });
    const sentinelSecond = { ...sentinelFirst, title: 'Synthetic scan second' };
    commit({ active: [sentinelFirst], expired: [older] });
    commit({ active: [sentinelSecond], expired: [newer] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [older, newer]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('keeps same localized slugs for different companies when their canton paths differ', () => {
    const sharedLocalizedSlug = 'synthetic-cross-company-localized-route';
    const first = record('synthetic-cross-company-primary-one', 209, {
      company: 'Synthetic Company One',
      companyKey: 'synthetic-company-one',
      canton: 'TI',
      slugByLocale: { it: 'synthetic-cross-company-primary-one', de: sharedLocalizedSlug },
      expiredAt: daysAgo(35),
    });
    const second = record('synthetic-cross-company-primary-two', 210, {
      company: 'Synthetic Company Two',
      companyKey: 'synthetic-company-two',
      canton: 'ZH',
      slugByLocale: { it: 'synthetic-cross-company-primary-two', de: sharedLocalizedSlug },
      expiredAt: daysAgo(25),
    });
    const sentinelFirst = activeJob('acme-scan-sentinel', 'synthetic-scan-sentinel', 392, {
      title: 'Synthetic scan first',
    });
    const sentinelSecond = { ...sentinelFirst, title: 'Synthetic scan second' };
    const firstGermanPath = emittedPathsOf(first).find((route) => route.startsWith('de/'));
    const secondGermanPath = emittedPathsOf(second).find((route) => route.startsWith('de/'));
    expect(firstGermanPath).not.toBe(secondGermanPath);
    commit({ active: [sentinelFirst], expired: [first, second] });
    commit({ active: [sentinelSecond], expired: [first, second] });
    commit({ active: [], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const rows = readArchive();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: first.slug, companyKey: first.companyKey }),
      expect.objectContaining({ slug: second.slug, companyKey: second.companyKey }),
    ]));
    const servedPaths = new Set(rows.flatMap((row) => emittedPathsOf(row)));
    expect(servedPaths.has(firstGermanPath!)).toBe(true);
    expect(servedPaths.has(secondGermanPath!)).toBe(true);
  });

  it('recovers the same primary slug separately for different companies and cantons', () => {
    const sharedPrimarySlug = 'synthetic-cross-company-shared-primary';
    const first = record(sharedPrimarySlug, 215, {
      company: 'Synthetic Company East',
      companyKey: 'synthetic-company-east',
      canton: 'TI',
      slugByLocale: { it: sharedPrimarySlug, de: 'synthetic-cross-company-east-de' },
      expiredAt: daysAgo(35),
    });
    const second = record(sharedPrimarySlug, 216, {
      company: 'Synthetic Company West',
      companyKey: 'synthetic-company-west',
      canton: 'ZH',
      slugByLocale: { it: sharedPrimarySlug, de: 'synthetic-cross-company-west-de' },
      expiredAt: daysAgo(25),
    });
    const sentinel = activeJob('synthetic-company-scope-sentinel', 'synthetic-company-scope-sentinel', 394);
    const firstItalianPath = emittedPathsOf(first).find((route) => !/^(?:de|en|fr)\//u.test(route));
    const secondItalianPath = emittedPathsOf(second).find((route) => !/^(?:de|en|fr)\//u.test(route));
    expect(firstItalianPath).not.toBe(secondItalianPath);
    commit({ active: [sentinel], expired: [first, second] });
    commit({ active: [sentinel], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const rows = readArchive();
    expect(rows.filter((row) => row.slug === sharedPrimarySlug)).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyKey: first.companyKey }),
      expect.objectContaining({ companyKey: second.companyKey }),
    ]));
    const servedPaths = new Set(rows.flatMap((row) => emittedPathsOf(row)));
    expect(servedPaths.has(firstItalianPath!)).toBe(true);
    expect(servedPaths.has(secondItalianPath!)).toBe(true);
  });

  it('deduplicates repeated identical legacy archive snapshots before ownership checks', () => {
    const legacy = record('synthetic-repeated-legacy-snapshot', 217, {
      companyKey: 'synthetic-legacy-company',
      expiredAt: daysAgo(45),
    });
    delete legacy.sourceIdentity;
    const sentinel = activeJob('synthetic-legacy-snapshot-sentinel', 'synthetic-legacy-snapshot-sentinel', 395);
    commit({ active: [sentinel], expired: [legacy] });
    commit({ active: [sentinel], expired: [legacy] });
    commit({ active: [sentinel], expired: [legacy] });
    const archiveBefore = readFileSync(expiredPath());

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    expect(readArchive().filter((row) => row.slug === legacy.slug)).toHaveLength(1);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it.each(['company-key-only', 'shared-listing-identity'] as const)(
    'keeps identity-less legacy rows with disjoint routes separate for %s',
    (identityKind) => {
      const listingIdentity = 'url:https://jobs.example.invalid/open-positions';
      const makeLegacyRow = (slug: string, localizedSlug: string) => {
        const row = record(slug, 218, {
          companyKey: 'synthetic-identityless-company',
          slugByLocale: { it: slug, de: localizedSlug },
        });
        if (identityKind === 'company-key-only') delete row.sourceIdentity;
        else row.sourceIdentity = listingIdentity;
        return row;
      };
      const first = makeLegacyRow('synthetic-legacy-disjoint-first', 'synthetic-legacy-first-de');
      const second = makeLegacyRow('synthetic-legacy-disjoint-second', 'synthetic-legacy-second-de');
      const sentinel = activeJob('synthetic-identityless-disjoint-sentinel', 'synthetic-identityless-sentinel', 396);
      commit({ active: [sentinel], expired: [first, second] });

      const result = run();

      expect(result?.refusedRoutes).toBeUndefined();
      const rows = readArchive();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.slug === first.slug)?.slugByLocale.de).toBe('synthetic-legacy-first-de');
      expect(rows.find((row) => row.slug === second.slug)?.slugByLocale.de).toBe('synthetic-legacy-second-de');
      expect(rows.every((row) => !row.previousSlugsByLocale?.de)).toBe(true);
    },
  );

  it.each(['company-key-only', 'shared-listing-identity'] as const)(
    'refuses identity-less legacy rows only when their emitted routes overlap for %s',
    (identityKind) => {
      const listingIdentity = 'url:https://jobs.example.invalid/open-positions';
      const sharedLocalizedSlug = 'synthetic-legacy-overlapping-de';
      const makeLegacyRow = (slug: string) => {
        const row = record(slug, 219, {
          companyKey: 'synthetic-identityless-company',
          slugByLocale: { it: slug, de: sharedLocalizedSlug },
        });
        if (identityKind === 'company-key-only') delete row.sourceIdentity;
        else row.sourceIdentity = listingIdentity;
        return row;
      };
      const first = makeLegacyRow('synthetic-legacy-overlap-first');
      const second = makeLegacyRow('synthetic-legacy-overlap-second');
      const sentinel = activeJob('synthetic-identityless-overlap-sentinel', 'synthetic-identityless-overlap-sentinel', 397);
      commit({ active: [sentinel], expired: [first, second] });
      const activeBefore = readFileSync(activePath());
      const archiveBefore = readFileSync(expiredPath());
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = run();

      expect(result?.refusedRoutes).toBeGreaterThan(0);
      const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
      expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
      expectRouteDetailsRedacted(diagnostic, [first, second]);
      expect(readFileSync(activePath())).toEqual(activeBefore);
      expect(readFileSync(expiredPath())).toEqual(archiveBefore);
    },
  );

  it('refuses a recovered posting that collides with an archived locale fallback path', () => {
    const archiveOwner = record('synthetic-archive-fallback-owner', 204, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-archive-fallback-owner' },
      previousSlugCantonByLocale: {
        de: { 'synthetic-archive-fallback-owner': 'ZH' },
      },
    });
    const recovered = activeJob('acme-recovered-fallback', 'synthetic-recovered-fallback-posting', 205, {
      canton: 'ZH',
      slugByLocale: {
        it: 'synthetic-recovered-fallback-posting',
        de: archiveOwner.slug,
      },
    });
    const archiveGermanPath = emittedPathsOf(archiveOwner).find((route) => route.startsWith('de/'));
    const recoveredGermanPath = emittedPathsOf(recovered, { active: true })
      .find((route) => route.startsWith('de/'));
    expect(archiveGermanPath).toBe(recoveredGermanPath);
    commit({ active: [recovered], expired: [archiveOwner] });
    commit({ active: [], expired: [archiveOwner] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [archiveOwner, recovered]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a recovered expired path whose canton history collides with a current active route', () => {
    const cantonHistorySlug = 'synthetic-expired-canton-history-alias';
    const recovered = activeJob('synthetic-lost-canton-history-257', 'synthetic-lost-canton-history-primary', 257, {
      canton: 'TI',
      previousSlugsByLocale: { de: [cantonHistorySlug] },
      previousSlugCantonByLocale: { de: { [cantonHistorySlug]: 'ZH' } },
    });
    const activeOwner = activeJob('synthetic-current-canton-route-258', 'synthetic-current-canton-route', 258, {
      canton: 'ZH',
      slugByLocale: {
        it: 'synthetic-current-canton-route',
        de: cantonHistorySlug,
      },
    });
    const candidateExpiredPath = emittedPathsOf(recovered)
      .find((route) => route.startsWith('de/') && route.endsWith(`/${cantonHistorySlug}/`));
    const candidateActivePath = emittedPathsOf(recovered, { active: true })
      .find((route) => route.startsWith('de/') && route.endsWith(`/${cantonHistorySlug}/`));
    const activeOwnerPath = emittedPathsOf(activeOwner, { active: true })
      .find((route) => route.startsWith('de/') && route.endsWith(`/${cantonHistorySlug}/`));
    expect(candidateExpiredPath).toBeDefined();
    expect(candidateActivePath).not.toBe(candidateExpiredPath);
    expect(activeOwnerPath).toBe(candidateExpiredPath);

    commit({ active: [recovered], expired: [] });
    commit({ active: [activeOwner], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('recovered expired route(s) would duplicate an active route');
    expectRouteDetailsRedacted(diagnostic, [recovered, activeOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a localized historical route colliding with an archive row under another primary slug', () => {
    const sharedFallbackSlug = 'synthetic-localized-fallback-route';
    const historical = activeJob('', sharedFallbackSlug, 181, { canton: 'TI' });
    delete historical.slugByLocale;
    const archiveOwner = record('synthetic-different-archive-primary', 182, {
      canton: 'ZH',
      slugByLocale: {
        it: 'synthetic-different-archive-primary',
        de: sharedFallbackSlug,
      },
    });
    commit({ active: [historical], expired: [archiveOwner] });
    commit({ active: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const historicalDePath = emittedPathsOf(historical, { active: true })
      .find((route) => route.startsWith('de/'));
    const archiveDePath = emittedPathsOf(archiveOwner)
      .find((route) => route.startsWith('de/'));
    expect(historicalDePath).not.toBe(archiveDePath);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(2);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, archiveOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses a localized route collision found only in historical expired rows', () => {
    const sharedFallbackSlug = 'synthetic-historical-only-route';
    const historical = activeJob('', sharedFallbackSlug, 183, { canton: 'TI' });
    delete historical.slugByLocale;
    const archiveOwner = record('synthetic-historical-only-primary', 184, {
      canton: 'ZH',
      slugByLocale: {
        it: 'synthetic-historical-only-primary',
        fr: sharedFallbackSlug,
      },
    });
    commit({ active: [historical], expired: [archiveOwner] });
    commit({ active: [], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(2);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, archiveOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses an active alias that would shadow a different expired posting', () => {
    const sharedAlias = 'synthetic-active-expired-alias';
    const historical = activeJob('', 'synthetic-old-active-primary', 185, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-old-active-primary', de: sharedAlias },
    });
    const activeOwner = activeJob('acme-current-185', 'synthetic-current-active-primary', 185, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-current-active-primary', de: 'synthetic-current-de' },
    });
    const expiredOwner = record('synthetic-other-expired-primary', 186, {
      canton: 'TI',
      slugByLocale: {
        it: 'synthetic-other-expired-primary',
        de: sharedAlias,
      },
    });
    commit({ active: [historical], expired: [expiredOwner] });
    commit({ active: [activeOwner], expired: [expiredOwner] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(1);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, activeOwner, expiredOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('refuses an active alias claimed by a distinct posting recovered in the same run', () => {
    const sharedAlias = 'synthetic-recovered-candidate-alias';
    const historicalActive = activeJob('', 'synthetic-alias-owner-old', 253, {
      canton: 'TI',
      sourceIdentity: `url:${sourceUrl(253)}`,
      slugByLocale: { it: 'synthetic-alias-owner-old', de: sharedAlias },
    });
    const recoveredPosting = activeJob('synthetic-recovered-owner-254', 'synthetic-recovered-primary', 254, {
      canton: 'TI',
      slugByLocale: { it: 'synthetic-recovered-primary', de: sharedAlias },
    });
    const currentActive = activeJob('synthetic-current-owner-253', 'synthetic-alias-owner-current', 253, {
      canton: 'TI',
      sourceIdentity: `url:${sourceUrl(253)}`,
      slugByLocale: { it: 'synthetic-alias-owner-current', de: 'synthetic-alias-owner-current-de' },
    });
    commit({ active: [historicalActive], expired: [] });
    commit({ active: [recoveredPosting], expired: [] });
    commit({ active: [currentActive], expired: [] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('recovered candidate of unknown or different posting identity');
    expectRouteDetailsRedacted(diagnostic, [historicalActive, recoveredPosting, currentActive]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('allows an active alias claimed by a recovered candidate proven to be the same posting', () => {
    const sharedAlias = 'synthetic-same-posting-recovered-alias';
    const postingIdentity = `url:${sourceUrl(255)}`;
    const historicalActive = activeJob('', 'synthetic-same-posting-alias-old', 255, {
      canton: 'TI',
      sourceIdentity: postingIdentity,
      slugByLocale: { it: 'synthetic-same-posting-alias-old', de: sharedAlias },
    });
    const recoveredPosting = activeJob('synthetic-recovered-same-posting-256', 'synthetic-same-posting-recovered', 255, {
      canton: 'TI',
      sourceIdentity: postingIdentity,
      slugByLocale: { it: 'synthetic-same-posting-recovered', de: sharedAlias },
    });
    const currentActive = activeJob('synthetic-current-same-posting-255', 'synthetic-same-posting-current', 255, {
      canton: 'TI',
      sourceIdentity: postingIdentity,
      slugByLocale: { it: 'synthetic-same-posting-current', de: 'synthetic-same-posting-current-de' },
    });
    commit({ active: [historicalActive], expired: [] });
    commit({ active: [recoveredPosting], expired: [] });
    commit({ active: [currentActive], expired: [] });

    const result = run();

    expect(result?.refusedRoutes).toBeUndefined();
    const [activeAfter] = JSON.parse(readFileSync(activePath(), 'utf8'));
    expect(localeRouteKeys(activeAfter)).toContain(`de:${sharedAlias}`);
    const activeAliasPath = emittedPathsOf(activeAfter, { active: true })
      .find((route) => route.endsWith(`/${sharedAlias}/`));
    const archivedCandidate = readArchiveRows().find((entry) => entry.slug === recoveredPosting.slug);
    expect(activeAliasPath).toBeDefined();
    expect(archivedCandidate).toMatchObject({
      slug: recoveredPosting.slug,
      title: recoveredPosting.title,
      descriptionByLocale: {},
    });
    expect(localeRouteKeys(archivedCandidate || {})).toContain(`it:${recoveredPosting.slug}`);
    expect(emittedPathsOf(archivedCandidate || {})).not.toContain(activeAliasPath);
    expect(emittedPathsOf(archivedCandidate || {}).some((route) => (
      emittedPathsOf(activeAfter, { active: true }).includes(route)
    ))).toBe(false);
  });

  it('checks missing locale slugs against the production title fallback before transferring aliases', () => {
    const fallbackSlug = 'synthetic-generated-fallback';
    const historical = activeJob('', fallbackSlug, 187, { canton: 'TI' });
    delete historical.slugByLocale;
    const activeOwner = activeJob('acme-current-187', 'synthetic-current-fallback-owner', 187, {
      canton: 'TI',
    });
    delete activeOwner.slugByLocale;
    const fallbackOwner = activeJob('acme-fallback-188', 'synthetic-unused-canonical', 188, {
      canton: 'TI',
      title: fallbackSlug,
      company: '',
      location: '',
    });
    delete fallbackOwner.slug;
    delete fallbackOwner.slugByLocale;
    expect(localizedActiveJobSlug(fallbackOwner, 'de')).toBe(fallbackSlug);
    const fallbackOwnerPaths = new Set(emittedPathsOf(fallbackOwner, { active: true }));
    commit({ active: [historical], expired: [] });
    commit({ active: [activeOwner, fallbackOwner] });
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const historicalRoutes = new Set(emittedPathsOf(historical, { active: true }));
    for (const locale of ['en', 'de', 'fr']) {
      const section = cantonResolvers.resolveCantonSection(locale, 'TI');
      const expectedPath = `${locale}/${section}/${fallbackSlug}/`;
      expect(historicalRoutes.has(expectedPath)).toBe(true);
      expect(fallbackOwnerPaths.has(expectedPath)).toBe(true);
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBeGreaterThan(0);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [historical, activeOwner, fallbackOwner]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
  });

  it('does not merge an already-served route-only candidate into a known archive identity', () => {
    const listing = 'https://jobs.example.invalid/open-positions';
    const sharedSlug = 'tecnico-sicurezza-lugano';
    const archived = record(sharedSlug, 75, {
      slugByLocale: { it: sharedSlug, de: 'sicherheitstechniker-lugano' },
    });
    const routeOnly = activeJob('', sharedSlug, 0, {
      url: listing,
      title: 'Payload route-only aggiornato',
      slugByLocale: { it: sharedSlug, de: 'sicherheitstechniker-lugano' },
    });
    commit({ active: [routeOnly], expired: [archived] });
    commit({ active: [], expired: [archived] });
    const archiveBefore = readArchive();

    run();

    expect(readArchive()).toEqual(archiveBefore);
    expect(readArchive()[0].sourceIdentity).toBe(`url:${sourceUrl(75)}`);
    expect(readArchive()[0]).not.toHaveProperty('sourceIdentityHistory');
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

  it('refuses a fixed-point history whose exact route is owned by a distinct posting', () => {
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
    const activeBefore = readFileSync(activePath());
    const archiveBefore = readFileSync(expiredPath());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run();

    expect(result?.refusedRoutes).toBe(4);
    const diagnostic = error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(diagnostic).toContain('emitted route(s) have archive ownership or canton history');
    expectRouteDetailsRedacted(diagnostic, [other, renamed]);
    expect(readFileSync(activePath())).toEqual(activeBefore);
    expect(readFileSync(expiredPath())).toEqual(archiveBefore);
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

  it('coalesces changing identity histories by a shared posting proof and keeps all compact route evidence', () => {
    const older = listingRecord('synthetic-identity-history-old', {
      id: 'synthetic-stable-posting-id',
      sourceIdentity: 'id:synthetic-source-v1',
      sourceIdentityHistory: [{ sourceIdentity: 'id:synthetic-source-shared' }],
      canton: 'TI',
      slugByLocale: {
        it: 'synthetic-identity-history-old',
        de: 'synthetic-identity-history-old-de',
      },
      expiredAt: daysAgo(40),
    });
    const newer = listingRecord('synthetic-identity-history-new', {
      id: 'synthetic-stable-posting-id',
      sourceIdentity: 'id:synthetic-source-v2',
      sourceIdentityHistory: [
        { sourceIdentity: 'id:synthetic-source-shared' },
        { sourceIdentity: 'id:synthetic-source-v2' },
      ],
      canton: 'ZH',
      slugByLocale: {
        it: 'synthetic-identity-history-new',
        de: 'synthetic-identity-history-new-de',
      },
      expiredAt: daysAgo(10),
    });
    const collector = createHistoricalExpiredOwnerCollector();
    collector.add(older);
    collector.add(newer);

    const owners = [...collector.values()];
    expect(owners).toHaveLength(1);
    expect(owners[0].representative).toMatchObject({
      slug: newer.slug,
      title: newer.title,
    });
    expect(owners[0].hasDistinctPayload).toBe(true);
    const retainedPaths = new Set(
      [...owners[0].routeEvidenceByPath.values()].map(({ emittedPath }: Row) => emittedPath),
    );
    for (const emittedPath of [...emittedPathsOf(older), ...emittedPathsOf(newer)]) {
      expect(retainedPaths.has(emittedPath)).toBe(true);
    }
    expect(owners[0].identityEvidence.sourceIdentity).toBe('id:synthetic-source-shared');
    expect([...owners[0].observedDeclaredIdentities]).toEqual(expect.arrayContaining([
      'id:synthetic-source-v1',
      'id:synthetic-source-shared',
      'id:synthetic-source-v2',
    ]));
  });

  it('keeps listing-only and non-transitive identity evidence in separate owner components', () => {
    const collector = createHistoricalExpiredOwnerCollector();
    collector.add(listingRecord('synthetic-shared-listing-a', { sourceIdentity: `url:${listing}` }));
    collector.add(listingRecord('synthetic-shared-listing-b', { sourceIdentity: `url:${listing}` }));
    expect([...collector.values()]).toHaveLength(2);

    const chainCollector = createHistoricalExpiredOwnerCollector();
    chainCollector.add(record('synthetic-non-transitive-route', 801, {
      sourceIdentity: 'id:synthetic-owner-a',
      sourceIdentityHistory: [{ sourceIdentity: 'id:synthetic-bridge-ab' }],
    }));
    chainCollector.add(record('synthetic-non-transitive-route', 802, {
      sourceIdentity: 'id:synthetic-bridge-ab',
      sourceIdentityHistory: [{ sourceIdentity: 'id:synthetic-bridge-bc' }],
    }));
    chainCollector.add(record('synthetic-non-transitive-route', 803, {
      sourceIdentity: 'id:synthetic-bridge-bc',
      sourceIdentityHistory: [{ sourceIdentity: 'id:synthetic-owner-c' }],
    }));
    expect([...chainCollector.values()]).toHaveLength(2);
    expect([...chainCollector.values()].map((owner) => [...owner.commonPostingIdentities]).sort())
      .toEqual([
        ['id:synthetic-bridge-ab'],
        ['id:synthetic-bridge-bc', 'id:synthetic-owner-c'],
      ]);
  });

  it('deduplicates repeated route keys while tracking listing overlaps and bridges', () => {
    const collector = createListingIdentityCollector();
    const listingIdentity = `url:${listing}`;
    collector.addArchiveRow({
      id: 'synthetic-posting-a',
      slug: 'synthetic-slug-a',
      slugByLocale: { it: 'synthetic-slug-a' },
      previousSlugs: ['synthetic-slug-a', 'synthetic-slug-a'],
      sourceIdentity: listingIdentity,
    });
    expect(collector.isAmbiguous(listingIdentity)).toBe(false);
    collector.addArchiveRow({
      id: 'synthetic-posting-b',
      slug: 'synthetic-slug-b',
      slugByLocale: { it: 'synthetic-slug-b' },
      previousSlugs: ['synthetic-slug-b'],
      sourceIdentity: listingIdentity,
    });
    expect(collector.isAmbiguous(listingIdentity)).toBe(true);
    collector.addArchiveRow({
      id: 'synthetic-bridge',
      slug: 'synthetic-slug-bridge',
      previousSlugs: ['synthetic-slug-a', 'synthetic-slug-b'],
      sourceIdentity: listingIdentity,
    });
    expect(collector.isAmbiguous(listingIdentity)).toBe(false);
    collector.addArchiveRow({ id: 'synthetic-posting-c', slug: 'synthetic-slug-c', sourceIdentity: listingIdentity });
    expect(collector.isAmbiguous(listingIdentity)).toBe(true);
  });

  it('joins a large synthetic set of listing components without timing assumptions', () => {
    const collector = createListingIdentityCollector();
    const listingIdentity = `url:${listing}`;
    const size = 4096;
    for (let index = 0; index < size; index += 1) {
      collector.addArchiveRow({
        id: `synthetic-posting-${index}`,
        slug: `synthetic-component-${index}`,
        sourceIdentity: listingIdentity,
      });
    }
    expect(collector.isAmbiguous(listingIdentity)).toBe(true);
    collector.addArchiveRow({
      id: 'synthetic-component-bridge',
      slug: 'synthetic-component-bridge',
      previousSlugs: Array.from({ length: size }, (_, index) => `synthetic-component-${index}`),
      sourceIdentity: listingIdentity,
    });
    expect(collector.isAmbiguous(listingIdentity)).toBe(false);
  });

  it('preserves fragment and within-version listing ambiguity', () => {
    const collector = createListingIdentityCollector();
    const listingIdentity = `url:${listing}`;
    collector.addVersion([{
      id: 'synthetic-fragment-id',
      slug: 'synthetic-fragment-slug',
      sourceIdentity: listingIdentity,
      url: `${listing}#first`,
    }]);
    collector.addVersion([{
      id: 'synthetic-fragment-id',
      slug: 'synthetic-fragment-slug',
      sourceIdentity: listingIdentity,
      url: `${listing}#second`,
    }]);
    expect(collector.isAmbiguous(listingIdentity)).toBe(true);

    const sameVersionCollector = createListingIdentityCollector();
    sameVersionCollector.addVersion([
      { id: 'synthetic-version-a', slug: 'synthetic-version-a', sourceIdentity: listingIdentity },
      { id: 'synthetic-version-b', slug: 'synthetic-version-b', sourceIdentity: listingIdentity },
    ]);
    expect(sameVersionCollector.isAmbiguous(listingIdentity)).toBe(true);
  });

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

  it('keeps a recovered posting separate when an archived identity history retains the listing URL', () => {
    const listingIdentity = `url:${listing}`;
    const archived = listingRecord('archive-current', {
      id: 'a',
      sourceIdentity: `url:${sourceUrl(1)}`,
      previousSlugs: ['archive-historical'],
      sourceIdentityHistory: [{ sourceIdentity: listingIdentity }],
    });
    const recovered = onListing('b', 'recovered-current', {
      sourceIdentity: listingIdentity,
      previousSlugs: ['recovered-historical'],
    });
    commit({ active: [recovered], expired: [archived] });
    commit({ active: [], expired: [archived] });

    const { first, second } = runTwice();

    expect(first).toHaveLength(2);
    const routes = routesBySlug(first);
    expect(routes['archive-current']).toEqual(expect.arrayContaining([
      'it:archive-current', 'it:archive-historical',
      'de:archive-historical', 'en:archive-historical', 'fr:archive-historical',
    ]));
    expect(routes['recovered-current']).toEqual(expect.arrayContaining([
      'it:recovered-current', 'it:recovered-historical',
      'de:recovered-historical', 'en:recovered-historical', 'fr:recovered-historical',
    ]));
    expect(second).toEqual(first);
  });

  it('keeps apart a lost job that declares the listing identity only in its history', () => {
    // `a` has its own detail page today and the listing URL in its history; the
    // older `b` is identified by the listing URL. Never open together.
    const ownDetail = 'https://jobs.example.invalid/jobs/a';
    commit({ active: [onListing('b', 'new', { crawledAt: daysAgo(40) })] });
    commit({
      active: [onListing('a', 'old', {
        url: ownDetail,
        sourceIdentityHistory: [{ sourceIdentity: `url:${listing}` }],
        crawledAt: daysAgo(3),
      })],
    });
    commit({ active: [] });

    const { first, second } = runTwice();
    commit({});
    run();

    expect(routesBySlug(first)).toEqual({ old: ['it:old'], new: ['it:new'] });
    expect(routesBySlug(second)).toEqual(routesBySlug(first));
    // The second run only completes `a`'s identity history with its own primary
    // identity (the existing same-slug merge); from there nothing moves.
    expect(readArchive()).toEqual(second);
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
      .toEqual([
        'de:lattoniere-faido',
        'en:lattoniere-faido',
        'fr:lattoniere-faido',
        'it:lattoniere-esperto-faido',
        'it:lattoniere-faido',
      ]);
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
