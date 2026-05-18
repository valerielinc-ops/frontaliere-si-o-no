/**
 * Shared inline-style constants and micro-renderers for SEO build plugins.
 *
 * All colors use CSS custom properties (`var(--color-*)`) defined in
 * `index.css` `:root` (light) and `html.dark` (dark) blocks. This ensures
 * every static SEO page automatically adapts to the user's dark-mode
 * preference without any extra work in individual plugins.
 *
 * Do NOT use Tailwind class strings here — Tailwind JIT does not scan
 * TypeScript files under `build-plugins/`. Inline styles are intentional.
 */

// ── Typography ────────────────────────────────────────────────────────────────

export const HERO_EYEBROW_STYLE =
  'margin:0 0 8px;color:var(--color-accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em';

export const H1_STYLE =
  'margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.75rem);line-height:1.15;color:var(--color-heading);font-weight:700';

export const LEDE_STYLE =
  'margin:0 0 14px;font-size:18px;line-height:1.55;color:var(--color-body);max-width:60ch';

export const BODY_STYLE =
  'margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:62ch';

export const H2_STYLE =
  'margin:2rem 0 1rem;font-size:1.75rem;line-height:1.2;color:var(--color-heading);font-weight:600';

export const H3_STYLE =
  'margin:1.5rem 0 0.75rem;font-size:1.25rem;line-height:1.3;color:var(--color-heading);font-weight:600';

/** For footer "correlati" eyebrows — semantically a `<p>`, visually small caps. */
export const SMALL_HEADING_STYLE =
  'margin:0 0 6px;font-size:12px;font-weight:700;color:var(--color-subtle);text-transform:uppercase;letter-spacing:0.05em';

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * Container style — rely on `main.seo-static-content` CSS added in PR2.
 * No inline wrapper needed; this constant is intentionally empty.
 */
export const CONTAINER_STYLE = '';

export const BREADCRUMB_STYLE =
  'margin:0 0 14px;font-size:13px;color:var(--color-subtle)';

export const BREADCRUMB_LINK_STYLE =
  'color:var(--color-link);text-decoration:none';

// ── Cards ─────────────────────────────────────────────────────────────────────

/**
 * Card visual style WITHOUT padding — use when you need a custom inset
 * (e.g. a wider section card) to avoid a duplicate `padding:` declaration
 * in the rendered inline style.
 */
export const CARD_BODY_STYLE =
  'border:1px solid var(--color-edge);border-radius:14px;background:var(--color-surface);color:var(--color-body)';

/** Default card padding (14px vertical, 16px horizontal). */
export const CARD_PADDING_STYLE = 'padding:14px 16px';

/** Standard card style: default padding + body. Safe default for most callers. */
export const CARD_STYLE = `${CARD_PADDING_STYLE};${CARD_BODY_STYLE}`;

// ── Stat tiles ────────────────────────────────────────────────────────────────

/** Neutral stat tile (replaces hard-coded #f1f5f9/#cbd5e1). */
export const STAT_TILE_BASE =
  'padding:18px;border-radius:16px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body)';

/** Accent (indigo) stat tile (replaces #eef2ff/#c7d2fe). */
export const STAT_TILE_ACCENT =
  'padding:18px;border-radius:16px;background:var(--color-accent-subtle);border:1px solid var(--color-accent-border);color:var(--color-heading)';

/** Success (green) stat tile (replaces #ecfccb/#bef264 / #ecfdf5). */
export const STAT_TILE_SUCCESS =
  'padding:18px;border-radius:16px;background:var(--color-success-subtle);border:1px solid var(--color-success-border);color:var(--color-heading)';

/** Warning (amber) stat tile (replaces #fef3c7/#fde68a). */
export const STAT_TILE_WARNING =
  'padding:18px;border-radius:16px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border);color:var(--color-heading)';

/** Danger (red) stat tile (replaces #fef2f2/#fecaca). */
export const STAT_TILE_DANGER =
  'padding:18px;border-radius:16px;background:var(--color-danger-subtle);border:1px solid var(--color-danger-border);color:var(--color-heading)';

export const STAT_TILE_LABEL =
  'font-size:12px;color:var(--color-subtle);font-weight:700;text-transform:uppercase;letter-spacing:0.04em';

export const STAT_TILE_VALUE =
  'margin-top:8px;font-size:28px;font-weight:700;color:var(--color-heading);line-height:1.1';

// ── Links / CTAs ──────────────────────────────────────────────────────────────

export const CTA_PRIMARY_STYLE =
  'display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:10px;background:var(--color-accent);color:var(--color-on-accent);text-decoration:none;font-weight:600';

export const LINK_INHERIT_STYLE =
  'color:inherit;text-decoration:none;display:block';

