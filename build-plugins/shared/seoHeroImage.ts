/**
 * The hero image every indexable static SEO page must carry, and the single
 * place that decides what that markup looks like (issue #5001 punto 2).
 *
 * WHY THIS EXISTS
 * ───────────────
 * `max-image-preview:large` — normalized site-wide in #5170 — only buys a
 * large Discover card if Google can find an image ON the page. #5101 already
 * learned this on article pages: before it, they carried the directive and a
 * `preload as=image` with no consumer, so the directive applied to nothing.
 *
 * Measured 2026-08-06 across the live sitemaps: 40 of 86 families emit **zero**
 * `<img>` tags. Most are data landings where a photograph would be invented
 * rather than editorial — that is a choice, not a defect. Eight families are
 * not: guides, glossario, minimum-wage, holidays, frontaliere-pillar, faq-hub,
 * market-report, annual-report — ~514 URLs of real editorial content with no
 * image at all. They declare `og:image` (the site-wide 1200×630 default), which
 * is why a header-only audit reads them as fine.
 *
 * WHY A GENERATED CARD RATHER THAN A STOCK PHOTO
 * ──────────────────────────────────────────────
 * The alternative was one relevant photo per family. On 416 faq-hub pages that
 * is the same image 416 times: near-duplicate imagery that represents the
 * family, not the page, and adds nothing a crawler can use to tell them apart.
 * A generated card carries the page's own headline, which is what a Discover
 * card is supposed to show — and it is the pattern the site already runs at
 * scale for jobs (`jobOgImagesPlugin`, ~2100 cards/build).
 *
 * WHY THE URL IS DETERMINISTIC
 * ────────────────────────────
 * Emitters reference the card before it exists. `seoHeroCardsPlugin` runs
 * afterwards, walks `dist/`, and generates exactly the cards the pages ask
 * for — so no plugin has to run before another, and a family can adopt this
 * without knowing anything about the generator. The `data-seo-hero` attribute
 * is that contract: it is what the generator scans for.
 */

import { imageObjectLd, type ImageObjectLd } from '../../services/seo/imageObjectLd';

/**
 * Canonical origin. Deliberately NOT `import { BASE_URL } from '../constants'`.
 *
 * `constants.ts` calls `assertPublicAssetExists('seo-static.css')` at module
 * scope, so importing it makes this module unloadable wherever `public/` is
 * not materialized — which per CLAUDE.md is every sparse worktree in this
 * repo, the documented way to check one out. The runtime half of
 * `tests/seo/discover-hero-image.test.ts` imports this file; it must not need
 * a 1.8 GB asset tree to answer a question about a URL string.
 *
 * The duplication is pinned rather than tolerated: that test reads
 * `constants.ts` as TEXT and fails if the two literals ever differ, which
 * costs nothing and needs no import.
 */
const SEO_HERO_ORIGIN = 'https://frontaliereticino.ch';

/** Card geometry. 1200×630 is the Discover/OG large-card aspect. */
export const SEO_HERO_WIDTH = 1200;
export const SEO_HERO_HEIGHT = 630;

/** Where a family's cards live under `dist/`. Mirrors `dist/og/jobs/<slug>.webp`. */
export function seoHeroCardPath(family: string, key: string, locale: string): string {
  return `/og/seo/${family}/${key}-${locale}.webp`;
}

export interface SeoHeroImageOpts {
  /** Family slug, e.g. `glossario`. Groups the generated cards. */
  readonly family: string;
  /** Stable per-page key within the family (usually the page slug). */
  readonly key: string;
  readonly locale: string;
  /**
   * Alt text. For these cards it is normally the headline itself, and that is
   * correct rather than lazy: the image contains exactly that text over the
   * brand background, so the headline IS the honest description of what a
   * sighted user sees. Never a keyword list.
   */
  readonly alt: string;
  /** Headline printed on the card. Defaults to {@link SeoHeroImageOpts.alt}. */
  readonly headline?: string;
  /** Small label above the headline (family name in the page's locale). */
  readonly eyebrow?: string;
  /** Extra classes for the wrapper, if the family's layout needs them. */
  readonly className?: string;
}

export interface SeoHeroCardRequest {
  readonly family: string;
  readonly key: string;
  readonly locale: string;
  readonly headline: string;
  readonly eyebrow: string;
}

