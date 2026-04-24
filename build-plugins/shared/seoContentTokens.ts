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

export const CARD_STYLE =
  'padding:14px 16px;border:1px solid var(--color-edge);border-radius:14px;background:var(--color-surface);color:var(--color-body)';

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
  return `<section style="margin:32px 0 0;padding:20px 24px;${CARD_STYLE}" aria-label="${esc(heading)}">
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
 * Returns an empty string when the series has fewer than two numeric points —
 * callers must skip their surrounding markup in that case.
 */
export function renderSparklineChart(
  points: ReadonlyArray<SparklinePoint>,
  opts: SparklineChartOptions,
): string {
  const numeric = points.filter(
    (p): p is { date: string; value: number } =>
      typeof p.value === 'number' && Number.isFinite(p.value),
  );
  if (numeric.length < 2) return '';

  const height = Math.max(80, Math.min(160, opts.height ?? 110));
  const width = Math.max(240, opts.width ?? 720);
  // Padding leaves room for the dashed average label on the right and circle radii.
  const padX = 8;
  const padTop = 8;
  const padBottom = 18;
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

  return `<svg role="img" aria-label="${esc(opts.ariaLabel)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block;overflow:visible">
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
