#!/usr/bin/env node
/**
 * manage-article.mjs — Remove or list blog articles with SEO-safe cleanup.
 *
 * Usage:
 *   node scripts/manage-article.mjs list                          # List all articles
 *   node scripts/manage-article.mjs remove <article-id>           # Remove article
 *   node scripts/manage-article.mjs remove <article-id> --redirect-to <other-id>  # Remove + redirect
 *   node scripts/manage-article.mjs remove <article-id> --force   # Skip confirmation
 *
 * What "remove" does:
 *   1. Removes article from BlogArticleId type union in router.ts
 *   2. Removes from ALL_BLOG_ARTICLE_IDS array in router.ts
 *   3. Removes slug entry from BLOG_SLUGS in routerBlogData.ts
 *   4. Removes the registry entry (id/category/date/...) from BOTH section
 *      registries (data/blog-articles-data.ts, data/swiss-articles-data.ts —
 *      see ARTICLE_SECTION_CORE; an id lives in exactly one, both are checked)
 *   5. Removes all i18n keys (title, excerpt, imageAlt, ...) from
 *      blog-meta-{locale}.ts / blog-meta-ch-{locale}.ts, all 4 locales
 *   6. Deletes the per-article body file from blog-body/ / blog-body-ch/,
 *      all 4 locales
 *   7. Removes the SEO metadata entry ('blog-<id>': {...}) from every
 *      services/seo/seo-blog*.ts lazy-loaded chunk (discovered dynamically —
 *      see removeFromSeoService)
 *   8. Removes <url> block from sitemap-blog.xml
 *   9. Deletes generated image from public/images/blog/ (if exists)
 *  10. Verifies NO target file still references the removed id — exits 1
 *      loudly (verifyRemovalClean) instead of silently leaving an orphan
 *  11. If --redirect-to specified, adds a redirect mapping for SEO
 *  12. Stages all changes with git add
 *
 * History: steps 4 and 7 used to target components/community/BlogArticles.tsx
 * (an inline ARTICLES array) and services/seoService.ts's SEO_METADATA object
 * respectively. FRO-328 extracted the inline array to data/blog-articles-data.ts
 * (BlogArticles.tsx now just re-exports it) and blog SEO metadata was later
 * code-split into services/seo/seo-blog{,-2..7,-ch}.ts lazy chunks — both
 * regexes kept matching the OLD, now-stale files, so they silently matched
 * ZERO entries on every run regardless of the id being removed. Steps 5-6
 * (i18n + body) DID target the current files and worked correctly, which is
 * why past removals left an orphan registry+SEO entry behind while i18n/body
 * were cleanly gone — the exact shape of the /articoli-frontaliere/ list
 * rendering raw `blog.article.<id>.title` keys for a "removed" article whose
 * registry entry was never actually removed. Step 10 is the general fix:
 * whatever future refactor moves a target file again, the tool now refuses
 * to report success while any reference to the id remains, instead of
 * silently no-op'ing that one step.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ARTICLE_SECTION_CORE_LIST } from '../build-plugins/shared/articleSectionCore.mjs';
import { resolveGitAddPath, resolveGitAddPaths } from './lib/resolve-git-add-path.mjs';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function resolve(rel) { return `${PROJECT_ROOT}/${rel}`; }
function read(rel) { return readFileSync(resolve(rel), 'utf-8'); }
function write(rel, content) { writeFileSync(resolve(rel), content, 'utf-8'); }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Scans a TS string literal starting at src[startIdx] (must be a quote
// char), honoring backslash escapes so a value containing an escaped
// same-type quote (`\'`) or an embedded, UNESCAPED other-type quote
// (`'"Ore gratis la sera": ...'` — a real blog-meta-it.ts title) is captured
// in full instead of truncating at the first quote character found. Returns
// { value, endIdx } (endIdx = index right after the closing quote, for
// callers that need to know WHERE a value ends, not just its content) or
// null if unterminated / startIdx isn't a quote.
function scanQuotedValue(src, startIdx) {
  const quote = src[startIdx];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  for (let i = startIdx + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += src[i + 1] ?? ''; i++; continue; }
    if (ch === quote) return { value: out, endIdx: i + 1 };
    out += ch;
  }
  return null;
}

// Extracts a TS string-literal value from `src` starting at `startIdx`
// (index of the opening quote). See scanQuotedValue for the escaping rules.
// Returns null if unterminated or startIdx isn't a quote.
function extractQuotedValue(src, startIdx) {
  return scanQuotedValue(src, startIdx)?.value ?? null;
}

// Finds `'<keyLiteral>': '<value>'` (or double-quoted value) in `src` and
// returns the value via extractQuotedValue, or null if the key isn't present.
function findKeyValue(src, keyLiteral) {
  const keyRe = new RegExp(`['"]${escapeRegex(keyLiteral)}['"]:\\s*(['"])`);
  const m = keyRe.exec(src);
  if (!m) return null;
  return extractQuotedValue(src, m.index + m[0].length - 1);
}

// Blog SEO metadata lazy-loaded chunks (services/seoService.ts's
// loadBlogSeoChunk()): 'seo-blog.ts' plus numbered/ch shards. Discovered
// dynamically (not hardcoded as a fixed list) so a future new shard
// (seo-blog-8.ts, ...) is picked up automatically — the same class of
// drift that made removeFromSeoService a silent no-op here otherwise.
function listBlogSeoShardFiles() {
  const dir = resolve('services/seo');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^seo-blog(-\d+|-ch)?\.ts$/.test(f))
    .map((f) => `services/seo/${f}`);
}

// Scans `src` starting at the opening `{` at `startIdx` and returns the index
// just past its matching closing `}`, skipping over string/template literal
// contents (so a stray `{`/`}` inside a quoted title or a template literal
// like `${BASE_URL}/x` — a REAL brace pair, tracked via the '${' stack frame
// below — doesn't perturb the depth count). Returns -1 if unmatched (caller
// must treat as "could not safely remove").
function findMatchingBraceEnd(src, startIdx) {
  let depth = 0;
  const stack = [];
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { stack.pop(); continue; }
      if (ch === '$' && src[i + 1] === '{') { stack.push('${'); depth++; i++; continue; }
      continue;
    }
    if (top === '${') {
      if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); continue; }
      if (ch === '{') { depth++; continue; }
      if (ch === '}') { depth--; stack.pop(); continue; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
      continue;
    }
  }
  return -1;
}

// Removes a top-level `'KEY': { ... },` object entry from `src`, using
// brace-depth scanning (not a fixed-nesting regex) so it's correct
// regardless of how deeply the value object nests (SEO entries nest
// structuredData.image.{...}, author.{...}, etc. — a fixed-depth regex like
// the old `[^}]*(?:\{[^}]*\}[^}]*)*` silently stops matching as soon as a
// consumer adds one more nesting level).
function removeTopLevelObjectEntry(src, key) {
  const keyRe = new RegExp(`(^|\\n)([ \\t]*)['"]${escapeRegex(key)}['"]:\\s*\\{`, 'm');
  const m = keyRe.exec(src);
  if (!m) return { result: src, removed: false };
  const braceStart = m.index + m[0].length - 1;
  const braceEnd = findMatchingBraceEnd(src, braceStart);
  if (braceEnd === -1) return { result: src, removed: false };
  let end = braceEnd;
  while (src[end] === ' ' || src[end] === '\t') end++;
  if (src[end] === ',') end++;
  while (src[end] === ' ' || src[end] === '\t') end++;
  if (src[end] === '\n') end++;
  const start = m.index + (m[1] ? m[1].length : 0);
  return { result: src.slice(0, start) + src.slice(end), removed: true };
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(r => rl.question(question, ans => { rl.close(); r(ans.trim()); }));
}

// ── List all articles ───────────────────────────────────────
// Was: read ONLY components/community/BlogArticles.tsx (frontaliere section)
// for both the id/category/date/image tuple AND the title lookup (against
// services/i18n.ts). Both targets are stale: BlogArticles.tsx is now just
// `export { ARTICLES } from '@/data/blog-articles-data'` (FRO-328), so the
// articleRegex below always matched zero entries — `list` unconditionally
// printed "Nessun articolo trovato" — and services/i18n.ts never held static
// per-article title strings (titles live in blog-meta-it.ts, loaded at
// runtime). Fixed to read each section's real registryFile
// (ARTICLE_SECTION_CORE_LIST) and its own IT meta file for titles.
function listArticles() {
  const articleRegex = /\{\s*id:\s*["']([^"']+)["'],\s*category:\s*["']([^"']+)["'],\s*date:\s*["']([^"']+)["'],\s*image:\s*["']([^"']+)["']/g;
  const articles = [];
  for (const { section, registryFile, metaPrefix } of ARTICLE_SECTION_CORE_LIST) {
    if (!existsSync(resolve(registryFile))) continue;
    const src = read(registryFile);
    const metaFile = `services/locales/${metaPrefix}-it.ts`;
    const metaSrc = existsSync(resolve(metaFile)) ? read(metaFile) : '';
    articleRegex.lastIndex = 0;
    let m;
    while ((m = articleRegex.exec(src)) !== null) {
      const [, id, category, date, image] = m;
      const title = findKeyValue(metaSrc, `blog.article.${id}.title`) ?? '(title not found)';
      articles.push({ id, category, date, image, title, section });
    }
  }

  if (articles.length === 0) {
    console.error('❌ Nessun articolo trovato.');
    return;
  }

  console.error(`\n📚 ${articles.length} articoli trovati:\n`);
  console.error('─'.repeat(100));
  console.error(` ${'#'.padEnd(3)} ${'ID'.padEnd(45)} ${'Sezione'.padEnd(12)} ${'Data'.padEnd(12)} Titolo`);
  console.error('─'.repeat(100));
  articles.forEach((a, i) => {
    console.error(` ${String(i + 1).padEnd(3)} ${a.id.padEnd(45)} ${a.section.padEnd(12)} ${a.date.padEnd(12)} ${a.title.slice(0, 55)}`);
  });
  console.error('─'.repeat(100));
  const orphans = articles.filter((a) => a.title === '(title not found)');
  if (orphans.length > 0) {
    console.error(`\n⚠️  ${orphans.length} articolo/i in registry SENZA titolo IT (orfani, vedi node scripts/ci/check-orphan-article-meta.mjs): ${orphans.map(a => a.id).join(', ')}`);
  }
}

// ── Remove article from router.ts + routerBlogData.ts ───────
function removeFromRouter(articleId) {
  const escaped = escapeRegex(articleId);

  // 1. Remove from BlogArticleId type union in router.ts: | 'article-id'
  let routerSrc = read('services/router.ts');
  routerSrc = routerSrc.replace(new RegExp(`\\s*\\|\\s*'${escaped}'`, 'g'), '');
  write('services/router.ts', routerSrc);

  // 2-5. Remove from routerBlogData.ts (ALL_BLOG_ARTICLE_IDS, BLOG_SLUGS)
  let blogSrc = read('services/routerBlogData.ts');

  // 2. Remove from ALL_BLOG_ARTICLE_IDS array: 'article-id',
  blogSrc = blogSrc.replace(new RegExp(`\\s*'${escaped}',?\\n?`, 'g'), (match) => {
    return '';
  });
  blogSrc = blogSrc.replace(/,(\s*\])/g, '$1');

  // 3. Remove slug interface entry: articleId: string;
  const slugKey = articleId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  blogSrc = blogSrc.replace(new RegExp(`\\s*${escapeRegex(slugKey)}:\\s*string;?\\n?`, 'g'), '');

  // 4. Remove from locale slug tables: slugKey: 'slug-value' (quote-agnostic value)
  blogSrc = blogSrc.replace(new RegExp(`\\s*${escapeRegex(slugKey)}:\\s*["'][^"']*["'],?\\n?`, 'g'), '');

  // 5. Remove from BLOG_SLUGS mapping: 'article-id': { ... } (quote-agnostic key)
  blogSrc = blogSrc.replace(new RegExp(`\\s*["']${escaped}["']:\\s*\\{[^}]+\\},?\\n?`, 'g'), '');

  write('services/routerBlogData.ts', blogSrc);
  console.error('  ✅ router.ts + routerBlogData.ts aggiornati');
}

// ── Remove article from BlogArticles.tsx ────────────────────
// Was: regexed components/community/BlogArticles.tsx for an inline object
// literal `{ id: 'xxx', ... },`. FRO-328 extracted that array out to
// data/blog-articles-data.ts (BlogArticles.tsx now just
// `export { ARTICLES } from '@/data/blog-articles-data'`) — this always
// matched zero entries, a guaranteed silent no-op regardless of the id
// removed. THIS is the confirmed root cause of the orphan registry entries
// behind the /articoli-frontaliere/ list rendering raw `blog.article.<id>.title`
// keys: i18n + body were correctly deleted by removeI18nKeys, but the
// registry entry survived every "remove" that ran before this fix. Fixed to
// target the current registryFile from ARTICLE_SECTION_CORE_LIST, checking
// BOTH sections (an id lives in exactly one, but checking only frontaliere
// would silently no-op a svizzera-section removal the same way).
function removeFromBlogArticles(articleId) {
  const escaped = escapeRegex(articleId);
  const blockRegex = new RegExp(`\\s*\\{[^}]*id:\\s*'${escaped}'[^}]*\\},?`, 's');
  let removedFromAny = false;
  for (const { registryFile } of ARTICLE_SECTION_CORE_LIST) {
    if (!existsSync(resolve(registryFile))) continue;
    let src = read(registryFile);
    if (!blockRegex.test(src)) continue;
    src = src.replace(blockRegex, '');
    write(registryFile, src);
    console.error(`  ✅ ${registryFile} aggiornato`);
    removedFromAny = true;
  }
  if (!removedFromAny) {
    console.error(`  ⚠️  ATTENZIONE: nessuna voce registry trovata per '${articleId}' in ${ARTICLE_SECTION_CORE_LIST.map(s => s.registryFile).join(', ')}`);
  }
}

// Removes EVERY `'blog.article.<id>.<suffix>': '<value>',` entry for
// `articleId` from `src` (title, excerpt, imageAlt, and any future suffix —
// not a fixed list). Value-quote-safe via scanQuotedValue: the regex it
// replaces (`'blog\\.article\\.${id}\\.[^']*':\\s*'[^']*',?\\n?`) captured
// the value with `[^']*`, which excludes ALL `'` chars — escaped or not —
// from the match. A title/excerpt/imageAlt with an embedded escaped
// apostrophe (e.g. "l'iniziativa", "dell'A9" — both real values in this
// corpus, see services/locales/blog-meta-it.ts) stopped that capture at the
// escaped quote, so `.replace()` matched only the entry's opening fragment
// and left a dangling, syntactically-broken tail like `iniziativa',` behind
// instead of deleting the whole line — corrupting the meta file on removal
// of ANY article whose title/excerpt/imageAlt has an apostrophe.
function removeI18nKeyEntries(src, articleId) {
  const escaped = escapeRegex(articleId);
  const keyStartRe = new RegExp(`\\s*['"]blog\\.article\\.${escaped}\\.[A-Za-z]+['"]:\\s*['"]`);
  let out = src;
  let m;
  while ((m = keyStartRe.exec(out)) !== null) {
    const quoteIdx = m.index + m[0].length - 1;
    const scanned = scanQuotedValue(out, quoteIdx);
    if (!scanned) break; // unterminated value — bail rather than risk corrupting further
    let sliceEnd = scanned.endIdx;
    if (out[sliceEnd] === ',') sliceEnd += 1;
    if (out[sliceEnd] === '\n') sliceEnd += 1;
    out = out.slice(0, m.index) + out.slice(sliceEnd);
  }
  return out;
}

// ── Remove i18n keys from a meta file + delete per-article body file ────
// Checked against BOTH the frontaliere section (blog-meta-{locale}.ts /
// blog-body/{locale}/) AND the svizzera section (blog-meta-ch-{locale}.ts /
// blog-body-ch/{locale}/) — an article id only ever lives in one, but
// checking only the former left svizzera-section removals silently
// orphaning the body file + meta keys (existsSync just skips, no error).
function removeI18nKeys(articleId, locale) {
  // 1. Remove meta keys from blog-meta-{locale}.ts / blog-meta-ch-{locale}.ts
  for (const metaFile of [
    `services/locales/blog-meta-${locale}.ts`,
    `services/locales/blog-meta-ch-${locale}.ts`,
  ]) {
    if (existsSync(resolve(metaFile))) {
      const src = removeI18nKeyEntries(read(metaFile), articleId);
      write(metaFile, src);
      console.error(`  ✅ ${metaFile} aggiornato`);
    }
  }

  // 2. Delete per-article body file from blog-body/ / blog-body-ch/
  for (const bodyFile of [
    `services/locales/blog-body/${locale}/${articleId}.ts`,
    `services/locales/blog-body-ch/${locale}/${articleId}.ts`,
  ]) {
    if (existsSync(resolve(bodyFile))) {
      unlinkSync(resolve(bodyFile));
      console.error(`  🗑️  ${bodyFile} eliminato`);
    }
  }
}

// ── Remove SEO metadata from seoService.ts ──────────────────
// Was: regexed services/seoService.ts's SEO_METADATA object (one-level-nesting
// regex `[^}]*(?:\{[^}]*\}[^}]*)*`), plus a "breadcrumb entry" step matching
// `'blog-<id>': '<string>'`. Blog SEO metadata was code-split OUT of
// SEO_METADATA into lazy-loaded services/seo/seo-blog{,-N,-ch}.ts chunks
// (loadBlogSeoChunk()) — the SEO_METADATA regex always matched zero blog
// entries. The breadcrumb step targeted a static per-article breadcrumb map
// that no longer exists either: breadcrumbs are computed dynamically by
// buildBreadcrumbs(route, locale, title) at render time — dropped, not
// ported. Fixed to target the real shard files (listBlogSeoShardFiles,
// discovered dynamically) using brace-depth scanning (removeTopLevelObjectEntry)
// instead of a fixed-nesting regex, since these entries nest arbitrarily
// (structuredData.image.{...}, structuredData.author.{...}, ...).
function removeFromSeoService(articleId) {
  const key = `blog-${articleId}`;
  let removedFromAny = false;
  for (const seoFile of listBlogSeoShardFiles()) {
    const src = read(seoFile);
    const { result, removed } = removeTopLevelObjectEntry(src, key);
    if (!removed) continue;
    write(seoFile, result);
    console.error(`  ✅ ${seoFile} aggiornato`);
    removedFromAny = true;
  }
  if (!removedFromAny) {
    console.error(`  ⚠️  ATTENZIONE: nessuna voce SEO trovata per '${key}' in services/seo/seo-blog*.ts`);
  }
}

// Section → sitemap file. Mirrors the convention already established in
// scripts/ci/check-blog-slugs-sitemap-sync.mjs (BLOG_SLUGS ↔ sitemap-blog.xml,
// SWISS_SLUGS ↔ sitemap-blog-ch.xml) — not a new invention.
const SITEMAP_FILE_BY_SECTION = { frontaliere: 'public/sitemap-blog.xml', svizzera: 'public/sitemap-blog-ch.xml' };

// Parses a `const <slugConst>: Record<string, Record<Locale,string>> = { ... }`
// slug map out of `slugDataFile` (same shape/regex as
// check-blog-slugs-sitemap-sync.mjs's parseSlugsConst — single source of the
// parsing convention would require exporting it from a shared module; kept
// local here to avoid widening that script's surface for these 2 callers).
// Returns `{ [articleId]: { it, en, de, fr } }`.
function parseSectionSlugs(slugDataFile, slugConst) {
  const src = read(slugDataFile);
  const block = src.match(new RegExp(`const ${slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
  const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
  const slugs = {};
  let m;
  while ((m = rx.exec(block)) !== null) {
    slugs[m[1]] = { it: m[2], en: m[3], de: m[4], fr: m[5] };
  }
  return slugs;
}

// Finds which section's registry contains `articleId` (an id lives in
// exactly one section). Returns the ARTICLE_SECTION_CORE entry, or undefined.
function findOwningSection(articleId) {
  return ARTICLE_SECTION_CORE_LIST.find(({ registryFile }) => {
    if (!existsSync(resolve(registryFile))) return false;
    return new RegExp(`id:\\s*['"]${escapeRegex(articleId)}['"]`).test(read(registryFile));
  });
}

// ── Remove <url> block from the article's sitemap ────────────────────────
// Was: hardcoded to public/sitemap-blog.xml (frontaliere only — a svizzera
// article's stale URL in sitemap-blog-ch.xml was never touched) and looked
// up the IT slug via a camelCase `slugKey` constant in services/router.ts —
// a per-locale slug-table shape that no longer exists (slugs live in the
// unified BLOG_SLUGS/SWISS_SLUGS maps in routerBlogData.ts/routerSwissData.ts
// today). That lookup always returned null, so `itSlug` silently fell back to
// the raw `articleId`, which only coincidentally matches the real slug.
// Fixed to resolve the section from the id (checked against both registries)
// and parse the real IT slug from the section's own slug map.
function removeFromSitemap(articleId) {
  const owningSection = findOwningSection(articleId);
  if (!owningSection) {
    console.error(`  ⚠️  ATTENZIONE: sezione non determinabile per '${articleId}' — sitemap non aggiornata`);
    return;
  }
  const slugs = parseSectionSlugs(owningSection.slugDataFile, owningSection.slugConst);
  const itSlug = slugs[articleId]?.it || articleId;
  const sitemapFile = SITEMAP_FILE_BY_SECTION[owningSection.section];
  if (!existsSync(resolve(sitemapFile))) {
    console.error(`  ⚠️  ${sitemapFile} non trovato — skip`);
    return;
  }
  let src = read(sitemapFile);
  const urlBlockRegex = new RegExp(`\\s*<url>\\s*<loc>[^<]*${escapeRegex(itSlug)}[^<]*</loc>[\\s\\S]*?</url>`, 'g');
  src = src.replace(urlBlockRegex, '');
  write(sitemapFile, src);
  console.error(`  ✅ ${sitemapFile} aggiornato`);
}

// ── Delete generated image ──────────────────────────────────
function deleteGeneratedImage(articleId) {
  const imgDir = resolve('public/images/blog');
  if (!existsSync(imgDir)) return;

  const files = readdirSync(imgDir);
  const matches = files.filter(f => f.startsWith(articleId));

  for (const file of matches) {
    const fullPath = resolve(`public/images/blog/${file}`);
    unlinkSync(fullPath);
    console.error(`  🗑️  Immagine eliminata: public/images/blog/${file}`);
  }

  if (matches.length === 0) {
    console.error('  ℹ️  Nessuna immagine generata trovata per questo articolo');
  }
}

// ── Add redirect mapping (SEO safety) ───────────────────────
function addRedirectMapping(fromId, toId) {
  const redirectsPath = 'data/article-redirects.json';
  let redirects = {};

  if (existsSync(resolve(redirectsPath))) {
    try {
      redirects = JSON.parse(read(redirectsPath));
    } catch { /* start fresh */ }
  }

  // Get the IT slugs for both articles
  const routerSrc = read('services/router.ts');
  const fromSlugKey = fromId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const toSlugKey = toId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  for (const locale of ['it', 'en', 'de', 'fr']) {
    // Find slugs in locale tables (search pattern: slugKey: 'value')
    const fromSlugMatch = routerSrc.match(new RegExp(`${escapeRegex(fromSlugKey)}:\\s*["']([^"']+)["']`));
    const toSlugMatch = routerSrc.match(new RegExp(`${escapeRegex(toSlugKey)}:\\s*["']([^"']+)["']`));

    if (fromSlugMatch && toSlugMatch) {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      redirects[`${prefix}/articoli-frontaliere/${fromSlugMatch[1]}`] = `${prefix}/articoli-frontaliere/${toSlugMatch[1]}`;
    }
  }

  write(redirectsPath, JSON.stringify(redirects, null, 2) + '\n');
  console.error(`  🔄 Redirect mapping aggiunto: ${fromId} → ${toId}`);
  console.error(`     File: ${redirectsPath}`);
}

