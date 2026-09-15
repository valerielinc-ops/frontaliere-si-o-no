import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  absoluteHttpUrl,
  advanceFindingStreaks,
  actionableStreaks,
  comparableUrl,
  deterministicSample,
  findingsForProbe,
  isAssetUrl,
  isJobDetailPath,
  isSameUrl,
  parseSitemapIndex,
  parseSitemapUrlSet,
  sourceResult,
} from '../../scripts/lib/seo-health-contract.mjs';
import {
  buildCycleIdentity,
  createCycleBudget,
  fetchWithRetry,
  loadSitemapGraph,
  runSeoHealthLoop,
  summarizeCloudflareProbeCoverage,
} from '../../scripts/seo/seo-health-loop.mjs';

const ORIGIN = 'https://fixture.test';
const NOSLASH_SOURCE = readFileSync(new URL('../../scripts/refresh-noslash-keep.mjs', import.meta.url), 'utf8');
const WORKFLOW_SOURCE = readFileSync(new URL('../../.github/workflows/seo-health-loop.yml', import.meta.url), 'utf8');

function response(url: string, status: number, body = '') {
  return {
    status,
    url,
    headers: { get: () => null },
    text: async () => body,
  };
}

describe('SEO health contract', () => {
  it('preserves slash shape while ignoring only URL noise', () => {
    expect(absoluteHttpUrl('')).toBeNull();
    expect(absoluteHttpUrl('   ')).toBeNull();
    expect(comparableUrl('https://fixture.test/jobs/?utm_source=test#top')).toBe('https://fixture.test/jobs/?utm_source=test');
    expect(isSameUrl('https://fixture.test/jobs/', 'https://fixture.test/jobs')).toBe(false);
    expect(isAssetUrl('https://fixture.test/assets/app.js')).toBe(true);
    expect(isAssetUrl('https://fixture.test/legacy.html')).toBe(false);
  });

  it('parses sitemap index, URL sets and job-detail eligibility', () => {
    expect(parseSitemapIndex('<sitemapindex><sitemap><loc>/sitemap-jobs.xml</loc></sitemap></sitemapindex>')).toEqual([
      'https://frontaliereticino.ch/sitemap-jobs.xml',
    ]);
    expect(parseSitemapUrlSet('<urlset><url><loc>/jobs/example/</loc><lastmod>2026-09-13</lastmod></url></urlset>')).toEqual([
      { url: 'https://frontaliereticino.ch/jobs/example/', lastmod: '2026-09-13' },
    ]);
    expect(isJobDetailPath('/cerca-lavoro-ticino/software-engineer-acme/')).toBe(true);
    expect(isJobDetailPath('/en/find-jobs-zurich/software-engineer-acme/')).toBe(true);
    expect(isJobDetailPath('/cerca-lavoro-ticino/')).toBe(false);
    expect(isJobDetailPath('/cerca-lavoro-ticino/azienda-acme/')).toBe(false);
    expect(isJobDetailPath('/cerca-lavoro-ticino/infermieri-in-ticino/')).toBe(false);
  });

  it('keeps deterministic samples stable regardless of input order', () => {
    const values = ['/a/', '/b/', '/c/', '/d/', '/e/'];
    expect(deterministicSample(values, 3, 'test')).toEqual(deterministicSample([...values].reverse(), 3, 'test'));
  });

  it('espone un lease serializzato e un budget bounded per ogni ciclo', async () => {
    expect(buildCycleIdentity({
      now: new Date('2026-09-13T00:00:00Z'),
      workflow: 'SEO closed-loop health and recovery',
      runId: '123',
    })).toMatchObject({
      idempotencyKey: 'run:123',
      lease: {
        cancelInProgress: false,
        group: 'seo-health-loop',
        mechanism: 'github-actions-concurrency',
        state: 'serialised',
      },
    });
    let calls = 0;
    const budget = createCycleBudget(async () => {
      calls += 1;
      return response('https://fixture.test/', 200);
    }, { maxFetches: 2, maxDurationMs: 60_000 });
    await budget.fetch('https://fixture.test/one');
    await budget.fetch('https://fixture.test/two');
    await expect(budget.fetch('https://fixture.test/three')).rejects.toThrow('seo_cycle_budget_exhausted');
    expect(calls).toBe(2);
    expect(budget.snapshot()).toMatchObject({ maxFetches: 2, usedFetches: 2, exhausted: true });
  });

  it('emits distinct findings for status, canonical, noindex and JobPosting defects', () => {
    const good = '<title>Job</title><link rel="canonical" href="https://fixture.test/cerca-lavoro-ticino/job/"><script type="application/ld+json">{"@type":"JobPosting"}</script>';
    expect(findingsForProbe({ url: 'https://fixture.test/cerca-lavoro-ticino/job/', status: 200, finalUrl: 'https://fixture.test/cerca-lavoro-ticino/job/', body: good })).toEqual([]);

    expect(findingsForProbe({ url: 'https://fixture.test/cerca-lavoro-ticino/job/', status: 503 })).toMatchObject([
      { code: 'http-server-error', status: 503 },
    ]);

    const bad = '<meta name="robots" content="noindex"><link rel="canonical" href="https://fixture.test/other/">';
    expect(findingsForProbe({ url: 'https://fixture.test/cerca-lavoro-ticino/job/', status: 200, body: bad }).map((finding) => finding.code)).toEqual([
      'canonical-mismatch',
      'sitemap-noindex',
      'jobposting-missing',
    ]);
  });

  it('does not turn an unavailable source into a healthy empty source', () => {
    expect(sourceResult({ name: 'ga4', rows: 0 })).toMatchObject({ available: false, error: 'empty result' });
    expect(sourceResult({ name: 'ga4', rows: 10, skipped: true })).toMatchObject({ available: false, error: 'skipped' });
    expect(sourceResult({ name: 'ga4', rows: 10 })).toMatchObject({ available: true, rows: 10, error: null });
  });

  it('requires consecutive observations before action and records recovery', () => {
    const finding = { code: 'canonical-mismatch', url: 'https://fixture.test/job/' };
    const first = advanceFindingStreaks({}, [finding], new Date('2026-09-13T00:00:00Z'));
    expect(actionableStreaks(first, 2)).toHaveLength(0);
    const second = advanceFindingStreaks(first, [finding], new Date('2026-09-14T00:00:00Z'));
    expect(actionableStreaks(second, 2)).toMatchObject([{ consecutiveRuns: 2, code: finding.code, url: finding.url }]);
    const recovered = advanceFindingStreaks(second, [], new Date('2026-09-15T00:00:00Z'));
    expect(recovered.findings).toEqual({});
    const afterGap = advanceFindingStreaks(second, [finding], new Date('2026-09-20T00:00:00Z'));
    expect(afterGap.findings[`${finding.code}|${finding.url}`].consecutiveRuns).toBe(1);
  });

  it('keeps the PostHog no-slash query time-bounded and locale-complete', () => {
    expect(NOSLASH_SOURCE).toMatch(/AND \(\s*properties\.\$pathname LIKE '\/cerca-lavoro-%'[\s\S]*OR properties\.\$pathname LIKE '\/de\/jobs-in-%'[\s\S]*\)\s*AND timestamp/s);
  });

  it('keeps the autonomous workflow conservative and resolver-gated', () => {
    expect(WORKFLOW_SOURCE).toContain("cron: '20 4 * * *'");
    expect(WORKFLOW_SOURCE).toContain('--strict-sources');
    expect(WORKFLOW_SOURCE).toContain('PRUNE_404_STRICT=1');
    expect(WORKFLOW_SOURCE).toContain('tests/search-console-compat.test.ts');
    expect(WORKFLOW_SOURCE).toContain('--in-place-resolver-cmd');
    expect(WORKFLOW_SOURCE).not.toContain("--in-place-resolver-cmd 'node scripts/lib/resolve-404-compat-conflict.mjs && git add -A'");
    expect(WORKFLOW_SOURCE).toContain('actions/upload-artifact@v6');
    expect(WORKFLOW_SOURCE).toContain('if-no-files-found: error');
    expect(WORKFLOW_SOURCE).toContain('always() && inputs.dry_run != true && (steps.health.outcome');
    expect(WORKFLOW_SOURCE).toContain('EXPECTED_SHA=');
    expect(WORKFLOW_SOURCE).toContain('No deploy token available');
    expect(WORKFLOW_SOURCE).toContain("dispatch_sent=true");
    expect(WORKFLOW_SOURCE).not.toMatch(/purge/i);
  });

  it('only permits issue auto-resolution after a clean recovery', () => {
    expect(readFileSync(new URL('../../scripts/seo/seo-health-loop.mjs', import.meta.url), 'utf8'))
      .toContain("report.findings.observed.length === 0");
    expect(readFileSync(new URL('../../scripts/seo/seo-health-loop.mjs', import.meta.url), 'utf8'))
      .toContain('resolveGithubIssue');
  });

  it('keeps Cloudflare paths outside the live sample unresolved', () => {
    const coverage = summarizeCloudflareProbeCoverage({
      total5xx: 10,
      paths: [
        { status: 502, host: 'fixture.test', path: '/hot/', count: 7 },
        { status: 503, host: 'fixture.test', path: '/long-tail/', count: 1 },
      ],
      probes: [
        { status: 502, host: 'fixture.test', path: '/hot/', count: 7, probeStatus: 200 },
      ],
    });
    expect(coverage).toMatchObject({
      sampledPath5xx: 7,
      transient5xx: 7,
      unverified5xx: 1,
      unprobed5xx: 2,
      unresolved5xx: 3,
    });
  });
});