export const LINK_ACCENT_STYLE =
  'color:var(--color-link);text-decoration:none';

// ── Tables ────────────────────────────────────────────────────────────────────

export const TABLE_STYLE =
  'width:100%;border-collapse:collapse;margin:1rem 0';

export const TABLE_HEAD_STYLE =
  'text-align:left;padding:10px 12px;font-size:13px;font-weight:700;color:var(--color-subtle);border-bottom:2px solid var(--color-edge);background:var(--color-surface-alt)';

export const TABLE_CELL_STYLE =
  'padding:10px 12px;border-bottom:1px solid var(--color-edge);color:var(--color-body);font-size:14px';

// ── SEO title / H1 utilities (Phase 3A) ───────────────────────────────────────
//
// Semrush W2 (issue 102) flagged 954 SEO landing pages with `<title>` longer
// than 60 characters; W3 (issue 105) flagged 458 pages where `<h1>` and
// `<title>` were textually identical. Both signals hurt SERP CTR.
//
// `formatSeoTitle` builds a keyword-first title string clamped to a target
// budget (default 60). It drops the optional fields in this order when the
// composition exceeds the budget: `qualifier` → `year` → `count` → `location`.
// `keyword` is mandatory and never dropped — if even the keyword alone is
// longer than the budget it is returned unmodified (the caller rendered too
// long a noun and we do not silently truncate).
//
// `clampSiteSuffix` appends a "| {brand}" suffix only when it still fits
// inside the budget, removing the long-tail brand bloat that pushed many
// titles past 60 chars (e.g. `… | Frontaliere Ticino`).
//
// `formatSeoH1` returns a narrative H1 that intentionally re-orders the same
// pieces so it is never a literal duplicate of the title. The H1 is meant for
// users (no length budget); the title is keyword-first for the SERP snippet.

export interface SeoTitleParts {
  /** Mandatory keyword/topic phrase (e.g. "Lavoro Case Anziani"). */
  readonly keyword: string;
  /** Optional location (e.g. "Ticino", "Lugano"). */
  readonly location?: string;
  /** Optional 4-digit year as string (e.g. "2026"). */
  readonly year?: string;
  /** Optional count (e.g. 990 active openings). */
  readonly count?: number;
  /** Optional trailing qualifier (e.g. "990 offerte", "47 datori (W17)"). */
  readonly qualifier?: string;
  /** Target maximum length, defaults to 60. */
  readonly maxLength?: number;
}

const DEFAULT_TITLE_BUDGET = 60;

function squashSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function joinTitleParts(
  keyword: string,
  location: string | undefined,
  year: string | undefined,
  count: number | undefined,
  qualifier: string | undefined,
): string {
  const head = [keyword, location, year].filter((p): p is string => Boolean(p && p.trim().length > 0)).join(' ');
  const tailParts: string[] = [];
  if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
    tailParts.push(`${count} offerte`);
  }
  if (qualifier && qualifier.trim().length > 0) {
    tailParts.push(qualifier.trim());
  }
  const tail = tailParts.join(' · ');
  if (!tail) return squashSpaces(head);
  return squashSpaces(`${head} — ${tail}`);
}

/**
 * Build an SEO `<title>` string clamped to `maxLength` (default 60 char).
 *
 * Composition order: `{keyword} {location} {year} — {count?} · {qualifier?}`.
 * When the composition is too long we drop optional fields in this priority:
 * `qualifier` → `year` → `count` → `location`. `keyword` is always preserved.
 * Strips any leading emoji / symbol characters from the keyword to keep the
 * SERP snippet clean (no `🔥` prefix per Semrush W2 guidance).
 */
export function formatSeoTitle(parts: SeoTitleParts): string {
  const budget = parts.maxLength ?? DEFAULT_TITLE_BUDGET;
  // Strip leading emoji / non-alphanumeric prefix from the keyword.
  const keyword = squashSpaces(
    String(parts.keyword || '')
      .replace(/^[\s\p{Extended_Pictographic}\p{S}\p{P}]+/u, '')
      .replace(/^[\s]+/, ''),
  );
  if (!keyword) return '';

  const candidates: Array<() => string> = [
    () => joinTitleParts(keyword, parts.location, parts.year, parts.count, parts.qualifier),
    () => joinTitleParts(keyword, parts.location, parts.year, parts.count, undefined),
    () => joinTitleParts(keyword, parts.location, undefined, parts.count, undefined),
    () => joinTitleParts(keyword, parts.location, undefined, undefined, undefined),
    () => joinTitleParts(keyword, undefined, undefined, undefined, undefined),
  ];

  for (const build of candidates) {
    const out = build();
    if (out.length <= budget) return out;
  }

  // Even the bare keyword overflows — return it as-is (no silent truncation).
  return keyword;
}

