/**
 * Pull the article data surface from the repository that owns it.
 *
 * The corpus lives in nanakokyobashi-rgb/frontaliere-articles, which republishes
 * it as plain JSON + sitemaps on every push. This site is a CONSUMER: it fetches
 * those artifacts over HTTP and writes them into public/, instead of generating
 * them from an in-tree copy of the corpus. That is what lets the two repositories
 * move independently — an article lands there and is announced to crawlers
 * without this repo rebuilding anything.
 *
 * Why HTTP JSON rather than an imported module: the previous coupling shipped the
 * registry as a Rollup-shaped ES module. Imported both statically and dynamically,
 * Rollup emitted a generated namespace export and rewrote the dynamic site to
 * `.then(m => m.blogArticlesData)`. Republished out-of-band as a standalone
 * esbuild bundle carrying only `ARTICLES`, that pick resolved to `undefined`, the
 * guard threw past the chunk-load recovery, and every article page sat on a
 * loading skeleton with nothing in the console. A JSON document has no module
 * shape to disagree about.
 *
 * Safety posture — this overwrites live SEO surface, so it refuses rather than
 * degrades. Everything is fetched and validated BEFORE anything is written, and
 * on any failure it exits non-zero having written nothing, so the committed copy
 * keeps serving.
 *
 * The alternate-count gate is not belt-and-braces: the first version of the
 * publisher derived its shape from the file served in production, which is a
 * reduced variant, and emitted sitemaps with the right url count and ZERO
 * hreflang alternates. Gating on urls alone would have accepted it and dropped
 * 15225 alternates from the index in one commit.
 *
 * Usage:
 *   node scripts/pull-articles-api.mjs                 # write public/
 *   node scripts/pull-articles-api.mjs --check         # verify only, write nothing
 *   node scripts/pull-articles-api.mjs --require-new   # treat the migration
 *       artifacts (hero-image manifest, sitemap-news candidates) as mandatory
 *       rather than not-yet-published. Set this once nanako's generator is live;
 *       see the ARTICLES_PULL_REQUIRE_NEW block below.
 */
import fs from 'node:fs';
import path from 'node:path';

const API_BASE =
  process.env.ARTICLES_API_BASE ?? 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const CHECK_ONLY = process.argv.includes('--check');

/** Sitemaps this site serves verbatim from the articles repo. */
const SITEMAPS = ['sitemap-blog.xml', 'sitemap-blog-ch.xml'];

/**
 * RSS feeds, served verbatim like the sitemaps (issue #4974 item 2). Ten files:
 * two sections x four locales, plus each section's main feed, which is a byte
 * copy of its Italian one.
 */
const FEEDS = [
  'rss.xml',
  'rss-it.xml',
  'rss-en.xml',
  'rss-de.xml',
  'rss-fr.xml',
  'rss-svizzera.xml',
  'rss-svizzera-it.xml',
  'rss-svizzera-en.xml',
  'rss-svizzera-de.xml',
  'rss-svizzera-fr.xml',
];

/** Slim homepage-ticker payload; the build plugin reads it from public/. */
const TICKER = 'news-ticker-live.json';

/** Items below which a feed is treated as broken rather than merely short. */
const MIN_FEED_ITEMS = 10;

/** Article count below which the published surface is treated as broken. */
const MIN_ARTICLES = 100;

const log = (msg) => console.log(`[pull-articles-api] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[pull-articles-api] ${msg}`);
  process.exit(1);
};

// ── Artifacts the generator migration adds (issue #4974 item 3) ──────
//
// docs/articles-generator-migration.md §3 lists two writes `create-article.mjs`
// does today that it loses when generation moves to nanako, and §5.5 says this
// script must be able to RECEIVE them before nanako starts emitting them for
// real. That ordering is the whole point, and it dictates the posture below:
// a missing artifact is NOT an error yet, because on the day this ships nanako
// publishes neither. A PRESENT-but-malformed one still refuses, exactly like
// every other pull here — "not emitted yet" and "emitted wrong" are different
// facts and only the second one is a failure.
//
// Flip `ARTICLES_PULL_REQUIRE_NEW=1` (or pass --require-new) in the same commit
// that turns nanako's publisher on: from then on, absence IS the failure, and
// silently serving a stale news sitemap is the thing being guarded against.
const IMAGE_MANIFEST = 'images-manifest.json';
const NEWS_CANDIDATES = 'sitemap-news-candidates.xml';
const NEWS_SITEMAP = 'sitemap-news.xml';
const SITEMAP_INDEX = 'sitemap.xml';

