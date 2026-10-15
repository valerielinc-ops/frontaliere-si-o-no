import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Pull internal helpers out of the audit script via dynamic import. The
// script's `main()` only runs when invoked as the entrypoint (we guard with
// `process.argv[1]` matching), so a regular import returns its `__test`
// bundle without executing the audit pipeline.
//
// Use process.cwd() to resolve the script path because `import.meta.url`
// is rewritten to an http:// scheme by vitest's worker (the default ESM
// loader rejects http:// URLs with TypeError).
const SCRIPT_PATH = resolve(process.cwd(), 'scripts/audit-orphan-pages-in-sitemaps.mjs');
const SCRIPT_URL_HREF = pathToFileURL(SCRIPT_PATH).href;

interface AuditTestExports {
  bfsReachableFromHome: (
    distRoot: string,
  ) => Promise<{
    linked: Set<string>;
    stats: { visited: number; noindex: number; dead: number };
  }>;
  extractAnchorHrefs: (html: string) => string[];
  htmlHasNoindex: (html: string) => boolean;
  normaliseInternalPath: (href: string) => string | null;
  resolvePathToDistFile: (distRoot: string, path: string) => Promise<string | null>;
  compareAgainstBaseline: (
    current: { perSitemap: Record<string, { orphans: number; total?: number; examples?: string[] }> },
    baseline:
      | {
          tolerance?: { relPct: number; absPp: number; minAbsDelta: number; maxDeltaPp: number };
          perSitemap: Record<string, { orphans: number; total?: number; ratePct?: number; examples?: string[] }>;
        }
      | null,
    perSitemapInMemory?: Record<string, { orphansList?: string[] }>,
    tol?: { relPct: number; absPp: number; minAbsDelta: number; maxDeltaPp: number },
  ) => {
    regressed: boolean;
    regressions: Array<{
      sitemap: string;
      prev: number;
      current: number;
      prevRate: number;
      curRate: number;
      rateCap: number;
      newOrphans: string[];
    }>;
    unbaselined: Array<{ sitemap: string; orphans: number; total: number; ratePct: number }>;
  };
  distHasEnoughHtml: (distRoot: string) => Promise<boolean>;
}

async function loadHelpers(): Promise<AuditTestExports> {
  const mod = (await import(SCRIPT_URL_HREF)) as { __test: AuditTestExports };
  return mod.__test;
}

describe('audit-orphan-pages: BFS reachability', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orphan-audit-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('visits a 3-page chain reachable from /', async () => {
    const { bfsReachableFromHome } = await loadHelpers();
    await mkdir(join(tmpDir, 'a'), { recursive: true });
    await mkdir(join(tmpDir, 'a', 'b'), { recursive: true });
    await writeFile(
      join(tmpDir, 'index.html'),
      `<html><body><a href="/a/">A</a></body></html>`,
      'utf8',
    );
    await writeFile(
      join(tmpDir, 'a', 'index.html'),
      `<html><body><a href="/a/b/">B</a></body></html>`,
      'utf8',
    );
    await writeFile(
      join(tmpDir, 'a', 'b', 'index.html'),
      `<html><body><p>leaf</p></body></html>`,
      'utf8',
    );

    const result = await bfsReachableFromHome(tmpDir);
    expect(result.linked.has('/')).toBe(true);
    expect(result.linked.has('/a')).toBe(true);
    expect(result.linked.has('/a/b')).toBe(true);
    expect(result.stats.visited).toBe(3);
  });

  it('records noindex pages as reachable but does not follow their links', async () => {
    const { bfsReachableFromHome } = await loadHelpers();
    await mkdir(join(tmpDir, 'gate'), { recursive: true });
    await mkdir(join(tmpDir, 'beyond'), { recursive: true });
    await writeFile(
      join(tmpDir, 'index.html'),
      `<html><body><a href="/gate/">Gate</a></body></html>`,
      'utf8',
    );
    await writeFile(
      join(tmpDir, 'gate', 'index.html'),
      `<html><head><meta name="robots" content="noindex,follow"></head>` +
        `<body><a href="/beyond/">Beyond</a></body></html>`,
      'utf8',
    );
    await writeFile(
      join(tmpDir, 'beyond', 'index.html'),
      `<html><body>far</body></html>`,
      'utf8',
    );

    const result = await bfsReachableFromHome(tmpDir);
    expect(result.linked.has('/')).toBe(true);
    expect(result.linked.has('/gate')).toBe(true);
    expect(result.linked.has('/beyond')).toBe(false);
    expect(result.stats.noindex).toBe(1);
  });

  it('does not follow <link rel="alternate"> hreflang tags', async () => {
    const { bfsReachableFromHome } = await loadHelpers();
    await mkdir(join(tmpDir, 'en'), { recursive: true });
    await writeFile(
      join(tmpDir, 'index.html'),
      `<html><head>` +
        `<link rel="alternate" hreflang="en" href="/en/">` +
        `<link rel="canonical" href="https://frontaliereticino.ch/">` +
        `</head><body><p>home only</p></body></html>`,
      'utf8',
    );
    await writeFile(
      join(tmpDir, 'en', 'index.html'),
      `<html><body>en home</body></html>`,
      'utf8',
    );

    const result = await bfsReachableFromHome(tmpDir);
    expect(result.linked.has('/')).toBe(true);
    expect(result.linked.has('/en')).toBe(false);
  });

  it('counts dangling links as dead-ends and never as reachable', async () => {
    const { bfsReachableFromHome } = await loadHelpers();
    await writeFile(
      join(tmpDir, 'index.html'),
      `<html><body><a href="/missing-page/">Missing</a></body></html>`,
      'utf8',
    );

    const result = await bfsReachableFromHome(tmpDir);
    expect(result.linked.has('/missing-page')).toBe(false);
    expect(result.stats.dead).toBe(1);
  });

  it('throws when dist/index.html is missing', async () => {
    const { bfsReachableFromHome } = await loadHelpers();
    await expect(bfsReachableFromHome(tmpDir)).rejects.toThrow(/start node missing/i);
  });
});

