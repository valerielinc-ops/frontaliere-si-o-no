import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyCompatPath,
  filterCompatPaths,
  filterSafeCompatPaths,
  hasCompatAttackPayload,
  isSafeCompatPath,
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

describe('404 compatibility path safety', () => {
  it('drops filesystem-overlong segments and total paths before persistence', () => {
    const longSegment = `/${'x'.repeat(256)}/`;
    const longTotal = `/${Array.from({ length: 20 }, () => 'x'.repeat(220)).join('/')}`;
    expect(classifyCompatPath(longSegment)).toBe('filesystem-limit');
    expect(classifyCompatPath(longTotal)).toBe('filesystem-limit');

    const result = filterCompatPaths(['/cerca-lavoro-ticino/valido/', longSegment, longTotal]);
    expect(result.paths).toEqual(['/cerca-lavoro-ticino/valido/']);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped.every(({ reason }) => reason === 'filesystem-limit')).toBe(true);
  });

  it.each([
    '/de/aziende/css-versicherung/%27%29%2F%2A%2A%2FANd%2F%2A%2A%2F4242%3D%28SElect/',
    '/de/aziende/css-versicherung/%2F%2A%2A%2FWAITFOR%2F%2A%2A%2FDELAY/',
    '/de/aziende/css-versicherung/%3Cscript%3Ealert(1)%3C%2Fscript%3E/',
    '/de/aziende/css-versicherung/UNION%20SELECT%20password%20FROM%20users/',
    '/de/aziende/css-versicherung//**//',
  ])('detects an attack payload in %s', (pathname) => {
    expect(hasCompatAttackPayload(pathname)).toBe(true);
    expect(classifyCompatPath(pathname)).toBe('attack-payload');
  });

  it.each([
    '/de/aziende/select-ag/',
    '/jobs-im-tessin/select-ag-lugano/',
    '/it/select-service-partner/',
  ])('keeps the legitimate SELECT slug %s', (pathname) => {
    expect(classifyCompatPath(pathname)).toBeNull();
    expect(hasCompatAttackPayload(pathname)).toBe(false);
  });

  it('detects SELECT when delimiters or SQL keywords make the context unambiguous', () => {
    const encodedSql = '/de/aziende/%28SElect%20FROM%20users/';
    const logPayload =
      "/de/aziende/css-versicherung/'))/**/ANd/**/4242=(SElect/**/uPPER(xMLTyPe(cHr(60)||.../";

    expect(classifyCompatPath(encodedSql)).toBe('attack-payload');
    expect(classifyCompatPath(logPayload)).toBe('attack-payload');
  });

  it('checks every SELECT occurrence and treats plus as a decoded space', () => {
    const laterSelect = '/de/aziende/select-ag/SELECT%2BFROM%2Busers/';
    expect(hasCompatAttackPayload(laterSelect)).toBe(true);
    expect(classifyCompatPath(laterSelect)).toBe('attack-payload');
  });

  it('keeps ordinary encoded URL paths', () => {
    const pathname = '/de/aziende/css-versicherung/versicherung-2026/';
    expect(hasCompatAttackPayload(pathname)).toBe(false);
    expect(filterCompatPaths([pathname])).toEqual({ paths: [pathname], dropped: [] });
  });

  it('filters unsafe paths before the sharded writer persists them', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-path-safety-'));
    const valid = '/de/aziende/css-versicherung/versicherung-2026/';
    const longSegment = `/${'x'.repeat(256)}/`;
    const attack = '/de/aziende/css-versicherung/%27%29%2F%2A%2A%2FSElect/';
    try {
      const result = writeCompatPaths({ paths: [valid, longSegment, attack] }, tempRoot);
      expect(result.filteredPaths).toBe(2);
      expect(result.rejectedPaths).toBe(2);
      expect(readCompatPaths(tempRoot).paths).toEqual([valid]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects the production SQL probe and its URL-encoded variants', () => {
    for (const pathname of SQL_PROBE_VARIANTS) {
      expect(isSafeDistPath(pathname)).toBe(false);
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
    expect(isSafeCompatPath(oversized)).toBe(false);
    expect(isSafeDistPath('/de/aziende/%27%2F%2A%2F')).toBe(false);
    expect(isSafeDistPath('de/aziende/company/')).toBe(true);
    expect(isSafeCompatPath(`/de/aziende/${'é'.repeat(101)}/`)).toBe(false);
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