const REQUIRE_NEW =
  process.env.ARTICLES_PULL_REQUIRE_NEW === '1' || process.argv.includes('--require-new');

/**
 * Google News freshness window, in hours — the same prune
 * `scripts/cleanup-news-sitemap.mjs` runs today as a pre-generation step inside
 * `generate-article.yml`. When that workflow goes away with the generator, the
 * prune has to live wherever the file is assembled, which is here.
 *
 * Read from `data/news-sitemap-whitelist.ts`, which exports it, rather than
 * re-typing the number: main is about to hold this window in two places at once
 * (that file and this script) while nanako holds a vendored third, and a literal
 * here would be the copy nobody remembers to update. Regex rather than an import
 * because the sync workflow runs this under plain `node` — pulling in tsx just to
 * read one integer would add a runtime dependency to a job whose entire job is to
 * be boring.
 *
 * The fallback is the Google News spec value, not a guess, and it is only reachable
 * once main stops carrying the whitelist at all (post-cutover, when it is fully
 * vendored nanako-side) — hence a log rather than a refusal.
 */
const NEWS_WINDOW_HOURS = (() => {
  const spec = 48;
  const wl = path.join(ROOT, 'data', 'news-sitemap-whitelist.ts');
  try {
    const src = fs.readFileSync(wl, 'utf-8');
    const m = src.match(/NEWS_SITEMAP_WINDOW_HOURS\s*=\s*(\d+)/);
    if (m) return Number(m[1]);
    log(`data/news-sitemap-whitelist.ts has no NEWS_SITEMAP_WINDOW_HOURS — using ${spec}h`);
  } catch {
    log(`data/news-sitemap-whitelist.ts not present — using the ${spec}h Google News spec window`);
  }
  return spec;
})();

/** Matches `BLOG_IMAGE_HARD_MAX_BYTES` in scripts/create-article.mjs. */
const IMAGE_MAX_BYTES = 320 * 1024;

/**
 * Hero-image paths are the one place this script lets a REMOTE document choose a
 * filesystem destination, so the pattern is an allowlist, not a sanitiser: anchored,
 * literal `images/blog/` prefix, a conservative basename charset, `.webp` only. No
 * `..` can survive it and no absolute path can, which is the property that matters —
 * `path.join(PUBLIC_DIR, x)` with an attacker-chosen `x` is otherwise a write
 * anywhere in the checkout, and this runs in a workflow that commits its output.
 */
const IMAGE_PATH_RE = /^images\/blog\/[a-z0-9][a-z0-9._-]*\.webp$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one artifact, retrying transient failures.
 *
 * Not defensive padding: observed on 2026-07-30, when a sync landed mid-publish
 * and Pages answered `sitemap-blog-ch.xml` with a 503 while the surface was
 * being replaced. The script did the right thing — refused, wrote nothing — but
 * the run failed for a condition that resolves itself in seconds, and the next
 * scheduled run was the only recovery.
 *
 * That was three fetches. This now pulls fourteen, so the odds of clipping a
 * publish window rise with it. Only 5xx/429 and network errors are retried; a
 * 404 is a real absence and fails immediately, as it should.
 */
