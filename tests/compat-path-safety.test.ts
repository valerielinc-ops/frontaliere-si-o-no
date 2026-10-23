import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  filterSafeCompatPaths,
  MAX_SAFE_URL_SEGMENT_BYTES,
} from '../scripts/lib/compat-path-safety.mjs';
import {
  isSafeDistPath,
  writeDistPageSafely,
} from '../build-plugins/shared/distPathSafety';
import {
  readCompatPaths,
  writeCompatPaths,
} from '../scripts/lib/compat-paths-store.mjs';

const SQL_PROBE = '/de/aziende/css-versicherung/%27%29%2F%2A%2A%2FANd%2F%2A%2A%2F4242%3D%28SElect%2F%2A%2A%2FxMLTyPe';
const SQL_PROBE_VARIANTS = [
  SQL_PROBE,
  '/de/aziende/css-versicherung/%27%2F%2A%2FSElect%2F%2A%2FxMLTyPe',
  '/de/aziende/css-versicherung/%2F%2A%2FANd%2F%2A%2F4242%3D%28SElect%2F%2A%2FxMLTyPe',
  '/de/aziende/css-versicherung/%2F%2A%2Fxmltype%2F%2A%2Fextractvalue',
];

let rootDir: string | undefined;

afterEach(() => {
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = undefined;
  vi.restoreAllMocks();
});

describe('compatibility URL path safety', () => {
  it('rejects the production SQL probe and its URL-encoded variants', () => {
    for (const path of SQL_PROBE_VARIANTS) {
      expect(isSafeDistPath(path)).toBe(false);
    }
    expect(filterSafeCompatPaths(SQL_PROBE_VARIANTS).rejectedPaths).toEqual(SQL_PROBE_VARIANTS);
  });

  it('keeps ordinary words containing select safe while rejecting an SQL keyword segment', () => {
    expect(isSafeDistPath('/de/aziende/selecta/')).toBe(true);
    expect(isSafeDistPath('/de/aziende/selection/')).toBe(true);
    expect(isSafeDistPath('/de/aziende/select/')).toBe(false);
  });

  it('rejects XSS-like URL payloads and encoded structured-data fragments', () => {
    expect(isSafeDistPath('/en/find-jobs-zurich/javascript:alert(')).toBe(false);
    expect(isSafeDistPath('/en/cross-border-articles/doctors/%22]],null')).toBe(false);
  });

  it('rejects a URL segment above the filesystem-safe byte cap', () => {
    const oversized = `/de/schweiz-artikel/${'a'.repeat(MAX_SAFE_URL_SEGMENT_BYTES + 1)}`;
    expect(isSafeDistPath(oversized)).toBe(false);
    expect(isSafeDistPath('/de/aziende/%27%2F%2A%2F')).toBe(false);
    expect(isSafeDistPath('de/aziende/company/')).toBe(true);
    expect(isSafeDistPath(`/de/aziende/${'é'.repeat(101)}/`)).toBe(false);
  });

  it('keeps ordinary canonical paths and reports rejected writes without throwing', () => {
    expect(isSafeDistPath('/de/aziende/css-versicherung/')).toBe(true);
    expect(isSafeDistPath('de/aziende/css-versicherung/')).toBe(true);
    expect(isSafeDistPath('.env/relative/')).toBe(false);

    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-path-safety-'));
    const blockedParent = path.join(rootDir, 'blocked');
    fs.writeFileSync(blockedParent, 'not-a-directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(writeDistPageSafely({
      indexPath: path.join(blockedParent, 'index.html'),
      html: '<html></html>',
      urlPath: '/blocked/',
      logPrefix: 'test-emitter',
    })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unwritable path /blocked/'), expect.anything());
  });

  it('rejects an unsafe path before attempting a dist write', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-path-safety-unsafe-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const indexPath = path.join(rootDir, 'de', 'aziende', 'unsafe', 'index.html');

    expect(writeDistPageSafely({
      indexPath,
      html: '<html></html>',
      urlPath: SQL_PROBE,
      logPrefix: 'test-emitter',
    })).toBe(false);
    expect(fs.existsSync(indexPath)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe path'));
  });

  it('filters unsafe paths at the compat-store ingress and preserves safe ones', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-path-store-safety-'));
    const safe = '/de/aziende/css-versicherung/';
    const result = writeCompatPaths({ paths: [safe, SQL_PROBE] }, rootDir);

    expect(result.rejectedPaths).toBe(1);
    expect(readCompatPaths(rootDir).paths).toEqual([safe]);
  });
});
