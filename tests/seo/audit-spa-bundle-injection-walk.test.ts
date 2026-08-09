/**
 * audit-spa-bundle-injection — walk/read semantics.
 *
 * WHY THIS SUITE EXISTS (issue #5432, point 6b)
 * --------------------------------------------
 * `scripts/audit-spa-bundle-injection.mjs` was the single critical path of
 * `validate-dist-postbuild` (1735-1880 s, 99.6-99.7 % of its step's wall on
 * runs 31283409340 / 31287634802 / 31296098323). Its synchronous
 * `readdirSync`/`readFileSync` generator was replaced by a bounded-concurrency
 * streaming walk. That change is only legitimate if it is an I/O-SCHEDULING
 * change and nothing else: this gate ratchets on an ABSOLUTE COUNT with zero
 * tolerance (`data/spa-bundle-injection-baseline.json`), so any drift in which
 * files get scanned moves the ratchet silently in one direction or the other.
 *
 * Deliberately NOT sampled, unlike most of the pool — the arithmetic is in the
 * script's own header. That makes the file SET the only thing that can change,
 * which is exactly what these tests pin:
 *
 *   • `assets/` `data/` `images/` subtrees stay excluded (they were excluded
 *     by the old walk as an I/O optimisation; including them would ADD
 *     offenders and fire the ratchet);
 *   • dot-directories stay INCLUDED (the old sync walk descended into them;
 *     `scripts/lib/audit-runner.mjs`'s walkHtmlFiles does not, which is why
 *     this script keeps a private walker rather than reusing it);
 *   • only entries literally named `index.html` are read, without an isFile()
 *     test, so a symlinked index.html is still scanned;
 *   • SKIP_PATHS and redirect-shape pages are counted in their own buckets;
 *   • a read error still aborts the run instead of quietly skipping a file —
 *     the async pump must REJECT, not deadlock (an earlier draft exited 13
 *     with "unsettled top-level await" on exactly this path);
 *   • the queue's prefix-release path (>4096 directories) is exercised.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-spa-bundle-injection.mjs');
// Writing a report would CREATE dist/ at the repo root and flip the suites that
// guard on fs.existsSync(dist) — see scripts/lib/auditReport.mjs's own note.
const REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-bundle-reports-'));
// Sparse worktrees have no data/, so a run without the baseline would CREATE
// it. Remember whether it was there and put the tree back exactly as found.
const BASELINE = path.join(REPO_ROOT, 'data', 'spa-bundle-injection-baseline.json');
const baselineExisted = fs.existsSync(BASELINE);

const BUNDLE = '<script type="module" crossorigin src="/assets/index-abc123XY.js"></script>';

let workdir: string;
let dist: string;

function page(relDir: string, body: string): void {
  const dir = path.join(dist, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<html><body>${body}</body></html>`, 'utf8');
}

function run(): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: workdir,
      encoding: 'utf8',
      env: { ...process.env, AUDIT_REPORTS_DIR: REPORTS_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

/** `scanned N index.html files (skipped A via SKIP_PATHS, B as redirect-shape)` */
function counters(stdout: string): { scanned: number; skipped: number; redirect: number } {
  const m = stdout.match(/scanned (\d+) index\.html files \(skipped (\d+) via SKIP_PATHS, (\d+) as redirect-shape\)/);
  if (!m) throw new Error(`no counter line in output:\n${stdout}`);
  return { scanned: Number(m[1]), skipped: Number(m[2]), redirect: Number(m[3]) };
}

/**
 * The violation total, whichever of the three exit paths the run took:
 *   `✅ 7 file(s) missing the bundle (baseline=…)`     — ratchet pass
 *   `❌ regression: 128 files missing the SPA bundle`  — ratchet fail
 *   `wrote initial baseline (total=7)`                 — no data/ (sparse tree)
 */
