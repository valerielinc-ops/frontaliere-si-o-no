/**
 * Generate OG landing pages for blog articles.
 *
 * For every blog article in seo-blog.ts, writes a full static HTML page
 * with OG/Twitter meta, hreflang alternates, JSON-LD (NewsArticle),
 * article body text, and the SPA entry bundle so the page hydrates into
 * the React app on load.
 */

import path from 'path';
import { buildRelatedArticlesIndex } from './relatedArticlesIndex';
import type { Plugin } from 'vite';
import { getSiteShell } from './siteShell';
import { buildArticleSeoSections, cleanupArticleBodySections, articleBodySectionLabel, renderArticleDerivedSectionsHtml } from './articleSeoFallback';
import { loadSwissArticleCanonicalOverrides, resolveSwissArticleCanonicalUrl, resolveShadowedArticleWinnerSlug } from './shared/swissArticleCanonicalOverrides';
import { loadArticleReviewOverrides, resolveArticleReviewerSlug } from './shared/articleReviewOverrides';
import { stripMarkdownPlain } from './shared/stripMarkdownPlain';
import { isFaqQuestionHeading } from './shared/faqQuestionPrefixes';
import { boostDescriptionForCtr } from './shared/ctrBoostDescription';
import { ARTICLE_SECTION_DESCRIPTORS, extractBlogEntryPositions, blogKeyToArticleId } from './shared/articleSectionDescriptors';
import { ARTICLE_ROBOTS_INDEX_ENHANCED } from './shared/robotsDirective';
import { readImageIntrinsicSize } from './shared/imageIntrinsicSize';
import { decodeTsStringEscapes, repairLegacyDoubleEscapedBreaks } from './shared/tsStringEscapes';
import { computeSectionTopicAssignment } from './articleHubPagesPlugin';
import { TOPIC_CLUSTERS, TOPIC_HUB_SEGMENT, type TopicLocale } from './topicTaxonomy';

/**
 * Empty SPA mount point, mirroring build-plugins/htmlTemplate.ts `rootShell`.
 *
 * Deliberately re-stated here instead of imported: this package is being split
 * into its own repo (#4959), so its renderers must not reach back into
 * build-plugins. It is also loaded inside the post-walk worker thread, where
 * every extra edge in the import graph is a resolution risk.
 *
 * The article body is emitted as a `<main class="seo-static-content">` SIBLING of
 * this shell rather than inside `#root`. Inside `#root` React destroys it on mount,
 * so a bundle that fails to render leaves a blank page — which is exactly what
 * happened when the out-of-band registry stranded the SPA (#4959). Outside it, the
 * shard stays in the DOM and App.tsx's existing pre-paint toggle hides it once the
 * SPA owns the view, the same contract every other static SEO page already uses
 * (see /articoli-frontaliere/tutti/ in build-plugins/seoHubsPlugin.ts).
 */
function articleRootShell(hasSpaBundle: boolean): string {
  return hasSpaBundle
    ? '<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div></div>'
    : '<div id="root"></div>';
}

/**
 * Footer portal target — the OTHER half of the staticOverlay shell contract.
 *
 * `articleRootShell` above mirrors only the `#root` mount of
 * build-plugins/htmlTemplate.ts; the canonical `seoContentOutsideRoot` body
 * section there emits BOTH `#root` and, after `</main>`, a
 * `<div id="footer-root"></div>`. App.tsx (`footerPortalTarget`) portals the
 * footer into that node on every `staticOverlay` route; when the node is
 * absent the portal resolves to `null` and the footer falls back to an INLINE
 * render inside `#root` — i.e. ABOVE `main.seo-static-content`, burying the
 * whole article (and every footer internal link) under ~1500 px of chrome on
 * mobile. That is the exact failure PR #243 fixed for `/calcola-stipendio/*`
 * and that `audit:footer-root-presence` (scripts/audit-footer-root-presence.mjs,
 * zero-tolerance) guards.
 *
 * Emitting the article body as a `<main class="seo-static-content">` sibling of
 * `#root` (#4959) opted these pages INTO that contract without bringing this
 * half along, so all ~900 articles × 4 locales shipped without the portal
 * target: 3608 offenders in post-deploy validation run 30974294824, up from 23.
 *
 * Deliberately re-stated here rather than imported, for the same reason as
 * `articleRootShell`: this package must not reach back into `build-plugins`
 * (tests/packages-articles-confinement.test.ts) and it is loaded inside the
 * post-walk worker thread.
 */
const ARTICLE_FOOTER_ROOT = '<div id="footer-root"></div>';

/**
 * Hero-image size of LAST RESORT — used only when the resolved hero file
 * cannot be opened or its header cannot be parsed.
 *
 * This pair used to be the size declared on EVERY article page, on the premise
 * (stated in the comment it replaces) that "every blog hero this pipeline
 * produces is 1200x675". Measuring the files rather than sampling them shows
 * the premise held for the width and failed for the height: across
 * public/images/blog/*.webp the width is 1200 essentially everywhere, but the
 * height spans 179..2469 — so several hundred article pages declared a height
 * their file does not have, in the <img>, in og:image:height and in the JSON-LD
 * ImageObject at once. Real sizes now come from resolveHeroSize(), which reads
 * the file header; see shared/imageIntrinsicSize.ts.
 *
 * 1200px wide is not incidental: it is Google Discover's documented floor for
 * the large-image card that `max-image-preview:large` opts into.
 */
const HERO_FALLBACK_WIDTH = 1200;
const HERO_FALLBACK_HEIGHT = 675;

/**
 * Google Discover's large-image-card width floor.
 *
 * Now that the emitter declares the file's REAL width instead of asserting
 * 1200, a hero that is actually narrower stops being invisible: it used to be
 * covered by the constant, which claimed eligibility the bytes did not support.
 * `resolveHeroSize` logs each such file once — a build-time report, not a gate,
 * because the page is still better off with a real (if small) image than with
 * none, and the remedy is re-encoding the asset, not failing the deploy.
 */
export const DISCOVER_MIN_IMAGE_WIDTH = 1200;

export interface RenderedArticleEntry {
 articleId: string;
 /** Locale -> path relative to distDir for the directory `index.html` (e.g. `articoli-frontaliere/<slug>/index.html`). */
 paths: Record<string, string>;
 /** Locale -> path relative to distDir for the flat redirect-bridge sibling (e.g. `articoli-frontaliere/<slug>.html`). */
 flatPaths: Record<string, string>;
 /** Locale -> canonical absolute URL (trailing slash). */
 urls: Record<string, string>;
 /**
  * Site-relative resolved hero image path (e.g. `/images/blog/<file>.webp`),
  * same for every locale — the value `resolveImagePath` computed for this
  * article, post existence-checking + extension fallback. Exposed (#4837
  * stream A) so publish-article-fast.mjs can derive the CDN upload manifest
  * from the renderer's own resolution instead of re-deriving/guessing it.
  */
 img: string;
}

export interface RenderArticlePagesOptions {
 rootDir: string;
 distDir: string;
 section: 'frontaliere' | 'svizzera';
 /**
 * When set, render/write ONLY this article's 4 locale pages instead of the
 * whole section (near-instant single-article publish, #4837 stream A).
 * Section-wide metadata (title-collision map, category map, related-articles
 * pool, slug maps) is still parsed in FULL first — those are cheap text
 * parses over already-concatenated seo-blog*.ts/registry sources and are
 * REQUIRED for byte-identical output (disambiguation/related-links depend on
 * every other article's metadata). Only the per-article BODY file read
 * (services/locales/<bodyDir>/<locale>/*.ts, ~3021 files x 4 locales) is
 * skipped down to the single needed file — see parseBlogBodyLocale below.
 */
 onlyArticleId?: string;
 /**
 * When set, render/write ONLY these articles' locale pages instead of the
 * whole section (bounded-memory batch mode, #4881 Fase 4 corpus re-render).
 * Same section-wide metadata parse as `onlyArticleId` (full, cheap, required
 * for byte-identical disambiguation/related-links output); the per-article
 * body-file read and the write-loop are narrowed to this id set instead of a
 * single id. Ignored when `onlyArticleId` is also set (that field wins — see
 * parseBlogBodyLocale below for the merge). Superset-safe: an id in this list
 * that has no matching entry in this section is a silent no-op, never an
 * error, so callers may safely pass ids belonging to other sections.
 */
 onlyArticleIds?: string[];
}

export interface RenderArticlePagesResult {
 /** Total files physically written (post content-hash-manifest skip), this call only. */
 written: number;
 /** One entry per article actually rendered (all of them in full-section mode, exactly one when onlyArticleId is set and found). */
 entries: RenderedArticleEntry[];
}

/**
 * Render+write static OG landing page(s) for blog article(s) in one section.
 *
 * Extracted from ogPagesPlugin's closeBundle (#4837 stream A) so a standalone
 * script (scripts/publish-article-fast.mjs, via `npx tsx`) can render a
 * single freshly-published article's 4 locale pages without running the full
 * `vite build` (~25-34 min, OOM-prone). `ogPagesPlugin`'s closeBundle below is
 * now a thin wrapper calling this same function once per section with no
 * `onlyArticleId` — full-build output is unchanged (same code path).
 *
 * Do NOT fork this render logic (mirrors the precedent set by
 * relatedSearchClustersPlugin's exported `renderClusterPage`) — any fix here
 * benefits both the full build and the fast single-article path for free,
 * and a fork would silently drift the two apart.
 */