async function fetchArtifact(name, { binary = false } = {}) {
  const url = `${API_BASE}/${name}`;
  const attempts = 4;
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        const err = new Error(`${url} → HTTP ${res.status}`);
        if (!retryable) throw err;
        lastErr = err;
      } else if (binary) {
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > 0) return body;
        lastErr = new Error(`${url} → empty body`);
      } else {
        const body = await res.text();
        if (body.length > 0) return body;
        // An empty 200 during a publish swap is the same transient class.
        lastErr = new Error(`${url} → empty body`);
      }
    } catch (err) {
      // fetch() itself rejects on DNS/TLS/socket errors — retryable too.
      if (err instanceof Error && /HTTP (4\d\d)/.test(err.message)) throw err;
      lastErr = err;
    }

    if (i < attempts) {
      const waitMs = 1000 * 2 ** (i - 1); // 1s, 2s, 4s
      log(`${name}: ${lastErr.message} — retry ${i}/${attempts - 1} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const get = (name) => fetchArtifact(name);
const getBinary = (name) => fetchArtifact(name, { binary: true });

/**
 * Fetch an artifact nanako may not publish yet. Only a 404 counts as "absent" —
 * a 500, a timeout or a truncated body is still a real failure, since treating
 * a flaky publish as "not emitted yet" is precisely how a stale surface would
 * sail through unnoticed. Under --require-new even the 404 is fatal.
 */
async function getIfPublished(name, { binary = false } = {}) {
  try {
    return await fetchArtifact(name, { binary });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) {
      if (REQUIRE_NEW) fail(`${name} is absent but --require-new is set — refusing`);
      log(`${name}: not published yet — skipping (pass --require-new to make this fatal)`);
      return null;
    }
    fail(`${name} unavailable: ${err.message}`);
  }
}

const countUrls = (xml) => (xml.match(/<url>/g) ?? []).length;
const countAlternates = (xml) => (xml.match(/xhtml:link/g) ?? []).length;

let manifest;
try {
  manifest = JSON.parse(await get('manifest.json'));
} catch (err) {
  fail(`manifest unavailable, keeping the committed copy: ${err.message}`);
}

if (typeof manifest.counts?.articles !== 'number' || manifest.counts.articles < MIN_ARTICLES) {
  fail(`manifest reports ${manifest.counts?.articles} articles (min ${MIN_ARTICLES}) — refusing`);
}
log(`manifest: commit ${String(manifest.commit).slice(0, 8)}, ${manifest.counts.articles} articles`);

// Fetch and validate everything first, so a mid-way failure cannot leave public/
// holding a half-updated set.
const staged = new Map();
for (const name of SITEMAPS) {
  let xml;
  try {
    xml = await get(name);
  } catch (err) {
    fail(`${name} unavailable: ${err.message}`);
  }

  const urls = countUrls(xml);
  const alts = countAlternates(xml);
  if (urls === 0) fail(`${name} has no <url> entries — refusing`);
  if (alts === 0) fail(`${name} has no hreflang alternates — refusing`);

  const dest = path.join(PUBLIC_DIR, name);
  if (fs.existsSync(dest)) {
    const current = fs.readFileSync(dest, 'utf-8');
    const curUrls = countUrls(current);
    const curAlts = countAlternates(current);
    // Shrinking either dimension drops pages or alternates from the index.
    if (urls < curUrls) {
      fail(`${name} would shrink from ${curUrls} to ${urls} urls — refusing`);
    }
    if (alts < curAlts) {
      fail(
        `${name} would shrink from ${curAlts} to ${alts} hreflang alternates — refusing. ` +
          `Same url count with fewer alternates means the publisher lost the ` +
          `<xhtml:link> block; fix it there before letting this through.`,
      );
    }
    log(`${name}: ${curUrls} → ${urls} urls, ${curAlts} → ${alts} alternates`);
  } else {
    log(`${name}: ${urls} urls, ${alts} alternates (new)`);
  }
  staged.set(dest, xml);
}

// ── RSS feeds ────────────────────────────────────────────────────────
//
// Same posture as the sitemaps: validate everything before writing anything,
// and refuse rather than degrade. A feed is a subscription surface — replacing
// a good one with an empty or truncated one drops the channel for every reader
// at once, and unlike a page nobody looks at a feed to notice.
const countItems = (xml) => (xml.match(/<item>/g) ?? []).length;

for (const name of FEEDS) {
  let xml;
  try {
    xml = await get(name);
  } catch (err) {
    fail(`${name} unavailable: ${err.message}`);
  }

  const items = countItems(xml);
  if (items < MIN_FEED_ITEMS) {
    fail(`${name} has ${items} items (min ${MIN_FEED_ITEMS}) — refusing`);
  }

  const dest = path.join(PUBLIC_DIR, name);
  if (fs.existsSync(dest)) {
    const curItems = countItems(fs.readFileSync(dest, 'utf-8'));
    // The feeds are capped at 50 newest, so the count is stable in normal
    // operation; a drop means the publisher lost entries, not that the corpus
    // shrank.
    if (items < curItems) {
      fail(`${name} would shrink from ${curItems} to ${items} items — refusing`);
    }
  }
  log(`${name}: ${items} items`);
  staged.set(dest, xml);
}

// ── News-ticker payload ──────────────────────────────────────────────
//
// The homepage ticker renders from this. `newsTickerDataPlugin` reads the
// committed copy at build time, so a malformed one ships straight to the
// homepage — hence the shape check here rather than a bare write. A raw i18n
// key as a title is the specific way this fails silently: it renders as
// `blog.article.<id>.title` to a real visitor.
{
  let raw;
  try {
    raw = await get(TICKER);
  } catch (err) {
    fail(`${TICKER} unavailable: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`${TICKER} is not valid JSON: ${err.message}`);
  }

  const articles = payload?.articles;
  if (!Array.isArray(articles) || articles.length === 0) {
    fail(`${TICKER} carries no articles — refusing`);
  }
  for (const art of articles) {
    if (!art?.id) fail(`${TICKER} has an article with no id — refusing`);
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const title = art.title?.[loc];
      if (!title) fail(`${TICKER}: '${art.id}' has no ${loc} title — refusing`);
      if (title === `blog.article.${art.id}.title`) {
        fail(`${TICKER}: '${art.id}' ${loc} title is the raw i18n key — refusing`);
      }
      if (!art.slug?.[loc]) fail(`${TICKER}: '${art.id}' has no ${loc} slug — refusing`);
    }
  }
  log(`${TICKER}: ${articles.length} articles`);
  staged.set(path.join(PUBLIC_DIR, TICKER), raw);
}

