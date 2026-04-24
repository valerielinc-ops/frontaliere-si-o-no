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
