import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  getSafeDistPageTargets,
  isDistPathOverFilesystemLimits,
  isSafeDistPath,
  MAX_DIST_PATH_BYTES,
  MAX_FILESYSTEM_SEGMENT_BYTES,
  writeDistPageSafely,
} from '../build-plugins/shared/distPathSafety';
import { assertRetainedBridgeMissingBudget, classifyRetainedNotEmitted, isRetainedBridgeOwnedBy, isRetainedBridgePathSafeToEmit } from '../build-plugins/shared/jobCanonBridgePaths';
import {
  claim,
  getJobAliasRedirectDirs,
  isJobAliasRedirectPath,
  reserveJobAliasRedirectDir,
  reserveRetainedJobBridgeDir,
  reset as resetWriteRegistry,
} from '../build-plugins/sharedWriteRegistry';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

const BATCH_WRITE_SOURCE = read('../build-plugins/batchWrite.ts');
const LEGACY_SOURCE = read('../build-plugins/legacyRedirectsPlugin.ts');
const CF_SOURCE = read('../build-plugins/cfHot404BridgePlugin.ts');
const JOBS_SOURCE = read('../build-plugins/jobsSeoPagesPlugin.ts');
const JOB_ORPHAN_SOURCE = read('../build-plugins/jobOrphanBridgePlugin.ts');
const LEGACY_ALIAS_SOURCE = read('../build-plugins/legacyAliasPlugin.ts');
const LOCATION_SOURCE = read('../build-plugins/locationHubBridgePlugin.ts');
const COMPANY_SOURCE = read('../build-plugins/companyHubBridgePlugin.ts');
const RELATED_SOURCE = read('../build-plugins/relatedSearchClustersPlugin.ts');
const CANTON_ORPHAN_SOURCE = read('../build-plugins/cantonOrphanRedirectsPlugin.ts');
const DIST_SAFETY_SOURCE = read('../build-plugins/shared/distPathSafety.ts');
const CALCULATOR_SOURCE = read('../build-plugins/calculatorLegacyAliasPlugin.ts');
const RECENCY_SOURCE = read('../build-plugins/jobRecencyPagesPlugin.ts');
const SECTOR_SOURCE = read('../build-plugins/jobSectorPagesPlugin.ts');
const PHARMACY_SOURCE = read('../build-plugins/pharmacyDirectoryPagesPlugin.ts');

describe('isSafeDistPath', () => {
  it('rejects dot-prefixed segments, including the Search Console offender shape', () => {
    expect(isSafeDistPath('/eventi/ginevra/le-forum-de-la-paix-2026-10-12//.env.bak/')).toBe(false);
    expect(isSafeDistPath('/foo/.well-known/page/')).toBe(false);
    expect(isSafeDistPath('/foo/../page/')).toBe(false);
    expect(isSafeDistPath('/foo/./page/')).toBe(false);
  });

  it('accepts ordinary URL paths and duplicate non-dot separators', () => {
    expect(isSafeDistPath('/eventi/ginevra/le-forum-de-la-paix-2026-10-12/')).toBe(true);
    expect(isSafeDistPath('/foo//page/')).toBe(true);
  });

  it('rejects a segment over the filesystem byte limit and an unreasonable total path', () => {
    expect(isDistPathOverFilesystemLimits(`/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`)).toBe(true);
    expect(isSafeDistPath(`/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`)).toBe(false);
    expect(isDistPathOverFilesystemLimits(`/${'x'.repeat(MAX_DIST_PATH_BYTES + 1)}`)).toBe(true);
    expect(isSafeDistPath(`/${'x'.repeat(MAX_DIST_PATH_BYTES + 1)}`)).toBe(false);
    expect(isSafeDistPath(`/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES)}/`)).toBe(true);
    expect(isDistPathOverFilesystemLimits(`/${'é'.repeat(127)}/`)).toBe(false);
    expect(isDistPathOverFilesystemLimits(`/${'é'.repeat(128)}/`)).toBe(true);
  });
});

