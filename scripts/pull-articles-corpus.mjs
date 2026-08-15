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
 * The file-count floor below is NOT that guarantee on its own, and 2026-08-07
 * proved it: commit 10c8c8178 deleted three live articles while adding three
 * others, the counts cancelled, and the floor never fired. A count cannot see
 * an article leave. So the REGISTRY is checked by name as well — see
 * scripts/lib/corpus-removal-guard.mjs for the incident and the criterion that
 * separates a deliberate retirement from an accidental loss.
 *
 * WHICH COMMIT THIS PULLS (issue #5298)
 * ─────────────────────────────────────
 * Not HEAD. The commit the PUBLISHED API says it was built from, read from
 * `manifest.json`'s `commit` field and checked out explicitly.
 *
 * Cloning `--branch main` took whatever was newest, which sounds strictly better
 * and is the bug: this script's output defines BLOG_SLUGS/SWISS_SLUGS (the
 * `services/router*Data.ts` symlinks point into the directory it mirrors), while
 * pull-articles-api.mjs's output — the sitemaps — comes from a Pages/CDN copy
 * built by an EARLIER publish. Same workflow, same commit, two different upstream
 * states, and `tests/blog-slugs-sitemap-sync.test.ts` red on every open branch.
 * scripts/lib/articles-sync-pin.mjs carries the full account.
 *
 * So: pin to the API's commit, and if the mirror cannot serve that commit, skip
 * the sync entirely rather than write a registry the sitemaps do not match.
 *
 * Usage: node scripts/pull-articles-corpus.mjs [--check]
 *   --check  report what would change, write nothing, exit 1 if stale
 *
 * Env: ARTICLES_SYNC_COMMIT pins the pull explicitly instead of asking the API.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { ARTICLES_API_BASE } from './lib/articles-api-base.mjs';
import {
  ARTICLE_REGISTRY_FILES,
  ARTICLE_SECTION_KEYS,
  readSlugRegistry,
} from './lib/article-slug-registry.mjs';
import { evaluateCorpusRemoval, parseRedirectSources } from './lib/corpus-removal-guard.mjs';
import { localOnlyIds, mergeEntries } from './lib/corpus-entry-merge.mjs';
import { collectPreserveSnapshots, dropLedgeredRetirements } from './lib/corpus-local-preserve.mjs';
import { emitSkip, pinVerdict, publishPin, readPin } from './lib/articles-sync-pin.mjs';

// Opt-in, never the default. See MAX_DELETIONS: removing content this repo
// published is an editorial decision, not a step in a routine sync.
const ALLOW_DELETIONS = process.argv.includes('--allow-deletions');

/**
 * The registries that DEFINE an article id. A site-published article is one
 * whose id these carry and upstream's copies do not; every other surface keys
 * off the same id, so this is the only place the question has to be asked.
 */
const REGISTRY_FILES = ['routerBlogData.ts', 'routerSwissData.ts'];


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

/**
 * Read both slug registries out of a tree. `resolveFile` maps the site-relative
 * registry path onto wherever that tree keeps it — the corpus checkout is
 * `content/<name>.ts`, this repo is `packages/articles/content/<name>.ts`.
 */
function readRegistries(resolveFile) {
  const out = {};
  for (const section of ARTICLE_SECTION_KEYS) {
    const { file, constName } = ARTICLE_REGISTRY_FILES[section];
    out[section] = readSlugRegistry(resolveFile(file), constName);
  }
  return out;
}

/**
 * The published manifest, or null when it cannot be read after `attempts` tries.
 *
 * It now carries TWO things this script needs, with opposite tolerances:
 *
 *   - `commit` — which corpus commit to check out. Load-bearing (#5298): without
 *     it there is no way to make this pull and pull-articles-api.mjs describe the
 *     same upstream state, so its absence SKIPS the sync.
 *   - `counts` — the weaker of the two removal gates. It was tolerant of a
 *     failed read on purpose, and stays that way in spirit; in practice a run
 *     that got here has already read the manifest successfully, so the tolerance
 *     is now unreachable rather than removed.
 *
 * Making the fetch load-bearing costs nothing that was not already lost: with the
 * manifest unavailable, pull-articles-api.mjs — the very next step — refuses and
 * exits 1 anyway. The only change is that the run now ends green and warned
 * instead of red, after a skipped clone rather than a wasted one.
 */