export async function renderArticlePages(opts: RenderArticlePagesOptions): Promise<RenderArticlePagesResult> {
 const rootDir = opts.rootDir;
 const fs = await import('node:fs');
 const np = await import('node:path');

 // Site-shell contract (#4881 Fase 6): every identifier below is destructured
 // under the SAME name the pre-move code imported directly, so the ~1200
 // lines of rendering logic that follow need zero further edits.
 const shell = getSiteShell();
 const {
 baseUrl: BASE_URL,
 gtagSnippet: GTAG_SNIPPET,
 adsenseSnippet: ADSENSE_SNIPPET,
 // `?? ''` perche' il campo e' opzionale nel contratto: finche' il repo
 // pubblicatore non passa il proprio snippet, qui non deve uscire `undefined`.
 partnerizeTagSnippet: PARTNERIZE_TAG_SNIPPET = '',
 offerwallFcSnippet: OFFERWALL_FC_SNIPPET,
 faviconLinks: FAVICON_LINKS,
 seoStaticCssFilename: SEO_STATIC_CSS_FILENAME,
 cdnPreconnectHint: CDN_PRECONNECT_HINT,
 asyncCssLink,
 asyncCssFallbackScript: ASYNC_CSS_FALLBACK_SCRIPT,
 WriteCollector,
 buildTitleWithBrand,
 truncateHeadline,
 titleBrandSuffix: TITLE_BRAND_SUFFIX,
 titleMaxChars: TITLE_MAX_CHARS,
 clampMetaDescription,
 repairSerpSnippet,
 truncateCodeUnits,
 stableChunkFile,
 stableChunkFiles,
 differentiateH1FromTitle,
 inlineScriptJson,
 criticalCssLink: CRITICAL_CSS_LINK,
 imageObjectLd,
 resolveSpaBundle,
 organizationLd: ORGANIZATION_LD,
 getAuthorBySlug,
 } = shell;

 const distDir = opts.distDir;
 const collector = new WriteCollector({ distDir, pluginName: 'ogPagesPlugin' });
 const DEFAULT_IMG = '/og-image.png';
 const blogImageById: Record<string, string> = {};
 // Single-article and batch narrowing collapse to the same Set<string> so
 // both the body-file read (parseBlogBodyLocale) and the write-loop filter
 // below share one code path. `onlyArticleId` wins when both are set (only
 // publish-article-fast.mjs sets it; the corpus driver sets onlyArticleIds).
 // undefined => full-section render, unchanged from pre-#4881 behaviour.
 const onlyArticleIdSet: Set<string> | undefined = opts.onlyArticleId
 ? new Set([opts.onlyArticleId])
 : (opts.onlyArticleIds && opts.onlyArticleIds.length ? new Set(opts.onlyArticleIds) : undefined);

 // Source-of-truth fallback for article images, used by resolveImagePath when
 // the SEO entry's own candidate has no file in distDir.
 //
 // This used to scrape `components/community/BlogArticles.tsx`, where the
 // `image:` literals lived when it was written. They moved to the article data
 // module years ago — `grep -c "image: '/images/" components/community/
 // BlogArticles.tsx` returns 0 — so the map has been EMPTY on every build
 // since, and the rung it feeds never fired. Repointed at the real registries.
 //
 // Several candidate paths, first hit wins, because this engine renders from
 // two different roots: the site (`data/…` + `packages/articles/content/…`)
 // and the corpus repo (`content/…`). A path that does not exist is skipped,
 // not fatal — the same tolerance the previous single-file read had.
 for (const rel of [
 'packages/articles/content/blog-articles-data.ts',
 'packages/articles/content/swiss-articles-data.ts',
 'data/blog-articles-data.ts',
 'data/swiss-articles-data.ts',
 'content/blog-articles-data.ts',
 'content/swiss-articles-data.ts',
 'components/community/BlogArticles.tsx',
 ]) {
 try {
 const src = fs.readFileSync(np.resolve(rootDir, rel), 'utf-8');
 const re = /\{\s*id:\s*'([^']+)'\s*,[\s\S]*?\bimage:\s*'([^']+)'/g;
 let m: RegExpExecArray | null;
 while ((m = re.exec(src)) !== null) {
 if (!blogImageById[m[1]]) blogImageById[m[1]] = m[2];
 }
 } catch { /* file absent from this root — try the next */ }
 }

 // ── Article-section descriptors ─────────────────────────────
 // The emit logic below runs once per section. Section #0 (frontaliere) is the
 // default and MUST stay byte-identical to the pre-section behaviour: same
 // seoFiles, hub slugs, body dir, registry, sitemap and slug-data inputs. The
 // svizzera section mirrors it against the *-ch sources. An empty svizzera
 // registry yields zero entries and is skipped (no warning, no early abort of
 // the whole plugin) — see the per-section `continue` below.
 //
 // Descriptor literal lives in shared/articleSectionDescriptors.ts (#4881
 // Fase 4): the corpus re-render driver script needs the exact same
 // seoFiles/bodyDir/registry paths to enumerate article ids for batching, and
 // a second literal copy here would drift from that one the moment either
 // changes (AGENTS.md #6). Zero behavior change — same two entries, same
 // field values. Named `articleSectionDescriptors`, not `articleSections`, to
 // avoid colliding with the pre-existing `services/articleSections.ts`
 // (a differently-shaped, already-canonical per-section config used by
 // create-article.mjs/staticPagesPlugin.ts/router — reconciling the two is a
 // separate, larger, pre-existing-duplication cleanup out of scope here; see
 // this PR's description for the sibling-pattern-check finding).
 type OgSection = (typeof ARTICLE_SECTION_DESCRIPTORS)[number];
 const SECTIONS: OgSection[] = ARTICLE_SECTION_DESCRIPTORS;

 let count = 0;
 let faqCount = 0;
 // Article PAGES (one per locale) whose structured `.faq` was present but
 // produced no FAQPage. `<articleId>:<locale>` -> reason.
 const faqRejected = new Map<string, string>();
 let totalEntries = 0;
 const writtenEntries: RenderedArticleEntry[] = [];

 for (const SECTION of SECTIONS.filter((s) => s.name === opts.section)) {

 // Issue #3010 item 1: near-duplicate articles (PR #3000 de-collided their
 // slugs, both are live now) declare a cross-URL canonical + og:url pointing
 // at the authoritative pair member instead of self, so Google consolidates
 // ranking signal without either page being removed/de-listed.
 //
 // Was `SECTION.name === 'svizzera' ? … : {}` with the path spelled out
 // here. Hardwiring it to one section is why the frontaliere duplicates the
 // generator shipped before the "argomento gia' coperto" gate (corpus PR
 // #120) — three guides on `piastrellista`, nine on `educatore` — had no way
 // to consolidate: the mechanism existed and could not be pointed at them.
 // The candidate-path list per section now comes from the descriptor
 // (shared/canonicalOverrideFiles.mjs), so a new pair is a data edit.
 const articleCanonicalOverrides = loadSwissArticleCanonicalOverrides(
 fs,
 SECTION.canonicalOverrides.map((p) => np.resolve(rootDir, p)),
 );

 // Issue #6337: articleId -> reviewerAuthorSlug map for the `reviewedBy`
 // JSON-LD signal (E-E-A-T on fiscal/legal YMYL content). Section-agnostic,
 // same map for every section — see shared/articleReviewOverrides.ts header.
 // Candidate list, not one path: `mirror-articles-engine.yml` copies this
 // engine subtree to `engine/shared/…` in the corpus repo that actually
 // renders article pages, so the second candidate is what resolves there.
 const articleReviewOverrides = loadArticleReviewOverrides(fs, [
 np.resolve(rootDir, 'packages/articles/engine/shared/article-reviewed-by.json'),
 np.resolve(rootDir, 'engine/shared/article-reviewed-by.json'),
 ]);

 // Parse article categories from blog-articles-data.ts for FAQ schema filtering
 const EVERGREEN_CATEGORIES = new Set(['fiscale', 'pratico', 'pensione']);
 const articleCategoryById: Record<string, string> = {};
 const articleUpdatedAtById: Record<string, string> = {};
 // Per-article author (E-E-A-T): was hardcoded to a single Person for every
 // article (JSON-LD + visible byline) — real values live alongside each
 // entry in SECTION.registry, resolved against data/authors.ts below.
 const articleAuthorSlugById: Record<string, string> = {};
 const articleAuthorNameById: Record<string, string> = {};
 try {
 const articleDataSrc = fs.readFileSync(np.resolve(rootDir, SECTION.registry), 'utf-8');
 const catRx = /id:\s*'([^']+)'[\s\S]*?category:\s*'([^']+)'/g;
 let cm: RegExpExecArray | null;
 while ((cm = catRx.exec(articleDataSrc)) !== null) {
 articleCategoryById[cm[1]] = cm[2];
 }
 // Parse updatedAt for dateModified support
 const uaRx = /id:\s*'([^']+)'[\s\S]*?updatedAt:\s*'([^']+)'/g;
 let um: RegExpExecArray | null;
 while ((um = uaRx.exec(articleDataSrc)) !== null) {
 articleUpdatedAtById[um[1]] = um[2];
 }
 // Parse authorSlug/authorName (E-E-A-T byline + JSON-LD author, #author-eeat)
 const asRx = /id:\s*'([^']+)'[\s\S]*?authorSlug:\s*'([^']*)'/g;
 let asm: RegExpExecArray | null;
 while ((asm = asRx.exec(articleDataSrc)) !== null) {
 articleAuthorSlugById[asm[1]] = asm[2];
 }
 const anRx = /id:\s*'([^']+)'[\s\S]*?authorName:\s*'([^']*)'/g;
 let anm: RegExpExecArray | null;
 while ((anm = anRx.exec(articleDataSrc)) !== null) {
 articleAuthorNameById[anm[1]] = anm[2];
 }
 } catch { /* non-fatal — FAQ extraction will be skipped for all articles */ }

 // Parse sitemap-blog.xml for <lastmod> dates (fallback for dateModified)
 const sitemapLastmodBySlug: Record<string, string> = {};
 try {
 const sitemapSrc = fs.readFileSync(np.resolve(rootDir, SECTION.sitemap), 'utf-8');
 const urlBlocks = [...sitemapSrc.matchAll(/<url>\s*[\s\S]*?<\/url>/g)];
 const sitemapPrefixRx = SECTION.canonicalPrefix.replace(/[/]/g, '\\/');
 for (const block of urlBlocks) {
 const locMatch = block[0].match(new RegExp(`<loc>[^<]*${sitemapPrefixRx}([^/<]+)\\/?<\\/loc>`));
 const lmMatch = block[0].match(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/);
 if (locMatch && lmMatch) {
 sitemapLastmodBySlug[locMatch[1]] = lmMatch[1];
 }
 }
 } catch { /* non-fatal */ }

 /* ── FAQ extraction for article-specific FAQPage schema ─────── */
 const stripMarkdownForFaq = stripMarkdownPlain;

 const extractArticleFaqPairs = (bodyText: string): Array<{ question: string; answer: string }> => {
 const pairs: Array<{ question: string; answer: string }> = [];
 const blocks = bodyText.split(/(?=^## )/m);
 for (const block of blocks) {
 const trimmed = block.trim();
 if (!trimmed.startsWith('## ')) continue;
 const nlIdx = trimmed.indexOf('\n');
 if (nlIdx === -1) continue;
 const heading = trimmed.slice(3, nlIdx).trim();
 const isQuestion = isFaqQuestionHeading(heading);
 if (!isQuestion) continue;
 const answerRaw = trimmed.slice(nlIdx + 1).trim();
 if (!answerRaw) continue;
 const cleanAnswer = stripMarkdownForFaq(answerRaw);
 if (!cleanAnswer) continue;
 // Surrogate-safe (truncateHeadline slices via truncateCodeUnits): this answer
 // becomes FAQPage JSON-LD acceptedAnswer.text; a raw slice can split an emoji
 // pair and leave a lone surrogate that breaks parsing. truncateHeadline also
 // cuts on a word boundary and peels the dangling clause tail — the previous
 // raw slice ended answers mid-word inside a rich result that Google renders
 // directly in the SERP.
 const truncated = truncateHeadline(cleanAnswer, 300);
 pairs.push({ question: heading, answer: truncated });
 }
 return pairs;
 };

 const resolveImagePath = (candidate: string, articleId: string): string => {
 // `norm('')` used to return '/', and '/' then passed `fileExists` because
 // np.join(distDir, '') is distDir itself — a directory that always exists.
 // So an article whose hero file was absent from distDir resolved to '/', the
 // site ROOT, and shipped `<img src="/">` + `og:image=<BASE_URL>/` + a JSON-LD
 // ImageObject pointing at the same place. All three then serve text/html,
 // not an image: the page has no valid <img> at all and drops out of Google
 // Discover eligibility, silently, with no build error. Measured live on
 // 2026-08-07: 92 pages (23 it + 69 en/de/fr), all HTTP 200.
 //
 // Two guards, because either alone still leaves a hole: an empty path is
 // never a path, and only a regular FILE is an image.
 const norm = (p: string) => (p ? (p.startsWith('/') ? p : `/${p}`).replace(/\/+/g, '/') : '');
 const fileExists = (publicPath: string) => {
 const rel = publicPath.replace(/^\/+/, '');
 if (!rel) return false;
 try {
 return fs.statSync(np.join(distDir, rel)).isFile();
 } catch {
 return false;
 }
 };
 const fromSameBase = (p: string): string | null => {
 const ext = np.extname(p);
 const base = ext ? p.slice(0, -ext.length) : p;
 for (const e of ['.jpg', '.jpeg', '.png', '.webp', '.avif']) {
 const alt = `${base}${e}`;
 if (fileExists(alt)) return alt;
 }
 return null;
 };

 const direct = norm(candidate || '');
 if (direct && fileExists(direct)) return direct;
 const altFromCandidate = direct ? fromSameBase(direct) : null;
 if (altFromCandidate) return altFromCandidate;

 const fromList = norm(blogImageById[articleId] || '');
 if (fromList && fileExists(fromList)) return fromList;
 const altFromList = fromList ? fromSameBase(fromList) : null;
 if (altFromList) return altFromList;

 return DEFAULT_IMG;
 };

 /**
  * Intrinsic size of a resolved hero, measured from the FILE, cached per path.
  *
  * The corpus shares heroes (`/images/places/lugano-view.webp` backs 11
  * articles) and a section render walks thousands of entries, so the same file
  * would otherwise be re-opened once per article.
  *
  * The fallback is only for a file we cannot open or parse. It is NOT a
  * "usually right" default: measured across the live corpus the width is 1200
  * everywhere, but the height ranges from 179 to 2469, so a fixed 675 was
  * wrong on hundreds of pages. Never widen this fallback into the common path.
  */
 const heroSizeCache = new Map<string, { width: number; height: number }>();
 const resolveHeroSize = (imgPath: string): { width: number; height: number } => {
 const cached = heroSizeCache.get(imgPath);
 if (cached) return cached;
 const measured = readImageIntrinsicSize(np.join(distDir, imgPath.replace(/^\/+/, '')));
 const size = measured ?? { width: HERO_FALLBACK_WIDTH, height: HERO_FALLBACK_HEIGHT };
 if (measured && measured.width < DISCOVER_MIN_IMAGE_WIDTH) {
 // Once per file (the cache guarantees it), so a shared hero used by
 // eleven articles does not print eleven times.
 console.warn(
 `[og-pages] hero below the Discover large-card floor: ${imgPath} is ${measured.width}px wide (< ${DISCOVER_MIN_IMAGE_WIDTH})`,
 );
 }
 heroSizeCache.set(imgPath, size);
 return size;
 };

 /* ── 1. Parse blog SEO entries from this section's seo files ─ */
 // Concatenate the section's seo files in declared order. The first file is
 // the primary chunk; subsequent files (frontaliere's seo-blog-2..10) are
 // appended verbatim with a single '\n' separator — byte-identical to the
 // legacy seo-blog.ts + seo-blog-N.ts concatenation. Missing chunks are
 // skipped. If the primary file itself is unreadable, the frontaliere section
 // keeps its historical seoService.ts fallback; other sections just skip.
 let seoSrc: string | null = null;
 for (const rel of SECTION.seoFiles) {
 let chunk: string;
 try {
 chunk = fs.readFileSync(np.resolve(rootDir, rel), 'utf-8');
 } catch {
 if (seoSrc === null) continue; // primary missing → try next / fall back
 break; // a later chunk missing → stop appending (matches old behaviour)
 }
 seoSrc = seoSrc === null ? chunk : seoSrc + '\n' + chunk;
 }
 if (seoSrc === null) {
 if (SECTION.name === 'frontaliere') {
 try {
 seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seoService.ts'), 'utf-8');
 } catch {
 console.warn('[og-pages] Could not read seo-blog.ts or seoService.ts — skipping');
 continue;
 }
 } else {
 // Section has no seo source yet (e.g. empty svizzera registry). Skip
 // quietly so the other section still emits.
 continue;
 }
 }

 interface Entry {
 key: string;
 articleId: string;
 title: string;
 desc: string;
 keywords: string;
 ogT: string;
 ogD: string;
 path: string;
 img: string;
 /**
  * Hero size MEASURED from the resolved file's own header (never read from a
  * `width=` attribute or a hand-authored structuredData literal — those are
  * exactly what drifted). Falls back to HERO_FALLBACK_* when the file cannot
  * be measured; see resolveHeroSize.
  */
 imgW: number;
 imgH: number;
 datePub: string;
 dateMod: string;
 /** Source structuredData @type (e.g. 'Event', 'BlogPosting', 'Article') */
 sdType: string;
 /** Whether the source author uses an @id reference */
 sdAuthorHasId: boolean;
 /** Raw structuredData block text for extracting Event-specific fields */
 sdBlock: string;
 /** Real per-article author slug/name from SECTION.registry (data/authors.ts key), empty when unset */
 authorSlug: string;
 authorName: string;
 }
 const entries: Entry[] = [];

 const pos = extractBlogEntryPositions(seoSrc);

 for (let i = 0; i < pos.length; i++) {
 const s = pos[i].start;
 const key = pos[i].key;
 const articleId = blogKeyToArticleId(key);
 const e = i + 1 < pos.length ? pos[i + 1].start : Math.min(s + 3000, seoSrc.length);
 const b = seoSrc.substring(s, e);

 // Match title/desc/og* allowing escaped quotes, trying single-quoted first
 // (dominant style) then double-quoted: the SEO entry sources mix both (e.g. the
 // metodologia + author entries in seo-pages.ts use `description: "…"`), and a
 // single-quote-only regex silently dropped those → empty og:title/og:description,
 // the same failure mode as #2996 transposed onto the OG emitter.
 const matchStr = (key: string, flags = ''): string => {
 const rxSingle = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, flags);
 const rxDouble = new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, flags);
 const m = b.match(rxSingle) || b.match(rxDouble);
 return m?.[1]?.replace(/\\(.)/g, (_: string, c: string) => c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c) ?? '';
 };
 const title = matchStr('title', 'm') || '';
 const desc = matchStr('description', 'm') || '';
 const keywords = matchStr('keywords', 'm') || '';
 const ogT = matchStr('ogTitle') || title;
 const ogD = matchStr('ogDescription') || desc;
 const cp = b.match(/canonicalPath:\s*'([^']+)'/)?.[1] ?? '';
 const imRaw = b.match(/\/images\/[^'"`\s,}]+/)?.[0] ?? DEFAULT_IMG;
 const im = resolveImagePath(imRaw, articleId);
 // Measured here, next to the resolution that produced the path, so the
 // size and the URL can never be computed from two different candidates.
 const imSize = resolveHeroSize(im);
 const datePub = b.match(/"datePublished":\s*"([^"]+)"/)?.[1] ?? '';
 // dateModified: prefer updatedAt from blog-articles-data.ts, then sitemap <lastmod>,
 // then the SEO metadata literal (if any). BUILD_DATE_ISO in seo-blog.ts is a variable
 // reference that the regex can't capture, so we need these external sources.
 const seoDateMod = b.match(/"dateModified":\s*"([^"]+)"/)?.[1] ?? '';
 const articleSlug = cp.replace(SECTION.canonicalPrefix, '').replace(/\/$/, '');
 // Issue #3368 item 1: a shadowed article's own slug was dropped from its
 // section's sitemap (SECTION.sitemap — sitemap-blog-ch.xml for svizzera,
 // PR #3360; sitemap-blog.xml for frontaliere), so sitemapLastmodBySlug
 // misses it — fall back to the authoritative winner's still-present
 // <lastmod> (same near-duplicate content) before the static SEO literal.
 const winnerSlug = resolveShadowedArticleWinnerSlug(articleSlug, articleCanonicalOverrides);
 const dateMod = articleUpdatedAtById[articleId]
 || sitemapLastmodBySlug[articleSlug]
 || (winnerSlug ? sitemapLastmodBySlug[winnerSlug] : '')
 || seoDateMod;

 // Extract source structuredData @type and author format
 const sdType = b.match(/"@type":\s*"([^"]+)"/)?.[1] ?? '';
 const sdAuthorHasId = /"author":\s*\{\s*"@id"/.test(b);
 // Capture the structuredData block for Event-specific fields
 const sdBlockMatch = b.match(/structuredData:\s*\{/);
 let sdBlock = '';
 if (sdBlockMatch && sdBlockMatch.index !== undefined) {
 // Find matching closing brace by counting braces
 let depth = 0;
 let started = false;
 const startIdx = sdBlockMatch.index + sdBlockMatch[0].length - 1; // position of opening {
 for (let ci = startIdx; ci < b.length; ci++) {
 if (b[ci] === '{') { depth++; started = true; }
 if (b[ci] === '}') { depth--; }
 if (started && depth === 0) {
 sdBlock = b.substring(startIdx, ci + 1);
 break;
 }
 }
 }

 if (cp.startsWith(SECTION.canonicalPrefix)) {
 const authorSlug = articleAuthorSlugById[articleId] || '';
 const authorName = articleAuthorNameById[articleId] || '';
 entries.push({ key, articleId, title, desc, keywords, ogT, ogD, path: cp, img: im, imgW: imSize.width, imgH: imSize.height, datePub, dateMod, sdType, sdAuthorHasId, sdBlock, authorSlug, authorName });
 }
 }

 // Zero entries (e.g. an empty svizzera registry) → skip this section without
 // aborting the plugin, so the other section still emits. No warning spam.
 if (!entries.length) { continue; }

 /* ── Title disambiguator (Semrush title-uniqueness gate) ──────────
  * Auto-generated articles occasionally collapse to identical <title>s
  * across different slugs (e.g. legacy "omaggio-angeli" + 2026-suffixed
  * republish, or two FR translations of the same headline). Compute a
  * (locale → baseTitle → count) map after locale meta is parsed; when a
  * baseTitle would collide, append a HUMAN-READABLE token derived from
  * the slug — year, city, or trailing meaningful word. Falls back to an
  * FNV-1a 8-char hash only when nothing extractable exists.
  *
  * Why readable > hash: Semrush counted 935 IT blog pages with `(#abcd1234)`
  * visible in <title> on the 2026-05-05 audit. Hashes pass title-uniqueness
  * but tank CTR and brand perception in SERP. The readable token (e.g.
  * "(2026)", "— Bellinzona") preserves uniqueness AND adds context.
  *
  * Source-level fix (renaming colliding articles in
  * services/locales/blog-meta-it.ts) is tracked separately — this is the
  * runtime backstop. The audit:title-no-disambig-hash ratchet still
  * monitors hash-only fallbacks so the count can only go down. */
 const KNOWN_CITY_KEYS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'lugano', name: 'Lugano' },
  { key: 'mendrisio', name: 'Mendrisio' },
  { key: 'bellinzona', name: 'Bellinzona' },
  { key: 'locarno', name: 'Locarno' },
  { key: 'chiasso', name: 'Chiasso' },
  { key: 'ticino', name: 'Ticino' },
  { key: 'milano', name: 'Milano' },
  { key: 'como', name: 'Como' },
  { key: 'varese', name: 'Varese' },
  { key: 'lombardia', name: 'Lombardia' },
 ];
 const SLUG_STOPWORDS = new Set([
  'di','da','del','della','dei','degli','delle','dal','con','per','tra','fra',
  'il','lo','la','i','gli','le','un','uno','una','in','su','ai','dai','nei','sui',
  'che','non','più','come','sono','articolo','news','update','aggiornamento',
  'frontaliere','frontalieri','svizzera','italia','svizzeri','italiani',
 ]);
 const fnvHashHex = (token: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
   h ^= token.charCodeAt(i);
   h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
 };
 const articleHashFromSlug = (slug: string, currentTitle?: string): string => {
  const cleaned = String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  if (!cleaned) return '';
  // Lowercase title used to skip tokens already present in the headline
  // (no point appending " (Bellinzona)" when the title already says it).
  const titleLower = String(currentTitle || '').toLowerCase();
  // 1. Year (4-digit, 20xx range) — strong, semantic, common in slugs.
  const yearMatch = cleaned.match(/\b(20[2-3]\d)\b/);
  if (yearMatch && !titleLower.includes(yearMatch[1])) {
   return ` (${yearMatch[1]})`;
  }
  // 2. Known city / region — also semantic and helpful in SERP.
  for (const c of KNOWN_CITY_KEYS) {
   if (cleaned.includes(c.key) && !titleLower.includes(c.key)) {
    return ` — ${c.name}`;
   }
  }
  // 3. Trailing meaningful word (>3 chars, not a stopword, not in title).
  const tokens = cleaned.split('-').filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
   const t = tokens[i];
   if (t.length < 4) continue;
   if (SLUG_STOPWORDS.has(t)) continue;
   if (titleLower.includes(t)) continue;
   return ` — ${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  }
  // 4. Last-resort FNV hash. Rare path now — flagged by
  //    audit:title-no-disambig-hash so the ratchet can drive it to zero.
  return ` (#${fnvHashHex(cleaned)})`;
 };
 const articleTitleCollisions: Record<'it' | 'en' | 'de' | 'fr', Map<string, number>> = {
  it: new Map(), en: new Map(), de: new Map(), fr: new Map(),
 };
 // Headline NEVER truncated — see build-plugins/shared/titleSuffix.ts.

 /* ── 2. Parse blog slug map from slug-data ── */
 // {slugConst}: Record<ArticleId, { it, en, de, fr }> — flat lookup
 const blogSlugs: Record<string, Record<string, string>> = {};
 try {
 const rSrc = fs.readFileSync(np.resolve(rootDir, SECTION.slugData), 'utf-8');
 // Parse the section's slug-const map ({slugConst})
 const bsBlock = rSrc.match(new RegExp(`const ${SECTION.slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
 const bsRx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
 let bm: RegExpExecArray | null;
 while ((bm = bsRx.exec(bsBlock)) !== null) {
 blogSlugs[bm[1]] = { it: bm[2], en: bm[3], de: bm[4], fr: bm[5] };
 }
 } catch { /* non-fatal — per-article slug lookup will be empty */ }

 // Blog index slug per locale (e.g. 'articoli-frontaliere') — read from the
 // site shell's narrowed SLUG_TABLES projection (#4315 originally, #4881
 // Fase 6 routed through SiteShellContract instead of importing
 // routeSlugs.data directly). `blogIndexSlugs` for the frontaliere section,
 // `swissBlogIndexSlugs` for svizzera.
 const blogIndexSlug: Record<string, string> =
 SECTION.name === 'frontaliere' ? { ...shell.blogIndexSlugs } : { ...shell.swissBlogIndexSlugs };

 // Both were chains of .replace() until 2026-08-11, which cannot decode
 // escapes: each pass re-reads the previous pass's output, and `\\` — the
 // escape that protects every other one — was resolved LAST. The source text
 // `\\t` (a JSON tab escape, correctly spelled for a single-quoted TS
 // literal) came out as `\` + a space, and for `faq` that lone backslash made
 // JSON.parse throw, dropping the article's FAQPage schema and its visible
 // accordion without a word. See shared/tsStringEscapes.ts for the full
 // measurement; the two decoders now differ ONLY in what `\n` becomes.
 const unescapeTsString = (value: string): string =>
 decodeTsStringEscapes(value, { newlineAs: ' ' });

 // Preserves \n as actual newlines (needed for body markdown structure: headings/lists/FAQ).
 const unescapeTsStringRaw = (value: string): string =>
 decodeTsStringEscapes(value, { newlineAs: '\n' });

 const parseBlogMetaLocale = (locale: 'en' | 'de' | 'fr') => {
 const out: Record<string, { title?: string; excerpt?: string; imageAlt?: string }> = {};
 const p = np.resolve(rootDir, `services/locales/${SECTION.metaPrefix}-${locale}.ts`);
 let src = '';
 try { src = fs.readFileSync(p, 'utf-8'); } catch { return out; }
 const rx = /'blog\.article\.([^']+)\.(title|excerpt|imageAlt)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
 let m: RegExpExecArray | null;
 while ((m = rx.exec(src)) !== null) {
 const articleId = m[1];
 const field = m[2] as 'title' | 'excerpt' | 'imageAlt';
 const value = unescapeTsString(m[3]);
 if (!out[articleId]) out[articleId] = {};
 out[articleId][field] = value;
 }
 return out;
 };

 const parseBlogBodyLocale = (locale: 'it' | 'en' | 'de' | 'fr') => {
 const out: Record<string, Record<string, string>> = {};
 const dir = np.resolve(rootDir, 'services', 'locales', SECTION.bodyDir, locale);
 let files: string[] = [];
 // Fast path (#4837 stream A, batched #4881 Fase 4): body filenames are
 // exactly `<articleId>.ts` (confirmed 1:1, e.g.
 // services/locales/blog-body/it/<id>.ts). When only a bounded id set is
 // being rendered there is no need to readdirSync + scan ~3021 files x 4
 // locales — stat just the needed files directly. Falls through to the full
 // directory scan (identical to pre-#4837 behaviour) whenever
 // onlyArticleIdSet is unset, so full-build output is unchanged.
 if (onlyArticleIdSet) {
 files = [];
 for (const id of onlyArticleIdSet) {
 const single = `${id}.ts`;
 try {
 fs.statSync(np.join(dir, single));
 files.push(single);
 } catch { /* id not in this section/locale — superset-safe no-op */ }
 }
 } else {
 try { files = fs.readdirSync(dir); } catch { return out; }
 }
 const rx = /'blog\.article\.([^']+)\.(body\d+|faq)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
 for (const file of files) {
 if (!file.endsWith('.ts')) continue;
 let src = '';
 try { src = fs.readFileSync(np.join(dir, file), 'utf-8'); } catch { continue; }
 let m: RegExpExecArray | null;
 while ((m = rx.exec(src)) !== null) {
 const articleId = m[1];
 const field = m[2];
 // `faq` is JSON and keeps its escapes verbatim for JSON.parse; body text
 // is markdown, where a leftover literal `\n` is legacy corpus damage that
 // renders as a visible backslash. See repairLegacyDoubleEscapedBreaks.
 const decoded = unescapeTsStringRaw(m[3]);
 const value = field === 'faq' ? decoded : repairLegacyDoubleEscapedBreaks(decoded);
 if (!out[articleId]) out[articleId] = {};
 out[articleId][field] = value;
 }
 }
 return out;
 };

 const blogMetaByLocale = {
 en: parseBlogMetaLocale('en'),
 de: parseBlogMetaLocale('de'),
 fr: parseBlogMetaLocale('fr'),
 } as const;

 // Populate the title-collision map now that locale meta is available.
 // Mirror the title formula used inside html(): localizedTitle stripped of
 // the publisher suffix, then re-joined with the canonical brand suffix.
 for (const en of entries) {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
   const localeMeta = locale === 'it' ? null : blogMetaByLocale[locale][en.articleId];
   const titleRaw = localeMeta?.title || en.ogT;
   const titlePure = titleRaw.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '');
   const baseT = buildTitleWithBrand(titlePure);
   const m = articleTitleCollisions[locale];
   m.set(baseT, (m.get(baseT) || 0) + 1);
  }
 }

 const blogBodyByLocale = {
 it: parseBlogBodyLocale('it'),
 en: parseBlogBodyLocale('en'),
 de: parseBlogBodyLocale('de'),
 fr: parseBlogBodyLocale('fr'),
 } as const;

 const normalizeDateTime = (value: string): string => {
 if (!value) return value;
 if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
 if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00+01:00`;
 if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return `${value}+01:00`;
 return value;
 };

 // Human-readable date+time for Google News (answer/9607104: "show both a clear date and time")
 const MONTH_NAMES: Record<string, string[]> = {
 it: ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'],
 en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
 de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
 fr: ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'],
 };
 // Read the calendar parts straight out of the ISO string instead of routing
 // them through `new Date(...)` accessors.
 //
 // Why (bug fixed 2026-07-28, #4837): normalizeDateTime stamps bare dates as
 // `T00:00:00+01:00` — Swiss wall clock, which is the author's intent and is
 // also exactly what `datetime="${pubIso.split('T')[0]}"` publishes. But
 // `new Date(iso).getDate()` returns the day in the RUNNING PROCESS's zone, and
 // CI builds in UTC, where 2026-02-26T00:00:00+01:00 is 23:00 on the 25th.
 // Live evidence before this fix, on /articoli-frontaliere/confronto-assicurazioni-auto/:
 //   <time datetime="2026-02-26" itemprop="datePublished">25 febbraio 2026</time>
 // — machine-readable and human-visible dates disagreed by a day on ~142
 // articles (138 stamped T00:xx+01:00, 4 date-only). Parsing the string's own
 // fields makes byline, datetime attribute and JSON-LD agree by construction
 // and makes the renderer timezone-independent.
 const ISO_PARTS_RX = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;
 const isoParts = (isoStr: string) => {
  const m = ISO_PARTS_RX.exec(isoStr || '');
  if (!m) return null;
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return { year: Number(m[1]), monthIdx, day: Number(m[3]), hh: m[4] ?? '00', mm: m[5] ?? '00' };
 };
 const formatHumanDateTime = (isoStr: string, locale: string): string => {
  const p = isoParts(isoStr);
  if (!p) return isoStr.split('T')[0];
  const month = (MONTH_NAMES[locale] || MONTH_NAMES.it)[p.monthIdx];
  return `${p.day} ${month} ${p.year}, ${p.hh}:${p.mm}`;
 };

 // Date-only formatter for visible E-E-A-T byline (squirrelscan eeat/content-dates).
 // Crawlers want a human "Pubblicato il 18 maggio 2026" near the H1.
 const formatHumanDate = (isoStr: string, locale: string): string => {
  const p = isoParts(isoStr);
  if (!p) return isoStr.split('T')[0];
  const month = (MONTH_NAMES[locale] || MONTH_NAMES.it)[p.monthIdx];
  return `${p.day} ${month} ${p.year}`;
 };
 const DATE_LABELS: Record<string, { published: string; updated: string }> = {
 it: { published: 'Pubblicato il', updated: 'Aggiornato il' },
 en: { published: 'Published on', updated: 'Updated on' },
 de: { published: 'Veröffentlicht am', updated: 'Aktualisiert am' },
 fr: { published: 'Publié le', updated: 'Mis à jour le' },
 };
 const buildDateByline = (datePubIso: string, dateModIso: string, locale: string): string => {
 const labels = DATE_LABELS[locale] || DATE_LABELS.it;
 const pubIso = normalizeDateTime(datePubIso);
 const modIso = normalizeDateTime(dateModIso);
 const pubDay = pubIso.split('T')[0];
 const modDay = modIso.split('T')[0];
 const pubHtml = `${labels.published} <time datetime="${esc(pubDay)}" itemprop="datePublished">${esc(formatHumanDate(pubIso, locale))}</time>`;
 if (modDay && modDay !== pubDay) {
 const modHtml = `${labels.updated} <time datetime="${esc(modDay)}" itemprop="dateModified">${esc(formatHumanDate(modIso, locale))}</time>`;
 return `${pubHtml} · ${modHtml}`;
 }
 return pubHtml;
 };

 /* ── 3. Write OG landing pages ──────────────────────────────── */
 const esc = (s: string) =>
 s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
 .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

 const LOC_TAG: Record<string, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };

 // Race-free SPA bundle hash extraction (SiteShellContract.resolveSpaBundle —
 // see build-plugins/spaBundleResolver.ts for the real site-side implementation).
 const spaBundle = resolveSpaBundle(distDir);
 const entryJs = spaBundle.entryJs;
 const entryCss = spaBundle.entryCss;
 // Stable-name chunk resolution, no disk I/O (shared/chunkFiles.ts — same
 // closeBundle-time race as resolveSpaBundle, #4762).
 const vendorReactChunk = stableChunkFile('vendor-react');
 const blogMetaItChunk = stableChunkFile('blog-meta-it');
 const itCriticalTags = stableChunkFiles(['it-core', 'it-calculator'])
 .map(f => `\n <link rel="modulepreload" href="/assets/${f}">`)
 .join('');
 // Tautological after the resolver throws on missing bundle. Kept so the
 // template branches that gate on it stay readable.
 const hasSpaBundle = spaBundle.hasSpaBundle;
 const corePreloads = [
 vendorReactChunk ? `<link rel="modulepreload" crossorigin href="/assets/${vendorReactChunk}">` : '',
 itCriticalTags,
 ].filter(Boolean).join('');
 const preloadTag = corePreloads ? '\n ' + corePreloads : '';

 // ── Build related articles helper for cross-linking (SEO: inter-article links) ──
 const relatedArticlesLabel: Record<string, string> = {
 it: 'Articoli correlati', en: 'Related articles', de: 'Verwandte Artikel', fr: 'Articles connexes',
 };
 // Topic-ranked related articles with an inbound-link floor
 // (packages/articles/engine/relatedArticlesIndex.ts).
 //
 // This replaces a picker that took the 3 newest same-category articles plus
 // the 2 newest overall. That pool is sorted globally by date and does not
 // vary per article, so every page emitted nearly the same five links:
 // replayed against the 3.085 published articles, 99,48% of them (3.069)
 // received ZERO inbound links from any other article, and two articles were
 // linked from all 3.084 others. `category` could not rescue it either — four
 // values, with `novita` holding 62% of the corpus.
 //
 // Built ONCE for the whole corpus rather than per page: the fairness pass and
 // the orphan repair are corpus-level properties and cannot be decided one
 // page at a time. `entries` is guaranteed full/unfiltered here even on the
 // single-article fast path (see the `onlyArticleIdSet` comment below), which
 // is exactly what this needs.
 const relatedArticlesMap = buildRelatedArticlesIndex(
 entries.map(e => ({
 articleId: e.articleId,
 title: e.ogT.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, ''),
 excerpt: e.ogD,
 datePub: e.datePub,
 category: articleCategoryById[e.articleId],
 })),
 );
 const entryById = new Map(entries.map(e => [e.articleId, e]));

 // Article → topic-hub link (issue #5003: pillar/spoke internal linking).
 // #5107 built article → article links; this closes the other half, article
 // → its own topic hub, which the corpus had zero of (`grep
 // 'argomenti/' articoli-frontaliere/**/index.html` on a published article
 // page returned nothing before this). Reuses computeSectionTopicAssignment
 // (packages/articles/engine/articleHubPagesPlugin.ts) — the exact same
 // input build topicClusterHubsPlugin.ts's hub emitter and the archive-page
 // "Argomenti" nav already use — instead of a third near-copy of it, so the
 // hub this link points to always agrees with which hub actually lists the
 // article. An article whose wording matches no topic (~20% of the corpus —
 // see topicClusters.ts's module header) gets no hub link; the
 // related-articles list still renders on its own for it.
 const topicAssignment = computeSectionTopicAssignment(fs, np, rootDir, SECTION.name);
 const topicByKey = new Map(TOPIC_CLUSTERS.map(t => [t.key, t]));
 const topicHubLinkPrefix: Record<string, string> = {
 it: 'Tutti gli articoli: ', en: 'All articles: ', de: 'Alle Artikel: ', fr: 'Tous les articles : ',
 };
 const buildTopicHubLinkHtml = (currentId: string, locale: string): string => {
 const topic = topicByKey.get(topicAssignment.topicOf.get(currentId) ?? '');
 if (!topic) return '';
 const loc: TopicLocale = (locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it';
 const indexSlug = blogIndexSlug[locale] ?? SECTION.indexSlug[loc] ?? SECTION.indexSlug.it;
 const prefix = locale === 'it' ? '' : `/${locale}`;
 const href = `${prefix}/${indexSlug}/${TOPIC_HUB_SEGMENT[loc]}/${topic.slug[loc]}/`;
 const label = `${topicHubLinkPrefix[loc] ?? topicHubLinkPrefix.it}${topic.label[loc]}`;
 return `<li class="s-65FRzB"><a class="s-ty-PxH" href="${esc(href)}">${esc(label)}</a></li>`;
 };

 const buildRelatedArticlesHtml = (currentId: string, _currentCategory: string, locale: string): string => {
 const picks = (relatedArticlesMap.get(currentId) ?? [])
 .map(id => entryById.get(id))
 .filter((e): e is typeof entries[number] => Boolean(e));
 const hubItem = buildTopicHubLinkHtml(currentId, locale);
 if (picks.length === 0 && !hubItem) return '';
 const items = hubItem + picks.map(art => {
 const slug = blogSlugs[art.articleId]?.[locale] ?? art.articleId;
 const indexSlug = blogIndexSlug[locale] ?? SECTION.indexSlug[locale as 'it' | 'en' | 'de' | 'fr'] ?? SECTION.indexSlug.it;
 const prefix = locale === 'it' ? '' : `/${locale}`;
 const href = `${prefix}/${indexSlug}/${slug}/`;
 const title = art.ogT.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '');
 return `<li class="s-65FRzB"><a class="s-ty-PxH" href="${esc(href)}">${esc(title)}</a></li>`;
 }).join('');
 return `<section class="s-zzuqwx"><h2 class="s-GipLjS">${esc(relatedArticlesLabel[locale] ?? relatedArticlesLabel.it)}</h2><ul class="s-9oHkUE">${items}</ul></section>`;
 };

 for (const en of entries) {
 // Single-article / batch fast path (#4837 stream A, batched #4881 Fase 4):
 // the entries parse above MUST stay full/unfiltered (the title-collision map
 // and the corpus-wide related-articles index both need every other article's
 // metadata to render THIS one correctly) — this is the only place that
 // narrows down to the requested id set.
 if (onlyArticleIdSet && !onlyArticleIdSet.has(en.articleId)) continue;
 const locSlugs = blogSlugs[en.articleId];

 const writtenPaths: Record<string, string> = {};
 const writtenFlatPaths: Record<string, string> = {};
 const writtenUrls: Record<string, string> = {};

 const lp: Record<string, string | null> = { it: en.path, en: null, de: null, fr: null };
 if (locSlugs) {
 for (const l of ['en', 'de', 'fr']) {
 const as = locSlugs[l], bs = blogIndexSlug[l];
 if (as && bs) lp[l] = `/${l}/${bs}/${as}`;
 }
 }

 const withTrailingSlash = (path: string): string => {
 if (!path || path === '/') return '/';
 const clean = path.replace(/\/+$/, '');
 return clean ? `${clean}/` : '/';
 };

 /** Extract plain-text excerpt from HTML body for structured data articleBody */
 const extractExcerpt = (htmlBody: string | undefined, maxChars = 500): string => {
 if (!htmlBody) return '';
 return htmlBody
 .replace(/<[^>]+>/g, ' ') // strip HTML tags
 .replace(/&[a-z]+;/gi, ' ') // strip HTML entities
 .replace(/\s+/g, ' ') // normalize whitespace
 .trim()
 .slice(0, maxChars)
 .replace(/\s+\S*$/, ''); // truncate at last complete word
 };

 /** Count words in HTML body */
 const countWords = (htmlBody: string | undefined): number => {
 if (!htmlBody) return 0;
 return htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).length;
 };

 const html = (locale: string, urlPath: string) => {
 const localeForMeta: 'en' | 'de' | 'fr' | null =
 (locale === 'en' || locale === 'de' || locale === 'fr') ? locale : null;
 const localizedMeta = localeForMeta ? blogMetaByLocale[localeForMeta][en.articleId] : null;
 const localizedTitleRaw = localizedMeta?.title || en.ogT;
 // Pure headline without publisher suffix — Google News requires <title>, <h1>, and
 // headline structured data to match (Publisher Center answer/9607104)
 // Headline VERBATIM — no truncation. Brand applied conditionally below.
 const localizedTitle = localizedTitleRaw.replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '');
 // Repair descriptions the corpus generator already amputated mid-clause
 // BEFORE they reach this render layer. `scripts/create-article.mjs` cut the
 // stored excerpt to a fixed budget without peeling the tail, so 2 936 entries
 // in content/seo/** end on a dangling preposition — 1 844 of them on the
 // literal "… Dati aggiornati 2026 per". Those arrive UNDER the clamp budget,
 // so no downstream truncation ever inspects them: without this call they ship
 // to the SERP broken. No-ops on text that already reads as complete.
 // Applied at the single definition point so <meta name="description">,
 // og:description, the visible <p> lede and JSON-LD all stay identical.
 const localizedDesc = repairSerpSnippet(localizedMeta?.excerpt || en.ogD);
 // Hero alt text. The corpus already carries a per-locale `imageAlt` (parsed
 // out of the blog-meta chunks alongside title/excerpt) and nothing consumed
 // it — og:image:alt fell back to the headline. Prefer the real alt, keep the
 // headline as the floor so the attribute is never empty: an <img> without an
 // accessible name fails the repo's own accessibility contract, and a decorative
 // alt="" would tell Discover this image is not about the article.
 const heroAlt = localizedMeta?.imageAlt || localizedTitle;
 // Pad short descriptions to ≥150 chars for Bing (locale variant excerpts are often <150)
 const LOCALE_DESC_CONTEXT: Partial<Record<string, string>> = {
 en: ' Practical guide and free tools for cross-border workers (frontalieri) between Switzerland and Italy. Frontaliere Ticino.',
 de: ' Praxisratgeber und kostenlose Tools für Grenzgänger zwischen der Schweiz und Italien. Frontaliere Ticino.',
 fr: " Guide pratique et outils gratuits pour travailleurs frontaliers entre la Suisse et l'Italie. Frontaliere Ticino.",
 };
 const metaDescPadded = (localeForMeta && localizedDesc.length < 150)
 ? localizedDesc + (LOCALE_DESC_CONTEXT[localeForMeta] ?? '')
 : localizedDesc;
 // SERP-CTR lever (issue #4300 plan item 2): title/h1/headline are locked by
 // the Google News verbatim-match rule above, so the description is the only
 // safe place to add a freshness/year signal for articles. Additive-only —
 // never rewrites existing text, no-ops when a year is already present or
 // there's no room before the clamp below.
 const metaDescRaw = boostDescriptionForCtr(
 metaDescPadded,
 (localeForMeta ?? 'it') as 'it' | 'en' | 'de' | 'fr',
 { maxLength: 155 },
 );
 // Truncate to ≤155 chars for Bing/Google snippet display.
 // truncateHeadline, NOT truncateCodeUnits: the raw code-unit slice cut mid
 // WORD and shipped snippets like "…impatto su perme…" (live offender
 // /articoli-frontaliere/calendario-festivi-ticino-2026/). truncateHeadline
 // cuts on a word boundary and peels the dangling clause tail, so the snippet
 // always ends on a content word — same helper every other template family
 // already reaches through clampMetaDescription.
 const metaDesc = truncateHeadline(metaDescRaw, 155);
 // <title>: headline VERBATIM, brand suffix only when total <= TITLE_MAX_CHARS.
 // Per build-plugins/shared/titleSuffix.ts, mid-headline ellipsis truncation
 // tanks CTR (see /calcola-stipendio/ regression doc). We only force a
 // truncation when there's a real disambiguator collision that MUST be
 // preserved to satisfy audit:title-uniqueness -- and even then, we drop the
 // brand first (it's "nice-to-have", not a ranking signal) before resorting
 // to mid-headline truncation.
 const articleLocale: 'it' | 'en' | 'de' | 'fr' = (locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it';
 const baseTitleProbe = buildTitleWithBrand(localizedTitle);
 const collidesInLocale = (articleTitleCollisions[articleLocale].get(baseTitleProbe) || 0) > 1;
 const articleSlugForLocale = String(urlPath || '').split('/').filter(Boolean).pop() || en.articleId;
 const disamb = collidesInLocale ? articleHashFromSlug(articleSlugForLocale, localizedTitle) : '';
 let htmlPageTitle: string;
 if (!disamb) {
  // No collision: trust buildTitleWithBrand to either keep brand or drop it.
  // It never truncates -- long headlines emit verbatim and the audit baseline
  // ratchets them down at source.
  htmlPageTitle = buildTitleWithBrand(localizedTitle);
 } else {
  // Disambiguator MUST survive (collision-resolution for title-uniqueness).
  // Try brand+disamb first; if it doesn't fit, drop brand and keep disamb;
  // if even headline+disamb overflows, truncate headline (last resort -- the
  // only path where ellipsis truncation is acceptable because the alternative
  // is dropping the (#hash) and breaking the title-uniqueness audit).
  const withBrandAndDisamb = `${localizedTitle}${disamb}${TITLE_BRAND_SUFFIX}`;
  if (withBrandAndDisamb.length <= TITLE_MAX_CHARS) {
   htmlPageTitle = withBrandAndDisamb;
  } else {
   const headlinePlusDisamb = `${localizedTitle}${disamb}`;
   if (headlinePlusDisamb.length <= TITLE_MAX_CHARS) {
    htmlPageTitle = headlinePlusDisamb;
   } else {
    const headlineBudget = TITLE_MAX_CHARS - disamb.length;
    const truncated = truncateHeadline(localizedTitle, Math.max(1, headlineBudget));
    htmlPageTitle = `${truncated}${disamb}`;
   }
  }
 }
 const articleBodyLocale = (locale === 'it' || locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it';
 const localizedBody = blogBodyByLocale[articleBodyLocale][en.articleId] ?? blogBodyByLocale.it[en.articleId];
 const allBodyKeys = localizedBody ? Object.keys(localizedBody).filter(k => /^body\d+$/.test(k)).sort((a, b) => {
 const na = parseInt(a.replace('body', ''), 10);
 const nb = parseInt(b.replace('body', ''), 10);
 return na - nb;
 }) : [];
 const bodySections = cleanupArticleBodySections(allBodyKeys.map(k => ({ key: k, text: localizedBody?.[k] })));
 const canonicalPath = withTrailingSlash(urlPath);
 const full = `${BASE_URL}${canonicalPath}`;
 // Issue #3010 item 1: shadowed near-duplicate variants (see
 // articleCanonicalOverrides above) resolve to the authoritative
 // pair member's URL here; everything else (JSON-LD url/mainEntityOfPage,
 // sitemap, RSS, routing) still uses this page's own URL/content — the
 // page stays live, only the canonical hint + og:url change.
 const effectiveCanonicalUrl = resolveSwissArticleCanonicalUrl(articleSlugForLocale, articleCanonicalOverrides, full);
 const imgU = `${BASE_URL}${en.img}`;
 const pp = urlPath.slice(1).replace(/&/g, '~and~');
 const href = Object.entries(lp)
 .filter((x): x is [string, string] => x[1] !== null)
 .map(([l, p]) => ` <link rel="alternate" hreflang="${l}" href="${BASE_URL}${withTrailingSlash(p)}">`)
 .concat([` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withTrailingSlash(lp.it)}">`])
 .join('\n');

 // Determine author: real per-article Person from data/authors.ts via
 // authorSlug (SECTION.registry field), Organization fallback when unset —
 // mirrors the SPA's mergeArticleByline (services/authorProfileService.ts)
 // + JSON-LD in components/community/BlogArticles.tsx (~1331-1351) and the
 // visible byline below, so static build + client hydration match (was:
 // hardcoded to a single author for every article, all sections).
 const resolvedAuthor = en.authorSlug ? getAuthorBySlug(en.authorSlug) : undefined;
 const authorObj: Record<string, unknown> = resolvedAuthor
 ? {
 '@type': 'Person' as const,
 name: resolvedAuthor.name,
 jobTitle: resolvedAuthor.role,
 url: `${BASE_URL}/autori/${resolvedAuthor.slug}/`,
 worksFor: { '@type': 'Organization', name: 'Frontaliere Ticino', '@id': `${BASE_URL}/#organization` },
 ...(resolvedAuthor.social?.linkedin ? { sameAs: [resolvedAuthor.social.linkedin] } : {}),
 }
 : {
 '@type': 'Organization' as const,
 '@id': `${BASE_URL}/#organization`,
 name: en.authorName || 'Redazione Frontaliere Ticino',
 url: `${BASE_URL}/chi-siamo/`,
 };

 // Issue #6337: `reviewedBy` E-E-A-T signal — only emitted when the
 // article has an explicit entry in articleReviewOverrides (nothing
 // reviewed by default, see shared/articleReviewOverrides.ts header).
 const reviewerSlug = resolveArticleReviewerSlug(en.articleId, articleReviewOverrides);
 const reviewerAuthor = reviewerSlug ? getAuthorBySlug(reviewerSlug) : undefined;
 const reviewedByObj: Record<string, unknown> | undefined = reviewerAuthor
 ? {
 '@type': 'Person' as const,
 name: reviewerAuthor.name,
 jobTitle: reviewerAuthor.role,
 url: `${BASE_URL}/autori/${reviewerAuthor.slug}/`,
 ...(reviewerAuthor.social?.linkedin ? { sameAs: [reviewerAuthor.social.linkedin] } : {}),
 }
 : undefined;

 // Build the JSON-LD object, respecting source @type (Event vs NewsArticle)
 const isEvent = en.sdType === 'Event';
 let ldObj: Record<string, unknown>;

 if (isEvent) {
 // Parse Event-specific fields from the source structuredData block
 const sd = en.sdBlock;
 const sdStr = (field: string): string => {
 // Handle escaped double quotes inside JSON strings (e.g. \"Corpi in prestito\")
 const rx = new RegExp(`"${field}":\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm');
 const val = sd.match(rx)?.[1] ?? '';
 return val.replace(/\\"/g, '"').replace(/\\'/g, "'");
 };
 // Parse nested objects like location, organizer, offers, performer.
 // Source keys are already double-quoted (JSON-LD style), so we only need
 // to resolve `${BASE_URL}` template literals and strip trailing commas.
 const parseNestedObj = (field: string): Record<string, unknown> | null => {
 const rx = new RegExp(`"${field}":\\s*\\{`);
 const m = rx.exec(sd);
 if (!m || m.index === undefined) return null;
 let depth = 0;
 let started = false;
 const start = m.index + m[0].length - 1;
 for (let ci = start; ci < sd.length; ci++) {
 if (sd[ci] === '{') { depth++; started = true; }
 if (sd[ci] === '}') { depth--; }
 if (started && depth === 0) {
 const raw = sd.substring(start, ci + 1);
 try {
 const jsonStr = raw
 .replace(/`\$\{BASE_URL\}([^`]*)`/g, `"${BASE_URL}$1"`)
 .replace(/,\s*([\]}])/g, '$1'); // strip trailing commas
 return JSON.parse(jsonStr);
 } catch { return null; }
 }
 }
 return null;
 };

 ldObj = {
 '@context': 'https://schema.org',
 '@type': 'Event',
 name: sdStr('name') || localizedTitle,
 // repairSerpSnippet anche qui: `localizedDesc` e' gia' riparata al punto di
 // definizione unico, ma questo fallback rilegge structuredData.description
 // GREZZA dal registro e la scavalcava — la riparazione applicata una volta e
 // poi aggirata da un ramo che torna alla sorgente (issue #5453).
 description: repairSerpSnippet(sdStr('description') || '') || localizedDesc,
 image: imageObjectLd({
 url: imgU,
 width: en.imgW,
 height: en.imgH,
 }),
 url: full,
 inLanguage: locale,
 author: authorObj,
 speakable: {
 '@type': 'SpeakableSpecification',
 cssSelector: ['article h1', 'article h2', 'article p'],
 },
 isAccessibleForFree: true,
 };

 // Add Event-specific fields from source
 const startDate = sdStr('startDate');
 const endDate = sdStr('endDate');
 const eventStatus = sdStr('eventStatus');
 const eventAttendanceMode = sdStr('eventAttendanceMode');
 if (startDate) ldObj.startDate = startDate;
 if (endDate) ldObj.endDate = endDate;
 if (eventStatus) ldObj.eventStatus = eventStatus;
 if (eventAttendanceMode) ldObj.eventAttendanceMode = eventAttendanceMode;

 const location = parseNestedObj('location');
 if (location) ldObj.location = location;
 const organizer = parseNestedObj('organizer');
 if (organizer) ldObj.organizer = organizer;
 const offers = parseNestedObj('offers');
 if (offers) {
 // Ensure validFrom is always present (Google recommended field)
 if (!offers.validFrom && startDate) {
 try {
 const sd = new Date(startDate as string);
 sd.setDate(sd.getDate() - 30);
 offers.validFrom = sd.toISOString().replace('Z', '+01:00').replace(/\.\d{3}/, '');
 } catch { /* skip */ }
 }
 ldObj.offers = offers;
 }
 const performer = parseNestedObj('performer');
 if (performer) ldObj.performer = performer;
 } else {
 // NewsArticle — Google News eligibility (Publisher Center answer/9607104)
 ldObj = {
 '@context': 'https://schema.org',
 '@type': 'NewsArticle',
 headline: localizedTitle,
 description: localizedDesc,
 // ImageObject, not the bare URL string this used to be. Google's
 // Article/NewsArticle guidance asks for the image's dimensions so card
 // eligibility can be decided WITHOUT fetching and measuring the file, and
 // Discover's large-image card has a documented 1200px floor — a bare string
 // makes that a fetch-and-hope. The Event branch above already builds its
 // image through this exact helper; this branch, which covers every real
 // news article, did not.
 image: imageObjectLd({
 url: imgU,
 width: en.imgW,
 height: en.imgH,
 caption: heroAlt,
 }),
 url: full,
 inLanguage: locale,
 // Author matches the visible "Di {authorName}" byline below and the
 // SPA-side Person schema (#3520) — Google's guidance: structured-data
 // author must match the byline. Person/Organization object defined once
 // above (authorObj), resolved from the article's real authorSlug.
 author: authorObj,
 // Same canonical entity as index.html / SPA (#3524); ORGANIZATION_LD is
 // the single source of truth (services/seo/organizationLd.ts) — was a
 // hand-rolled duplicate pointing at a 404'd logo (/images/logo-192.png).
 publisher: ORGANIZATION_LD,
 // Issue #6337: expert-review signal, present only when the article has
 // an entry in articleReviewOverrides — absent (not a fabricated default)
 // for every article until an editor marks it reviewed. schema.org's
 // `reviewedBy` has `domainIncludes: WebPage` only (verified against
 // schema.org; Article/NewsArticle isn't a listed domain and Google's own
 // Article structured-data guidance doesn't mention the property at all),
 // so it is nested on the `WebPage` entity via `mainEntityOfPage` instead
 // of attached directly to this NewsArticle node — the placement schema.org
 // actually defines, not the type this PR happens to be building.
 mainEntityOfPage: reviewedByObj
 ? { '@type': 'WebPage', '@id': full, reviewedBy: reviewedByObj }
 : full,
 isPartOf: { '@type': 'WebSite', '@id': `${BASE_URL}/#website`, name: 'Frontaliere Ticino' },
 speakable: {
 '@type': 'SpeakableSpecification',
 cssSelector: ['article h1', 'article h2', 'article p'],
 },
 // Google Discover eligibility fields
 isAccessibleForFree: true,
 articleSection: 'Frontalieri Ticino',
 };
 }
 const buildDateIso = new Date().toISOString();
 const todayIso = buildDateIso.slice(0, 10);

 // Article-specific fields (datePublished, dateModified, articleBody, wordCount)
 // are not applicable to Event schema
 if (!isEvent) {
 ldObj.datePublished = normalizeDateTime(en.datePub || en.dateMod || todayIso);
 // Use datePublished for dateModified — avoids false freshness signals on every deploy
 ldObj.dateModified = normalizeDateTime(en.dateMod || en.datePub || todayIso);

 // articleBody excerpt + wordCount (Google Discover uses this for topic relevance)
 const fullBodyHtml = bodySections.map((s) => s.html).join('\n');
 const excerpt = extractExcerpt(fullBodyHtml, 500);
 if (excerpt) {
 ldObj.articleBody = excerpt;
 ldObj.wordCount = countWords(fullBodyHtml);
 }
 }

 // keywords from article metadata
 if (en.keywords) {
 const kw = typeof en.keywords === 'string'
 ? en.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
 : Array.isArray(en.keywords) ? en.keywords : [];
 if (kw.length > 0) ldObj.keywords = kw;
 }

 const ldJsonStr = inlineScriptJson(ldObj);

 // BreadcrumbList for article pages (enables rich result breadcrumbs in Google)
 const sectionName = locale === 'en' ? 'Articles' : locale === 'de' ? 'Artikel' : locale === 'fr' ? 'Articles' : 'Articoli';
 const sectionSlug = blogIndexSlug[locale] || SECTION.indexSlug[(locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it'];
 const breadcrumbLd = inlineScriptJson({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
 { '@type': 'ListItem', position: 2, name: sectionName, item: `${BASE_URL}/${sectionSlug}/` },
 { '@type': 'ListItem', position: 3, name: localizedTitle },
 ],
 });

 // Article-specific FAQPage schema: prefer structured `faq` key from body data,
 // fall back to heuristic extraction from H2 headings for evergreen articles.
 let faqLdTag = '';
 let visibleFaqHtml = '';
 const articleCategory = articleCategoryById[en.articleId] ?? '';

 // Try structured FAQ from body data first (new articles with AI-generated FAQ)
 let faqPairsFromData: Array<{ question: string; answer: string }> | null = null;
 const articleBodyData = blogBodyByLocale[articleBodyLocale]?.[en.articleId] ?? blogBodyByLocale.it?.[en.articleId];
 if (articleBodyData) {
 const faqRaw = articleBodyData['faq'];
 if (faqRaw) {
 try {
 const parsed = JSON.parse(faqRaw);
 if (Array.isArray(parsed) && parsed.length >= 2) {
 faqPairsFromData = parsed
 .filter((p: any) => p.q && p.a && p.q.length > 10 && p.a.length > 20)
 .map((p: any) => ({ question: String(p.q), answer: String(p.a) }));
 if (faqPairsFromData!.length < 2) faqPairsFromData = null;
 }
 if (!faqPairsFromData) faqRejected.set(`${en.articleId}:${locale}`, 'too-few-usable-pairs');
 } catch {
 // Was `catch { /* invalid JSON, fall through to heuristic */ }` — silent.
 // Falling through is right (the heuristic still covers evergreen
 // categories), but staying quiet is how 102 published articles could lose
 // their FAQPage schema and their visible accordion with nothing to look at:
 // no error, no exit code, no line in the build log. The fall-through is
 // kept exactly as it was; only the counter below is new, so a corpus that
 // starts emitting unreadable `.faq` is visible in the build output the
 // same day instead of via a rich-results audit weeks later.
 faqRejected.set(`${en.articleId}:${locale}`, 'json-parse');
 }
 }
 }

 // Use structured FAQ if available, otherwise fall back to heuristic for evergreen articles
 const useFaqPairs = faqPairsFromData ?? (() => {
 if (!EVERGREEN_CATEGORIES.has(articleCategory)) return null;
 const rawBody = blogBodyByLocale[articleBodyLocale]?.[en.articleId] ?? blogBodyByLocale.it?.[en.articleId];
 if (!rawBody) return null;
 const rawBodyKeys = Object.keys(rawBody).sort((a, b) => {
 const na = parseInt(a.replace(/\D/g, ''), 10);
 const nb = parseInt(b.replace(/\D/g, ''), 10);
 return na - nb;
 });
 const rawBodyText = rawBodyKeys
 .filter(k => k.includes('body'))
 .map(k => rawBody[k])
 .filter(Boolean)
 .join('\n\n');
 const pairs = extractArticleFaqPairs(rawBodyText);
 return pairs.length >= 2 ? pairs : null;
 })();

 if (useFaqPairs && useFaqPairs.length >= 2) {
 const faqSchema = {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: useFaqPairs.slice(0, 10).map(pair => ({
 '@type': 'Question',
 name: pair.question,
 acceptedAnswer: { '@type': 'Answer', text: pair.answer },
 })),
 };
 faqLdTag = `\n <script type="application/ld+json">${inlineScriptJson(faqSchema)}</script>`;
 faqCount++;

 const faqLabel = locale === 'en' ? 'Frequently Asked Questions'
 : locale === 'de' ? 'Häufig gestellte Fragen'
 : locale === 'fr' ? 'Questions fréquentes'
 : 'Domande frequenti';
 visibleFaqHtml = `<details class="s-lfB4Bo"><summary class="s-qAjSfB">${faqLabel}</summary><dl class="s-4vhLHi">` +
 useFaqPairs.slice(0, 10).map(pair =>
 `<dt class="s-fG2BFJ">${esc(pair.question)}</dt><dd class="s-nrPIRx">${esc(pair.answer).substring(0, 500)}</dd>`
 ).join('') +
 `</dl></details>`;
 }

 const headTags = ` <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 ${FAVICON_LINKS}
 <title>${esc(htmlPageTitle)}</title>
 <meta name="description" content="${esc(clampMetaDescription(metaDesc))}">
 <link rel="canonical" href="${effectiveCanonicalUrl}">
 <meta property="og:type" content="article">
 <meta property="og:url" content="${effectiveCanonicalUrl}">
 <meta property="og:title" content="${esc(localizedTitle)}">
 <meta property="og:description" content="${esc(clampMetaDescription(localizedDesc))}">
 <meta property="og:image" content="${imgU}">
 <meta property="og:image:width" content="${en.imgW}">
 <meta property="og:image:height" content="${en.imgH}">
 <meta property="og:image:type" content="${en.img?.includes('.webp') ? 'image/webp' : 'image/jpeg'}">
 <meta property="og:image:alt" content="${esc(localizedTitle)}">
 <meta property="og:locale" content="${LOC_TAG[locale] ?? 'it_CH'}">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta name="robots" content="${ARTICLE_ROBOTS_INDEX_ENHANCED}">
 <meta property="fb:app_id" content="891036063797338">
 <meta property="article:published_time" content="${esc(normalizeDateTime(en.datePub || en.dateMod || todayIso))}">
 <meta property="article:modified_time" content="${esc(normalizeDateTime(en.dateMod || en.datePub || todayIso))}">
 <meta property="article:section" content="Frontalieri Ticino">
 <meta property="article:author" content="${BASE_URL}/chi-siamo/">
${href}
 <link rel="alternate" type="application/rss+xml" title="Frontaliere Ticino" href="${BASE_URL}/rss.xml">
 <script type="application/ld+json">${ldJsonStr}</script>
 <script type="application/ld+json">${breadcrumbLd}</script>${faqLdTag}
 <link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

 // The hero image, as an ELEMENT. Until now the static article HTML carried
 // none: measured on four live article pages with a Googlebot-smartphone UA,
 // `<img` occurred 0 times, `<picture>` 0, `srcset` 0. The only reference was
 // the preload directly below — a preload with no consumer in the document,
 // which is both a wasted high-priority fetch and, more to the point, nothing
 // for Discover to build a card from. The image existed only in the React
 // render (components/community/BlogArticles.tsx), i.e. behind JS execution.
 //
 // `max-image-preview:large` was already set in the head. That directive
 // raises the CAP on preview size; it does not supply an image. With no <img>
 // in the crawled markup the cap applied to nothing — which is why this is the
 // technical half of "appear in Discover", not an editorial one.
 //
 // Same `en.img` URL as the preload on purpose, so the preload finally has its
 // consumer and resolves to one request rather than two. width/height are the
 // MEASURED intrinsic size of this article's own file (resolveHeroSize), not a
 // shared constant, so the box reserved matches the bytes that land — no CLS
 // for Auto Ads to inherit, and no width declared that the file contradicts.
 // Same numbers feed og:image:width/height and the JSON-LD ImageObject, so the
 // three sources cannot disagree. The `/images/blog/...`
 // src is rewritten to the CDN downstream by rewriteBlogImageRefs(), which is
 // attribute-agnostic (it matches the path, not the surrounding attribute) and
 // therefore already covers src= exactly as it covers the preload's href=.
 const heroFigureHtml =
 `<figure class="my-4"><img src="${en.img}" alt="${esc(heroAlt)}" width="${en.imgW}" height="${en.imgH}" fetchpriority="high" decoding="async" class="w-full h-auto rounded-lg"></figure>`;

 const blogPreloads = [
 `<link rel="preload" as="image" href="${en.img}" fetchpriority="high">`,
 blogMetaItChunk ? `<link rel="modulepreload" href="/assets/${blogMetaItChunk}">` : '',
 ].filter(Boolean).join('\n ');

 if (hasSpaBundle) {
 const fallbackSections = buildArticleSeoSections(
 articleBodyLocale,
 localizedTitle,
 localizedDesc,
 en.keywords,
 SECTION.name,
 );
 const bodyWordCount = countWords(bodySections.map((s) => s.html).join(' '));
 // bodySections are already-rendered HTML (headings/lists/links) from cleanupArticleBodySections;
 // fallbackSections carry plain prose paragraphs that still need escaping + <p> wrapping.
 // Pair each rendered body with its heading by stable key (bodyN, not post-filter
 // array index) — an empty body2 must not shift body3's html onto body2's heading.
 const bodyDerivedSections = bodySections.map(({ key, html }) => {
 const n = parseInt(key.replace(/^body/, ''), 10);
 return {
 heading: articleBodySectionLabel(articleBodyLocale, n),
 html,
 };
 });
 const fallbackDerivedSections = fallbackSections.map((section) => ({
 heading: section.heading,
 html: section.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join(''),
 }));
 const sectionSource = !bodySections.length
 ? fallbackDerivedSections
 : (bodyWordCount < 360
 ? [...bodyDerivedSections, ...fallbackDerivedSections]
 : bodyDerivedSections);
 // Duplicate generic headings (bodyN, n>=3 all map to the third label)
 // collapse to a single visible <h2>; repeats keep content + aria-label (#3521).
 const articleBodyHtml = renderArticleDerivedSectionsHtml(sectionSource);
 return `<!DOCTYPE html>
<html lang="${locale}">
 <head>
${headTags}
 ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n ` : ''}${blogPreloads}
 <script>if(localStorage.theme==='dark')document.documentElement.classList.add('dark');window.__ARTICLE_TITLE__=${inlineScriptJson(localizedTitle)}</script>
 ${CRITICAL_CSS_LINK}
 <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
 <link rel="preload" href="/fonts/space-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
 <link rel="preload" as="style" crossorigin href="/assets/${entryCss}" data-clarity-unmask="true">
 <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="print" onload="this.media='all'" data-clarity-unmask="true">
 <noscript><link rel="stylesheet" crossorigin href="/assets/${entryCss}" data-clarity-unmask="true"></noscript>
 ${ASYNC_CSS_FALLBACK_SCRIPT}${preloadTag}
 ${asyncCssLink(`/assets/${SEO_STATIC_CSS_FILENAME}`)}
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 ${PARTNERIZE_TAG_SNIPPET}
 ${OFFERWALL_FC_SNIPPET}
 </head>
 <body class="bg-surface-alt text-heading overflow-x-hidden">
 ${articleRootShell(true)}<main class="seo-static-content"><article class="ft-blog-article"><h1>${esc(differentiateH1FromTitle(localizedTitle, htmlPageTitle, articleLocale))}</h1><p class="article-byline s-L_lk4l">Di ${en.authorSlug && en.authorName ? `<a href="/autori/${en.authorSlug}/" rel="author">${esc(en.authorName)}</a>` : esc(en.authorName || 'Redazione Frontaliere Ticino')} · ${buildDateByline(en.datePub || en.dateMod || todayIso, en.dateMod || en.datePub || todayIso, locale)}</p>${heroFigureHtml}<p>${esc(localizedDesc)}</p>${articleBodyHtml}${visibleFaqHtml}${buildRelatedArticlesHtml(en.articleId, articleCategoryById[en.articleId] || '', locale)}<nav><a href="/">Simulatore Fiscale</a> | <a href="/compara-servizi/">Confronta Servizi</a> | <a href="/tasse-e-pensione/">Tasse e Pensione</a> | <a href="/guida-frontaliere/">Guida Frontaliere</a> | <a href="/domande-frequenti-frontalieri/">FAQ</a> | <a href="/glossario-frontaliere/">Glossario</a> | <a href="/${SECTION.indexSlug.it}/">Articoli</a></nav></article></main>${ARTICLE_FOOTER_ROOT}
 <script type="module" crossorigin fetchpriority="high" src="/assets/${entryJs}"></script>
 </body>
</html>`;
 }

 // Bundle-less fallback. Currently unreachable: `hasSpaBundle` is typed
 // `true` (spaBundleResolver throws on a missing bundle rather than returning
 // false), so the `if (hasSpaBundle)` above never falls through. Kept in
 // parity with the rich branch (and with staticPagesPlugin's own bundle-less
 // fallback) so that — if the resolver invariant ever changes — article pages
 // emitted here still carry the Offerwall FC snippet and never silently lose
 // revenue. Defense-in-depth, not a live branch.
 return `<!DOCTYPE html>
<html lang="${locale}">
 <head>
${headTags}
 <noscript><meta http-equiv="refresh" content="0;url=/?p=${pp}"></noscript>
 ${GTAG_SNIPPET}
 ${ADSENSE_SNIPPET}
 ${PARTNERIZE_TAG_SNIPPET}
 ${OFFERWALL_FC_SNIPPET}
 </head>
 <body>
 ${articleRootShell(false)}<main class="seo-static-content"><article class="ft-blog-article"><h1>${esc(differentiateH1FromTitle(localizedTitle, htmlPageTitle, articleLocale))}</h1>${heroFigureHtml}<p>${esc(localizedDesc)}</p><nav><a href="/">Simulatore Fiscale</a> | <a href="/compara-servizi/">Confronta Servizi</a> | <a href="/tasse-e-pensione/">Tasse e Pensione</a> | <a href="/guida-frontaliere/">Guida Frontaliere</a> | <a href="/domande-frequenti-frontalieri/">FAQ</a> | <a href="/glossario-frontaliere/">Glossario</a> | <a href="/${SECTION.indexSlug.it}/">Articoli</a></nav></article></main>${ARTICLE_FOOTER_ROOT}
 </body>
</html>`;
 };

 // Italian (primary)
 const itHtml = html('it', en.path);
 const flatItHtml = itHtml.replace(/\s*<script>location\.replace\([^<]*\)<\/script>/, '');
 // canonicalPath is captured WITH trailing slash from seo-blog*.ts. The
 // sibling index.html target wants the trailing slash, but the flat .html
 // sibling must NOT inherit it — `path.join(distDir, '/foo/' + '.html')`
 // emits a dotfile `dist/foo/.html` that GitHub Pages serves with
 // content-type=application/octet-stream for the URL `/foo/`, masking the
 // real `index.html`. Strip the trailing slash before the `.html` concat.
 const itFlatPath = en.path.replace(/\/+$/, '');
 collector.add(np.join(distDir, en.path, 'index.html'), itHtml);
 collector.add(np.join(distDir, itFlatPath + '.html'), flatItHtml);
 count++;
 writtenPaths.it = np.join(en.path, 'index.html').replace(/^\/+/, '');
 writtenFlatPaths.it = (itFlatPath + '.html').replace(/^\/+/, '');
 writtenUrls.it = `${BASE_URL}${withTrailingSlash(en.path)}`;

 // EN / DE / FR
 for (const [loc, lPath] of Object.entries(lp)) {
 if (loc === 'it' || !lPath) continue;
 const locHtml = html(loc, lPath);
 const flatLocHtml = locHtml.replace(/\s*<script>location\.replace\([^<]*\)<\/script>/, '');
 // Defense-in-depth: locale paths are built without trailing slash
 // (`/${l}/${bs}/${as}`) but normalize anyway in case the source convention
 // changes.
 const locFlatPath = lPath.replace(/\/+$/, '');
 collector.add(np.join(distDir, lPath, 'index.html'), locHtml);
 collector.add(np.join(distDir, locFlatPath + '.html'), flatLocHtml);
 count++;
 writtenPaths[loc] = np.join(lPath, 'index.html').replace(/^\/+/, '');
 writtenFlatPaths[loc] = (locFlatPath + '.html').replace(/^\/+/, '');
 writtenUrls[loc] = `${BASE_URL}${withTrailingSlash(lPath)}`;
 }

 writtenEntries.push({
 articleId: en.articleId,
 paths: writtenPaths,
 flatPaths: writtenFlatPaths,
 urls: writtenUrls,
 img: en.img,
 });
 }

 totalEntries += entries.length;
 } // end for (const SECTION of SECTIONS.filter(...))

 const written = await collector.flush();
 const skippedHash = collector.skippedByHash;
 console.log(`\x1b[36m[og-pages]\x1b[0m [${opts.section}] Generated ${count} OG landing pages for ${totalEntries} articles (${faqCount} with FAQPage schema) — wrote ${written}, skipped ${skippedHash} unchanged`);
 // Never fatal: the heuristic fallback stays in charge and a corpus defect
 // must not be able to fail a build. But it is no longer invisible.
 if (faqRejected.size > 0) {
 const byReason = new Map<string, number>();
 for (const reason of faqRejected.values()) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
 const breakdown = [...byReason].map(([r, n]) => `${r}=${n}`).join(', ');
 const sample = [...faqRejected.keys()].slice(0, 5).join(', ');
 console.warn(`\x1b[33m[og-pages]\x1b[0m [${opts.section}] ${faqRejected.size} article page(s) carry a .faq that produced no FAQPage (${breakdown}) — e.g. ${sample}`);
 }
 return { written, entries: writtenEntries };
}