describe('audit-orphan-pages: extractors and helpers', () => {
  it('extractAnchorHrefs picks <a> hrefs but ignores <link>', async () => {
    const { extractAnchorHrefs } = await loadHelpers();
    const html =
      `<link rel="alternate" hreflang="en" href="/en/"/>` +
      `<a href="/foo">F</a>` +
      `<a href='/bar'>B</a>` +
      `<a href="/baz#x">Z</a>`;
    const hrefs = extractAnchorHrefs(html);
    expect(hrefs).toEqual(['/foo', '/bar', '/baz#x']);
  });

  it('htmlHasNoindex detects various meta-robots formats', async () => {
    const { htmlHasNoindex } = await loadHelpers();
    expect(htmlHasNoindex('<meta name="robots" content="noindex">')).toBe(true);
    expect(htmlHasNoindex('<meta name="robots" content="noindex, follow">')).toBe(true);
    expect(htmlHasNoindex(`<meta name='robots' content='index,follow'>`)).toBe(false);
    expect(htmlHasNoindex('<p>no meta</p>')).toBe(false);
  });

  it('normaliseInternalPath handles internal absolute, relative, and external URLs', async () => {
    const { normaliseInternalPath } = await loadHelpers();
    expect(normaliseInternalPath('/foo/')).toBe('/foo');
    expect(normaliseInternalPath('/foo')).toBe('/foo');
    expect(normaliseInternalPath('https://frontaliereticino.ch/foo/')).toBe('/foo');
    expect(normaliseInternalPath('https://www.frontaliereticino.ch/foo')).toBe('/foo');
    expect(normaliseInternalPath('https://other.example/foo')).toBe(null);
    expect(normaliseInternalPath('mailto:x@y.z')).toBe(null);
    expect(normaliseInternalPath('//cdn.example/foo')).toBe(null);
    expect(normaliseInternalPath('/foo?q=1#frag')).toBe('/foo');
  });
});

