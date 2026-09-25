#!/usr/bin/env node
/**
 * validate-article-append-integrity — final integrity gate for the SVIZZERA
 * article generator's append-only files, run AFTER conflict resolution / rebase
 * and BEFORE the commit is pushed to main.
 *
 * Why this exists
 * ---------------
 * Two concurrent `generate-article` runs append at the same insertion point;
 * git marks a conflict and `resolve-append-conflicts.sh` keeps BOTH sides. When
 * the conflict boundary falls mid-entry the two articles fuse into one object
 * (duplicate keys / missing separator) — that path is already caught by the
 * per-file esbuild guard in the resolver. But two OTHER corruption shapes stay
 * syntactically valid and slip past a pure parse check, yet still red main:
 *
 *   1. Duplicate SVIZZERA localized slug — two separate, valid SWISS_SLUGS
 *      entries whose en/de/fr/it slug collides (the same news regenerated twice
 *      translates to the same slug). `REVERSE_SWISS` is last-wins, so the
 *      round-trip breaks → tests/blog/svizzera-section-routing goes red. esbuild
 *      sees nothing wrong: the object KEYS (article ids) stay unique; only the
 *      string VALUES collide.
 *   2. Merged sitemap <url> block — the same keep-both merge applied to a
 *      url-sitemap yields one <url> with two <loc> + two hreflang sets, so
 *      hreflang count != <url> count → tests/seo-completeness goes red. The XML
 *      stays well-formed, so a parser wouldn't flag it.
 *
 * Both shapes broke main on 2026-06-24 (PR #2832). This validator asserts the
 * invariants those tests encode — cheaply, without a vitest run — so the
 * resolver can abort the push before a corrupted tree reaches main.
 *
 * Scope notes (deliberately narrow to stay false-positive-free on a clean main):
 *  - Both SWISS_SLUGS (routerSwissData.ts) and BLOG_SLUGS/FRONTALIERE
 *    (routerBlogData.ts) are slug-uniqueness-checked (see follow-up #2837).
 *    BLOG_SLUGS used to carry ~36 tolerated pre-existing duplicate localized
 *    slugs (last-write-wins on REVERSE_BLOG, same round-trip break as SWISS);
 *    those were deduplicated in #3012, so this check is now false-positive-free
 *    on a clean main and can guard the FRONTALIERE map going forward too.
 *  - The merged-entry / duplicate-id .ts shape is already covered by the
 *    per-file esbuild guard in resolve-append-conflicts.sh; not duplicated here.
 *  - The sitemap index (sitemap.xml — <sitemap> blocks, zero <url>) is skipped;
 *    only url-sitemaps (those that actually contain <url>) are balance-checked.
 *    Verified 1:1 <loc>-per-<url> (both aggregate AND per-block) on all 6
 *    non-news url-sitemaps in public/ (sitemap-blog-ch, sitemap-blog,
 *    sitemap-glossario, sitemap-guides, sitemap-jobs, sitemap-pages) in
 *    addition to sitemap-news.xml — see #2837. The per-block check below
 *    (not just the aggregate count) is what actually enforces the invariant,
 *    so a corrupted block can't hide behind a compensating miss elsewhere.
 *
 * Exit 0 = all invariants hold. Exit 1 = at least one violation (caller MUST
 * abort the push). Pure Node built-ins; no dependencies, no network.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const violations = [];
const fail = (msg) => violations.push(msg);

function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ── 1. Duplicate localized slug in SWISS_SLUGS / BLOG_SLUGS ─────────────────
// Shape (both files): `'id': { it: '…', en: '…', de: '…', fr: '…' }`. Each file
// holds only the literal map (+ a derived REVERSE_* with no `<loc>: '…'`-style
// literals), so locale-keyed string literals belong solely to the map — a
// plain regex scan of the whole file is safe without needing to fence the
// map's start/end.
function checkSlugUniqueness(rel, reverseMapName) {
  const src = read(rel);
  if (src === null) return;
  const entryRx = /(^|\n)\s*'([^']+)'\s*:\s*\{([^}]*)\}/g;
  const perLocale = { it: new Map(), en: new Map(), de: new Map(), fr: new Map() };
  for (const m of src.matchAll(entryRx)) {
    const id = m[2];
    const body = m[3];
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const sm = body.match(new RegExp(`\\b${loc}:\\s*'([^']+)'`));
      if (!sm) continue;
      const slug = sm[1];
      const seen = perLocale[loc].get(slug);
      if (seen && seen !== id) {
        fail(
          `${rel}: duplicate ${loc.toUpperCase()} slug "${slug}" maps to both ` +
            `"${seen}" and "${id}" — ${reverseMapName} collides (round-trip breaks). ` +
            `Almost always a duplicate article: drop one of the two.`,
        );
      } else {
        perLocale[loc].set(slug, id);
      }
    }
  }
}

function checkSwissSlugUniqueness() {
  checkSlugUniqueness('services/routerSwissData.ts', 'REVERSE_SWISS');
}

function checkBlogSlugUniqueness() {
  checkSlugUniqueness('services/routerBlogData.ts', 'REVERSE_BLOG');
}

// ── 2. url-sitemap <url>/<loc>/<image:image> balance ─────────────────────────
// A merged <url> block carries two <loc> (and an unbalanced <image:image>) —
// well-formed XML, but these counts catch it. Skip index sitemaps (no <url>).
//
// Two layers, deliberately both kept:
//  - Aggregate counts (cheap, catches most shapes, gives a single clear count).
//  - Per-block <loc> count (below): the aggregate alone has a blind spot — if
//    one merge fuses two <loc> into a single <url> block while another block
//    elsewhere is missing its <loc> entirely, the totals can still coincide
//    and the aggregate check passes despite real corruption. The per-block
//    scan asserts the invariant directly (exactly one <loc> per <url> block)
//    so that blind spot can't hide a violation. Verified 1:1 on every <url>
//    block, aggregate AND per-block, across all 7 sitemap-*.xml url-sitemaps
//    on a clean main (sitemap-news.xml + the 6 others) — see #2837.
function checkSitemapBalance(rel) {
  const xml = read(rel);
  if (xml === null) return;
  const count = (re) => (xml.match(re) || []).length;
  const urlOpen = count(/<url>/g);
  if (urlOpen === 0) return; // sitemap index (<sitemap> blocks) — not a url-sitemap
  const urlClose = count(/<\/url>/g);
  const loc = count(/<loc>/g);
  const imgOpen = count(/<image:image>/g);
  const imgClose = count(/<\/image:image>/g);
  if (urlOpen !== urlClose) {
    fail(`${rel}: <url> open/close imbalance (${urlOpen} vs ${urlClose}) — malformed merge.`);
  }
  if (loc !== urlOpen) {
    fail(
      `${rel}: <loc> count (${loc}) != <url> count (${urlOpen}) — a <url> block has ` +
        `two <loc> (concurrent-append merge fused two entries).`,
    );
  }
  if (imgOpen !== imgClose) {
    fail(`${rel}: <image:image> open/close imbalance (${imgOpen} vs ${imgClose}) — malformed merge.`);
  }

  // Per-block check: guards against the aggregate blind spot described above.
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (let i = 0; i < blocks.length; i++) {
    const blockLoc = (blocks[i].match(/<loc>/g) || []).length;
    if (blockLoc !== 1) {
      fail(
        `${rel}: <url> block #${i + 1} has ${blockLoc} <loc> entries (expected exactly 1) — ` +
          `concurrent-append merge fused entries into one block.`,
      );
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
checkSwissSlugUniqueness();
checkBlogSlugUniqueness();

const publicDir = join(ROOT, 'public');
if (existsSync(publicDir)) {
  for (const f of readdirSync(publicDir)) {
    if (f.startsWith('sitemap') && f.endsWith('.xml')) checkSitemapBalance(`public/${f}`);
  }
}

if (violations.length) {
  console.error('❌ article-append integrity check FAILED:');
  for (const v of violations) console.error(`   • ${v}`);
  console.error(
    '\nThis usually means a concurrent generate-article append was merged badly. ' +
      'Do NOT push: drop the duplicate article / un-merge the block, then retry.',
  );
  process.exit(1);
}
console.log(
  '✅ article-append integrity: SWISS + BLOG slug-uniqueness + url-sitemap balance OK',
);