describe('filesystem target preflight', () => {
  it('rejects a 251-byte final segment because the flat sibling would be 256 bytes', () => {
    const pathname = `/${'x'.repeat(251)}/`;
    expect(isSafeDistPath(pathname)).toBe(true);
    expect(getSafeDistPageTargets('/runner/dist', pathname)).toBeNull();
  });

  it('accepts and reserves a removable alias when only its flat sibling is unaddressable', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-removable-alias-'));
    const pathname = `/${'x'.repeat(251)}/`;
    const targets = getSafeDistPageTargets(distDir, pathname, { includeFlat: false });
    try {
      expect(isSafeDistPath(pathname)).toBe(true);
      expect(getSafeDistPageTargets(distDir, pathname)).toBeNull();
      expect(targets).not.toBeNull();
      expect(targets?.flatPath).toBeUndefined();

      fs.mkdirSync(targets!.directoryPath);
      reserveJobAliasRedirectDir(targets!.directoryPath);

      expect([...getJobAliasRedirectDirs()]).toContain(path.resolve(targets!.directoryPath));
      expect(isJobAliasRedirectPath(targets!.indexPath)).toBe(true);
      expect(isJobAliasRedirectPath(`${targets!.directoryPath}.html`)).toBe(true);
      expect(fs.existsSync(targets!.indexPath)).toBe(false);
      expect(fs.existsSync(`${targets!.directoryPath}.html`)).toBe(false);
    } finally {
      resetWriteRegistry();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('uses the index target for retained aliases when only the flat sibling is unsafe', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-retained-alias-'));
    const reservedPath = `/${'x'.repeat(251)}/`;
    const retainedClassification = vi.fn(() => true);
    const indexTargets = getSafeDistPageTargets(distDir, reservedPath, { includeFlat: false });
    try {
      expect(indexTargets).not.toBeNull();
      expect(getSafeDistPageTargets(distDir, reservedPath)).toBeNull();

      fs.mkdirSync(indexTargets!.directoryPath);
      reserveJobAliasRedirectDir(indexTargets!.directoryPath);

      expect(isRetainedBridgePathSafeToEmit(
        distDir,
        reservedPath,
        isJobAliasRedirectPath,
        retainedClassification,
      )).toBe(false);
      expect(retainedClassification).not.toHaveBeenCalled();

      const safeRetainedClassification = vi.fn(() => true);
      expect(isRetainedBridgePathSafeToEmit(
        distDir,
        '/safe/',
        isJobAliasRedirectPath,
        safeRetainedClassification,
      )).toBe(true);
      expect(safeRetainedClassification).toHaveBeenCalledWith('/safe/');

      const onUnplannedPath = vi.fn();
      expect(isRetainedBridgePathSafeToEmit(distDir, '/unclassified/', isJobAliasRedirectPath, () => false, onUnplannedPath))
        .toBe(false);
      expect(onUnplannedPath).toHaveBeenCalledTimes(1);
      expect(onUnplannedPath).toHaveBeenCalledWith('/unclassified/');

      const classifiedCallback = vi.fn();
      expect(isRetainedBridgePathSafeToEmit(distDir, '/classified/', isJobAliasRedirectPath, () => true, classifiedCallback))
        .toBe(true);
      expect(classifiedCallback).not.toHaveBeenCalled();

      const reservedCallback = vi.fn();
      expect(isRetainedBridgePathSafeToEmit(distDir, reservedPath, isJobAliasRedirectPath, () => false, reservedCallback))
        .toBe(false);
      expect(reservedCallback).not.toHaveBeenCalled();

      const nonReservedPath = `/${'y'.repeat(251)}/`;
      const nonReservedClassification = vi.fn(() => true);
      expect(isRetainedBridgePathSafeToEmit(
        distDir,
        nonReservedPath,
        isJobAliasRedirectPath,
        nonReservedClassification,
      )).toBe(true);
      expect(nonReservedClassification).toHaveBeenCalledWith(nonReservedPath);
    } finally {
      resetWriteRegistry();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('skips unsafe URL and directory targets before retained classification', () => {
    const unsafeUrl = `/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`;
    const hasRetainedClassification = vi.fn(() => true);
    expect(isRetainedBridgePathSafeToEmit('/runner/dist', unsafeUrl, isJobAliasRedirectPath, hasRetainedClassification))
      .toBe(false);

    const overlongDistDir = path.resolve(
      os.tmpdir(),
      ...Array.from({ length: 17 }, () => 'd'.repeat(235)),
    );
    expect(isRetainedBridgePathSafeToEmit(overlongDistDir, '/safe/', isJobAliasRedirectPath, hasRetainedClassification))
      .toBe(false);
    expect(hasRetainedClassification).not.toHaveBeenCalled();
  });

  it('keeps URL and directory target safety checks when the flat sibling is omitted', () => {
    const unsafeUrl = `/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`;
    expect(getSafeDistPageTargets('/runner/dist', unsafeUrl, { includeFlat: false })).toBeNull();

    const overlongDistDir = path.resolve(
      os.tmpdir(),
      ...Array.from({ length: 17 }, () => 'd'.repeat(235)),
    );
    expect(getSafeDistPageTargets(overlongDistDir, '/safe/', { includeFlat: false })).toBeNull();
  });

  it('rejects a pathname at the 4096-byte boundary before either target is emitted', () => {
    const pathname = `/${[
      ...Array.from({ length: 16 }, () => 'x'.repeat(204)),
      ...Array.from({ length: 4 }, () => 'x'.repeat(203)),
    ].join('/')}`;
    expect(Buffer.byteLength(pathname, 'utf8')).toBe(MAX_DIST_PATH_BYTES);
    expect(isSafeDistPath(pathname)).toBe(true);

    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-preflight-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const relativePath = pathname.replace(/^\/+/, '');
      const indexPath = path.join(distDir, relativePath, 'index.html');
      const flatPath = path.join(distDir, `${relativePath}.html`);
      expect(getSafeDistPageTargets(distDir, pathname)).toBeNull();
      expect(writeDistPageSafely({
        distDir,
        indexPath,
        flatPath,
        html: '<html></html>',
        urlPath: pathname,
        logPrefix: 'preflight-test',
      })).toBe(false);
      expect(fs.readdirSync(distDir)).toEqual([]);
    } finally {
      warn.mockRestore();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('returns both targets and emits a normal page', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-preflight-'));
    const pathname = '/de/aziende/normal-page/';
    try {
      const targets = getSafeDistPageTargets(distDir, pathname);
      expect(targets?.flatPath).toBe(path.join(distDir, 'de/aziende/normal-page.html'));
      expect(writeDistPageSafely({
        distDir,
        indexPath: targets!.indexPath,
        flatPath: targets!.flatPath,
        html: '<html></html>',
        urlPath: pathname,
        logPrefix: 'preflight-test',
      })).toBe(true);
      expect(fs.existsSync(targets!.indexPath)).toBe(true);
      expect(fs.existsSync(targets!.flatPath!)).toBe(true);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('blocks safe compatibility page writes after an alias path is reserved', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-reserved-alias-'));
    const pathname = '/de/jobs-in-zurich/old-route/';
    const targets = getSafeDistPageTargets(distDir, pathname)!;
    try {
      reserveJobAliasRedirectDir(targets.directoryPath);
      expect(writeDistPageSafely({
        distDir,
        indexPath: targets.indexPath,
        flatPath: targets.flatPath,
        html: '<html>compatibility page</html>',
        urlPath: pathname,
        logPrefix: 'reserved-alias-test',
      })).toBe(false);
      expect(fs.existsSync(targets.indexPath)).toBe(false);
      expect(fs.existsSync(targets.flatPath!)).toBe(false);
    } finally {
      resetWriteRegistry();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('blocks direct compatibility writes after a retained bridge reserves the output', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-retained-bridge-'));
    const pathname = '/de/jobs-in-zurich/old-route/';
    const targets = getSafeDistPageTargets(distDir, pathname)!;
    try {
      reserveRetainedJobBridgeDir(targets.directoryPath);
      expect(writeDistPageSafely({
        distDir,
        indexPath: targets.indexPath,
        flatPath: targets.flatPath,
        html: '<html>archive or compatibility page</html>',
        urlPath: pathname,
        logPrefix: 'retained-bridge-reservation-test',
      })).toBe(false);
      expect(fs.existsSync(targets.indexPath)).toBe(false);
      expect(fs.existsSync(targets.flatPath!)).toBe(false);
    } finally {
      resetWriteRegistry();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('blocks safe compatibility page writes when a richer page is only claimed', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-path-claimed-page-'));
    const pathname = '/de/jobs-in-zurich/active-route/';
    const targets = getSafeDistPageTargets(distDir, pathname)!;
    try {
      claim(targets.indexPath, 'jobs-seo-pages', '<html>active page</html>');
      expect(writeDistPageSafely({
        distDir,
        indexPath: targets.indexPath,
        flatPath: targets.flatPath,
        html: '<html>compatibility page</html>',
        urlPath: pathname,
        logPrefix: 'claimed-page-test',
      })).toBe(false);
      expect(fs.existsSync(targets.indexPath)).toBe(false);
      expect(fs.existsSync(targets.flatPath!)).toBe(false);
    } finally {
      resetWriteRegistry();
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});

describe('raw URL-to-dist writers apply the guard before filesystem joins', () => {
  it('keeps the full filesystem preflight in the 404/GSC emitters, not batchWrite', () => {
    expect(BATCH_WRITE_SOURCE).not.toContain('distPathSafety');
    expect(BATCH_WRITE_SOURCE).not.toContain('getSafeDistPageTargets');
    expect(BATCH_WRITE_SOURCE).not.toContain('isSafeDistTargetPath');
  });

  it('guards both legacy redirect emission loops', () => {
    expect(LEGACY_SOURCE.match(/getSafeDistPageTargets\(distDir, from\)/g) ?? []).toHaveLength(2);
    expect(LEGACY_SOURCE.match(/isSafeDistPath\(from\)/g) ?? []).toHaveLength(2);
    expect(LEGACY_SOURCE.match(/isDistPathOverFilesystemLimits\(from\)/g) ?? []).toHaveLength(2);
    expect(LEGACY_SOURCE.match(/const outDir = safeTargets\.directoryPath;/g) ?? []).toHaveLength(2);
    expect(LEGACY_SOURCE.indexOf('getSafeDistPageTargets(distDir, from)')).toBeLessThan(
      LEGACY_SOURCE.indexOf('const outDir = safeTargets.directoryPath;'),
    );
  });

  it('guards the Cloudflare/GSC compatibility writer', () => {
    expect(CF_SOURCE).toContain('getSafeDistPageTargets(distDir, from)');
    expect(CF_SOURCE).toContain('if (isDistPathOverFilesystemLimits(from)');
    expect(CF_SOURCE).toContain('if (!isSafeDistPath(from)');
    expect(CF_SOURCE.indexOf('getSafeDistPageTargets(distDir, from)')).toBeLessThan(
      CF_SOURCE.indexOf('const outDir = safeTargets.directoryPath;'),
    );
  });

  it('guards job soft-landing and cross-locale writes before filesystem joins', () => {
    expect(JOBS_SOURCE).toContain('getSafeDistPageTargets(distDir, distPath)');
    expect(JOBS_SOURCE.match(/getSafeDistPageTargets\(distDir, relPath\)/g) ?? []).toHaveLength(1);
    expect(JOBS_SOURCE.match(/getSafeDistPageTargets\(distDir, relPath, \{ includeFlat: false \}\)/g) ?? [])
      .toHaveLength(1);
    expect(JOBS_SOURCE).toContain('isDistPathOverFilesystemLimits(distPath)');
    expect(JOBS_SOURCE.match(/isDistPathOverFilesystemLimits\(relPath\)/g) ?? []).toHaveLength(2);
    expect(JOBS_SOURCE.indexOf('getSafeDistPageTargets(distDir, distPath)')).toBeLessThan(
      JOBS_SOURCE.indexOf('const targetFile = safeTargets.indexPath'),
    );
  });

  it('guards the dedicated GSC orphan emitters before filesystem joins', () => {
    expect(JOB_ORPHAN_SOURCE).toContain('getSafeDistPageTargets(distDir, orphanPath)');
    expect(JOB_ORPHAN_SOURCE).toContain('if (isDistPathOverFilesystemLimits(orphanPath)');
    expect(JOB_ORPHAN_SOURCE.indexOf('getSafeDistPageTargets(distDir, orphanPath)')).toBeLessThan(
      JOB_ORPHAN_SOURCE.indexOf('const { indexPath: indexTarget, flatPath: flatTarget } = safeTargets;'),
    );
    expect(LEGACY_ALIAS_SOURCE).toContain('isDistPathOverFilesystemLimits(entry.orphanPath)');
    expect(LEGACY_ALIAS_SOURCE).toContain('isDistPathOverFilesystemLimits(route)');
  });

  it('guards GSC location and company bridge emitters before filesystem joins', () => {
    for (const [source, name] of [[LOCATION_SOURCE, 'location'], [COMPANY_SOURCE, 'company']] as const) {
      expect(source, name).toContain('getSafeDistPageTargets(distDir, hubPath)');
      expect(source, name).toContain('isDistPathOverFilesystemLimits(hubPath)');
      expect(source, name).toContain('isSafeDistPath(hubPath)');
      expect(source.indexOf('getSafeDistPageTargets(distDir, hubPath)'), name).toBeLessThan(
        source.indexOf('const { indexPath: indexTarget, flatPath: flatTarget } = safeTargets;'),
      );
    }
  });

  it('uses the same guard for related-search retirement writes', () => {
    expect(RELATED_SOURCE).toContain('if (stem === \'\' || !isSafeDistPath(stem)) return null;');
    expect(RELATED_SOURCE).toContain('const safeTargets = getSafeDistPageTargets(distDir, landingPath);');
    expect(RELATED_SOURCE).toContain('!hasClaimedOrReservedPath(path.resolve(distDir, rel))');
    expect(RELATED_SOURCE).toContain('!hasClaimedOrReservedPath(outputPath)');
    expect(RELATED_SOURCE).toContain('return safeWrites.length;');
  });

  it('routes direct compatibility writers through active job path reservations', () => {
    for (const source of [JOB_ORPHAN_SOURCE, LEGACY_ALIAS_SOURCE, LOCATION_SOURCE,
      COMPANY_SOURCE, CANTON_ORPHAN_SOURCE]) {
      expect(source).toContain('hasClaimedOrReservedPath');
    }
    expect(LEGACY_SOURCE).toContain('writeDistPageSafely({');
    expect(CF_SOURCE).toContain('writeDistPageSafely({');
    expect(DIST_SAFETY_SOURCE).toContain('hasClaimedOrReservedPath(indexPath)');
    expect(DIST_SAFETY_SOURCE).toContain('hasClaimedOrReservedPath(flatPath)');
    expect(JOB_ORPHAN_SOURCE).toContain('hasClaimedOrReservedPath(indexTarget)');
    expect(LEGACY_ALIAS_SOURCE).toContain('hasClaimedOrReservedPath(indexTarget)');
    expect(LOCATION_SOURCE).toContain('hasClaimedOrReservedPath(indexTarget)');
    expect(COMPANY_SOURCE).toContain('hasClaimedOrReservedPath(indexTarget)');
    expect(CF_SOURCE).toContain('hasClaimedOrReservedPath(safeTargets.indexPath)');
    expect(CANTON_ORPHAN_SOURCE).toContain('hasClaimedOrReservedPath(outFile)');
    expect(CALCULATOR_SOURCE).toContain('hasClaimedOrReservedPath(safeTargets.indexPath)');
    // Recency hubs own their URL: skip only job-alias redirects and retained
    // bridges, never a path merely claimed by another writer (it is logged).
    expect(RECENCY_SOURCE).toContain('isJobAliasRedirectPath(safeTargets.indexPath)');
    expect(RECENCY_SOURCE).toContain('isRetainedJobBridgeOutputPath(safeTargets.indexPath)');
    expect(RECENCY_SOURCE).not.toContain('hasClaimedOrReservedPath');
    expect(RECENCY_SOURCE).toContain('claimed-by-other-writer=');
    // Explicit ownership through the registry: declaration + claims, disk
    // writes only on allow-write, sitemap push only when we own the final page.
    expect(RECENCY_SOURCE).toContain('declareSharedPath({');
    expect(RECENCY_SOURCE).toContain('winner: JOB_RECENCY_WRITER');
    expect(RECENCY_SOURCE).toContain("claim(safeTargets.indexPath, JOB_RECENCY_WRITER, html)");
    expect(RECENCY_SOURCE).toContain("claim(safeTargets.flatPath, JOB_RECENCY_WRITER, html)");
    expect(RECENCY_SOURCE).toContain("indexOutcome === 'allow-write'");
    expect(RECENCY_SOURCE).toContain("flatOutcome === 'allow-write'");
    expect(RECENCY_SOURCE.indexOf('const ownsOutput')).toBeLessThan(RECENCY_SOURCE.indexOf('sitemapEntries.push('));
    expect(RECENCY_SOURCE).toContain('JSON.stringify(claimedByOtherWriterExamples)');
    // Sector hubs own their URL family just like recency hubs: only alias
    // redirects and retained bridges may suppress the page, otherwise a prior
    // claim must not make the sitemap outrun the emitted page.
    expect(SECTOR_SOURCE).toContain('isJobAliasRedirectPath(safeTargets.indexPath)');
    expect(SECTOR_SOURCE).toContain('isRetainedJobBridgeOutputPath(safeTargets.indexPath)');
    expect(SECTOR_SOURCE).not.toContain('hasClaimedOrReservedPath');
    expect(SECTOR_SOURCE).toContain('declareSharedPath({');
    expect(SECTOR_SOURCE).toContain('winner: JOB_SECTOR_WRITER');
    expect(SECTOR_SOURCE).toContain("claim(safeTargets.indexPath, JOB_SECTOR_WRITER, html)");
    expect(SECTOR_SOURCE).toContain("claim(safeTargets.flatPath, JOB_SECTOR_WRITER, html)");
    expect(SECTOR_SOURCE).toContain("indexOutcome === 'allow-write'");
    expect(SECTOR_SOURCE).toContain("flatOutcome === 'allow-write'");
    expect(SECTOR_SOURCE.indexOf('const ownsOutput')).toBeLessThan(SECTOR_SOURCE.indexOf('sitemapEntries.push('));
    expect(PHARMACY_SOURCE).toContain('hasClaimedOrReservedPath(safeTargets.indexPath)');
    expect(JOBS_SOURCE).toContain('const pathWasClaimed = (filePath: string): boolean => hasClaimedPath(filePath);');
    expect(JOBS_SOURCE).toContain('const pathIsClaimedOrReserved = (filePath: string): boolean => hasClaimedOrReservedPath(filePath);');
    expect(JOBS_SOURCE).toContain('const isSelfHealTrackingPathClaimed = (relativePath: string): boolean => pathWasClaimed(');
  });
});

describe('assertRetainedBridgeMissingBudget', () => {
  it('accepts gaps within max(25, 1%) of the retained bridges', () => {
    expect(() => assertRetainedBridgeMissingBudget(0, 0)).not.toThrow();
    expect(() => assertRetainedBridgeMissingBudget(25, 100)).not.toThrow();
    expect(() => assertRetainedBridgeMissingBudget(48, 4800)).not.toThrow();
  });

  it('rejects a systemic gap and reports the numbers', () => {
    expect(() => assertRetainedBridgeMissingBudget(26, 100)).toThrow(/missing=26.*budget=25/);
    expect(() => assertRetainedBridgeMissingBudget(49, 4800)).toThrow(/missing=49.*budget=48/);
  });
});

describe('retained bridge budget denominator and ownership classification', () => {
  it('uses only the eligible retained total: 26 missing of 100 eligible exceeds budget=25', () => {
    // Retained bridges of locales excluded by shouldEmitLocale() must not be passed as the total.
    expect(() => assertRetainedBridgeMissingBudget(26, 100)).toThrow(/budget=25/);
    expect(() => assertRetainedBridgeMissingBudget(26, 10_100)).not.toThrow();
  });

  it('counts an existing but unclaimed file as missing, never as owned elsewhere', () => {
    const results = Array.from({ length: 26 }, () => classifyRetainedNotEmitted({ claimed: false, ownedBeforePlan: false, exists: true }));
    expect(results.filter((r) => r.kind === 'missing')).toHaveLength(26);
    expect(results.filter((r) => r.kind === 'owned-elsewhere')).toHaveLength(0);
    expect(results[0].flag).toBe('unclaimed-existing');
    expect(classifyRetainedNotEmitted({ claimed: false, ownedBeforePlan: false, exists: false })).toEqual({ kind: 'missing', flag: 'absent' });
  });

  it('treats a claimed path or one owned before the plan as owned elsewhere', () => {
    expect(classifyRetainedNotEmitted({ claimed: true, ownedBeforePlan: false, exists: true }).kind).toBe('owned-elsewhere');
    expect(classifyRetainedNotEmitted({ claimed: false, ownedBeforePlan: true, exists: false }).kind).toBe('owned-elsewhere');
  });
});

describe('isRetainedBridgeOwnedBy', () => {
  const retained = { kind: 'previousSlug', sourceJobIdentifier: 'job-1' };

  it('accepts only the same kind and owner', () => {
    expect(isRetainedBridgeOwnedBy(retained, 'previousSlug', 'job-1')).toBe(true);
    expect(isRetainedBridgeOwnedBy(retained, 'legacyTiMirror', 'job-1')).toBe(false);
    expect(isRetainedBridgeOwnedBy(retained, 'previousSlug', 'job-2')).toBe(false);
    expect(isRetainedBridgeOwnedBy(undefined, 'previousSlug', 'job-1')).toBe(false);
  });
});