// ── Hero images (docs/articles-generator-migration.md §3, §5.5) ──────
//
// `gitAddAll()` in create-article.mjs stages `public/images/blog/<id>.webp`
// next to the article it belongs to. Once generation runs in nanako, that file
// is written there and main has no copy — and unlike the sitemaps, an image is
// not a document this script can re-derive, so it has to be transferred.
//
// The manifest is a plain list, not a diff: nanako republishes the full set on
// every push and main downloads only what it is missing. That keeps the pull
// idempotent and cheap (a steady-state run fetches zero images) without either
// side tracking what the other already has.
//
// Deliberately additive: an id that disappears from the manifest does NOT
// delete the local file. Article images are referenced by already-published
// sitemap and RSS entries with a 48h Google News tail, so unlinking one on the
// strength of a single manifest read trades a little disk for a broken <image:loc>
// in a surface that is already out the door. Removal, if it is ever wanted, is a
// separate deliberate job — not a side effect of a sync.
{
  const raw = await getIfPublished(IMAGE_MANIFEST);
  if (raw === null) {
    // Nothing to do — nanako has not started publishing images.
  } else {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      fail(`${IMAGE_MANIFEST} is not valid JSON: ${err.message}`);
    }

    const images = payload?.images;
    if (!Array.isArray(images)) fail(`${IMAGE_MANIFEST} has no images[] array — refusing`);
    if (images.length === 0) fail(`${IMAGE_MANIFEST} lists zero images — refusing`);

    const imagesDir = path.join(PUBLIC_DIR, 'images', 'blog');
    const seen = new Set();
    let fetched = 0;
    let present = 0;

    for (const entry of images) {
      const id = entry?.id;
      const relPath = entry?.path;
      if (typeof id !== 'string' || id === '') {
        fail(`${IMAGE_MANIFEST} has an entry with no id — refusing`);
      }
      if (typeof relPath !== 'string' || !IMAGE_PATH_RE.test(relPath)) {
        fail(
          `${IMAGE_MANIFEST}: '${id}' has path ${JSON.stringify(relPath)}, which is not an ` +
            `images/blog/<name>.webp path — refusing`,
        );
      }
      if (seen.has(relPath)) fail(`${IMAGE_MANIFEST}: ${relPath} listed twice — refusing`);
      seen.add(relPath);

      const dest = path.join(PUBLIC_DIR, relPath);
      // Belt to the regex's braces: whatever the pattern let through, the
      // resolved destination must still land inside public/images/blog.
      if (path.relative(imagesDir, dest).startsWith('..')) {
        fail(`${IMAGE_MANIFEST}: ${relPath} resolves outside public/images/blog — refusing`);
      }

      if (fs.existsSync(dest)) {
        present += 1;
        continue;
      }

      let bytes;
      try {
        bytes = await getBinary(relPath);
      } catch (err) {
        fail(`${IMAGE_MANIFEST}: '${id}' listed but ${relPath} is unavailable: ${err.message}`);
      }

      if (bytes.length > IMAGE_MAX_BYTES) {
        fail(
          `${relPath} is ${bytes.length} bytes (cap ${IMAGE_MAX_BYTES}) — refusing. ` +
            `The generator's own optimizeImageToWebp enforces the same ceiling, so this ` +
            `means the publisher shipped an unoptimised file.`,
        );
      }
      // A WebP is "RIFF" + 4 size bytes + "WEBP". Checking it here rather than
      // trusting the extension is what stops an HTML error page that came back
      // with a 200 from being committed as an article's hero image.
      const isWebp =
        bytes.length > 12 &&
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP';
      if (!isWebp) fail(`${relPath} is not a WebP file (bad RIFF/WEBP header) — refusing`);

      if (typeof entry.bytes === 'number' && entry.bytes !== bytes.length) {
        fail(
          `${relPath}: manifest says ${entry.bytes} bytes, fetched ${bytes.length} — refusing`,
        );
      }

      staged.set(dest, bytes);
      fetched += 1;
    }

    log(`${IMAGE_MANIFEST}: ${images.length} listed, ${present} already local, ${fetched} to fetch`);
  }
}

