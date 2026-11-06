import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  auditHtml,
  auditLive,
  checkSource,
  parseHtmlContract,
} from '../../scripts/seo/bing-seo-live-loop.mjs';
import {
  BING_INDEXNOW_REMEDIATION_URLS,
  BING_TITLE_AUDIT_URLS,
  BING_TITLE_MAX_CHARS,
} from '../../scripts/seo/bing-seo-policy.mjs';
import { submitIndexNowUrlsStreaming } from '../../scripts/lib/indexnow-submit.mjs';

const URL = 'https://frontaliereticino.ch/';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Bing SEO live contract', () => {
  it('accepts one visible homepage H1 and a matching canonical', () => {
    const html = [
      '<html><head>',
      '<title>Frontaliere Ticino | Frontaliere Ticino</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/">',
      '</head><body><main><h1 id="homepage-static-h1">Frontaliere Ticino 2026</h1></main></body></html>',
    ].join('');

    const result = auditHtml(URL, html, { homepage: true });
    expect(result.findings).toEqual([]);
    expect(result.h1s).toEqual([{ text: 'Frontaliere Ticino 2026', hidden: false }]);
  });

  it('flags an offscreen H1 even when the tag exists', () => {
    const html = [
      '<title>Frontaliere Ticino</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/">',
      '<h1 style="position:absolute;left:-9999px;width:1px;height:1px">Home</h1>',
    ].join('');

    expect(auditHtml(URL, html, { homepage: true }).findings.map((item) => item.code))
      .toContain('homepage-h1-hidden');
  });

  it('flags an empty homepage H1 as missing', () => {
    const html = [
      '<title>Frontaliere Ticino</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/">',
      '<h1>   </h1>',
    ].join('');

    expect(auditHtml(URL, html, { homepage: true }).findings.map((item) => item.code))
      .toContain('homepage-h1-missing');
  });

  it('flags title overflow and canonical drift', () => {
    const html = [
      '<title>',
      'Titolo volutamente molto lungo che supera il limite Bing per verificare il gate automatico',
      '</title>',
      '<link rel="canonical" href="https://frontaliereticino.ch/altra-pagina/">',
    ].join('');

    const findings = auditHtml(URL, html).findings.map((item) => item.code);
    expect(findings).toEqual(expect.arrayContaining(['title-too-long', 'canonical-drift']));
  });

  it('parses minified attributes without matching data attributes or values', () => {
    const canonical = `${URL}minified/`;
    expect(parseHtmlContract(`<link rel=canonical href=${canonical}>`).canonical).toBe(canonical);
    expect(parseHtmlContract('<link data-rel=canonical data-href=/fake>').canonical).toBe('');
    expect(parseHtmlContract('<link data="rel=canonical href=https://example.test/fake/">').canonical).toBe('');
  });

  it('keeps the observed policy sets unique and bounded', () => {
    expect(new Set(BING_TITLE_AUDIT_URLS).size).toBe(BING_TITLE_AUDIT_URLS.length);
    expect(new Set(BING_INDEXNOW_REMEDIATION_URLS).size).toBe(BING_INDEXNOW_REMEDIATION_URLS.length);
    expect(BING_TITLE_MAX_CHARS).toBe(66);
    expect(parseHtmlContract('<h1>ok</h1>').h1s).toHaveLength(1);
  });

  it('stops each streamed batch after the first accepted IndexNow endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitIndexNowUrlsStreaming(
      ['https://frontaliereticino.ch/first/', 'https://frontaliereticino.ch/second/'],
      { batchSize: 1, delayMs: 0 },
    );

    expect(fetchMock.mock.calls.map(([endpoint]) => String(endpoint))).toEqual([
      'https://api.indexnow.org/indexnow',
      'https://api.indexnow.org/indexnow',
    ]);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.ok)).toBe(true);
    expect(result.results.map((item) => item.attempts.map((attempt) => attempt.engine)))
      .toEqual([['api.indexnow.org'], ['api.indexnow.org']]);
  });

  it('uses the next endpoint after retries and keeps an unaccepted batch failed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);

    const acceptedPromise = submitIndexNowUrlsStreaming(
      ['https://frontaliereticino.ch/fallback/'],
      {
        endpoints: ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow'],
        batchSize: 1,
        delayMs: 0,
      },
    );
    await vi.runAllTimersAsync();
    const accepted = await acceptedPromise;

    expect(accepted.results[0]).toMatchObject({
      ok: true,
      engine: 'www.bing.com',
      attempts: [
        { ok: false, engine: 'api.indexnow.org', error: 'fetch failed' },
        { ok: true, engine: 'www.bing.com', status: 202 },
      ],
    });

    const rejected = await submitIndexNowUrlsStreaming(
      ['https://frontaliereticino.ch/rejected/'],
      {
        endpoints: ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow'],
        batchSize: 1,
        delayMs: 0,
      },
    );

    expect(rejected.results[0].ok).toBe(false);
    expect(rejected.results[0].attempts.map((attempt) => attempt.status)).toEqual([422, 422]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('keeps the automated workflow fail-closed for owner auth and manual submit false', () => {
    expect(checkSource()).toEqual({ ok: true, findings: [] });
  });

  it('skips only the optional ONNX CUDA payload during dependency install', () => {
    const workflow = YAML.parse(
      fs.readFileSync(path.resolve('.github/workflows/bing-seo-loop.yml'), 'utf8'),
    ) as {
      jobs?: {
        audit?: {
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }>;
        };
      };
    };
    const install = workflow.jobs?.audit?.steps?.find(
      (step) => step.name === 'Install dependencies',
    );

    expect(install?.run).toBe('npm ci');
    expect(install?.env?.ONNXRUNTIME_NODE_INSTALL).toBe('skip');
  });

  it('passes the full-tree issue report by file, not through process argv', () => {
    const workflow = fs.readFileSync(
      path.resolve('.github/workflows/bing-seo-loop.yml'),
      'utf8',
    );

    expect(workflow).toContain('--description-file "$RUNNER_TEMP/bing-site-tree-issue.md"');
    expect(workflow).not.toContain('--description "$(cat "$RUNNER_TEMP/bing-site-tree-issue.md")"');
  });

  it('checks out the crawler import closure for every tree job', () => {
    const workflow = YAML.parse(
      fs.readFileSync(path.resolve('.github/workflows/bing-seo-loop.yml'), 'utf8'),
    ) as {
      jobs?: Record<string, {
        steps?: Array<{
          uses?: string;
          with?: { 'sparse-checkout'?: string };
        }>;
      }>;
    };
    const requiredJobs = [
      'tree-inventory',
      'tree-crawl',
      'tree-discovered-inventory',
      'tree-discovered-crawl',
      'tree-report',
    ];
    const requiredPaths = [
      '/scripts/lib/professionLandingsSections.mjs',
      '/data/profession-landing-routes.json',
    ];

    for (const jobName of requiredJobs) {
      const checkout = workflow.jobs?.[jobName]?.steps?.find(
        (step) => step.uses?.startsWith('actions/checkout@'),
      );
      const sparsePaths = (checkout?.with?.['sparse-checkout'] || '')
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean);
      expect(sparsePaths, `${jobName}: crawler import closure`).toEqual(
        expect.arrayContaining(requiredPaths),
      );
    }
  });

  it('accepts a canonical after redirect and reports a stale IndexNow URL as warning', async () => {
    const titleUrl = BING_TITLE_AUDIT_URLS[0];
    const staleUrl = BING_INDEXNOW_REMEDIATION_URLS.at(-1);
    const redirectedUrl = titleUrl.replace(/\/$/, '-2026/');
    const html = (title, canonical, h1 = '') => [
      '<title>', title, '</title>',
      '<link rel="canonical" href="', canonical, '">',
      h1 ? '<h1>' + h1 + '</h1>' : '',
    ].join('');

    const result = await auditLive({
      homepageUrl: URL,
      titleUrls: [titleUrl],
      indexNowUrls: [staleUrl],
      routeContracts: [],
      fetchImpl: async (url) => {
        if (url === URL) {
          return {
            status: 200,
            url,
            text: async () => html('Frontaliere Ticino', url, 'Homepage'),
          };
        }
        if (url === titleUrl) {
          return {
            status: 200,
            url: redirectedUrl,
            text: async () => html('Titolo articolo entro il limite', redirectedUrl),
          };
        }
        return {
          status: 404,
          url,
          text: async () => '<title>Pagina non trovata</title>',
        };
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toEqual(['indexnow-stale-url']);
  });

  it('checks HTTP contracts for edge aliases, gone URLs and indexable landings', async () => {
    const result = await auditLive({
      homepageUrl: URL,
      titleUrls: [],
      indexNowUrls: [],
      routeContracts: [
        { url: URL + 'legacy/', path: '/legacy/', expectedStatus: 301, location: '/canonical/' },
        { url: URL + 'gone/', path: '/gone/', expectedStatus: 410 },
        { url: URL + 'landing/', path: '/landing/', expectedStatus: 200 },
      ],
      fetchImpl: async (url) => {
        if (url === URL) return {
          status: 200,
          url,
          headers: new Headers(),
          text: async () => '<title>Home</title><link rel="canonical" href="https://frontaliereticino.ch/"><h1>Home</h1>',
        };
        if (url.endsWith('/legacy/')) return { status: 301, url, headers: new Headers({ location: '/canonical/' }), text: async () => '' };
        if (url.endsWith('/gone/')) return { status: 410, url, headers: new Headers({ 'x-robots-tag': 'noindex' }), text: async () => '' };
        return {
          status: 200,
          url,
          headers: new Headers(),
          text: async () => '<title>Landing</title><link rel="canonical" href="https://frontaliereticino.ch/landing/">',
        };
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.routeContracts).toBe(3);
  });
});
