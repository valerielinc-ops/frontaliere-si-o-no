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

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

const LEGACY_SOURCE = read('../build-plugins/legacyRedirectsPlugin.ts');
const CF_SOURCE = read('../build-plugins/cfHot404BridgePlugin.ts');
const JOBS_SOURCE = read('../build-plugins/jobsSeoPagesPlugin.ts');
const JOB_ORPHAN_SOURCE = read('../build-plugins/jobOrphanBridgePlugin.ts');
const LEGACY_ALIAS_SOURCE = read('../build-plugins/legacyAliasPlugin.ts');
const LOCATION_SOURCE = read('../build-plugins/locationHubBridgePlugin.ts');
const COMPANY_SOURCE = read('../build-plugins/companyHubBridgePlugin.ts');
const RELATED_SOURCE = read('../build-plugins/relatedSearchClustersPlugin.ts');

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
});

describe('raw URL-to-dist writers apply the guard before filesystem joins', () => {
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
    expect(CF_SOURCE).toContain('getSafeDistPageTargets(distDir, from, { includeFlat: false })');
    expect(CF_SOURCE).toContain('if (isDistPathOverFilesystemLimits(from)');
    expect(CF_SOURCE).toContain('if (!isSafeDistPath(from)');
    expect(CF_SOURCE.indexOf('getSafeDistPageTargets(distDir, from, { includeFlat: false })')).toBeLessThan(
      CF_SOURCE.indexOf('const outDir = safeTargets.directoryPath;'),
    );
  });

  it('guards job soft-landing and cross-locale writes before filesystem joins', () => {
    expect(JOBS_SOURCE).toContain('getSafeDistPageTargets(distDir, distPath)');
    expect(JOBS_SOURCE.match(/getSafeDistPageTargets\(distDir, relPath, \{ includeFlat: false \}\)/g) ?? []).toHaveLength(2);
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
    expect(RELATED_SOURCE).toContain('return safeWrites.length;');
  });
});
