import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chunkAbiHash } from '@/build-plugins/shared/abiChunkNaming';
import { scanHtmlAssetReferences } from '@/scripts/lib/spa-chunk-interface-check.mjs';

/**
 * The gate reads EVERY emitted page. A sample (the first 400 pages, three levels
 * deep) cannot see a renamed chunk that one emitter failed to follow in a single
 * locale or section, which is exactly where such a miss would live.
 */
describe('scanHtmlAssetReferences — every emitted page, at any depth', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const assets = new Set(['vendor-react.5a1b2c3d.js', 'it-core.js']);
  const link = (file: string) => `<link rel="modulepreload" href="/assets/${file}">`;

  function distWith(pages: Record<string, string>): string {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-html-scan-'));
    dirs.push(dist);
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    // A page inside dist/assets must never be read: that directory holds only chunks.
    fs.writeFileSync(path.join(dist, 'assets', 'ignored.html'), link('vendor-react.deadbeef.js'));
    for (const [rel, html] of Object.entries(pages)) {
      fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
      fs.writeFileSync(path.join(dist, rel), html);
    }
    return dist;
  }

  it('finds the one broken reference on a page far below depth 3', async () => {
    const dist = distWith({
      'index.html': link('vendor-react.5a1b2c3d.js'),
      'it/section/canton/city/profession/page/index.html': link('vendor-react.js'),
    });
    const { scanned, problems } = await scanHtmlAssetReferences(dist, assets);
    expect(scanned).toBe(2);
    expect(problems).toEqual([
      {
        page: path.join('it', 'section', 'canton', 'city', 'profession', 'page', 'index.html'),
        asset: 'vendor-react.js',
        reason: 'chunk is emitted only under its interface-hashed name',
      },
    ]);
  });

  it('reads past any sample limit and checks non-index pages too', async () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 450; i += 1) pages[`p${i}/index.html`] = link('it-core.js');
    pages['zz/last/index.html'] = link('vendor-react.deadbeef.js');
    pages['404.html'] = link('vendor-react.js');
    const { scanned, problems } = await scanHtmlAssetReferences(distWith(pages), assets, { concurrency: 8 });
    expect(scanned).toBe(452);
    expect(problems.map((p) => p.page).sort()).toEqual(['404.html', path.join('zz', 'last', 'index.html')]);
  });

  it('is clean when every reference follows the rename, and reports the truncation when problems are capped', async () => {
    const clean = await scanHtmlAssetReferences(distWith({ 'a/b/c/d/e/index.html': link('vendor-react.5a1b2c3d.js') }), assets);
    expect(clean).toMatchObject({ scanned: 1, problems: [], truncated: false });

    const pages: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) pages[`bad${i}/index.html`] = link('vendor-react.js');
    const capped = await scanHtmlAssetReferences(distWith(pages), assets, { maxProblems: 2 });
    expect(capped.problems).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

/**
 * The review acceptance case on the real script: a valid dist whose only broken
 * `/assets/<base>.<hash>.js` reference sits in an index.html below depth 3 must
 * make `verify-spa-entry-assets.mjs` exit 1 with `verify-spa-html-assets`.
 */
describe('verify-spa-entry-assets.mjs end to end', () => {
  const root = process.cwd();
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  const script = path.join(root, 'scripts', 'verify-spa-entry-assets.mjs');
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function validDist(deepPageHtml: string): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-verify-e2e-'));
    dirs.push(cwd);
    const assets = path.join(cwd, 'dist', 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const appHash = chunkAbiHash(['App']);
    fs.writeFileSync(path.join(assets, 'index-entry.js'), `import"./App.${appHash}.js";`);
    fs.writeFileSync(path.join(assets, 'index.css'), 'body{margin:0}');
    fs.writeFileSync(path.join(assets, `App.${appHash}.js`), 'const a=1;export{a as App};');
    fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), `<link rel="modulepreload" href="/assets/App.${appHash}.js">`);
    const deep = path.join(cwd, 'dist', 'it', 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'index.html'), deepPageHtml);
    return cwd;
  }

  function run(cwd: string): { status: number; output: string } {
    try {
      const output = execFileSync(tsx, [script], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, output };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('exits 1 with verify-spa-html-assets for a broken reference below depth 3', () => {
    const cwd = validDist('<link rel="modulepreload" href="/assets/App.js">');
    const { status, output } = run(cwd);
    expect(output).toContain('verify-spa-html-assets');
    expect(output).toContain('App.js');
    expect(status).toBe(1);
  }, 60_000);

  it('exits 0 when the deep page follows the rename', () => {
    const appHash = chunkAbiHash(['App']);
    const cwd = validDist(`<link rel="modulepreload" href="/assets/App.${appHash}.js">`);
    const { status, output } = run(cwd);
    expect(output).toContain('[verify-spa-html-assets] ok — 2 page(s)');
    expect(status).toBe(0);
  }, 60_000);
});
