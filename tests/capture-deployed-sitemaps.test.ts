import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSitemapSnapshot } from '../scripts/lib/sitemap-snapshot.mjs';

const temporaryDirectories = new Set<string>();
const savedEnvironment = new Map<string, string | undefined>();
const environmentKeys = [
  'HOST',
  'SOURCE',
  'OUTPUT',
  'LOCAL_ROOT',
  'SITEMAP_BASE',
  'GITHUB_RUN_ID',
  'GITHUB_STEP_SUMMARY',
];

function makeTemporaryDirectory(prefix: string) {
  const root = process.env.CODEX_SNPTOL_TMP_DIR || tmpdir();
  const directory = mkdtempSync(join(root, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function setEnvironment(values: Record<string, string>) {
  for (const key of environmentKeys) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('pre-deploy sitemap capture', () => {
  it('writes the snapshot when only an expired-archive child remains unreachable', async () => {
    const baseUrl = 'https://frontaliereticino.ch';
    const outputDirectory = makeTemporaryDirectory('capture-snapshot-');
    const outputPath = join(outputDirectory, 'pre-deploy-snapshot.ndjson');
    const summaryPath = join(outputDirectory, 'step-summary.md');
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.pathname === '/robots.txt') {
        return Promise.resolve(new Response(`Sitemap: ${baseUrl}/sitemap.xml`, { status: 200 }));
      }
      if (url.pathname === '/sitemap.xml') {
        return Promise.resolve(new Response(
          `<sitemapindex><sitemap><loc>${baseUrl}/sitemap-jobs-expired-044.xml</loc></sitemap>` +
          `<sitemap><loc>${baseUrl}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
          { status: 200 },
        ));
      }
      if (url.pathname === '/sitemap-news.xml' || url.pathname === '/sitemap-cantons.xml') {
        return Promise.resolve(new Response('<urlset></urlset>', { status: 200 }));
      }
      if (url.pathname === '/sitemap-pages.xml') {
        return Promise.resolve(new Response(
          `<urlset><url><loc>${baseUrl}/pagina-corrente/</loc></url></urlset>`,
          { status: 200 },
        ));
      }
      if (url.pathname === '/sitemap-jobs-expired-044.xml') {
        return Promise.resolve(new Response('missing', {
          status: 404,
          headers: { 'cf-cache-status': 'MISS', age: '63' },
        }));
      }
      return Promise.resolve(new Response('missing', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    setEnvironment({
      HOST: 'frontaliereticino.ch',
      SOURCE: 'live',
      OUTPUT: outputPath,
      SITEMAP_BASE: baseUrl,
      GITHUB_RUN_ID: 'capture-test-run',
      GITHUB_STEP_SUMMARY: summaryPath,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const scriptUrl = new URL('../scripts/capture-deployed-sitemaps.mjs', import.meta.url);
    scriptUrl.searchParams.set('test', String(Date.now()));
    await import(scriptUrl.href);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Captured'));
    }, { timeout: 5_000, interval: 20 });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('Tolerated 1 unreachable expired-archive sitemap'));
    expect(calls.some((url) => {
      const parsed = new URL(url);
      return parsed.pathname === '/sitemap-jobs-expired-044.xml'
        && parsed.searchParams.get('cb') === 'capture-test-run';
    })).toBe(true);
    expect(existsSync(outputPath)).toBe(true);

    const snapshot = readSitemapSnapshot(outputPath);
    expect(snapshot.perSitemap['sitemap-pages.xml']).toEqual([`${baseUrl}/pagina-corrente/`]);
    expect(snapshot.perSitemap).not.toHaveProperty('sitemap-jobs-expired-044.xml');
    expect(snapshot.missingSitemaps).not.toContain('sitemap-jobs-expired-044.xml');
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('sitemap-jobs-expired-044.xml');
    expect(summary).toContain('parent=sitemap.xml');
    expect(summary).toContain('status=404');
    expect(summary).toContain('cf-cache-status=MISS');
    expect(summary).toContain('age=63');
  });
});
