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
 * pull-articles-api.mjs: a fetch failure or an implausibly small upstream
 * leaves the checkout untouched.
 *
 * And it never DELETES. A file this repo has and upstream lacks is kept, because
 * that is exactly what a site-published article looks like — `generate-article.yml`
 * writes articles here while the content mirror upward is dispatch-only and being
 * retired, so the two trees diverge in both directions as a matter of course.
 * `--allow-deletions` exists for the day someone means it. See MAX_DELETIONS
 * below; that asymmetry is the whole of #5289.
 *
 * Usage: node scripts/pull-articles-corpus.mjs [--check]
 *   --check            report what would change, write nothing, exit 1 if stale
 *   --allow-deletions  also remove local files upstream lacks (NOT the default)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REMOTE = process.env.ARTICLES_CORPUS_REMOTE
  ?? 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git';
const BRANCH = process.env.ARTICLES_CORPUS_BRANCH ?? 'main';
const ROOT = process.cwd();
const DEST = path.join(ROOT, 'packages', 'articles', 'content');
const CHECK_ONLY = process.argv.includes('--check');
// Opt-in, never the default. See MAX_DELETIONS: removing content this repo
// published is an editorial decision, not a step in a routine sync.
const ALLOW_DELETIONS = process.argv.includes('--allow-deletions');

/** Body files below this count mean something went wrong upstream, not a real shrink. */
const MIN_BODY_FILES = 5000;

/**
 * THE PULL DOES NOT DELETE (#5289)
 * ────────────────────────────────
 * A sync that only ADDS and UPDATES cannot lose anything, so that is the
 * default and `--allow-deletions` is the only way to get the other behaviour.
 * The bounds below apply on that opt-in path alone.
 *
 * The old guard was `srcN < dstN` — refuse when upstream has fewer files than
 * local. That single number has to separate two situations it cannot see apart:
 *
 *   TRUNCATION  upstream LOST files it used to have. Mirroring it deletes live
 *               articles from the site's own lists.
 *   DIVERGENCE  the trees differ by a handful in BOTH directions. This is the
 *               NORMAL steady state, not a defect: `mirror-articles-corpus.yml`
 *               (site → nanako) is dispatch-only and being retired, while this
 *               repo's `generate-article.yml` still publishes articles here. So
 *               "present downstream, absent upstream" is what a site-published
 *               article looks like — every one of them, by construction.
 *
 * On 2026-08-07 the net count got it wrong in both directions within two hours.
 * It jammed on divergence — `upstream has FEWER files than local (14984 <
 * 14988)`, three consecutive runs from 05:28 — and since this is the FIRST step
 * of sync-articles-sitemaps.yml the whole job aborted before
 * pull-articles-api.mjs ever ran, leaving the sitemaps stale on main and
 * tests/blog-slugs-sitemap-sync.test.ts red on every unrelated PR. Then at
 * 07:07 one article landed on each side, the arithmetic balanced at 14988, and
 * the same guard waved through a mirror that deleted three articles which were
 * live and answering HTTP 200.
 *
 * That is the lesson worth keeping: the count blocked on the accounting and
 * never on the risk. Deleting published content is an editorial act and does
 * not belong in a routine sync at any threshold — it needs someone to choose
 * it. Hence opt-in rather than a smarter number.
 */
const MAX_DELETIONS = 200;
const MAX_DELETIONS_RATIO = 0.02;

/** How many deleted paths to name in the log before truncating the list. */
const DELETION_LOG_SAMPLE = 40;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/**
 * Every file under `dir`, as a Set of paths RELATIVE to it.
 *
 * The relative path is the whole point: it is what makes the two trees
 * comparable as sets, so the caller can ask which side a difference is on
 * instead of only how many files each side has. Counting was what let a
 * two-way divergence read as a truncation (#5289).
 */
function listFiles(dir) {
  const out = new Set();
  const walk = (d, prefix) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel); else out.add(rel);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * The whole refuse/proceed decision, as a pure function of the two file sets.
 *
 * Pure and exported so the #5289 distinction can be pinned by a test instead of
 * only by a comment: the previous guard was a single `srcN < dstN` buried in an
 * I/O-bound script that clones 15k files before it can decide anything, so
 * there was no way to assert what it did without a network. A regression here
 * is a one-character edit away from re-conflating truncation with divergence,
 * which is precisely what nobody noticed the first time.
 *
 * Returns `refusal: null` to proceed, or a human-readable reason to stop.
 */