function offenders(stdout: string): number {
  const m =
    stdout.match(/(\d+) files?(?:\(s\))? missing the (?:SPA )?bundle/) ??
    stdout.match(/wrote initial baseline \(total=(\d+)\)/);
  if (!m) throw new Error(`no offender line in output:\n${stdout}`);
  return Number(m[1]);
}

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-bundle-dist-'));
  dist = path.join(workdir, 'dist');

  // 12 pages that carry the bundle — never offenders.
  for (let i = 0; i < 12; i++) page(`ok/deep/a/b/page-${i}`, BUNDLE);

  // 5 genuine offenders: no bundle, no redirect shape.
  for (let i = 0; i < 5; i++) page(`bad/section/p-${i}`, '<h1>no bundle</h1>');

  // Subtrees the walk must NOT descend into. Each holds a page that would be
  // an offender if it were visited, so a regression shows up as a count change.
  page('assets/nested/thing', '<h1>never scanned</h1>');
  page('data/blob', '<h1>never scanned</h1>');
  page('images/hero', '<h1>never scanned</h1>');
  page('ok/deep/assets/x', '<h1>never scanned (nested)</h1>');

  // Dot-directory: the sync walk DID descend here. +1 offender.
  page('.well-known/portal', '<h1>dot-dir offender</h1>');

  // Redirect-shape pages — own bucket, not offenders.
  page('bridge/meta', '<meta http-equiv="refresh" content="0;url=/x/">');
  page('bridge/js', '<script>location.replace("/y/")</script>');

  // SKIP_PATHS — own bucket, not offenders, not counted as scanned.
  page('contact', '<h1>contact</h1>');
  page('about', '<h1>about</h1>');

  // Non-index.html files are ignored entirely.
  fs.writeFileSync(path.join(dist, 'bad', '404.html'), '<h1>not an index</h1>', 'utf8');

  // Symlinked index.html: readdir reports a symlink, not a file — the walk has
  // no isFile() test, so it is still read. +1 offender.
  fs.mkdirSync(path.join(dist, 'symlinked'), { recursive: true });
  fs.symlinkSync(path.join(dist, 'bad', 'section', 'p-0', 'index.html'), path.join(dist, 'symlinked', 'index.html'));

  // >4096 directories so the queue's prefix-release branch actually runs.
  for (let i = 0; i < 4200; i++) fs.mkdirSync(path.join(dist, 'wide', `n-${i}`), { recursive: true });
});

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
  if (!baselineExisted) fs.rmSync(BASELINE, { force: true });
});

describe('audit-spa-bundle-injection — which files the walk visits', () => {
  it('scans every index.html outside assets/data/images and counts each bucket separately', () => {
    const { stdout, status } = run();
    const c = counters(stdout);

    // 12 with bundle + 5 offenders + 1 dot-dir + 1 symlink + 2 redirect-shape = 21.
    // The four pages under assets/ data/ images/ are NOT in this number, and
    // neither are the two SKIP_PATHS pages (skipped before `scanned++`).
    expect(c.scanned).toBe(21);
    expect(c.skipped).toBe(2);
    expect(c.redirect).toBe(2);
    // status is 0 or 1 depending on the repo baseline; the counters are the
    // assertion here. `-1` would mean the process died.
    expect([0, 1]).toContain(status);
  });

  it('flags exactly the bundle-less pages — dot-directory and symlink included, assets/data/images excluded', () => {
    const { stdout } = run();
    // 5 under bad/section + .well-known/portal + symlinked = 7. If the walk
    // started descending into assets/data/images this would be 11; if it
    // stopped descending into dot-directories it would be 6.
    expect(offenders(stdout)).toBe(7);
  });

  it('fails closed when a file cannot be read, instead of skipping it', () => {
    // A dangling symlink named index.html: readdir yields it, readFile raises
    // ENOENT. readFileSync used to throw and kill the run; the async pump must
    // reject with the same effect — and must SETTLE (exit 13 = "unsettled
    // top-level await" means the pump deadlocked instead).
    const broken = path.join(dist, 'dangling');
    fs.mkdirSync(broken, { recursive: true });
    fs.symlinkSync(path.join(dist, 'does-not-exist', 'index.html'), path.join(broken, 'index.html'));
    try {
      const { status } = run();
      expect(status).toBe(1);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });
});