// ── Google News sitemap (docs/articles-generator-migration.md §3, §5.5) ──
//
// §3 picks option (a): nanako decides Google News eligibility ONCE, at generation
// time, from the whitelist vendored into its own tree (§5.3), and publishes the
// resulting <url> blocks as candidates. Main never re-decides eligibility — it
// merges the candidates over what it is serving and applies the mechanical 48h
// prune. Two independent eligibility codepaths is the "two producers, last writer
// wins" failure modifySitemap()'s own comment already warns about; there is
// exactly one author here, and main is a mechanism, not a second opinion.
//
// NOTE the shrink guard is deliberately NOT the one the sitemaps above use. This
// file is *supposed* to shrink — the 48h window prunes it every day, and a count
// floor would refuse every correct quiet-day run. What must never happen is losing
// an entry that is still inside its window, so that is what is asserted instead.
{
  const raw = await getIfPublished(NEWS_CANDIDATES);
  if (raw === null) {
    // Nothing to do — nanako has not started publishing candidates. The file
    // keeps being written by create-article.mjs until the generator cuts over.
  } else {
    const blocksOf = (xml) => (xml.match(/<url>[\s\S]*?<\/url>/g) ?? []);
    const locOf = (block) => block.match(/<loc>([^<]+)<\/loc>/)?.[1] ?? '';
    const publishedAtOf = (block) =>
      block.match(/<news:publication_date>([^<]+)<\/news:publication_date>/)?.[1];

    const candidates = blocksOf(raw);
    if (candidates.length === 0 && !/<urlset[^>]*>/.test(raw)) {
      fail(`${NEWS_CANDIDATES} is not a sitemap document — refusing`);
    }

    const now = Date.now();
    const inWindow = (block) => {
      const at = publishedAtOf(block);
      if (!at) return false;
      const ts = new Date(at).getTime();
      if (Number.isNaN(ts)) return false;
      const ageHours = (now - ts) / 3_600_000;
      // A future date is a clock or timezone bug at the publisher, not an
      // exceptionally fresh article; refusing it here keeps a bad timestamp
      // from pinning an entry in the sitemap forever.
      return ageHours >= 0 && ageHours <= NEWS_WINDOW_HOURS;
    };

    for (const block of candidates) {
      const loc = locOf(block);
      if (!loc) fail(`${NEWS_CANDIDATES} has a <url> with no <loc> — refusing`);
      if (!publishedAtOf(block)) {
        fail(`${NEWS_CANDIDATES}: ${loc} has no <news:publication_date> — refusing`);
      }
    }

    const dest = path.join(PUBLIC_DIR, NEWS_SITEMAP);
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : '';
    const currentBlocks = blocksOf(current);

    // Candidate wins on a shared <loc>: it carries the fresher publication date
    // and the newer hreflang set, and it is the side that owns the decision.
    const merged = new Map();
    for (const block of currentBlocks) merged.set(locOf(block), block);
    for (const block of candidates) merged.set(locOf(block), block);

    const kept = [...merged.values()].filter(inWindow);

    // The guard: anything main is serving that is still inside its window has to
    // come out the other side. A candidate document that silently dropped a live
    // entry would de-list a page from Google News with no other signal.
    const keptLocs = new Set(kept.map(locOf));
    for (const block of currentBlocks) {
      const loc = locOf(block);
      if (inWindow(block) && !keptLocs.has(loc)) {
        fail(
          `${NEWS_SITEMAP}: ${loc} is still inside the ${NEWS_WINDOW_HOURS}h window but the ` +
            `merge dropped it — refusing`,
        );
      }
    }

    const header =
      current.match(/^[\s\S]*?<urlset[^>]*>/)?.[0] ??
      raw.match(/^[\s\S]*?<urlset[^>]*>/)?.[0] ??
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml">';
    const body = kept.map((b) => `  ${b.replace(/^\s+/, '')}`).join('\n\n');
    staged.set(dest, `${header}\n\n${body}\n\n</urlset>\n`);

    const pruned = merged.size - kept.length;
    log(
      `${NEWS_SITEMAP}: ${currentBlocks.length} serving + ${candidates.length} candidate ` +
        `→ ${kept.length} entries (${pruned} outside the ${NEWS_WINDOW_HOURS}h window)`,
    );

    // §3: whoever rewrites a child sitemap bumps the index's <lastmod> for it, in
    // the same commit. That used to be updateSitemapIndexLastmod() inside the
    // generator; with the generator gone, this is the same actor doing the same
    // write, so no new coupling is introduced.
    const indexPath = path.join(PUBLIC_DIR, SITEMAP_INDEX);
    if (fs.existsSync(indexPath)) {
      const src = fs.readFileSync(indexPath, 'utf-8');
      const today = new Date().toISOString().slice(0, 10);
      const rx =
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-news\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/;
      if (rx.test(src)) {
        const next = src.replace(rx, `$1${today}$2`);
        if (next !== src) {
          staged.set(indexPath, next);
          log(`${SITEMAP_INDEX}: bumped sitemap-news.xml lastmod to ${today}`);
        }
      } else {
        fail(`${SITEMAP_INDEX} has no sitemap-news.xml <lastmod> to bump — refusing`);
      }
    }
  }
}

if (CHECK_ONLY) {
  log('--check: validated, wrote nothing');
  process.exit(0);
}

for (const [dest, body] of staged) {
  // public/images/blog/ is the one destination that may legitimately not exist
  // yet on a fresh checkout; everything else writes next to a committed file.
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  log(`wrote ${path.relative(ROOT, dest)}`);
}
log(`done — ${staged.size} artifact(s) from ${API_BASE}`);