export function classifySync(srcFiles, dstFiles, opts = {}) {
  const minBodyFiles = opts.minBodyFiles ?? MIN_BODY_FILES;
  const maxDeletions = opts.maxDeletions ?? MAX_DELETIONS;
  const maxRatio = opts.maxDeletionsRatio ?? MAX_DELETIONS_RATIO;
  const allowDeletions = opts.allowDeletions ?? false;

  const srcN = srcFiles.size;
  const dstN = dstFiles.size;

  // `deletions` is what an --allow-deletions run WOULD remove. On a default run
  // it is purely a report: those files stay.
  const deletions = [...dstFiles].filter((f) => !srcFiles.has(f)).sort();
  const additions = [...srcFiles].filter((f) => !dstFiles.has(f)).sort();
  const ratio = dstN > 0 ? deletions.length / dstN : 0;

  let refusal = null;
  if (srcN < minBodyFiles) {
    // Kept even though the default run deletes nothing: an upstream this small
    // means the clone or the sparse checkout went wrong, and mirroring its
    // CONTENTS over local files would still corrupt them.
    refusal = `upstream corpus has only ${srcN} files (< ${minBodyFiles})`;
  } else if (allowDeletions && (deletions.length > maxDeletions || ratio > maxRatio)) {
    refusal = `--allow-deletions would remove ${deletions.length} local file(s) `
      + `(${(ratio * 100).toFixed(2)}% of ${dstN}), over the bound of `
      + `${maxDeletions} / ${(maxRatio * 100).toFixed(2)}% — `
      + `this is the shape of an upstream truncation, investigate before syncing`;
  }

  return { srcN, dstN, additions, deletions, ratio, refusal, willDelete: allowDeletions };
}

/**
 * Recursive copy of `src` onto `dst`.
 *
 * `deleteExtraneous` defaults to FALSE: a file `dst` has and `src` lacks is
 * left alone. That is the whole safety property — an article this repo
 * published and never mirrored upward looks exactly like an extraneous file,
 * and removing it un-lists a page that is serving HTTP 200 (#5289).
 */
function mirrorTree(src, dst, deleteExtraneous = false) {
  fs.mkdirSync(dst, { recursive: true });
  if (deleteExtraneous) {
    const want = new Set(fs.readdirSync(src));
    for (const name of fs.readdirSync(dst)) {
      if (name === '.git') continue;
      if (!want.has(name)) fs.rmSync(path.join(dst, name), { recursive: true, force: true });
    }
  }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      mirrorTree(s, d, deleteExtraneous);
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

function main() {
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

    const srcFiles = listFiles(src);
    const dstFiles = fs.existsSync(DEST) ? listFiles(DEST) : new Set();
    const { srcN, dstN, additions, deletions, refusal } =
      classifySync(srcFiles, dstFiles, { allowDeletions: ALLOW_DELETIONS });

    const delta = srcN - dstN;
    console.log(
      `[pull-articles-corpus] upstream ${srcN} files, local ${dstN} (${delta >= 0 ? '+' : ''}${delta}) — `
      + `${additions.length} to add, ${deletions.length} to delete`,
    );

    // Local-only files are never silent either way. On a default run this is
    // the list of articles this repo published that upstream has never seen —
    // worth reading, because it is also the backlog the content mirror would
    // carry up. Reconstructing it afterwards means diffing two 15k-file trees.
    if (deletions.length > 0) {
      const shown = deletions.slice(0, DELETION_LOG_SAMPLE);
      console.log(
        `[pull-articles-corpus] ${deletions.length} file(s) present locally but NOT upstream — `
        + (ALLOW_DELETIONS
          ? 'WILL BE DELETED (--allow-deletions):'
          : 'KEPT; pass --allow-deletions to remove them:'),
      );
      for (const f of shown) console.log(`    ${f}`);
      if (deletions.length > shown.length) {
        console.log(`    … and ${deletions.length - shown.length} more`);
      }
    }

    if (refusal) {
      console.error(`[pull-articles-corpus] ${refusal} — refusing`);
      process.exit(1);
    }

    if (CHECK_ONLY) {
      // Only additions make the corpus "stale". Local-only files are the normal
      // residue of a site-published article and no pull will ever resolve them.
      if (additions.length > 0) {
        console.error('[pull-articles-corpus] corpus is stale — run without --check to sync');
        process.exit(1);
      }
      console.log('[pull-articles-corpus] up to date');
      process.exit(0);
    }

    // Mirror in Node rather than shelling out to rsync: rsync is present on a
    // GitHub runner but not everywhere this might be run, and a missing binary
    // surfaced as `status: null` with an empty stderr — a failure mode that reads
    // like nothing at all. An article DELETED upstream disappears here too —
    // bounded by the deletion guard above, and every removed path is named in the
    // log, so a mirror that un-lists a live article is visible in the run rather
    // than discovered later from a 404.
    mirrorTree(src, DEST, ALLOW_DELETIONS);
    console.log(`[pull-articles-corpus] synced ${srcN} files into packages/articles/content/`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Only when run as a command. Importing this module — which the guard's test
// does — must not clone 15k files as a side effect.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
