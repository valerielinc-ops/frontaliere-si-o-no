import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyCompatPath,
  filterCompatPaths,
  hasCompatAttackPayload,
} from '../scripts/lib/compat-path-safety.mjs';
import { readCompatPaths, writeCompatPaths } from '../scripts/lib/compat-paths-store.mjs';

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

  it('keeps ordinary encoded URL paths', () => {
    const pathname = '/de/aziende/css-versicherung/versicherung-2026/';
    expect(hasCompatAttackPayload(pathname)).toBe(false);
    expect(filterCompatPaths([pathname])).toEqual({ paths: [pathname], dropped: [] });
  });

  it('filters unsafe paths before the sharded writer persists them', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-path-safety-'));
    const valid = '/de/aziende/css-versicherung/versicherung-2026/';
    const longSegment = `/${'x'.repeat(256)}/`;
    const attack = '/de/aziende/css-versicherung/%27%29%2F%2A%2A%2FSElect/';
    try {
      const result = writeCompatPaths({ paths: [valid, longSegment, attack] }, rootDir);
      expect(result.filteredPaths).toBe(2);
      expect(readCompatPaths(rootDir).paths).toEqual([valid]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