/**
 * Vite plugin wrapper — thin shell around {@link renderArticlePages}.
 * Runs the SAME render logic once per section (frontaliere, svizzera) with
 * no `onlyArticleId`, so full-build output is byte-identical to before this
 * function was extracted (#4837 stream A). Do not add per-section logic
 * here — it belongs in renderArticlePages so the fast single-article path
 * (scripts/publish-article-fast.mjs) gets it for free.
 *
 * **Build-time emit skip (issue #4881 Fase 5).** Both article sections
 * already serve fully from their own per-locale shard repos
 * (`ARTICOLIFRONTALIERE_SHARD_LIVE` / `ARTICOLISVIZZERA_SHARD_LIVE`, #4881
 * Fase 1/3/3-bis/4) — the full build's own copy of the ~29,600 article
 * pages is redundant weight in the monolith `dist/` that deploy.yml's
 * full-replace push loop then force-pushes over the shard on every deploy,
 * even though `scripts/publish-article-fast.mjs` already keeps the shard
 * incrementally current. `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` /
 * `ARTICOLISVIZZERA_BUILD_EMIT_SKIP` (repo variables, same per-section
 * convention as `<SECTION>_SHARD_LIVE`, plumbed into this job's env by
 * deploy.yml) let the owner turn off one section's build-time emission at
 * a time once rehydration (`scripts/lib/rehydrate-section-shards.sh`) is
 * verified to keep post-deploy dist-walking audits green — WITHOUT a code
 * change, same instant-rollback shape as every other shard-live flag.
 * Default (unset) = unchanged legacy behavior: both sections keep emitting
 * into the monolith build exactly as before this flag existed. MUST be
 * flipped true here in lockstep with excluding the section from
 * deploy.yml's push loop (never emit-off with push-loop still active —
 * that would force-push a near-empty tree over the live shard).
 * `renderArticlePages` itself is UNCHANGED and stays exported/callable —
 * `scripts/publish-article-fast.mjs` (single-article fast path) and
 * `scripts/rerender-article-corpus.mjs` (corpus re-render) both call it
 * directly, bypassing this plugin entirely; only the closeBundle
 * invocation below is ever skipped.
 */