describe('SEO health live runner', () => {
  it('follows the sitemap graph and samples the same URLs with a fixture fetcher', async () => {
    const sitemap = `${ORIGIN}/sitemap.xml`;
    const child = `${ORIGIN}/sitemap-pages.xml`;
    const bodies = new Map<string, string>([
      [`${ORIGIN}/robots.txt`, `User-agent: *\nSitemap: ${sitemap}\n`],
      [sitemap, `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`],
      [child, '<urlset><url><loc>https://fixture.test/</loc></url><url><loc>https://fixture.test/cerca-lavoro-ticino/example-job/</loc></url><url><loc>https://fixture.test/bad-page</loc></url></urlset>'],
      [`${ORIGIN}/`, '<title>Home</title><link rel="canonical" href="https://fixture.test/">'],
      [`${ORIGIN}/cerca-lavoro-ticino/example-job/`, '<title>Job</title><link rel="canonical" href="https://fixture.test/cerca-lavoro-ticino/example-job/"><script type="application/ld+json">{"@type":"JobPosting"}</script>'],
      [`${ORIGIN}/bad-page`, '<title>Bad</title><link rel="canonical" href="https://fixture.test/other/"><meta name="robots" content="noindex">'],
    ]);
    const fetchImpl = async (url: string) => {
      const body = bodies.get(url);
      return body == null ? response(url, 404) : response(url, 200, body);
    };

    const graph = await loadSitemapGraph({ origin: ORIGIN, sitemap, fetchImpl, timeoutMs: 1000 });
    expect(graph.source).toMatchObject({ name: 'live-sitemap', available: true, rows: 3 });
    expect(graph.files).toHaveLength(2);
    expect(graph.entries.map((entry) => entry.url)).toEqual([
      'https://fixture.test/',
      'https://fixture.test/bad-page',
      'https://fixture.test/cerca-lavoro-ticino/example-job/',
    ]);
    expect(graph.findings.map((finding) => finding.code)).toContain('sitemap-no-trailing-slash');

    const root = mkdtempSync(join(tmpdir(), 'seo-health-dry-run-'));
    const previousRunId = process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ID;
    try {
      const report = await runSeoHealthLoop({
        options: {
          origin: ORIGIN,
          sitemap,
          sample: 10,
          jobSample: 10,
          strictSources: true,
          dryRun: true,
          reportDir: join(root, 'reports'),
          statePath: join(root, 'state.json'),
          historyPath: join(root, 'history.jsonl'),
        },
        fetchImpl,
        collectAnalytics: false,
        root,
        now: new Date('2026-09-13T00:00:00Z'),
      });
      expect(report.pageAudit.sampledCount).toBe(3);
      expect(report.findings.observed.map((finding) => finding.code)).toEqual(expect.arrayContaining([
        'sitemap-no-trailing-slash',
        'canonical-mismatch',
        'sitemap-noindex',
        'source-unavailable',
      ]));
      expect(report.findings.actionable).toHaveLength(0);
      expect(report.issue).toMatchObject({ skipped: 'dry-run' });
      expect(report.cycle).toMatchObject({
        idempotencyKey: expect.stringMatching(/^generated:/),
        lease: { group: 'seo-health-loop', state: 'serialised' },
        budget: { maxFetches: 640 },
      });
      expect(readFileSync(join(root, 'reports', 'latest.json'), 'utf8')).toContain('"dryRun": true');
      expect(existsSync(join(root, 'state.json'))).toBe(false);
      expect(existsSync(join(root, 'history.jsonl'))).toBe(false);
    } finally {
      if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = previousRunId;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces a sitemap graph truncated exactly at the configured cap', async () => {
    const sitemap = `${ORIGIN}/sitemap.xml`;
    const children = ['one', 'two', 'three'].map((name) => `${ORIGIN}/sitemap-${name}.xml`);
    const bodies = new Map<string, string>([
      [`${ORIGIN}/robots.txt`, `Sitemap: ${sitemap}`],
      [sitemap, `<sitemapindex>${children.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`],
      [children[0], '<urlset><url><loc>https://fixture.test/one/</loc></url></urlset>'],
    ]);
    const fetchImpl = async (url: string) => response(url, bodies.has(url) ? 200 : 404, bodies.get(url) || '');
    const graph = await loadSitemapGraph({ origin: ORIGIN, sitemap, fetchImpl, maxSitemaps: 2, timeoutMs: 1000 });
    expect(graph.files).toHaveLength(2);
    expect(graph.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sitemap-graph-truncated' }),
    ]));
  });

  it('bounds a response body that never resolves', async () => {
    const result = await fetchWithRetry('https://fixture.test/slow', {
      timeoutMs: 10,
      attempts: 1,
      fetchImpl: async (url: string) => ({
        status: 200,
        url,
        headers: { get: () => null },
        text: () => new Promise<string>(() => {}),
      }),
    });
    expect(result.status).toBe(0);
    expect(result.error).toContain('response body timeout');
  });

  it('persists the observation streak and makes a repeated defect actionable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seo-health-loop-'));
    const previousRunId = process.env.GITHUB_RUN_ID;
    const sitemap = `${ORIGIN}/sitemap.xml`;
    const bodies = new Map<string, string>([
      [`${ORIGIN}/robots.txt`, `Sitemap: ${sitemap}`],
      [sitemap, '<urlset><url><loc>https://fixture.test/bad-page</loc></url></urlset>'],
      [`${ORIGIN}/bad-page`, '<title>Bad</title><link rel="canonical" href="https://fixture.test/other/">'],
    ]);
    const fetchImpl = async (url: string) => response(url, bodies.has(url) ? 200 : 404, bodies.get(url) || '');
    const options = {
      origin: ORIGIN,
      sitemap,
      sample: 5,
      jobSample: 5,
      strictSources: false,
      reportDir: join(root, 'reports'),
      statePath: join(root, 'state.json'),
      historyPath: join(root, 'history.jsonl'),
    };
    delete process.env.GITHUB_RUN_ID;
    try {
      const first = await runSeoHealthLoop({ options, fetchImpl, collectAnalytics: false, root, now: new Date('2026-09-13T00:00:00Z') });
      expect(first.findings.actionable).toHaveLength(0);
      const second = await runSeoHealthLoop({ options, fetchImpl, collectAnalytics: false, root, now: new Date('2026-09-14T00:00:00Z') });
      expect(second.findings.actionable).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'canonical-mismatch', consecutiveRuns: 2 }),
      ]));
      expect(readFileSync(join(root, 'history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = previousRunId;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not duplicate history when a GitHub run is retried', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seo-health-history-'));
    const previousRunId = process.env.GITHUB_RUN_ID;
    const sitemap = `${ORIGIN}/sitemap.xml`;
    const bodies = new Map<string, string>([
      [`${ORIGIN}/robots.txt`, `Sitemap: ${sitemap}`],
      [sitemap, '<urlset><url><loc>https://fixture.test/</loc></url></urlset>'],
      [`${ORIGIN}/`, '<title>Home</title><link rel="canonical" href="https://fixture.test/">'],
    ]);
    const fetchImpl = async (url: string) => response(url, bodies.has(url) ? 200 : 404, bodies.get(url) || '');
    const options = {
      origin: ORIGIN,
      sitemap,
      sample: 2,
      jobSample: 1,
      reportDir: join(root, 'reports'),
      statePath: join(root, 'state.json'),
      historyPath: join(root, 'history.jsonl'),
    };
    process.env.GITHUB_RUN_ID = 'retryable-run-8539';
    try {
      await runSeoHealthLoop({ options, fetchImpl, collectAnalytics: false, root, now: new Date('2026-09-13T00:00:00Z') });
      await runSeoHealthLoop({ options, fetchImpl, collectAnalytics: false, root, now: new Date('2026-09-13T00:05:00Z') });
      expect(readFileSync(join(root, 'history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = previousRunId;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
