#!/usr/bin/env node
/**
 * pull-articles-corpus.mjs — bring the article CORPUS back from nanako.
 *
 * WHY THIS EXISTS
 * ───────────────
 * After the cutover this repo stopped being the corpus's home
 * (`mirror-articles-corpus.yml` pushed content HERE → THERE, and its schedule
 * is commented out; its last run was 2026-08-02). Nothing replaced it in the
 * other direction, so `packages/articles/content/` froze on the cutover date.
 *
 * That is invisible from the machine-facing surfaces and obvious to a reader.
 * `pull-articles-api.mjs` fetches the sitemaps, the feeds and the ticker, so
 * Google and feed readers see every new article. But the reader-facing lists —
 * the `/articoli-frontaliere/` hub, the archive, the homepage — are rendered
 * from the SPA bundle, which is built from THIS corpus. Measured 2026-08-03:
 * fourteen articles answered 200 at their own URL, appeared in
 * sitemap-blog.xml and in the RSS, and the hub's most recent entry was dated
 * 2026-07-29. Reachable, listed by machines, and unfindable by a human.
 *
 * The published API cannot fix this on its own: `articles.json` is
 * `{id, category, date, updatedAt, image, hasCalculator, authorSlug, authorName}`
 * — no title, no body (§7.1, §10.1). A list needs titles, so the corpus itself
 * has to come back.
 *
 * DIRECTION AND OWNERSHIP. This is a CONSUMER pull, not a return of ownership.
 * nanako generates, renders and publishes; this repo copies the corpus in so
 * its bundle can list what already exists. It never writes back — that is what
 * `mirror-articles-corpus.yml` did and it stays retired.
 *
 * SAFETY. Refuses rather than degrades, in the same posture as
 * pull-articles-api.mjs: a fetch failure, an empty tree, or a corpus that
 * SHRANK leaves the checkout untouched. A silent truncation here would delete
 * live articles from the site's own lists.
 *
 * Usage: node scripts/pull-articles-corpus.mjs [--check]
 *   --check  report what would change, write nothing, exit 1 if stale
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const REMOTE = process.env.ARTICLES_CORPUS_REMOTE
  ?? 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git';
const BRANCH = process.env.ARTICLES_CORPUS_BRANCH ?? 'main';
const ROOT = process.cwd();
const DEST = path.join(ROOT, 'packages', 'articles', 'content');
const CHECK_ONLY = process.argv.includes('--check');

/** Body files below this count mean something went wrong upstream, not a real shrink. */
const MIN_BODY_FILES = 5000;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else n++;
    }
  };
  walk(dir);
  return n;
}

/** Recursive copy of `src` onto `dst`, deleting anything in `dst` that src lacks. */
function mirrorTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const want = new Set(fs.readdirSync(src));
  for (const name of fs.readdirSync(dst)) {
    if (name === '.git') continue;
    if (!want.has(name)) fs.rmSync(path.join(dst, name), { recursive: true, force: true });
  }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      mirrorTree(s, d);
    } else {
      // Skip an identical file so the mtime (and any downstream cache keyed on
      // it) does not churn on every sync.
      let same = false;
      try {
        const a = fs.statSync(s), b = fs.statSync(d);
        same = a.size === b.size && fs.readFileSync(s).equals(fs.readFileSync(d));
      } catch { same = false; }
      if (!same) {
        if (fs.existsSync(d)) fs.rmSync(d, { force: true });
        fs.copyFileSync(s, d);
      }
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'articles-corpus-'));
try {
  // Blobless + sparse: the corpus is ~15k small files but the repo also carries
  // images and generator history we do not want. --depth 1 keeps it to one commit.
  run('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout',
              '--branch', BRANCH, REMOTE, tmp]);
  run('git', ['-C', tmp, 'sparse-checkout', 'set', '--no-cone', 'content']);
  run('git', ['-C', tmp, 'checkout', '--quiet']);

  const src = path.join(tmp, 'content');
  if (!fs.existsSync(src)) throw new Error(`upstream has no content/ on ${BRANCH}`);

  const srcN = countFiles(src);
  const dstN = fs.existsSync(DEST) ? countFiles(DEST) : 0;

  if (srcN < MIN_BODY_FILES) {
    console.error(`[pull-articles-corpus] upstream corpus has only ${srcN} files (< ${MIN_BODY_FILES}) — refusing`);
    process.exit(1);
  }
  // A shrink is the dangerous direction: this content feeds the site's own
  // article lists, so losing entries here un-lists live articles.
  if (dstN > 0 && srcN < dstN) {
    console.error(`[pull-articles-corpus] upstream has FEWER files than local (${srcN} < ${dstN}) — refusing; investigate before syncing`);
    process.exit(1);
  }

  const delta = srcN - dstN;
  console.log(`[pull-articles-corpus] upstream ${srcN} files, local ${dstN} (${delta >= 0 ? '+' : ''}${delta})`);

  if (CHECK_ONLY) {
    if (delta !== 0) {
      console.error('[pull-articles-corpus] corpus is stale — run without --check to sync');
      process.exit(1);
    }
    console.log('[pull-articles-corpus] up to date');
    process.exit(0);
  }

  // Mirror in Node rather than shelling out to rsync: rsync is present on a
  // GitHub runner but not everywhere this might be run, and a missing binary
  // surfaced as `status: null` with an empty stderr — a failure mode that reads
  // like nothing at all. An article DELETED upstream disappears here too; safe
  // because of the shrink guard above.
  mirrorTree(src, DEST);
  console.log(`[pull-articles-corpus] synced ${srcN} files into packages/articles/content/`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
