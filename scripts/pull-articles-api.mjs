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

if (CHECK_ONLY) {
  log('--check: validated, wrote nothing');
  process.exit(0);
}

for (const [dest, body] of staged) {
  fs.writeFileSync(dest, body);
  log(`wrote ${path.relative(ROOT, dest)}`);
}
log(`done — ${staged.size} artifact(s) from ${API_BASE}`);
