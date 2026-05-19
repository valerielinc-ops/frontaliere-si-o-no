/**
 * Shared HTML renderer for employer cards used across SEO landing-page plugins.
 * Two variants: `compact` (grid in profession/career/nursing/costOfLiving
 * landings) and `detailed` (weeklyEmployersPlugin company cards).
 *
 * Mirrors the visual language of jobCardHtml.ts — same Tailwind tokens
 * (`bg-surface-raised`, `border-edge`, `text-heading`, etc.), same logo
 * fallback chain via companyLogoResolver. Build plugins are scanned by
 * Tailwind (`./build-plugins/**\/*.{js,ts}` in tailwind.config.js) so every
 * class used here is preserved in the production CSS bundle.
 */
import {
  resolveJobLogoSrc,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from './companyLogoResolver';

export type EmployerCardLocale = 'it' | 'en' | 'de' | 'fr';

export type EmployerMetricTone =
  | 'default'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger';

export interface EmployerCardEmployer {
  name: string;
  companyKey?: string;
  companyDomain?: string;
  url?: string;
  logo?: string | null;
  openings?: number | null;
  city?: string | null;
  sector?: string | null;
  /** Ranking prefix (1, 2, 3) prepended to the title in the detailed variant. */
  rank?: number;
  /** Free-form second line in the detailed variant. Overrides the
   *  auto-built `city · sector` line when present. Used by weekly-employers
   *  pages to surface "city · +3 questa settimana"-style deltas. */
  subtitle?: string;
  /** Prominent right-side metric in the detailed variant (e.g. "5 posti").
   *  When set, takes priority over the implicit `openings` rendering. */
  metric?: string;
  /** Tone for the `metric` color in the detailed variant. */
  metricTone?: EmployerMetricTone;
}

export interface EmployerCardOptions {
  href: string;
  locale: EmployerCardLocale;
  variant?: 'compact' | 'detailed';
  openingsLabel?: (n: number) => string;
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OPENINGS_DEFAULT_LABEL: Record<EmployerCardLocale, (n: number) => string> = {
  it: (n) => (n === 1 ? '1 posto' : `${n} posti`),
  en: (n) => (n === 1 ? '1 opening' : `${n} openings`),
  de: (n) => (n === 1 ? '1 Stelle' : `${n} Stellen`),
  fr: (n) => (n === 1 ? '1 poste' : `${n} postes`),
};

const METRIC_TONE_CLASS: Record<EmployerMetricTone, string> = {
  default: 'text-link',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

function renderLogoSlot(e: EmployerCardEmployer, sizeClass: string): string {
  const safeAlt = escHtml(`Logo ${e.name}`);
  const logoSrc = resolveJobLogoSrc({
    company: e.name,
    companyKey: e.companyKey,
    companyDomain: e.companyDomain,
    url: e.url,
    logo: e.logo,
  });
  const fallbackSrc = e.name ? generateInitialsLogo(e.name) : LOGO_FALLBACK_SRC;
  const onerror = `this.onerror=null;this.src=&quot;${escHtml(fallbackSrc)}&quot;`;
  return `<div class="${sizeClass} rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0"><img alt="${safeAlt}" class="w-7 h-7 sm:w-9 sm:h-9 object-contain" width="40" height="40" loading="lazy" src="${escHtml(logoSrc)}" onerror="${onerror}"></div>`;
}

export function renderEmployerCardHtml(
  e: EmployerCardEmployer,
  opts: EmployerCardOptions,
): string {
  const variant = opts.variant ?? 'compact';
  const openingsLbl = opts.openingsLabel ?? OPENINGS_DEFAULT_LABEL[opts.locale];
  const openingsHtml = typeof e.openings === 'number' && e.openings > 0
    ? `<span class="font-bold text-accent tabular-nums shrink-0">${escHtml(String(e.openings))}</span>`
    : '';

  if (variant === 'detailed') {
    // Title with optional ranking prefix.
    const titleHtml = e.rank
      ? `<h3 class="text-sm sm:text-base font-bold font-display text-heading leading-tight"><span class="tabular-nums">${escHtml(String(e.rank))}.</span> ${escHtml(e.name)}</h3>`
      : `<h3 class="text-sm sm:text-base font-bold font-display text-heading leading-tight">${escHtml(e.name)}</h3>`;

    // Subtitle: explicit `subtitle` wins, else fall back to chips of sector + city.
    let subtitleHtml = '';
    if (e.subtitle) {
      subtitleHtml = `<p class="mt-1 text-xs sm:text-sm text-subtle leading-snug">${escHtml(e.subtitle)}</p>`;
    } else {
      const sectorChip = e.sector
        ? `<span class="px-1.5 py-0.5 rounded bg-surface-raised text-subtle text-xs">${escHtml(e.sector)}</span>`
        : '';
      const cityChip = e.city
        ? `<span class="text-xs text-subtle">${escHtml(e.city)}</span>`
        : '';
      if (sectorChip || cityChip) {
        subtitleHtml = `<div class="mt-1 flex flex-wrap items-center gap-2">${sectorChip}${cityChip}</div>`;
      }
    }

    // Metric: explicit `metric` wins, else fall back to localized openings line.
    let metricHtml = '';
    if (e.metric) {
      const toneClass = METRIC_TONE_CLASS[e.metricTone ?? 'default'];
      metricHtml = `<span class="shrink-0 ml-2 font-bold text-sm tabular-nums ${toneClass}">${escHtml(e.metric)}</span>`;
    } else if (typeof e.openings === 'number' && e.openings > 0) {
      metricHtml = `<p class="text-sm text-success font-semibold mt-1">${escHtml(openingsLbl(e.openings))}</p>`;
    }

    // Layout: when a metric is present we use a flex row (logo · title/subtitle · metric).
    // Otherwise we use the original stacked layout (logo+title above, openings line below).
    if (e.metric) {
      return `<article class="rounded-xl border border-edge bg-surface/50 hover:border-accent-border transition-colors p-3 sm:p-4"><a href="${escHtml(opts.href)}" class="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"><div class="flex items-center gap-3">${renderLogoSlot(e, 'w-12 h-12 sm:w-14 sm:h-14')}<div class="min-w-0 flex-1">${titleHtml}${subtitleHtml}</div>${metricHtml}</div></a></article>`;
    }
    return `<article class="rounded-xl border border-edge bg-surface/50 hover:border-accent-border transition-colors p-3 sm:p-4"><a href="${escHtml(opts.href)}" class="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"><div class="flex items-start gap-3">${renderLogoSlot(e, 'w-12 h-12 sm:w-14 sm:h-14')}<div class="min-w-0 flex-1">${titleHtml}${subtitleHtml}${metricHtml}</div></div></a></article>`;
  }

  // compact (default)
  return `<a href="${escHtml(opts.href)}" class="flex items-center gap-2.5 rounded-xl border border-edge bg-surface/50 p-3 hover:border-accent-border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-inherit no-underline">${renderLogoSlot(e, 'w-9 h-9 sm:w-10 sm:h-10')}<div class="flex-1 min-w-0"><div class="font-bold text-sm text-heading leading-tight truncate">${escHtml(e.name)}</div></div>${openingsHtml}</a>`;
}

export interface EmployerCardListItem {
  employer: EmployerCardEmployer;
  href: string;
}

export interface EmployerCardListOptions {
  locale: EmployerCardLocale;
  variant?: 'compact' | 'detailed';
  ulClassName?: string;
  emptyStateHtml?: string;
  openingsLabel?: (n: number) => string;
}

const DEFAULT_UL_COMPACT = 'list-none p-0 m-0 grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
const DEFAULT_UL_DETAILED = 'list-none p-0 m-0 grid gap-3';

export function renderEmployerCardListHtml(
  items: ReadonlyArray<EmployerCardListItem>,
  opts: EmployerCardListOptions,
): string {
  if (items.length === 0) return opts.emptyStateHtml ?? '';
  const variant = opts.variant ?? 'compact';
  const ulClass = opts.ulClassName ?? (variant === 'detailed' ? DEFAULT_UL_DETAILED : DEFAULT_UL_COMPACT);
  const cards = items
    .map(({ employer, href }) =>
      `<li>${renderEmployerCardHtml(employer, {
        href,
        locale: opts.locale,
        variant,
        openingsLabel: opts.openingsLabel,
      })}</li>`,
    )
    .join('');
  return `<ul role="list" class="${escHtml(ulClass)}">${cards}</ul>`;
}