async function fetchManifest(attempts = 3) {
  const url = `${ARTICLES_API_BASE}/manifest.json`;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body && typeof body === 'object') return body;
      throw new Error('manifest is not a JSON object');
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  console.warn(`[pull-articles-corpus] manifest unavailable from ${url} (${lastErr?.message})`);
  return null;
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

// ── Which corpus commit this sync is pinned to (issue #5298) ─────────────────
//
// Resolved BEFORE the clone, because a manifest we cannot read is a sync we must
// not start: an unpinned clone is exactly the HEAD-vs-published-API skew that
// reddens tests/blog-slugs-sitemap-sync.test.ts on every open branch.
const manifest = await fetchManifest();
const pin = pinVerdict({ pinned: readPin(), manifestCommit: manifest?.commit });

/** Abandon the sync without writing anything. Green, warned, retried next round. */
let tmp = null;
function skipSync(reason) {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  emitSkip('pull-articles-corpus', reason);
  process.exit(0);
}

if (!pin.ok) skipSync(pin.reason);
const TARGET = pin.commit;

tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'articles-corpus-'));
try {
  // Blobless + sparse: the corpus is ~15k small files but the repo also carries
  // images and generator history we do not want. --depth 1 keeps it to one commit.
  run('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout',
              '--branch', BRANCH, REMOTE, tmp]);
  run('git', ['-C', tmp, 'sparse-checkout', 'set', '--no-cone', 'content']);

  // Check out the commit the API was BUILT from, not the branch tip.
  //
  // Usually the tip already IS it and the extra fetch is skipped. When it is
  // not, `git fetch origin <sha>` asks for that exact object: legal against
  // GitHub for any commit reachable from a ref, which the manifest's commit is
  // by construction — build-api.mjs read it off this very branch.
  //
  // A failure here means the mirror genuinely cannot serve it (force-pushed
  // away, or the API is ahead of a mirror that has not received the push yet).
  // That is the one case where continuing would produce the mixed state: the
  // registry from `main`, the sitemaps from an older publish. So it skips.
  const head = run('git', ['-C', tmp, 'rev-parse', 'HEAD']).trim();
  let ref = head;
  if (head !== TARGET) {
    const fetched = spawnSync(
      'git', ['-C', tmp, 'fetch', '--quiet', '--depth', '1', 'origin', TARGET],
      { encoding: 'utf-8' },
    );
    if (fetched.status !== 0) {
      skipSync(
        `${BRANCH} is at ${head.slice(0, 8)} and the mirror cannot serve ${TARGET.slice(0, 8)}, ` +
        `the commit ${ARTICLES_API_BASE}/manifest.json says the published API was built from: ` +
        `${(fetched.stderr || fetched.stdout || 'no output').trim().split('\n').pop()}`,
      );
    }
    ref = 'FETCH_HEAD';
  }
  run('git', ['-C', tmp, 'checkout', '--quiet', '--detach', ref]);
  console.log(
    `[pull-articles-corpus] corpus pinned to ${TARGET}` +
    (head === TARGET ? ` (${BRANCH} tip)` : ` (${BRANCH} tip is ${head.slice(0, 8)}, ahead)`),
  );

  const src = path.join(tmp, 'content');
  if (!fs.existsSync(src)) throw new Error(`upstream has no content/ on ${BRANCH}`);

  const srcN = countFiles(src);
  const dstN = fs.existsSync(DEST) ? countFiles(DEST) : 0;

  if (srcN < MIN_BODY_FILES) {
    console.error(`[pull-articles-corpus] upstream corpus has only ${srcN} files (< ${MIN_BODY_FILES}) — refusing`);
    process.exit(1);
  }
  // A shrink is the dangerous direction: this content feeds the site's own
  // article lists, so losing entries here un-lists live articles. Nothing is
  // written on either reading — the only question is which alarm to raise.
  //
  // Since the pin (#5298) this branch has a BENIGN cause it never had before,
  // and it is the normal state rather than an edge case: the checkout is at the
  // commit the API was BUILT from, which is by construction at or behind the
  // corpus tip. Measured on the first real run of this code — the mirror at
  // b8669256 with 15090 files, the published API still at c6897c28 with 15088.
  // Nothing was truncated; the sitemaps simply have not caught up with a corpus
  // this repo already committed. Refusing there would have put the sync in the
  // red for hours over a condition the next publish clears on its own.
  //
  // The dangerous reading is not dismissed, it is REROUTED. An upstream that
  // genuinely lost articles at this commit cannot resolve itself, so it skips
  // again and again and the workflow's escalation opens an issue on the third.
  // What changes is the alarm's shape and latency, never whether a shrunken
  // corpus can reach packages/articles/content/ — it cannot, on either path.
  if (dstN > 0 && srcN < dstN) {
    skipSync(
      `the published API is built from ${TARGET.slice(0, 8)}, whose corpus carries ${srcN} files, ` +
      `while packages/articles/content/ already holds ${dstN}. Either the API has not caught up ` +
      'with the corpus committed here, or upstream truncated at that commit — neither is ' +
      'something to mirror. If this keeps repeating it is the second one.',
    );
  }

  const delta = srcN - dstN;
  console.log(`[pull-articles-corpus] upstream ${srcN} files, local ${dstN} (${delta >= 0 ? '+' : ''}${delta})`);

  // ── Registry gate: no article leaves the site unless a human said so ────────
  //
  // The file counts above net out — that is how three live articles were
  // deleted on 2026-08-07 without either floor firing. Compare the registries
  // by article id instead, and let a removal through only when the site's
  // retirement ledger (legacyRedirectsPlugin's `redirects` table) already
  // carries a bridge for its canonical URL. Rationale and incident:
  // scripts/lib/corpus-removal-guard.mjs.
  //
  // Both sides resolve by BASENAME onto the tree that is actually about to be
  // overwritten. `slugDataFile` names the `services/` symlink, which resolves to
  // the same bytes — but DEST is the directory mirrorTree writes, so reading it
  // directly keeps the comparison about the thing being changed.
  const local = readRegistries((f) => path.join(DEST, path.basename(f)));
  const incoming = readRegistries((f) => path.join(src, path.basename(f)));

  let ledgerSrc = '';
  try {
    ledgerSrc = fs.readFileSync(path.join(ROOT, 'build-plugins', 'legacyRedirectsPlugin.ts'), 'utf-8');
  } catch (err) {
    // Fail CLOSED. Without the ledger every removal reads as unledgered, and
    // that is the correct reading: we cannot prove any of them was intended.
    console.error(`[pull-articles-corpus] cannot read the retirement ledger (${err.message}) — refusing`);
    process.exit(1);
  }

  const verdict = evaluateCorpusRemoval({
    local,
    incoming,
    retiredPaths: parseRedirectSources(ledgerSrc),
    // Same manifest read the pin came from — one fetch, one upstream state. It
    // used to be a second, independent fetch, which could disagree with the tree
    // just cloned and made the count gate answer about a different corpus than
    // the one being mirrored.
    manifestCounts:
      manifest?.counts && typeof manifest.counts === 'object' ? manifest.counts : null,
  });

  for (const section of ARTICLE_SECTION_KEYS) {
    console.log(
      `[pull-articles-corpus] ${section}: ${Object.keys(local[section]).length} → ` +
      `${Object.keys(incoming[section]).length} articles (+${verdict.additions[section]} new)`,
    );
  }
  for (const r of verdict.removals.filter((r) => r.ledgered)) {
    console.log(`[pull-articles-corpus] retired (bridged): ${r.section}/${r.id} → ${r.canonical}`);
    if (r.unbridgedLocalePaths.length) {
      console.warn(
        `[pull-articles-corpus] ⚠️  ${r.id}: ${r.unbridgedLocalePaths.length} locale URL(s) have no ` +
        `bridge and will 404 after the next shard deploy — ${r.unbridgedLocalePaths.join(' ')}`,
      );
    }
  }

  if (!verdict.ok) {
    for (const p of verdict.parseFailures) {
      console.error(
        `::error::[pull-articles-corpus] ${p.side} ${p.section} registry parsed to ${p.size} entries — ` +
        'that is a parse failure, not a corpus. The generator\'s emit shape most likely changed; ' +
        'fix scripts/lib/article-slug-registry.mjs before syncing, or this guard is blind.',
      );
    }
    for (const r of verdict.unledgered) {
      console.error(
        `::error::[pull-articles-corpus] upstream drops ${r.section}/${r.id} but nothing retired it — ` +
        `live URLs: ${r.paths.join(' ')}`,
      );
    }
    for (const s of verdict.shortfalls) {
      console.error(
        `::error::[pull-articles-corpus] ${s.section}: incoming tree has ${s.incoming} articles, ` +
        `the published manifest already serves ${s.published} — snapshot is behind, refusing`,
      );
    }
    console.error(
      '[pull-articles-corpus] nothing written. Two legitimate ways forward:\n' +
      '  (a) the article should live → restore it in the corpus repo, which OWNS it ' +
      '(nanakokyobashi-rgb/frontaliere-articles), then re-run this sync;\n' +
      '  (b) the article should go → add its four locale URLs to the `redirects` table in ' +
      'build-plugins/legacyRedirectsPlugin.ts (pattern: PR #5299), then re-run.\n' +
      'Editing the sitemaps or the registry by hand is neither: the page stays live on the ' +
      'shard and only the site forgets it.',
    );
    process.exit(1);
  }

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
  // like nothing at all. An article DELETED upstream disappears here too — safe
  // now because the registry gate above has already proved every such removal
  // was a deliberate, bridged retirement.
    // they still exist on disk.
    //
    // Every shared file is scanned, not a curated list of "the surfaces we know
    // about". A curated list is exactly what would go stale the next time the
    // generator gains a file, and the failure mode of a stale list here is a
    // silent half-restore (#5289). Cheap enough to be unconditional: the corpus
    // is ~15k small files and the ones that mention a local-only id are a
    // couple of dozen.
    const preserveIds = localOnlyIds({
      localSources: REGISTRY_FILES
        .map((f) => path.join(DEST, f))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf-8')),
      upstreamSources: REGISTRY_FILES
        .map((f) => path.join(src, f))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf-8')),
    });

    // A ledgered retirement is local-only by definition, but it must NOT be
    // preserved: the registry gate above has just approved its removal, and
    // the mirror is about to delete its body on purpose. Preserving it would
    // resurrect a registry row whose module no longer exists — forever, since
    // the id stays local-only on every subsequent sync.
    dropLedgeredRetirements(preserveIds, verdict.removals);

    const snapshots = [];
    if (preserveIds.size > 0) {
      console.log(
        `[pull-articles-corpus] ${preserveIds.size} article id(s) exist only downstream: `
        + `${[...preserveIds].join(', ')}`,
      );
      snapshots.push(...collectPreserveSnapshots({ src, dest: DEST, preserveIds }));
    }


  mirrorTree(src, DEST);
  console.log(`[pull-articles-corpus] synced ${srcN} files into packages/articles/content/`);

    // ── Put the local-only entries back ──────────────────────────────────
    //
    // Refuses rather than degrades, like everything else in this script: an id
    // that was in a file before the mirror and is not in it afterwards means a
    // surface this could not merge. Reporting that as an error is the point —
    // a partial restore looks like success and is discovered days later from a
    // 404 or a red gate on somebody else's PR.
    const unmerged = [];
    for (const snap of snapshots) {
      const abs = path.join(DEST, snap.rel);
      const upstreamText = fs.readFileSync(abs, 'utf-8');
      const { text, preserved, upstreamWins, missing } =
        mergeEntries(upstreamText, snap.text, snap.ids);

      if (preserved.length > 0) {
        fs.writeFileSync(abs, text);
        console.log(`[pull-articles-corpus] ${snap.rel}: preserved ${preserved.join(', ')}`);
      }
      // Not a warning: upstream carrying the id is the normal, correct end
      // state — the article finally made it up and we stop shadowing it.
      for (const id of upstreamWins) {
        console.log(`[pull-articles-corpus] ${snap.rel}: ${id} now comes from upstream`);
      }
      for (const id of missing) unmerged.push(`${snap.rel}: ${id}`);
    }

    if (unmerged.length > 0) {
      console.error(
        '[pull-articles-corpus] could not preserve these local-only entries — refusing:\n'
        + unmerged.map((u) => `    ${u}`).join('\n')
        + '\n  The sync ran, so the checkout is now upstream\'s copy for those files.'
        + '\n  Restore them from the previous commit and teach'
        + ' scripts/lib/corpus-entry-merge.mjs the shape it did not recognise.',
      );
      process.exit(1);
    }

  // Hand the pin to pull-articles-api.mjs. Published only now, on the success
  // path, so the value in the environment always names a commit the registry on
  // disk actually came from — a pin published before the mirror could outlive a
  // refusal and vouch for a tree that was never written.
  publishPin(TARGET, { tag: 'pull-articles-corpus' });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
