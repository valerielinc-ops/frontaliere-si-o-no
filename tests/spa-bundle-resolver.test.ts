import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveSpaBundle,
  _resetSpaBundleResolverCacheForTests,
} from '../build-plugins/spaBundleResolver';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';

function makeTmpDistDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spa-bundle-resolver-'));
}

function writeEntryAssets(distDir: string): void {
  const assetsDir = path.join(distDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf-8');
  fs.writeFileSync(path.join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf-8');
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

  it('resolves the stable entry filenames when both assets exist', () => {
    writeEntryAssets(distDir);
    const info = resolveSpaBundle(distDir);
    expect(info.entryJs).toBe(SPA_ENTRY_JS_FILENAME);
    expect(info.entryCss).toBe(SPA_ENTRY_CSS_FILENAME);
    expect(info.hasSpaBundle).toBe(true);
  });

  it('caches per distDir — second call does not re-check disk', () => {
    writeEntryAssets(distDir);
    const first = resolveSpaBundle(distDir);
    fs.rmSync(path.join(distDir, 'assets'), { recursive: true, force: true });
    const second = resolveSpaBundle(distDir);
    expect(second.entryJs).toBe(first.entryJs);
    expect(second.entryCss).toBe(first.entryCss);
  });

  it('throws with a diagnostic message when the entry JS is missing', () => {
    const assetsDir = path.join(distDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf-8');
    expect(() => resolveSpaBundle(distDir)).toThrow(new RegExp(SPA_ENTRY_JS_FILENAME.replace('.', '\\.')));
  });

  it('throws with a diagnostic message when the entry CSS is missing', () => {
    const assetsDir = path.join(distDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf-8');
    expect(() => resolveSpaBundle(distDir)).toThrow(new RegExp(SPA_ENTRY_CSS_FILENAME.replace('.', '\\.')));
  });

  it('throws when dist/assets does not exist at all', () => {
    expect(() => resolveSpaBundle(distDir)).toThrow(/expected stable SPA entry file\(s\) missing/);
  });
});
