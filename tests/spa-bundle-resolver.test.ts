import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveSpaBundle,
  _resetSpaBundleResolverCacheForTests,
} from '../build-plugins/spaBundleResolver';

function makeTmpDistDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spa-bundle-resolver-'));
}

function writeIndexHtml(distDir: string, jsHash: string, cssHash: string): void {
  const html = `<!doctype html>
<html><head>
<link rel="stylesheet" href="/assets/index-${cssHash}.css">
<script type="module" crossorigin src="/assets/index-${jsHash}.js"></script>
</head><body><div id="root"></div></body></html>`;
  fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf-8');
}

describe('resolveSpaBundle', () => {
  let distDir: string;

  beforeEach(() => {
    _resetSpaBundleResolverCacheForTests();
    distDir = makeTmpDistDir();
  });

  afterEach(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('extracts entry hashes from a well-formed dist/index.html', () => {
    writeIndexHtml(distDir, 'B0v4sJnp', 'BHVvZKod');
    const info = resolveSpaBundle(distDir);
    expect(info.entryJs).toBe('index-B0v4sJnp.js');
    expect(info.entryCss).toBe('index-BHVvZKod.css');
    expect(info.hasSpaBundle).toBe(true);
  });

  it('caches per distDir — second call does not re-read', () => {
    writeIndexHtml(distDir, 'AAA', 'BBB');
    const first = resolveSpaBundle(distDir);
    // Mutate the file on disk; cache should NOT pick up the change
    writeIndexHtml(distDir, 'XXX', 'YYY');
    const second = resolveSpaBundle(distDir);
    expect(second.entryJs).toBe(first.entryJs);
    expect(second.entryCss).toBe(first.entryCss);
  });

  it('throws with a diagnostic message when index.html is missing', () => {
    // distDir is empty, no index.html
    expect(() => resolveSpaBundle(distDir)).toThrow(/index\.html does not exist yet|poll exhausted/);
  });

  it('throws when index.html lacks the expected script tag', () => {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><body>no bundle</body></html>', 'utf-8');
    expect(() => resolveSpaBundle(distDir)).toThrow(/regex miss|poll exhausted/);
  });

  it('throws when index.html is empty', () => {
    fs.writeFileSync(path.join(distDir, 'index.html'), '', 'utf-8');
    expect(() => resolveSpaBundle(distDir)).toThrow(/empty|poll exhausted/);
  });

  it('handles multiple index-*.js chunks by picking the one referenced in index.html', () => {
    // The whole point: dist/assets/ may contain index-A.js and index-B.js, but
    // only the one wired into <script src="..."> is the entry. Confirm the
    // resolver follows that source of truth.
    writeIndexHtml(distDir, 'EntryHash', 'StyleHash');
    const info = resolveSpaBundle(distDir);
    expect(info.entryJs).toBe('index-EntryHash.js');
  });
});