/**
 * Append a `" | {siteSuffix}"` site-name suffix to `base`. The suffix is
 * ALWAYS appended, even when the combined string overflows `maxLength` —
 * truncating the base risks collapsing distinct pages to the same `<title>`
 * (Semrush "Duplicate <title>" rule, deploy-blocking) when the unique
 * disambiguator (city name, canton label, address number, age bucket,
 * week/month) lives at the END of the headline. Going slightly past the
 * SERP-display budget is a softer issue ("title too long" is a soft
 * warning, never a deploy gate).
 *
 * `maxLength` is therefore advisory: callers that genuinely need to fit
 * inside the budget MUST shorten `base` themselves before calling. The
 * function still skips appending the suffix when `siteSuffix` is empty,
 * matching the original contract.
 */
export function clampSiteSuffix(
  base: string,
  siteSuffix: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- advisory only
  _maxLength: number = DEFAULT_TITLE_BUDGET,
): string {
  const baseTrim = (base || '').trim();
  const suffixTrim = (siteSuffix || '').trim();
  if (!suffixTrim) return baseTrim;
  return `${baseTrim} | ${suffixTrim}`;
}

export interface SeoH1Parts {
  /** Mandatory user-facing keyword (e.g. "Case Anziani", "Lugano"). */
  readonly keyword: string;
  /** Optional location, e.g. "Ticino". */
  readonly location?: string;
  /** Optional count to weave into the narrative ("990 offerte attive..."). */
  readonly count?: number;
  /**
   * Locale-aware narrative template selector. Only `it`/`en`/`de`/`fr` are
   * supported; unknown locales fall back to `it`.
   */
  readonly locale?: 'it' | 'en' | 'de' | 'fr';
  /**
   * Narrative noun used in the count phrase (e.g. "offerte", "openings",
   * "Stellen", "offres"). When omitted a sensible per-locale default is used.
   */
  readonly noun?: string;
  /** Optional title to compare against — when equal we add a small variant. */
  readonly title?: string;
}

const H1_DEFAULT_NOUN: Record<NonNullable<SeoH1Parts['locale']>, string> = {
  it: 'offerte attive',
  en: 'active openings',
  de: 'aktive Stellen',
  fr: 'offres actives',
};

const H1_PREP_IN: Record<NonNullable<SeoH1Parts['locale']>, string> = {
  it: 'in',
  en: 'in',
  de: 'in',
  fr: 'au',
};

/**
 * Build a user-facing H1 string that is intentionally narrative — and never a
 * literal duplicate of the matching SEO title.
 *
 * When both `count` and `keyword` are present the H1 leads with the count
 * (e.g. `"990 offerte attive per Case Anziani in Ticino"`), giving a clear
 * narrative signal to the user. Otherwise the H1 is just the keyword + location.
 *
 * If the resulting H1 ends up identical to `title` (case-insensitive) we
 * append a ` ·` separator + count fragment so the strings differ — the
 * `h1-not-equal-title` test asserts strict inequality after both strings are
 * normalised, so a structural variant is enough.
 */
export function formatSeoH1(parts: SeoH1Parts): string {
  const locale = (parts.locale ?? 'it') as NonNullable<SeoH1Parts['locale']>;
  const keyword = squashSpaces(String(parts.keyword || ''));
  const location = parts.location ? squashSpaces(parts.location) : '';
  const noun = parts.noun || H1_DEFAULT_NOUN[locale];
  const prep = H1_PREP_IN[locale];

  let h1: string;
  if (typeof parts.count === 'number' && Number.isFinite(parts.count) && parts.count > 0) {
    const inLoc = location ? ` ${prep} ${location}` : '';
    if (locale === 'en') {
      h1 = `${parts.count} ${noun} for ${keyword}${inLoc}`;
    } else if (locale === 'de') {
      h1 = `${parts.count} ${noun} ${keyword}${inLoc}`;
    } else if (locale === 'fr') {
      h1 = `${parts.count} ${noun} pour ${keyword}${inLoc}`;
    } else {
      h1 = `${parts.count} ${noun} per ${keyword}${inLoc}`;
    }
  } else {
    h1 = location ? `${keyword} ${prep} ${location}` : keyword;
  }
  h1 = squashSpaces(h1);

  // Ensure h1 differs from the title (Semrush W3, issue 105).
  if (parts.title && squashSpaces(parts.title).toLowerCase() === h1.toLowerCase()) {
    h1 = `${h1} · ${noun}`;
  }
  return h1;
}

/**
 * Per-locale "guida frontaliere" tag appended to an H1 when it would
 * otherwise collide with the page <title> after the brand suffix gets
 * dropped by `buildTitleWithBrand` (headline + brand > 66 chars).
 *
 * Used by `differentiateH1FromTitle` — see its docstring for the full
 * rationale (Semrush "Duplicate H1 and title tags", deploy-blocking
 * `audit:h1-title-duplicates`).
 */