/**
 * Cards requested this build, keyed by output path so a page emitted twice
 * (directory form + flat sibling) enqueues one render.
 *
 * A module-level registry rather than a `dist/` scan on purpose: the site
 * emits ~800k HTML files, and walking all of them to discover a few hundred
 * hero markers would cost more than rendering the cards. Every hero goes
 * through {@link renderSeoHeroImage}, so registering there means a family
 * cannot emit the markup and forget to request the image — the two are the
 * same call.
 */
const CARD_REQUESTS = new Map<string, SeoHeroCardRequest>();

/**
 * Set once the generator has taken the registry. Anything registered after
 * this point will never be rendered.
 *
 * This exists because the ordering invariant is REAL and was broken on the
 * first try: `closeBundle` is an async/parallel Rollup hook, so `enforce`
 * decides only when each hook is *started*, not when it finishes. An emitter
 * that hits an `await` before its render loop yields, and a later plugin's
 * synchronous first statement can run before it resumes.
 *
 * That is exactly what happened to `pdfWhitepapersPlugin`: it opened
 * `closeBundle` with `await import('node:fs')`, so it suspended before
 * registering any card, and the generator drained an empty slot for the
 * `guides` family — while the four pages had already been written with an
 * `<img>` pointing at a WebP that would never exist. A 404 hero on the whole
 * family, which is the precise opposite of what this module is for, and
 * invisible without a real build.
 *
 * The import is static now, but "no emitter introduces an await before its
 * render loop" is not a property anyone can hold in their head across seven
 * plugins. So the failure mode is made loud instead of silent.
 */
let drained = false;

/** Drain the registry. Called once by `seoHeroCardsPlugin` at closeBundle. */
export function drainSeoHeroCardRequests(): SeoHeroCardRequest[] {
  const out = [...CARD_REQUESTS.values()].sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.key.localeCompare(b.key) ||
      a.locale.localeCompare(b.locale),
  );
  CARD_REQUESTS.clear();
  drained = true;
  return out;
}

/** Test seam: undo {@link drainSeoHeroCardRequests}'s latch. */
export function resetSeoHeroCardRegistry(): void {
  CARD_REQUESTS.clear();
  drained = false;
}

/**
 * Families that asked for a card too late to get one. Empty on a healthy
 * build; `seoHeroCardsPlugin` reports it so a broken hero is a build message
 * rather than a 404 discovered in production weeks later.
 */
const LATE_REQUESTS = new Set<string>();
export function lateSeoHeroCardFamilies(): string[] {
  return [...LATE_REQUESTS].sort();
}

