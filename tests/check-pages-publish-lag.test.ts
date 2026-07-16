/**
 * Unit tests for the pure decision logic in
 * scripts/check-pages-publish-lag.mjs (the Pages publish-lag watchdog).
 *
 * No network and no IO for parsePathsIgnore/globToRegExp/isIgnoredPath/
 * filterUnignored: exercised through injected fixtures. The parsePathsIgnore
 * test also reads the REAL deploy.yml so the two never drift apart silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parsePathsIgnore,
  globToRegExp,
  isIgnoredPath,
  filterUnignored,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/check-pages-publish-lag.mjs';

describe('parsePathsIgnore', () => {
  it('extracts a flat glob list under paths-ignore:', () => {
    const yaml = [
      'on:',
      '  push:',
      '    branches:',
      '      - main',
      '    paths-ignore:',
      "      - 'data/border-wait-current.json'",
      "      - 'docs/**'",
      '    workflow_dispatch:',
    ].join('\n');
    expect(parsePathsIgnore(yaml)).toEqual(['data/border-wait-current.json', 'docs/**']);
  });

  it('returns an empty array when the key is absent', () => {
    expect(parsePathsIgnore('on:\n  push:\n    branches:\n      - main\n')).toEqual([]);
  });

  it('reads the real deploy.yml and includes the known-ignored paths', () => {
    const deployYmlPath = path.resolve(__dirname, '../.github/workflows/deploy.yml');
    const globs = parsePathsIgnore(fs.readFileSync(deployYmlPath, 'utf8'));
    expect(globs).toEqual(
      expect.arrayContaining(['data/weather-snapshot.json', 'docs/**', '.github/**', 'tests/**', '.claude/**']),
    );
  });
});

describe('globToRegExp / isIgnoredPath', () => {
  it('matches a literal path exactly', () => {
    expect(globToRegExp('data/weather-snapshot.json').test('data/weather-snapshot.json')).toBe(true);
    expect(globToRegExp('data/weather-snapshot.json').test('data/weather-snapshot2.json')).toBe(false);
  });

  it('`**` crosses directory boundaries', () => {
    const re = globToRegExp('docs/**');
    expect(re.test('docs/a.md')).toBe(true);
    expect(re.test('docs/nested/b.md')).toBe(true);
    expect(re.test('other/docs/a.md')).toBe(false);
  });

  it('a bare `*.md` matches only at the root, not nested paths', () => {
    const re = globToRegExp('*.md');
    expect(re.test('README.md')).toBe(true);
    expect(re.test('public/press-kit/README.md')).toBe(false);
  });

  it('isIgnoredPath is true if any glob in the list matches', () => {
    const globs = ['data/weather-snapshot.json', 'docs/**'];
    expect(isIgnoredPath('docs/CI-CD-PIPELINE.md', globs)).toBe(true);
    expect(isIgnoredPath('data/jobs.json', globs)).toBe(false);
  });
});

describe('filterUnignored', () => {
  it('keeps only dist-affecting files', () => {
    const globs = ['data/weather-snapshot.json', 'docs/**', '*.md'];
    const changed = ['data/weather-snapshot.json', 'docs/GITNEXUS.md', 'README.md', 'data/blog-articles/foo.json'];
    expect(filterUnignored(changed, globs)).toEqual(['data/blog-articles/foo.json']);
  });

  it('returns an empty array when every changed file is ignored', () => {
    const globs = ['data/weather-snapshot.json'];
    expect(filterUnignored(['data/weather-snapshot.json'], globs)).toEqual([]);
  });

  it('returns everything unfiltered when there are no globs', () => {
    expect(filterUnignored(['a.ts', 'b.ts'], [])).toEqual(['a.ts', 'b.ts']);
  });
});
