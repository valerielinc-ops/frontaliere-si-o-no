// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSitemapFamilyBridgeEvidence,
  createTarDistReader,
  hasNoindexFollow,
  urlLocale,
} from '../../scripts/ci/build-sitemap-family-bridge-evidence.mjs';

const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-family-bridge-evidence-'));
  temporaryRoots.push(root);
  return root;
}

function writeFile(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function makeTar(root: string, members: Array<{ name: string; contents: string }>): string {
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  for (const member of members) writeFile(source, member.name.replace(/^\.\//u, ''), member.contents);
  const tarFile = path.join(root, 'dist.tar');
  execFileSync('tar', ['-cf', tarFile, ...members.map(({ name }) => name)], { cwd: source });
  return tarFile;
}

function snapshot(urls: string[]) {
  return { version: 3, perSitemap: { 'sitemap-orphan-landings.xml': urls } };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sitemap family bridge evidence builder', () => {
  it.each([
    ['unquoted attributes', '<meta name=robots content=noindex,follow>', true],
    ['double-quoted attributes', '<meta name="robots" content="noindex,follow">', true],
    ['content before name with spaced directives', '<meta content="noindex, follow" name="robots">', true],
    ['single-quoted content', "<meta name='robots' content='noindex,follow'>", true],
    ['index directive', '<meta name=robots content=index,follow>', false],
    ['nofollow directive', '<meta name=robots content=noindex,nofollow>', false],
    ['missing robots tag', '<meta name=viewport content=width=device-width>', false],
    ['description tag', '<meta name=description content=noindex,follow>', false],
  ])('accepts only noindex,follow robots directives (%s)', (_label, html, expected) => {
    expect(hasNoindexFollow(html)).toBe(expected);
  });

  it.each([
    ['https://frontaliereticino.ch/', 'it'],
    ['https://frontaliereticino.ch/ricerca/x/', 'it'],
    ['https://frontaliereticino.ch/de/suche/x/', 'de'],
    ['https://frontaliereticino.ch/en/y/', 'en'],
    ['https://frontaliereticino.ch/fr/z/', 'fr'],
  ])('detects locale for %s', (url, locale) => {
    expect(urlLocale(url)).toBe(locale);
  });

  it('filters removed URLs to the requested locale without reporting other locales as missing', () => {
    const urls = [
      'https://frontaliereticino.ch/ricerca/x/',
      'https://frontaliereticino.ch/en/y/',
      'https://frontaliereticino.ch/de/suche/z/',
      'https://frontaliereticino.ch/fr/a/',
    ];
    const root = tempRoot();
    const distDir = path.join(root, 'dist');
    writeFile(distDir, 'de/suche/z/index.html', '<meta name="robots" content="noindex,follow">');

    const result = buildSitemapFamilyBridgeEvidence({
      previousSnapshot: snapshot(urls),
      currentSnapshot: snapshot([]),
      distDir,
      locale: 'de',
    });

    expect(result.locale).toBe('de');
    expect(result.entries.map(({ url }) => url)).toEqual([urls[2]]);
    expect(result.missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('keeps the unfiltered behavior when locale is omitted', () => {
    const urls = [
      'https://frontaliereticino.ch/ricerca/x/',
      'https://frontaliereticino.ch/en/y/',
      'https://frontaliereticino.ch/de/suche/z/',
      'https://frontaliereticino.ch/fr/a/',
    ];
    const root = tempRoot();
    const distDir = path.join(root, 'dist');
    writeFile(distDir, 'de/suche/z/index.html', '<meta name="robots" content="noindex,follow">');

    const result = buildSitemapFamilyBridgeEvidence({
      previousSnapshot: snapshot(urls),
      currentSnapshot: snapshot([]),
      distDir,
    });

    expect(result).not.toHaveProperty('locale');
    expect(result.entries.map(({ url }) => url)).toEqual([urls[2]]);
    const expectedMissing = [urls[0], urls[1], urls[3]]
      .sort((a, b) => `orphan-landings\0${a}`.localeCompare(`orphan-landings\0${b}`));
    expect(result.missing.map(({ url }) => url)).toEqual(expectedMissing);
    expect(result.complete).toBe(false);
  });

  it('reads tar members with and without a ./ prefix and reports tar stderr on failure', () => {
    const root = tempRoot();
    const itHtml = '<meta name=robots content=noindex,follow>';
    const deHtml = '<html>de bridge</html>';
    const tarFile = makeTar(root, [
      { name: './ricerca/x/index.html', contents: itHtml },
      { name: 'de/suche/y/index.html', contents: deHtml },
    ]);
    const reader = createTarDistReader(tarFile);

    expect(reader.exists('ricerca/x/index.html')).toBe(true);
    expect(reader.read('ricerca/x/index.html')).toBe(itHtml);
    expect(reader.exists('de/suche/y/index.html')).toBe(true);
    expect(reader.read('de/suche/y/index.html')).toBe(deHtml);
    expect(reader.exists('de/suche/missing/index.html')).toBe(false);

    const missingTar = path.join(root, 'missing.tar');
    const tarFailure = spawnSync('tar', ['-tf', missingTar], { encoding: 'utf8' });
    expect(tarFailure.status).not.toBe(0);
    expect(tarFailure.stderr.trim()).not.toBe('');
    expect(() => createTarDistReader(missingTar)).toThrow(tarFailure.stderr.trim());
  });

  it('builds sha256 evidence from tar bytes and marks files without noindex,follow missing', () => {
    const root = tempRoot();
    const itUrl = 'https://frontaliereticino.ch/ricerca/x/';
    const deUrl = 'https://frontaliereticino.ch/de/suche/y/';
    const itHtml = '<!doctype html><meta name="robots" content="noindex,follow"><body>IT</body>';
    const deHtml = '<!doctype html><meta name="robots" content="index,follow"><body>DE</body>';
    const distReader = createTarDistReader(makeTar(root, [
      { name: './ricerca/x/index.html', contents: itHtml },
      { name: 'de/suche/y/index.html', contents: deHtml },
    ]));

    const result = buildSitemapFamilyBridgeEvidence({
      previousSnapshot: snapshot([itUrl, deUrl]),
      currentSnapshot: snapshot([]),
      distReader,
    });

    expect(result.entries).toEqual([{
      family: 'orphan-landings',
      url: itUrl,
      path: 'ricerca/x/index.html',
      sha256: crypto.createHash('sha256').update(itHtml).digest('hex'),
      robots: 'noindex,follow',
    }]);
    expect(result.missing).toEqual([{
      family: 'orphan-landings',
      url: deUrl,
      reason: 'bridge file is not noindex,follow',
    }]);
    expect(result.complete).toBe(false);
  });
});