/** Test seam: how many cards are currently queued. */
export function pendingSeoHeroCardCount(): number {
  return CARD_REQUESTS.size;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The hero `<img>`.
 *
 * `width`/`height` are declared so the browser reserves the box before the
 * image arrives — without them this markup would trade a Discover card for a
 * layout shift, and the CLS measured on these families is already the thing
 * being fixed elsewhere in #5001. `loading="eager"` + `fetchpriority="high"`
 * because on these pages the hero IS the LCP candidate; lazy-loading it would
 * push LCP out, which is the opposite of the point.
 */
export function renderSeoHeroImage(opts: SeoHeroImageOpts): string {
  const src = seoHeroCardPath(opts.family, opts.key, opts.locale);
  // Emitting the markup IS the request for the image — see CARD_REQUESTS.
  // If the generator has already drained, this card will never be rendered and
  // the page below would ship an <img> at a 404. Record it so the build says so.
  if (drained) LATE_REQUESTS.add(`${opts.family}/${opts.key}/${opts.locale}`);
  CARD_REQUESTS.set(src, {
    family: opts.family,
    key: opts.key,
    locale: opts.locale,
    headline: opts.headline ?? opts.alt,
    eyebrow: opts.eyebrow ?? '',
  });
  const cls = opts.className ? ` ${opts.className}` : '';
  return (
    `<figure class="my-4${cls}">` +
    `<img data-seo-hero="${esc(opts.family)}/${esc(opts.key)}/${esc(opts.locale)}"` +
    ` src="${esc(src)}" width="${SEO_HERO_WIDTH}" height="${SEO_HERO_HEIGHT}"` +
    ` alt="${esc(opts.alt)}" loading="eager" fetchpriority="high" decoding="async"` +
    ` class="w-full h-auto rounded-md" style="aspect-ratio:${SEO_HERO_WIDTH}/${SEO_HERO_HEIGHT}">` +
    `</figure>`
  );
}

/**
 * Absolute URL of the card. The relative {@link seoHeroCardPath} is right for
 * `<img src>`; JSON-LD and `og:image` are both consumed off-page (by a crawler
 * that may have the markup without the page's origin) and need the origin.
 */
export function seoHeroImageUrl(opts: SeoHeroImageOpts): string {
  return `${SEO_HERO_ORIGIN}${seoHeroCardPath(opts.family, opts.key, opts.locale)}`;
}

/**
 * The hero as an `ImageObject`, for the page's `Article.image`.
 *
 * WHY AN OBJECT AND NOT THE URL STRING
 * ────────────────────────────────────
 * schema.org allows `image` to be a bare URL and every one of these families
 * shipped exactly that — pointing, moreover, at the site-wide
 * `/og-image.png` rather than at anything about the page. #5104 already
 * settled this once for `NewsArticle.image`: a bare string carries no
 * dimensions, so a consumer cannot tell a 1200×630 card from a 512×512 app
 * icon without fetching it, and Google's large-card eligibility is stated in
 * pixels. The declared `width`/`height` are the same two constants the
 * `<img>` declares, from the same place, so the two cannot drift.
 *
 * WHY IT GOES THROUGH `imageObjectLd`
 * ───────────────────────────────────
 * Hand-rolling the object here would ship five missing GSC licensable-image
 * fields on ~514 URLs at once, and `tests/seo/image-object-license-fields.ts`
 * is a hard CI gate on exactly that. The shared builder is the only way to
 * emit an ImageObject on this site.
 *
 * WHY IT REGISTERS THE CARD TOO
 * ─────────────────────────────
 * Same contract as {@link renderSeoHeroImage}: referencing the card IS the
 * request for it. A family that emitted only the structured data would
 * otherwise advertise a WebP nobody renders — the same 404-hero failure that
 * `pdfWhitepapersPlugin` shipped, just in JSON-LD where no browser would ever
 * make it visible. Registration is keyed by `src`, so a page that calls both
 * (all of them do) still enqueues one render.
 */
export function seoHeroImageObject(opts: SeoHeroImageOpts): ImageObjectLd {
  const src = seoHeroCardPath(opts.family, opts.key, opts.locale);
  if (drained) LATE_REQUESTS.add(`${opts.family}/${opts.key}/${opts.locale}`);
  CARD_REQUESTS.set(src, {
    family: opts.family,
    key: opts.key,
    locale: opts.locale,
    headline: opts.headline ?? opts.alt,
    eyebrow: opts.eyebrow ?? '',
  });
  return imageObjectLd({
    contentUrl: `${SEO_HERO_ORIGIN}${src}`,
    width: SEO_HERO_WIDTH,
    height: SEO_HERO_HEIGHT,
    // The card prints this headline over the brand background, so the caption
    // describes the image truthfully — same string, same reason, as the alt.
    caption: opts.alt,
    inLanguage: opts.locale,
    // True in the literal sense: the same call site also feeds `og:image`.
    representativeOfPage: true,
  });
}

/**
 * {@link seoHeroImageObject} as a standalone JSON-LD document.
 *
 * For the one family that has no `Article` node to hang `image` on:
 * `staticPagesPlugin` carries page structured data as a pre-serialized string
 * assembled ~2400 lines before the hero exists, and the glossary's only
 * page-level node is a `DefinedTerm`. Parsing that string back to reach it
 * would be a new failure mode on 42 URLs to save one `<script>` tag; emitting
 * the ImageObject as its own node — with `representativeOfPage` doing the
 * linking — does not. Wrapping here rather than letting the caller write
 * `@context` by hand keeps the field choices above the only ones in effect.
 */
export function seoHeroImageObjectDocument(
  opts: SeoHeroImageOpts,
): ImageObjectLd & { '@context': 'https://schema.org' } {
  return { '@context': 'https://schema.org', ...seoHeroImageObject(opts) };
}
