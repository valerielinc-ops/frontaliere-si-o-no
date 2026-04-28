import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pull internal helpers out of the audit script via dynamic import. The
// script's `main()` only runs when invoked as the entrypoint (we guard with
// `process.argv[1]` matching), so a regular import returns its `__test`
// bundle without executing the audit pipeline.
const SCRIPT_URL = new URL('../scripts/audit-orphan-pages-in-sitemaps.mjs', import.meta.url);

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
    current: { perSitemap: Record<string, { orphans: number; examples: string[] }> },
    baseline: { perSitemap: Record<string, { orphans: number; examples: string[] }> } | null,
  ) => { regressed: boolean; regressions: Array<{ sitemap: string; prev: number; current: number; newOrphans: string[] }> };
  distHasEnoughHtml: (distRoot: string) => Promise<boolean>;
}

async function loadHelpers(): Promise<AuditTestExports> {
  const mod = (await import(SCRIPT_URL.href)) as { __test: AuditTestExports };
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

describe('audit-orphan-pages: --gate=baseline', () => {
  it('compareAgainstBaseline flags regressions only when count is higher', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: {
        'sitemap-blog.xml': { orphans: 100, examples: ['https://x/a', 'https://x/b'] },
        'sitemap-jobs.xml': { orphans: 50, examples: [] },
      },
    };
    const current = {
      perSitemap: {
        'sitemap-blog.xml': { orphans: 105, examples: ['https://x/a', 'https://x/c', 'https://x/d'] },
        'sitemap-jobs.xml': { orphans: 40, examples: [] },
      },
    };
    const cmp = compareAgainstBaseline(current, baseline);
    expect(cmp.regressed).toBe(true);
    expect(cmp.regressions).toHaveLength(1);
    expect(cmp.regressions[0]?.sitemap).toBe('sitemap-blog.xml');
    expect(cmp.regressions[0]?.prev).toBe(100);
    expect(cmp.regressions[0]?.current).toBe(105);
    // newOrphans should surface the items not in baseline examples
    expect(cmp.regressions[0]?.newOrphans).toEqual(['https://x/c', 'https://x/d']);
  });

  it('compareAgainstBaseline returns no regression when counts are flat or lower', async () => {
    const { compareAgainstBaseline } = await loadHelpers();
    const baseline = {
      perSitemap: { 'sitemap-blog.xml': { orphans: 100, examples: [] } },
    };
    const flat = compareAgainstBaseline(
      { perSitemap: { 'sitemap-blog.xml': { orphans: 100, examples: [] } } },
      baseline,
    );
    expect(flat.regressed).toBe(false);
    const lower = compareAgainstBaseline(
      { perSitemap: { 'sitemap-blog.xml': { orphans: 50, examples: [] } } },
      baseline,
    );
    expect(lower.regressed).toBe(false);
  });

  it('script exits 1 when --gate=baseline runs in Mode B (no dist/)', async () => {
    // Spawn the script in source-mode against a worktree without dist/. We
    // can't realistically fetch remote sitemaps from a unit test, so we
    // instead force an early-exit path: the Mode B + gate combo bails out
    // before any network call.
    const scriptPath = fileURLToPath(SCRIPT_URL);
    const { code, stderr } = await runScript(scriptPath, ['--source-mode', '--gate=baseline'], {
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
