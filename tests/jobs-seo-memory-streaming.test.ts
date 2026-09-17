// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBridgeThinHtml } from '../build-plugins/shared/bridgeThinShell';
import { WriteCollector } from '../build-plugins/batchWrite';
import { minifyHtml } from '../build-plugins/shared/htmlMinify';
import {
  hasCollectorWrittenHtml,
  readCachedOrEmittedHtml,
  releaseDiskBackedHtmlCache,
} from '../build-plugins/shared/jobsSeoHtmlCache';
import {
  buildSoftLandingThinHtml,
} from '../build-plugins/shared/softLandingThinShell';

const ACTIVE_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
 <meta charset="utf-8">
 <link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/canonical-job/">
 <script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"name":"EOC"},"jobLocation":{"address":{"addressLocality":"Bellinzona"}}}</script>
</head>
<body>
 <main class="seo-static-content static-job-page">
  <article class="ft-static-article"><h1>Infermiere — EOC</h1><p>Contenuto attivo della fixture.</p></article>
 </main>
</body>
</html>`;

const STALE_ACTIVE_PAGE = ACTIVE_PAGE.replace('Contenuto attivo della fixture.', 'Contenuto stale della build precedente.');

const SOFT_LANDING_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
 <meta charset="utf-8">
 <link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/expired-job/">
 <script type="application/ld+json">{"@type":"JobPosting","title":"Infermiere","hiringOrganization":{"name":"EOC"},"jobLocation":{"address":{"addressLocality":"Bellinzona"}}}</script>
</head>
<body>
 <main class="seo-static-content static-job-page">
  <article class="ft-static-article"><h1>Offerta non più disponibile</h1><p>Dettagli dell'annuncio archiviato.</p><section><h2>Posizioni simili</h2></section></article>
 </main>
</body>
</html>`;

const bridgeScript = (targetSlug: string) =>
  `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(targetSlug)};</script>`;

function fullBridgeHtml(source: string, targetSlug: string): string {
  return source.replace('</head>', ` ${bridgeScript(targetSlug)}\n </head>`);
}

function writeCanonicalPage(source: string): { distDir: string; relativePath: string } {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-memory-streaming-'));
  const relativePath = 'it/cerca-lavoro-ticino/canonical-job';
  const filePath = path.join(distDir, relativePath, 'index.html');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, minifyHtml(source), 'utf8');
  return { distDir, relativePath };
}

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('jobsSeoPages disk-backed HTML retention', () => {
  it('preserves active full and thin bridge bytes after rereading the canonical page', () => {
    const fixture = writeCanonicalPage(ACTIVE_PAGE);
    tempDirs.push(fixture.distDir);
    const loaded = readCachedOrEmittedHtml(
      new Map(),
      'it:canonical-job',
      fixture.distDir,
      fixture.relativePath,
    );
    expect(loaded).toBeDefined();

    const beforeFull = minifyHtml(fullBridgeHtml(ACTIVE_PAGE, 'canonical-job'));
    const afterFull = minifyHtml(fullBridgeHtml(loaded!, 'canonical-job'));
    expect(afterFull).toBe(beforeFull);

    const beforeThin = minifyHtml(buildBridgeThinHtml(ACTIVE_PAGE, 'canonical-job', 'it'));
    const afterThin = minifyHtml(buildBridgeThinHtml(loaded!, 'canonical-job', 'it'));
    expect(afterThin).toBe(beforeThin);
  });

  it('preserves expired soft-landing bridge bytes after chunk release', () => {
    const softLanding = buildSoftLandingThinHtml(SOFT_LANDING_PAGE, 'it');
    const fixture = writeCanonicalPage(softLanding);
    tempDirs.push(fixture.distDir);
    const loaded = readCachedOrEmittedHtml(
      new Map(),
      'it:expired-job',
      fixture.distDir,
      fixture.relativePath,
    );
    expect(loaded).toBeDefined();

    const before = minifyHtml(fullBridgeHtml(softLanding, 'expired-job'));
    const after = minifyHtml(fullBridgeHtml(loaded!, 'expired-job'));
    expect(after).toBe(before);
  });

  it('releases only disk-backed cache entries and keeps fallback cardinality observable', () => {
    const cache = new Map([
      ['it:disk-a', '<html>a</html>'],
      ['it:disk-b', '<html>b</html>'],
      ['it:fallback', '<html>fallback</html>'],
    ]);
    const diskBacked = new Set(['it:disk-a', 'it:disk-b']);

    expect(releaseDiskBackedHtmlCache(cache, diskBacked)).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.has('it:fallback')).toBe(true);
    expect(diskBacked.size).toBe(0);
    expect(releaseDiskBackedHtmlCache(cache, diskBacked)).toBe(0);
  });

  it('keeps a stale dist file as a fallback until this collector writes the path', async () => {
    const fixture = writeCanonicalPage(STALE_ACTIVE_PAGE);
    tempDirs.push(fixture.distDir);
    const indexFile = path.join(fixture.distDir, fixture.relativePath, 'index.html');
    const cacheKey = 'it:canonical-job';
    const cacheHtml = ACTIVE_PAGE;
    const cache = new Map([[cacheKey, cacheHtml]]);
    const collector = new WriteCollector({ pluginName: 'jobsSeoPagesPlugin' });
    const collectorWrittenKeys = () => hasCollectorWrittenHtml(
      fixture.distDir,
      fixture.relativePath,
      (filePath) => collector.hasWritten(filePath),
    ) ? new Set([cacheKey]) : new Set<string>();

    expect(hasCollectorWrittenHtml(
      fixture.distDir,
      fixture.relativePath,
      (filePath) => collector.hasWritten(filePath),
    )).toBe(false);
    expect(releaseDiskBackedHtmlCache(cache, collectorWrittenKeys())).toBe(0);
    const fallbackHtml = readCachedOrEmittedHtml(
      cache,
      cacheKey,
      fixture.distDir,
      fixture.relativePath,
    );
    expect(fallbackHtml).toBe(cacheHtml);
    expect(fallbackHtml).not.toContain('Contenuto stale');

    collector.add(indexFile, minifyHtml(cacheHtml));
    await collector.flush();

    expect(hasCollectorWrittenHtml(
      fixture.distDir,
      fixture.relativePath,
      (filePath) => collector.hasWritten(filePath),
    )).toBe(true);
    expect(releaseDiskBackedHtmlCache(cache, collectorWrittenKeys())).toBe(1);
    const diskHtml = readCachedOrEmittedHtml(
      cache,
      cacheKey,
      fixture.distDir,
      fixture.relativePath,
    );
    expect(diskHtml).toBe(minifyHtml(cacheHtml));
    expect(
      minifyHtml(fullBridgeHtml(diskHtml!, 'canonical-job')),
    ).toBe(minifyHtml(fullBridgeHtml(cacheHtml, 'canonical-job')));
  });

  it('pins the retained-set markers and bounded expired cache cardinalities', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    expect(source).toContain("logJobsSeoMem('after-active-pages'");
    expect(source).toContain('activeHtmlSource: \'disk\'');
    expect(source).toContain('const EXPIRED_HTML_CACHE_CHUNK_SIZE = 512');
    expect(source).toContain('expiredCacheEntries: expiredSoftLandingCache.size');
    expect(source).toContain('expiredHtmlCachePeakEntries');
  });
});
