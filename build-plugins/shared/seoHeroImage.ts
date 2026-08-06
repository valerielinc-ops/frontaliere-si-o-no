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

/** Drain the registry. Called once by `seoHeroCardsPlugin` at closeBundle. */
export function drainSeoHeroCardRequests(): SeoHeroCardRequest[] {
  const out = [...CARD_REQUESTS.values()].sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.key.localeCompare(b.key) ||
      a.locale.localeCompare(b.locale),
  );
  CARD_REQUESTS.clear();
  return out;
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
 * `ImageObject` for the page's structured data, with the dimensions declared.
 *
 * A bare image URL string is what #5104 found wrong on `NewsArticle.image`;
 * an `ImageObject` with width/height is what replaced it. Same shape here so
 * the two surfaces agree.
 */
export function seoHeroImageObject(baseUrl: string, opts: SeoHeroImageOpts): Record<string, unknown> {
  return {
    '@type': 'ImageObject',
    url: `${baseUrl}${seoHeroCardPath(opts.family, opts.key, opts.locale)}`,
    width: SEO_HERO_WIDTH,
    height: SEO_HERO_HEIGHT,
    caption: opts.alt,
  };
}

/** Absolute card URL, for `og:image`. */
export function seoHeroImageUrl(baseUrl: string, opts: SeoHeroImageOpts): string {
  return `${baseUrl}${seoHeroCardPath(opts.family, opts.key, opts.locale)}`;
}
