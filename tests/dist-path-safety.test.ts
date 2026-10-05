import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isSafeDistPath } from '../build-plugins/shared/distPathSafety';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

const LEGACY_SOURCE = read('../build-plugins/legacyRedirectsPlugin.ts');
const CF_SOURCE = read('../build-plugins/cfHot404BridgePlugin.ts');
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
});

describe('raw URL-to-dist writers apply the guard before filesystem joins', () => {
  it('guards both legacy redirect emission loops', () => {
    expect(LEGACY_SOURCE.match(/isSafeDistPath\(from\)/g) ?? []).toHaveLength(2);
    const firstJoin = LEGACY_SOURCE.indexOf('const outDir = path.join(distDir, from.slice(1));');
    expect(LEGACY_SOURCE.indexOf('if (!isSafeDistPath(from)')).toBeLessThan(firstJoin);
  });

  it('guards the Cloudflare/GSC compatibility writer', () => {
    expect(CF_SOURCE).toContain('if (!isSafeDistPath(from)');
    expect(CF_SOURCE.indexOf('if (!isSafeDistPath(from)')).toBeLessThan(
      CF_SOURCE.indexOf('const outDir = path.join(distDir, from.slice(1));'),
    );
  });

  it('uses the same guard for related-search retirement writes', () => {
    expect(RELATED_SOURCE).toContain('if (stem === \'\' || !isSafeDistPath(stem)) return null;');
  });
});