const H1_DIFFERENTIATOR_TAG: Record<'it' | 'en' | 'de' | 'fr', string> = {
  it: 'guida frontaliere',
  en: 'cross-border guide',
  de: 'Grenzgänger-Leitfaden',
  fr: 'guide frontalier',
};

/**
 * Guarantee the visible H1 string differs from the page `<title>`.
 *
 * Why this exists: `buildTitleWithBrand` drops the
 * " | Frontaliere Ticino" brand suffix when the headline alone already
 * fills the 66-char SERP cap. When that happens the final `<title>`
 * becomes byte-identical to the matching `<h1>` — Semrush flags this
 * as "Duplicate H1 and title tags" and the deploy-blocking
 * `audit:h1-title-duplicates` ratchet (baseline 0) refuses the build.
 *
 * The fix: when title (after brand-strip) ≡ h1 (case-insensitive,
 * whitespace-collapsed), append a small locale-aware narrative tag in
 * parentheses. The tag is keyword-relevant (frontaliere context), short
 * enough to not push the H1 line into a wrap on mobile, and never
 * applied when the strings already differ. No effect on the `<title>`.
 *
 * @param h1     Original visible H1 string from the plugin.
 * @param title  The corresponding `<title>` string (may include the
 *               brand suffix; we strip it before comparison so the
 *               check matches the audit's normalisation).
 * @param locale Page locale — drives the appended tag.
 * @returns      H1 string that is guaranteed to differ from `title`.
 */