export function ogPagesPlugin(rootDir: string): Plugin {
 return {
 name: 'og-pages',
 apply: 'build',
 enforce: 'post',
 async closeBundle() {
 const np = await import('node:path');
 const distDir = np.resolve(rootDir, 'dist');
 const skipFrontaliere = process.env.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP === 'true';
 const skipSvizzera = process.env.ARTICOLISVIZZERA_BUILD_EMIT_SKIP === 'true';
 const frontaliere = skipFrontaliere
 ? { written: 0, entries: [] }
 : await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
 const svizzera = skipSvizzera
 ? { written: 0, entries: [] }
 : await renderArticlePages({ rootDir, distDir, section: 'svizzera' });
 const written = frontaliere.written + svizzera.written;
 const totalArticles = frontaliere.entries.length + svizzera.entries.length;
 const skipNote = skipFrontaliere || skipSvizzera
 ? ` (build-time emit SKIPPED for ${[skipFrontaliere && 'frontaliere', skipSvizzera && 'svizzera'].filter(Boolean).join(', ')} — served from shard, see ARTICOLI*_BUILD_EMIT_SKIP)`
 : '';
 console.log(`\x1b[36m[og-pages]\x1b[0m Done — wrote ${written} files across ${totalArticles} article(s) total (frontaliere + svizzera).${skipNote}`);
 },
 };
}
