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
 *   node scripts/pull-articles-api.mjs            # write public/
 *   node scripts/pull-articles-api.mjs --check    # verify only, write nothing
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

async function get(name) {
  const url = `${API_BASE}/${name}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body = await res.text();
  if (body.length === 0) throw new Error(`${url} → empty body`);
  return body;
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

if (CHECK_ONLY) {
  log('--check: validated, wrote nothing');
  process.exit(0);
}

for (const [dest, body] of staged) {
  fs.writeFileSync(dest, body);
  log(`wrote ${path.relative(ROOT, dest)}`);
}
log(`done — ${staged.size} artifact(s) from ${API_BASE}`);