export function differentiateH1FromTitle(
  h1: string,
  title: string,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  const safeH1 = squashSpaces(String(h1 || ''));
  const safeTitle = squashSpaces(String(title || '')).replace(
    /\s*[|·]\s*Frontaliere Ticino\s*$/i,
    '',
  ).trim();
  if (!safeH1 || !safeTitle) return safeH1;
  if (safeH1.toLowerCase() !== safeTitle.toLowerCase()) return safeH1;
  const tag = H1_DIFFERENTIATOR_TAG[locale] ?? H1_DIFFERENTIATOR_TAG.it;
  return `${safeH1} (${tag})`;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

/**
 * HTML-escape helper — equivalent to PHP's `htmlspecialchars`.
 * Exported so each plugin can drop its own identical local `esc()`.
 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Brand-logo resolver (F3) ──────────────────────────────────────────────────
//
// Centralised check for a local brand logo at `public/images/brands/{slug}.png`.
// Used by the fuel-daily, weekly-employers and job-market-snapshot plugins to
// decide whether to render a real logo in `renderEntityCard` or fall back to
// the neutral icon bubble. No network access, no asset generation.
//
// Memoised per-slug to keep build time O(1) regardless of how many cards
// reference the same brand.

import * as _fs from 'node:fs';
import * as _path from 'node:path';

const _brandLogoCache = new Map<string, string | null>();

/**
 * Return the public URL for a self-hosted company logo if one exists on disk,
 * or `null` otherwise. Memoises per slug.
 *
 * Lookup order:
 *   1. `data/company-logos-manifest.json` (generated by
 *      `scripts/download-company-logos.mjs`) — supports any extension and
 *      pre-resolved paths under `/images/logos/...` for the curated SVGs.
 *   2. Legacy `public/images/brands/{slug}.{png,svg,jpg,jpeg,ico,gif,webp}`
 *      probe so manually-dropped files keep working without a manifest.
 *
 * `slug` is normalised (lowercased, non-[a-z0-9-] stripped). An empty or
 * non-string slug returns `null`.
 */
const _BRAND_EXT_PROBE = ['png', 'svg', 'jpg', 'jpeg', 'ico', 'gif', 'webp'] as const;
let _manifestCache: Record<string, string> | null = null;
function loadManifest(rootDir: string): Record<string, string> {
  if (_manifestCache) return _manifestCache;
  try {
    const raw = _fs.readFileSync(
      _path.join(rootDir, 'data', 'company-logos-manifest.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, string>;
    _manifestCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    _manifestCache = {};
  }
  return _manifestCache;
}

export function resolveBrandLogoUrl(
  rootDir: string,
  slug: string | null | undefined,
): string | null {
  if (!slug) return null;
  const normalised = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalised) return null;
  const cacheKey = `${rootDir}::${normalised}`;
  const cached = _brandLogoCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const manifest = loadManifest(rootDir);
  const manifestPath = manifest[normalised];
  if (manifestPath) {
    _brandLogoCache.set(cacheKey, manifestPath);
    return manifestPath;
  }

  for (const ext of _BRAND_EXT_PROBE) {
    const fsPath = _path.join(rootDir, 'public', 'images', 'brands', `${normalised}.${ext}`);
    if (_fs.existsSync(fsPath)) {
      const url = `/images/brands/${normalised}.${ext}`;
      _brandLogoCache.set(cacheKey, url);
      return url;
    }
  }

  _brandLogoCache.set(cacheKey, null);
  return null;
}

/**
 * Render an accessible breadcrumb nav.
 *
 * @param items - Ordered crumbs. The last item is the current page (no link).
 */
export function renderBreadcrumb(
  items: ReadonlyArray<{ label: string; href?: string }>,
): string {
  const parts = items.map((item, i) => {
    const isLast = i === items.length - 1;
    if (isLast || !item.href) {
      return `<span>${esc(item.label)}</span>`;
    }
    return `<a href="${esc(item.href)}" style="${BREADCRUMB_LINK_STYLE}">${esc(item.label)}</a>`;
  });
  return `<nav aria-label="breadcrumb" style="${BREADCRUMB_STYLE}">${parts.join('<span> / </span>')}</nav>`;
}

/**
 * Render a card — optionally wrapped in an anchor.
 *
 * If `href` is provided the card becomes a `<a class="seo-card-link">` with
 * hover-capable styling (`.seo-card-link` CSS is in `index.css`).
 */
export function renderCard(
  innerHtml: string,
  href?: string,
  extraStyle?: string,
): string {
  const style = extraStyle ? `${CARD_STYLE};${extraStyle}` : CARD_STYLE;
  if (href) {
    return `<a href="${esc(href)}" class="seo-card-link" style="${style};${LINK_INHERIT_STYLE}">${innerHtml}</a>`;
  }
  return `<div style="${style}">${innerHtml}</div>`;
}

export type StatTileTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/**
 * Render a single stat tile with a label + prominent value.
 *
 * @param label - Small-caps label above the value.
 * @param value - The prominent metric string.
 * @param tone  - Visual tone (accent = indigo default, neutral, success, warning, danger).
 */
export function renderStatTile(
  label: string,
  value: string,
  tone: StatTileTone = 'accent',
): string {
  const tileStyle =
    tone === 'neutral'
      ? STAT_TILE_BASE
      : tone === 'success'
      ? STAT_TILE_SUCCESS
      : tone === 'warning'
      ? STAT_TILE_WARNING
      : tone === 'danger'
      ? STAT_TILE_DANGER
      : STAT_TILE_ACCENT;

  return `<div style="${tileStyle}">
  <div style="${STAT_TILE_LABEL}">${esc(label)}</div>
  <div style="${STAT_TILE_VALUE}">${esc(value)}</div>
</div>`;
}

/**
 * Render a responsive grid of stat tiles.
 */
export function renderStatGrid(
  tiles: ReadonlyArray<{ label: string; value: string; tone?: StatTileTone }>,
): string {
  const items = tiles.map((t) => renderStatTile(t.label, t.value, t.tone)).join('');
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">${items}</div>`;
}

/**
 * Render a "Correlati" footer link column.
 *
 * Uses `SMALL_HEADING_STYLE` for the title (a `<p>`, NOT an `<h3>`) to avoid
 * semantic heading inflation in the footer.
 */
export function renderFooterLinkColumn(
  title: string,
  links: ReadonlyArray<{ label: string; href: string }>,
): string {
  const items = links
    .map(
      (l) =>
        `<li style="margin:0;padding:0"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE};display:inline-block;padding:6px 0;font-weight:600">${esc(l.label)} →</a></li>`,
    )
    .join('');
  return `<div>
  <p style="${SMALL_HEADING_STYLE}">${esc(title)}</p>
  <ul style="list-style:none;padding:0;margin:0">${items}</ul>
</div>`;
}

// ── Entity card (F3) ──────────────────────────────────────────────────────────

/**
 * Visual tone for the right-side metric in an entity card.
 *  - `default` → neutral link color.
 *  - `accent`  → indigo (used for prices / headline values).
 *  - `success` → green.
 *  - `warning` → amber.
 *  - `danger`  → red.
 */
export type EntityCardMetricTone =
  | 'default'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger';

export interface EntityCardOpts {
  /** When present, wrapper is an `<a>`; else a `<div>`. */
  readonly href?: string;
  /** Absolute path (e.g. `/images/brands/acme.png`). */
  readonly logoUrl?: string;
  /** Alt text for the `<img>`. Required when `logoUrl` is provided. */
  readonly logoAlt?: string;
  /** Inline `onerror` handler for the logo `<img>`. Enables Clearbit → favicon → placeholder fallback chain. */
  readonly logoOnerror?: string;
  /** Inline SVG markup used when there is no `logoUrl` (24×24 stroke icon). */
  readonly iconSvg?: string;
  /** Card heading. */
  readonly title: string;
  /** Optional second line (address, city, sector, …). */
  readonly subtitle?: string;
  /** Optional right-side metric (e.g. "1.790 CHF/litro"). */
  readonly metric?: string;
  /** Color tone for `metric`. Defaults to `default`. */
  readonly metricTone?: EntityCardMetricTone;
}

const ENTITY_CARD_BUBBLE_STYLE =
  'display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:var(--color-surface-alt);color:var(--color-subtle);flex-shrink:0;font-weight:700;font-size:16px;overflow:hidden';

const ENTITY_CARD_METRIC_VAR: Record<EntityCardMetricTone, string> = {
  default: 'var(--color-link)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
};

function renderEntityCardVisual(opts: EntityCardOpts): string {
  if (opts.logoUrl) {
    const alt = opts.logoAlt ?? opts.title;
    const onerrorAttr = opts.logoOnerror ? ` onerror="${opts.logoOnerror}"` : '';
    return `<img src="${esc(opts.logoUrl)}" alt="${esc(alt)}" width="40" height="40" loading="lazy" decoding="async"${onerrorAttr} style="display:block;width:40px;height:40px;border-radius:10px;object-fit:contain;background:var(--color-surface-alt);flex-shrink:0">`;
  }
  if (opts.iconSvg) {
    // Inline SVG already sized 24×24 by the caller; wrap in the neutral bubble.
    return `<span aria-hidden="true" style="${ENTITY_CARD_BUBBLE_STYLE}">${opts.iconSvg}</span>`;
  }
  const initial = (opts.title || '?').trim().charAt(0).toUpperCase();
  return `<span aria-hidden="true" style="${ENTITY_CARD_BUBBLE_STYLE}">${esc(initial)}</span>`;
}

/**
 * Render a reusable entity card (fuel station, company, sector, …).
 *
 * The card is a flex row: logo/icon (40×40) ▸ title+subtitle ▸ optional metric.
 * When `href` is provided the wrapper becomes an `<a class="seo-entity-card">`
 * with hover/focus styling defined in `index.css`; otherwise a neutral `<div>`.
 *
 * All text is HTML-escaped via `esc()`; `iconSvg` is trusted markup (caller
 * responsibility — only internal constants should be passed).
 */
export function renderEntityCard(opts: EntityCardOpts): string {
  const visual = renderEntityCardVisual(opts);
  const titleHtml = `<div style="font-weight:700;font-size:15px;color:var(--color-heading);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(opts.title)}</div>`;
  const subtitleHtml = opts.subtitle
    ? `<div style="margin-top:2px;font-size:13px;color:var(--color-subtle);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(opts.subtitle)}</div>`
    : '';
  const middle = `<div style="flex:1;min-width:0">${titleHtml}${subtitleHtml}</div>`;
  const tone = opts.metricTone ?? 'default';
  const metricColor = ENTITY_CARD_METRIC_VAR[tone];
  const metricHtml = opts.metric
    ? `<div style="flex-shrink:0;color:${metricColor};font-weight:700;font-size:14px;white-space:nowrap">${esc(opts.metric)}</div>`
    : '';
  const inner = `${visual}${middle}${metricHtml}`;
  const style = `display:flex;align-items:center;gap:12px;${CARD_PADDING_STYLE};${CARD_BODY_STYLE}`;
  if (opts.href) {
    return `<a class="seo-entity-card" href="${esc(opts.href)}" style="${style};text-decoration:none">${inner}</a>`;
  }
  return `<div class="seo-entity-card" style="${style}">${inner}</div>`;
}

/**
 * Inline "building-2" (lucide-style) icon for companies/employers.
 * Sized 24×24; `stroke="currentColor"` so it inherits the enclosing text
 * color (var(--color-subtle) inside the neutral bubble).
 */
export const ICON_BUILDING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>';

/**
 * Inline "fuel" (lucide-style) pump icon for fuel stations.
 * Sized 24×24; inherits current color.
 */
export const ICON_FUEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="3" x2="15" y1="22" y2="22"/><line x1="4" x2="14" y1="9" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/></svg>';

/** Inline lucide "trophy" icon — used for ranking chips. 16×16, currentColor stroke. */
export const ICON_TROPHY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';

/** Inline lucide "map-pin" icon — used for location actions. 16×16. */
export const ICON_MAP_PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';

/** Inline lucide "navigation" arrow — used for Waze / driving direction actions. 16×16. */
export const ICON_NAVIGATION_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';

/** Inline lucide "bar-chart-3" icon — used for ranking/leaderboard actions. 16×16. */
export const ICON_BAR_CHART_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>';

// ── Discover-more CTA block ───────────────────────────────────────────────────

const DISCOVER_MORE_HEADING: Record<string, string> = {
  it: 'Scopri di più',
  en: 'Discover more',
  de: 'Mehr entdecken',
  fr: 'Découvrir plus',
};

/**
 * Render a "Scopri di più" (Discover more) section with 3 feature-specific
 * CTA links. Each plugin passes its own curated list so users see relevant
 * next steps instead of generic/affiliate-feel suggestions.
 *
 * @param locale  - Page locale (it/en/de/fr).
 * @param ctas    - Ordered list of exactly 3 CTAs. Excess items are silently
 *                  truncated; fewer than 3 are shown as-is.
 */
export function renderDiscoverMore(
  locale: string,
  ctas: ReadonlyArray<{ title: string; href: string }>,
): string {
  if (!ctas || ctas.length === 0) return '';
  const heading = DISCOVER_MORE_HEADING[locale] ?? DISCOVER_MORE_HEADING['it'];
  const items = ctas.slice(0, 3)
    .map(
      (cta) =>
        `<li style="margin:0;padding:0"><a href="${esc(cta.href)}" style="${LINK_ACCENT_STYLE};display:inline-block;padding:8px 0;font-weight:600;font-size:15px">${esc(cta.title)} →</a></li>`,
    )
    .join('');
  return `<section style="margin:32px 0 0;padding:20px 24px;${CARD_BODY_STYLE}" aria-label="${esc(heading)}">
  <p style="${SMALL_HEADING_STYLE}">${esc(heading)}</p>
  <ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:2px">${items}</ul>
</section>`;
}

// ── Sparkline chart ───────────────────────────────────────────────────────────
//
// Inline, JavaScript-free SVG trend chart used by fuel-daily pages (F6) and
// any future SEO page that needs a lightweight 7–30 point time series. All
// colors bind to the semantic `--color-chart-*` tokens defined in index.css
// so the chart follows the user's dark-mode preference without duplication.
//
// Rendering contract:
//  - If fewer than 2 numeric data points are available, return `''` so the
//    caller can omit the chart section entirely (no empty axis).
//  - Filled area + smooth line + one circle per point + a dashed horizontal
//    line at the period average (excluding null points from the mean).
//  - `role="img"` with an `aria-label` that communicates period + delta in
//    the caller's locale; the caller composes the sentence.

export interface SparklinePoint {
  /** ISO date (YYYY-MM-DD) — used only for the x-axis tick labels. */
  readonly date: string;
  /** CHF/litre (or any scalar). Null when no snapshot was recorded. */
  readonly value: number | null;
}

export interface SparklineChartOptions {
  /** Accessible label for screen readers (period + delta in the page locale). */
  readonly ariaLabel: string;
  /** Pixel height of the rendered SVG (default 110, clamped to [80, 160]). */
  readonly height?: number;
  /** Pixel width reference; the SVG uses responsive viewBox so this is only a hint (default 720). */
  readonly width?: number;
  /** Format a numeric value for the aria-hidden tick labels (e.g. "2,149"). */
  readonly formatValue?: (v: number) => string;
}

/**
 * Render an inline-SVG sparkline chart from a series of day/value points.
 *
 * Returns an empty string when the series has fewer than three numeric points —
 * callers must render a locale-aware fallback in that case (a two-point chart
 * would be visually uninformative and invites "where's the history?" bounces).
 */
export function renderSparklineChart(
  points: ReadonlyArray<SparklinePoint>,
  opts: SparklineChartOptions,
): string {
  const numeric = points.filter(
    (p): p is { date: string; value: number } =>
      typeof p.value === 'number' && Number.isFinite(p.value),
  );
  if (numeric.length < 3) return '';

  const height = Math.max(180, Math.min(260, opts.height ?? 220));
  const width = Math.max(480, Math.min(880, opts.width ?? 720));
  // Padding leaves room for the dashed average label on the right and circle radii.
  const padX = 8;
  const padTop = 12;
  const padBottom = 24;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;

  const values = numeric.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // Pad the y-range by 10% of the span (or a small epsilon when series is flat)
  // so the line doesn't sit flush against the top/bottom edges.
  const pad = span > 0 ? span * 0.1 : Math.max(0.01, Math.abs(max) * 0.02);
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin || 1;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;

  // Map each point to plot coordinates. Points are evenly spaced in X even
  // when some intermediate days are missing — this keeps the chart compact
  // and honest about the gaps via the circle markers' absence.
  const n = points.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const coords = points.map((p, i) => {
    const x = padX + i * xStep;
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
      return { x, y: null as number | null, value: null, date: p.date };
    }
    const y = padTop + (1 - (p.value - yMin) / yRange) * plotH;
    return { x, y, value: p.value, date: p.date };
  });

  // Build the line path — jumping over null points. We treat each contiguous
  // numeric sub-series as its own M/L chain so Safari doesn't draw phantom
  // segments through the gaps.
  const pathSegments: string[] = [];
  let current = '';
  for (const c of coords) {
    if (c.y === null) {
      if (current) {
        pathSegments.push(current);
        current = '';
      }
      continue;
    }
    if (!current) {
      current = `M${c.x.toFixed(1)} ${c.y.toFixed(1)}`;
    } else {
      current += ` L${c.x.toFixed(1)} ${c.y.toFixed(1)}`;
    }
  }
  if (current) pathSegments.push(current);
  const linePath = pathSegments.join(' ');

  // Build the filled area — only for contiguous runs of ≥2 points so we don't
  // invent data under a gap.
  const areaSegments: string[] = [];
  let runStart: { x: number; y: number } | null = null;
  let run: string[] = [];
  for (const c of coords) {
    if (c.y !== null) {
      if (runStart === null) {
        runStart = { x: c.x, y: c.y };
        run = [`M${c.x.toFixed(1)} ${c.y.toFixed(1)}`];
      } else {
        run.push(`L${c.x.toFixed(1)} ${c.y.toFixed(1)}`);
      }
    } else if (runStart !== null) {
      if (run.length >= 2) {
        const last = coords.slice(0, coords.indexOf(c)).filter((p) => p.y !== null).pop();
        if (last) {
          run.push(
            `L${last.x.toFixed(1)} ${(padTop + plotH).toFixed(1)}`,
            `L${runStart.x.toFixed(1)} ${(padTop + plotH).toFixed(1)}`,
            'Z',
          );
          areaSegments.push(run.join(' '));
        }
      }
      runStart = null;
      run = [];
    }
  }
  if (runStart !== null && run.length >= 2) {
    // Close final run.
    const last = coords.filter((p) => p.y !== null).pop();
    if (last) {
      run.push(
        `L${last.x.toFixed(1)} ${(padTop + plotH).toFixed(1)}`,
        `L${runStart.x.toFixed(1)} ${(padTop + plotH).toFixed(1)}`,
        'Z',
      );
      areaSegments.push(run.join(' '));
    }
  }
  const areaPath = areaSegments.join(' ');

  // Average reference line (horizontal, dashed).
  const avgY = padTop + (1 - (avg - yMin) / yRange) * plotH;
  const avgLabel = opts.formatValue ? opts.formatValue(avg) : avg.toFixed(3);

  // Grid line at top and bottom of the plot — very subtle, purely decorative.
  const gridTop = padTop;
  const gridBottom = padTop + plotH;

  const circles = coords
    .filter((c): c is { x: number; y: number; value: number; date: string } => c.y !== null)
    .map(
      (c) =>
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="var(--color-chart-dot)" stroke="var(--color-surface)" stroke-width="1.5"><title>${esc(c.date)}: ${esc(
          opts.formatValue ? opts.formatValue(c.value) : c.value.toFixed(3),
        )}</title></circle>`,
    )
    .join('');

  // Tick labels: only first and last date, to keep the chart uncluttered.
  const first = coords[0];
  const last = coords[coords.length - 1];
  const tickStyle =
    'font:11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:var(--color-chart-label);font-variant-numeric:tabular-nums';

  return `<svg role="img" aria-label="${esc(opts.ariaLabel)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-width:${width}px;height:auto;display:block;overflow:visible">
  <line x1="${padX}" x2="${width - padX}" y1="${gridTop}" y2="${gridTop}" stroke="var(--color-chart-grid)" stroke-width="1"></line>
  <line x1="${padX}" x2="${width - padX}" y1="${gridBottom}" y2="${gridBottom}" stroke="var(--color-chart-grid)" stroke-width="1"></line>
  ${areaPath ? `<path d="${areaPath}" fill="var(--color-chart-area)" opacity="0.35"></path>` : ''}
  <line x1="${padX}" x2="${width - padX}" y1="${avgY.toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="var(--color-chart-tick)" stroke-width="1" stroke-dasharray="4 4"></line>
  <text x="${(width - padX).toFixed(0)}" y="${Math.max(padTop + 10, avgY - 4).toFixed(1)}" text-anchor="end" style="${tickStyle}">⌀ ${esc(avgLabel)}</text>
  ${linePath ? `<path d="${linePath}" fill="none" stroke="var(--color-chart-line)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>` : ''}
  ${circles}
  <text x="${first.x.toFixed(0)}" y="${(height - 4).toFixed(0)}" text-anchor="start" style="${tickStyle}">${esc(first.date)}</text>
  <text x="${last.x.toFixed(0)}" y="${(height - 4).toFixed(0)}" text-anchor="end" style="${tickStyle}">${esc(last.date)}</text>
</svg>`;
}
