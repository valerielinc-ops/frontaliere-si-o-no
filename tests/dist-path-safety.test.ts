import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isDistPathOverFilesystemLimits,
  isSafeDistPath,
  MAX_DIST_PATH_BYTES,
  MAX_FILESYSTEM_SEGMENT_BYTES,
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

describe('raw URL-to-dist writers apply the guard before filesystem joins', () => {
  it('guards both legacy redirect emission loops', () => {
    expect(LEGACY_SOURCE.match(/isSafeDistPath\(from\)/g) ?? []).toHaveLength(2);
    expect(LEGACY_SOURCE.match(/isDistPathOverFilesystemLimits\(from\)/g) ?? []).toHaveLength(2);
    const firstJoin = LEGACY_SOURCE.indexOf('const outDir = path.join(distDir, from.slice(1));');
    expect(LEGACY_SOURCE.indexOf('isDistPathOverFilesystemLimits(from)')).toBeLessThan(firstJoin);
    expect(LEGACY_SOURCE.indexOf('if (!isSafeDistPath(from)')).toBeLessThan(firstJoin);
  });

  it('guards the Cloudflare/GSC compatibility writer', () => {
    expect(CF_SOURCE).toContain('if (isDistPathOverFilesystemLimits(from)');
    expect(CF_SOURCE).toContain('if (!isSafeDistPath(from)');
    expect(CF_SOURCE.indexOf('if (isDistPathOverFilesystemLimits(from)')).toBeLessThan(
      CF_SOURCE.indexOf('const outDir = path.join(distDir, from.slice(1));'),
    );
    expect(CF_SOURCE.indexOf('if (!isSafeDistPath(from)')).toBeLessThan(
      CF_SOURCE.indexOf('const outDir = path.join(distDir, from.slice(1));'),
    );
  });

  it('guards job soft-landing and cross-locale writes before filesystem joins', () => {
    expect(JOBS_SOURCE).toContain('isDistPathOverFilesystemLimits(distPath)');
    expect(JOBS_SOURCE.match(/isDistPathOverFilesystemLimits\(relPath\)/g) ?? []).toHaveLength(2);
    expect(JOBS_SOURCE.indexOf('isDistPathOverFilesystemLimits(distPath)')).toBeLessThan(
      JOBS_SOURCE.indexOf('const targetFile = np.join(distDir, normPath'),
    );
    expect(JOBS_SOURCE.indexOf('isDistPathOverFilesystemLimits(relPath)')).toBeLessThan(
      JOBS_SOURCE.indexOf('const outDir = np.join(distDir, relPath.replace(/^\\//, \'\'));'),
    );
  });

  it('guards the dedicated GSC orphan emitters before filesystem joins', () => {
    expect(JOB_ORPHAN_SOURCE).toContain('if (isDistPathOverFilesystemLimits(orphanPath)');
    expect(JOB_ORPHAN_SOURCE.indexOf('if (isDistPathOverFilesystemLimits(orphanPath)')).toBeLessThan(
      JOB_ORPHAN_SOURCE.indexOf("const indexTarget = path.join(distDir, orphanPath, 'index.html');"),
    );
    expect(LEGACY_ALIAS_SOURCE).toContain('isDistPathOverFilesystemLimits(entry.orphanPath)');
    expect(LEGACY_ALIAS_SOURCE).toContain('isDistPathOverFilesystemLimits(route)');
  });

  it('guards GSC location and company bridge emitters before filesystem joins', () => {
    for (const [source, name] of [[LOCATION_SOURCE, 'location'], [COMPANY_SOURCE, 'company']] as const) {
      expect(source, name).toContain('isDistPathOverFilesystemLimits(hubPath)');
      expect(source, name).toContain('isSafeDistPath(hubPath)');
      expect(source.indexOf('isDistPathOverFilesystemLimits(hubPath)'), name).toBeLessThan(
        source.indexOf("const indexTarget = path.join(distDir, hubPath, 'index.html');"),
      );
    }
  });

  it('uses the same guard for related-search retirement writes', () => {
    expect(RELATED_SOURCE).toContain('if (stem === \'\' || !isSafeDistPath(stem)) return null;');
  });
});