// True if `relPath` either exists on disk (modified/added) or is a git-tracked
// path (so `git add -A -- <path>` can stage its deletion). Needed because a
// deleted body file (removeI18nKeys's unlinkSync) no longer exists on disk —
// the old existsSync-only filter below silently EXCLUDED every such deletion
// from staging, so `remove` left "deleted, not staged" body files behind on
// every run (git add on a never-tracked, nonexistent path errors and aborts
// the whole `execSync`, which is why the deletions couldn't just be
// unconditionally included either).
function pathIsTrackedOrExists(relPath) {
  if (existsSync(resolve(relPath))) return true;
  // Ask git about the REAL path. Since #4881 Fase 6 the body/meta paths under
  // services/locales/ traverse a directory symlink into packages/articles/
  // content/, and git only ever tracks the resolved path — querying the
  // symlink-traversing literal always came back empty, so every deleted body
  // file was filtered out of staging.
  const real = resolveGitAddPath(PROJECT_ROOT, relPath);
  try {
    return execSync(`git ls-files -- ${JSON.stringify(real)}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim().length > 0;
  } catch {
    return false;
  }
}

// ── Git add all modified files ──────────────────────────────
// Was: a hand-maintained list missing services/routerBlogData.ts entirely
// (removeFromRouter's BLOG_SLUGS edit was never staged — left as an unstaged
// modification after every "successful" remove), listing services/i18n.ts
// (never modified by anything in this script — dead entry) and
// services/seoService.ts / public/sitemap-blog.xml only (missing the real
// seo-blog*.ts shards, the registry files, sitemap-blog-ch.xml, and every
// per-locale body-file DELETION, since existsSync filtered those out — see
// pathIsTrackedOrExists). Rebuilt from ARTICLE_SECTION_CORE_LIST so it can't
// silently drift out of sync with the removal functions above again.
function gitAddAll(articleId) {
  const files = [
    'services/router.ts',
    'components/community/BlogArticles.tsx',
    'services/routerBlogData.ts',
    'services/routerSwissData.ts',
    ...listBlogSeoShardFiles(),
    'services/seoService.ts',
  ];
  for (const { registryFile, bodyDir, metaPrefix } of ARTICLE_SECTION_CORE_LIST) {
    files.push(registryFile);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      files.push(`services/locales/${metaPrefix}-${locale}.ts`);
      files.push(`services/locales/${bodyDir}/${locale}/${articleId}.ts`);
    }
  }
  files.push(...Object.values(SITEMAP_FILE_BY_SECTION));

  if (existsSync(resolve('data/article-redirects.json'))) {
    files.push('data/article-redirects.json');
  }

  const existing = [...new Set(files)].filter(pathIsTrackedOrExists);
  if (existing.length > 0) {
    execSync(`git add -A -- ${existing.map(f => JSON.stringify(f)).join(' ')}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    execSync(`git add ${resolveGitAddPaths(PROJECT_ROOT, existing).join(' ')}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.error('  ✅ File modificati aggiunti a git');
  }
}

// ── Post-removal verification ────────────────────────────────────────────
// Generic safety net for the "stale target file" bug class that made
// removeFromBlogArticles/removeFromSeoService/listArticles silently no-op in
// the first place (see their history comments above). Whatever a future
// refactor moves again, `remove` refuses to report success while ANY of
// these checks still finds a reference to the id — loud failure instead of
// a silent orphan. Deliberately checks BOTH BLOG_SLUGS (routerBlogData.ts)
// and SWISS_SLUGS (routerSwissData.ts) even though removeFromRouter only
// ever edits the former (it has no svizzera-section slug removal at all,
// see its docstring note) — a svizzera-section removal is EXPECTED to fail
// this check today, surfacing that known gap loudly instead of hiding it.
function verifyRemovalClean(articleId) {
  const escaped = escapeRegex(articleId);
  const problems = [];

  for (const { registryFile } of ARTICLE_SECTION_CORE_LIST) {
    if (existsSync(resolve(registryFile)) && new RegExp(`id:\\s*['"]${escaped}['"]`).test(read(registryFile))) {
      problems.push(`registry: ${registryFile} still has an entry for '${articleId}'`);
    }
  }

  for (const seoFile of listBlogSeoShardFiles()) {
    if (new RegExp(`['"]blog-${escaped}['"]:\\s*\\{`).test(read(seoFile))) {
      problems.push(`SEO: ${seoFile} still has 'blog-${articleId}'`);
    }
  }

  for (const locale of ['it', 'en', 'de', 'fr']) {
    for (const metaFile of [`services/locales/blog-meta-${locale}.ts`, `services/locales/blog-meta-ch-${locale}.ts`]) {
      if (existsSync(resolve(metaFile)) && new RegExp(`blog\\.article\\.${escaped}\\.`).test(read(metaFile))) {
        problems.push(`i18n: ${metaFile} still has blog.article.${articleId}.* keys`);
      }
    }
    for (const bodyFile of [`services/locales/blog-body/${locale}/${articleId}.ts`, `services/locales/blog-body-ch/${locale}/${articleId}.ts`]) {
      if (existsSync(resolve(bodyFile))) {
        problems.push(`body: ${bodyFile} still exists`);
      }
    }
  }

  if (new RegExp(`['"]${escaped}['"]:\\s*\\{\\s*it:`).test(read('services/routerBlogData.ts'))) {
    problems.push(`slugs: services/routerBlogData.ts BLOG_SLUGS still has '${articleId}'`);
  }
  if (new RegExp(`['"]${escaped}['"]:\\s*\\{\\s*it:`).test(read('services/routerSwissData.ts'))) {
    problems.push(`slugs: services/routerSwissData.ts SWISS_SLUGS still has '${articleId}' (removeFromRouter has no svizzera-section slug removal — known gap)`);
  }
  if (new RegExp(`['"]${escaped}['"]`).test(read('services/router.ts'))) {
    problems.push(`router.ts: still references '${articleId}' (BlogArticleId union or ALL_BLOG_ARTICLE_IDS)`);
  }

  return problems;
}

// ── Verify article exists ───────────────────────────────────
function articleExists(articleId) {
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/["']([^"']+)["']/g)?.map(s => s.slice(1, -1)) || [] : [];
  return existingIds.includes(articleId);
}

function getAllArticleIds() {
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  return idMatch ? idMatch[1].match(/["']([^"']+)["']/g)?.map(s => s.slice(1, -1)) || [] : [];
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.error(`
📰 manage-article.mjs — Gestione articoli del blog

Comandi:
  list                                    Lista tutti gli articoli
  remove <id>                             Rimuovi un articolo
  remove <id> --redirect-to <other-id>    Rimuovi con redirect SEO
  remove <id> --force                     Rimuovi senza conferma

Esempi:
  node scripts/manage-article.mjs list
  node scripts/manage-article.mjs remove telelavoro-frontalieri-via-libera-italia
  node scripts/manage-article.mjs remove old-article --redirect-to new-article
`);
    process.exit(0);
  }

  if (command === 'list') {
    listArticles();
    process.exit(0);
  }

  if (command === 'remove') {
    const articleId = args[0];
    if (!articleId) {
      console.error('❌ Specifica l\'ID dell\'articolo da rimuovere.');
      console.error('   Usa "node scripts/manage-article.mjs list" per vedere gli ID disponibili.');
      process.exit(1);
    }

    if (!articleExists(articleId)) {
      console.error(`❌ Articolo "${articleId}" non trovato.`);
      console.error('   Articoli disponibili:');
      getAllArticleIds().forEach(id => console.error(`     - ${id}`));
      process.exit(1);
    }

    const forceFlag = args.includes('--force');
    const redirectToIdx = args.indexOf('--redirect-to');
    const redirectTo = redirectToIdx !== -1 ? args[redirectToIdx + 1] : null;

    if (redirectTo && !articleExists(redirectTo)) {
      console.error(`❌ Articolo target per redirect "${redirectTo}" non trovato.`);
      process.exit(1);
    }

    // Get article title for confirmation. Was: read from services/i18n.ts,
    // which never held static per-article title strings (see listArticles()
    // history note above) — titleMatch was always null and this always fell
    // back to printing the raw id. Fixed to read the owning section's real
    // IT meta file.
    const owningSectionForTitle = findOwningSection(articleId);
    const metaItFile = owningSectionForTitle ? `services/locales/${owningSectionForTitle.metaPrefix}-it.ts` : null;
    const metaItSrc = metaItFile && existsSync(resolve(metaItFile)) ? read(metaItFile) : '';
    const title = findKeyValue(metaItSrc, `blog.article.${articleId}.title`) ?? articleId;

    if (!forceFlag) {
      console.error(`\n⚠️  Stai per rimuovere l'articolo:`);
      console.error(`   ID: ${articleId}`);
      console.error(`   Titolo: ${title}`);
      if (redirectTo) {
        console.error(`   Redirect a: ${redirectTo}`);
      }
      console.error('');
      const answer = await ask('Confermi la rimozione? (s/n): ');
      if (answer.toLowerCase() !== 's' && answer.toLowerCase() !== 'si' && answer.toLowerCase() !== 'sì' && answer.toLowerCase() !== 'y') {
        console.error('❌ Operazione annullata.');
        process.exit(0);
      }
    }

    console.error(`\n🗑️  Rimozione articolo: ${articleId}\n`);

    // If redirect requested, save mapping BEFORE removal (need slug data)
    if (redirectTo) {
      addRedirectMapping(articleId, redirectTo);
    }

    // Remove from all source files. removeFromSitemap runs BEFORE
    // removeFromBlogArticles: it resolves the owning section via
    // findOwningSection(articleId), which looks the id up in the registry —
    // that lookup must happen while the registry entry still exists.
    removeFromRouter(articleId);
    removeFromSitemap(articleId);
    removeFromBlogArticles(articleId);
    removeI18nKeys(articleId, 'it');
    removeI18nKeys(articleId, 'en');
    removeI18nKeys(articleId, 'de');
    removeI18nKeys(articleId, 'fr');
    removeFromSeoService(articleId);
    deleteGeneratedImage(articleId);

    // Git add
    console.error('\n📦 Staging file:');
    gitAddAll(articleId);

    // Post-removal verification: refuse to report success while any target
    // file still references the id (see verifyRemovalClean's docstring —
    // this is the generic safety net for the whole "stale target file" bug
    // class this fix addresses).
    const problems = verifyRemovalClean(articleId);
    if (problems.length > 0) {
      console.error(`\n❌ VERIFICA FALLITA — '${articleId}' rimane referenziato dopo la rimozione:`);
      problems.forEach(p => console.error(`   - ${p}`));
      console.error('\n   Le modifiche parziali sono state comunque stagate (vedi sopra) per ispezione manuale.');
      console.error('   NON considerare questa rimozione completa finché ogni riga sopra non è risolta.');
      process.exit(1);
    }

    console.error(`\n✅ Articolo "${articleId}" rimosso con successo!`);
    if (redirectTo) {
      console.error(`   🔄 Redirect configurato verso: ${redirectTo}`);
    }
    console.error('   Esegui "npm test && npx vite build" per verificare che tutto funzioni.');
    process.exit(0);
  }

  console.error(`❌ Comando sconosciuto: ${command}`);
  console.error('   Usa "list" o "remove <id>". Vedi --help per dettagli.');
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ Errore: ${e.message}`);
  process.exit(1);
});