describe('audit-orphan-pages: --gate=baseline (rate ratchet)', () => {
  it('does NOT regress on organic growth — orphan count rises but the rate falls', async () => {
    // The real-world false-fail this migration fixes: sitemap-jobs grew
    // 1039/2409 (43%) → 1046/8721 (12%). +7 orphans tripped the old
    // absolute-count gate even though the orphan SHARE dropped 31pp.
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: {
        'sitemap-jobs.xml': { total: 2409, orphans: 1039, ratePct: 43.13, examples: [] },
      },
    };
    const current = {
      perSitemap: {
        'sitemap-jobs.xml': { total: 8721, orphans: 1046, examples: [] },
      },
    };
    const cmp = compareAgainstBaseline(current, baseline);
    expect(cmp.regressed).toBe(false);
    expect(cmp.regressions).toHaveLength(0);
  });

  it('regresses when the orphan RATE spikes beyond tolerance AND count grows past the floor', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: {
        'sitemap-blog.xml': { total: 1000, orphans: 100, ratePct: 10, examples: ['https://x/a'] },
      },
    };
    const current = {
      perSitemap: {
        'sitemap-blog.xml': { total: 1000, orphans: 300, examples: ['https://x/a', 'https://x/c', 'https://x/d'] },
      },
    };
    const cmp = compareAgainstBaseline(current, baseline);
    expect(cmp.regressed).toBe(true);
    expect(cmp.regressions).toHaveLength(1);
    expect(cmp.regressions[0]?.sitemap).toBe('sitemap-blog.xml');
    expect(cmp.regressions[0]?.curRate).toBe(30);
    // newOrphans surfaces items not present in the baseline examples
    expect(cmp.regressions[0]?.newOrphans).toEqual(['https://x/c', 'https://x/d']);
  });

  it('does NOT regress when the rate worsens slightly but stays within tolerance', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 100, ratePct: 10, examples: [] } },
    };
    // 100 → 130 orphans, rate 10% → 13%. Cap = 10 + min(1.5, 8) + 5 = 16.5%.
    // 13% < 16.5% → within tolerance even though +30 count > minAbsDelta.
    const cmp = compareAgainstBaseline(
      { perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 130, examples: [] } } },
      baseline,
    );
    expect(cmp.regressed).toBe(false);
  });

  it('does NOT regress on a small count bump below minAbsDelta even if the rate ticks up', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-pages.xml': { total: 100, orphans: 10, ratePct: 10, examples: [] } },
    };
    // 10 → 25 orphans on a flat total: rate 25% > cap 16.5%, BUT +15 < minAbsDelta(20).
    const cmp = compareAgainstBaseline(
      { perSitemap: { 'sitemap-pages.xml': { total: 100, orphans: 25, examples: [] } } },
      baseline,
    );
    expect(cmp.regressed).toBe(false);
  });

  it('does NOT regress on pure corpus contraction — total shrinks, orphan count flat (#1605 item 3)', async () => {
    // Denominator-shrink is intentionally not a regression: linked pages leave
    // the sitemap (de-indexed/removed) so `total` halves while `orphans` stays
    // flat → the orphan RATE doubles (10% → 20%, > cap) purely from the smaller
    // denominator. No NEW page is buried (the same orphan URLs exist before and
    // after), so there is zero new crawl-budget waste; the count floor is
    // denominator-independent and stays false (+0 < minAbsDelta). Gating this
    // would deploy-block legitimate corpus shrink — a new organic false-fail,
    // the class #1604 removed. A real burial under contraction still fires
    // because the count floor catches it regardless of `total`.
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-jobs.xml': { total: 2000, orphans: 200, ratePct: 10, examples: [] } },
    };
    const cmp = compareAgainstBaseline(
      { perSitemap: { 'sitemap-jobs.xml': { total: 1000, orphans: 200, examples: [] } } },
      baseline,
    );
    expect(cmp.regressed).toBe(false);
    expect(cmp.regressions).toHaveLength(0);
  });

  it('STILL regresses when real burial happens during contraction (count floor is denominator-independent)', async () => {
    // Same shrink as above, but orphans also grow past the floor: rate worsens
    // AND +220 > minAbsDelta(20) → caught. Contraction never hides a real
    // internal-link regression above the noise floor.
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-jobs.xml': { total: 2000, orphans: 200, ratePct: 10, examples: [] } },
    };
    const cmp = compareAgainstBaseline(
      { perSitemap: { 'sitemap-jobs.xml': { total: 1000, orphans: 420, examples: [] } } },
      baseline,
    );
    expect(cmp.regressed).toBe(true);
    expect(cmp.regressions).toHaveLength(1);
  });

  it('returns no regression when counts are flat or lower', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 100, ratePct: 10, examples: [] } },
    };
    const flat = compareAgainstBaseline(
      { perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 100, examples: [] } } },
      baseline,
    );
    expect(flat.regressed).toBe(false);
    const lower = compareAgainstBaseline(
      { perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 50, examples: [] } } },
      baseline,
    );
    expect(lower.regressed).toBe(false);
  });

  it('never fails on a sitemap absent from the baseline — only records it as unbaselined', async () => {
    // Pre-migration the gate skipped unbaselined sitemaps entirely. The rate
    // migration preserves that: a brand-new sitemap (even 100% orphaned) is
    // surfaced for the log but does NOT fail the build — a fresh rebaseline
    // folds it in, after which the rate ratchet guards it. Avoids turning a
    // pre-existing tolerated condition (e.g. sitemap-comuni-frontiera at ~95%
    // orphaned, already accepted by the bfs-depth baseline) into a deploy block.
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-blog.xml': { total: 1000, orphans: 100, ratePct: 10, examples: [] } },
    };
    const cmp = compareAgainstBaseline(
      { perSitemap: { 'sitemap-new-shard.xml': { total: 320, orphans: 304, examples: [] } } },
      baseline,
    );
    expect(cmp.regressed).toBe(false);
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.unbaselined).toHaveLength(1);
    expect(cmp.unbaselined[0]?.sitemap).toBe('sitemap-new-shard.xml');
    expect(cmp.unbaselined[0]?.ratePct).toBe(95);
  });

  it('script exits 1 when --gate=baseline runs in Mode B (no dist/)', async () => {
    // Spawn the script in source-mode against a worktree without dist/. We
    // can't realistically fetch remote sitemaps from a unit test, so we
    // instead force an early-exit path: the Mode B + gate combo bails out
    // before any network call.
    const { code, stderr } = await runScript(SCRIPT_PATH, ['--source-mode', '--gate=baseline'], {
      // Run in a temp cwd with no dist/ so fetchAllSitemaps wouldn't be
      // reached anyway.
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/gate=baseline requires Mode A|FATAL/i);
  });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: opts.cwd,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
