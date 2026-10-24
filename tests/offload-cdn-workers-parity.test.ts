/**
 * OFFLOAD_CDN_WORKERS parity: the full CDN rewrite of
 * scripts/offload-generated-images-cdn.mjs split across worker threads must
 * leave EXACTLY the tree the single-thread pass leaves — same bytes in every
 * file, same files deleted by the guarded deletes, same /assets/ verdict
 * marker (including the order of its leak list) and the same summary lines.
 *
 * The fixture spans several 512-file slices so the merge order is exercised,
 * and mixes every per-file branch: og + brand refs, /assets/ rewrites, a
 * surviving same-origin /assets/ ref (LEAK marker), /data/ rewrites in HTML,
 * an XML sitemap /data/ ref that pins its file, robots.txt, a page without
 * <head>, and a malformed head that the template scan rejects.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/offload-generated-images-cdn.mjs', import.meta.url));
// Unresolvable on purpose: the post-rewrite CDN existence probe is fail-open
// and must not reach the network from a unit test.
const CDN_BASE = 'https://cdn.invalid';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function page(i: number): string {
  const head = i % 97 === 0
    ? '' // no <head>: left as-is
    : i % 89 === 0
      ? '<head><meta charset="utf-8"><template><script>window.__CDN_DATA_BASE__="x"</head>'
      : '<head><meta charset="utf-8"><title>p' + i + '</title>' +
        '<meta property="og:image" content="https://frontaliereticino.ch/og/jobs/j' + i + '.webp">' +
        '<script type="module" src="/assets/index-entry.js"></script>' +
        '<link rel="modulepreload" href="/assets/chunk-' + (i % 7) + '.js"></head>';
  const body = '<body><img src=/images/brands/b' + (i % 5) + '.png alt=x>' +
    (i % 13 === 0 ? '<a download href="/data/file-' + (i % 3) + '.json">d</a>' : '') +
    // Relative `assets/` is not rewritten: it survives as a same-origin leak
    // and lands in the marker list, in walk order, from two different slices.
    (i === 700 || i === 1300 ? '<script src="assets/leak-' + i + '.js"></script>' : '') +
    '</body>';
  return '<!doctype html><html>' + head + body + '</html>';
}

function makeDist(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-workers-'));
  tmpDirs.push(tmp);
  const dist = path.join(tmp, 'dist');
  for (let i = 0; i < 1400; i += 1) {
    const dir = path.join(dist, 'cerca-lavoro-ticino', 'job-' + i);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page(i));
  }
  fs.mkdirSync(path.join(dist, 'og', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'og', 'jobs', 'j1.webp'), 'webp');
  fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
  for (let k = 0; k < 4; k += 1) fs.writeFileSync(path.join(dist, 'data', 'file-' + k + '.json'), '{}');
  fs.writeFileSync(
    path.join(dist, 'sitemap.xml'),
    '<urlset><url><loc>https://frontaliereticino.ch/data/file-3.json</loc></url></urlset>',
  );
  fs.writeFileSync(path.join(dist, 'robots.txt'), 'Allow: /data/file-2.json\n');
  fs.writeFileSync(path.join(dist, 'index.html'), page(1));
  return tmp;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function run(tmp: string, workers: string): { stdout: string; marker: string } {
  const runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp, { recursive: true });
  const stdout = execFileSync('node', [SCRIPT], {
    cwd: tmp,
    env: { ...process.env, CDN_BASE, RUNNER_TEMP: runnerTemp, OFFLOAD_CDN_WORKERS: workers },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return { stdout, marker: fs.readFileSync(path.join(runnerTemp, 'assets-same-origin.marker'), 'utf8') };
}

const summaryLines = (stdout: string) =>
  stdout.split('\n').filter((l) => /^\[offload-generated-cdn\] (single-pass|data →|offloaded|GUARD|assets guard|no )/.test(l));

describe('OFFLOAD_CDN_WORKERS parallel rewrite parity', () => {
  it('leaves byte-identical files, deletes and marker for 1 vs 4 workers', () => {
    const a = makeDist();
    const b = makeDist();
    const seq = run(a, '');
    const par = run(b, '4');

    expect(par.stdout).toMatch(/parallel rewrite: 1403 file\(s\) across 4 worker thread\(s\)/);
    expect(seq.stdout).not.toMatch(/parallel rewrite/);
    expect(snapshot(path.join(b, 'dist'))).toEqual(snapshot(path.join(a, 'dist')));
    expect(par.marker).toBe(seq.marker);
    expect(seq.marker.startsWith('LEAK\n')).toBe(true);
    expect(summaryLines(par.stdout)).toEqual(summaryLines(seq.stdout));
    expect(summaryLines(seq.stdout).length).toBeGreaterThan(2);
  });

  it('treats invalid worker counts as the single-thread pass', () => {
    const a = makeDist();
    for (const bad of ['0', '-2', 'four', '1']) {
      fs.rmSync(path.join(a, 'runner-temp'), { recursive: true, force: true });
      expect(run(a, bad).stdout).not.toMatch(/parallel rewrite/);
    }
  });
});
