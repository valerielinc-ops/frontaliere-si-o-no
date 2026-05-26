/**
 * Shared HTML renderer for job cards used across SEO landing-page plugins.
 *
 * Mirrors the in-app `<JobCard>` component (components/community/JobBoard.tsx)
 * pixel-for-pixel by reusing the same Tailwind utility classes. The static
 * pages already include the production CSS bundle (`/assets/index-*.css`)
 * which is built from the SPA source — so every class referenced here is
 * already present in that bundle. Build-plugin source files are *not* scanned
 * by the Tailwind JIT, so we must only use class names that appear at least
 * once in the SPA source (and the JobCard component covers all of them).
 *
 * Used by:
 *  - jobsSeoPagesPlugin       (employer hubs / city pages / search pages)
 *  - jobSectorPagesPlugin     (sector hubs: case-anziani, infermieri, ...)
 *  - jobRecencyPagesPlugin    (last-3-days / since-yesterday landings)
 *  - orphanQueryLandingPlugin (GSC orphan-query landings)
 */

import { escHtml } from './htmlEscape';
import {
  resolveJobLogoSrc as resolveJobCardLogo,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from './companyLogoResolver';

export { resolveJobCardLogo, escHtml };

/**
 * Strip literal markdown markers from a job title before it lands in <h3>.
 * The shared description parser only runs on body text — titles flow through
 * `escHtml()` raw, so AI-translation leaks like `**Title**` survive into the
 * card markup and trigger the 0-tolerance `audit-no-literal-markdown` gate.
 * Mirrors the helper of the same name in build-plugins/jobsSeoPagesPlugin.ts
 * (kept duplicated to avoid a circular import between the plugin and this
 * shared file). Contract: `**X**` → `X`, separator runs (3+ of `_`/`=`/`~`) → space,
 * orphan leading/trailing `*` removed, double-spaces collapsed. Idempotent.
 */
function stripLiteralMarkdownFromTitle(title: string): string {
  if (!title) return title;
  let t = String(title);
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  t = t.replace(/[_=~]{3,}/g, ' ');
  t = t.replace(/^\s*\*+\s*/, '').replace(/\s*\*+\s*$/, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

export type JobCardLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Minimal shape required by the renderer. All fields are optional to keep
 * callers permissive — missing fields just hide the corresponding chip.
 */
export interface JobCardJob {
  title?: string;
  titleByLocale?: Partial<Record<JobCardLocale, string>>;
  company?: string;
  companyKey?: string;
  location?: string;
  addressLocality?: string;
  canton?: string;
  contract?: string;
  postedDate?: string;
  datePosted?: string;
  salaryMin?: number | string | null;
  salaryMax?: number | string | null;
  featured?: boolean;
  /** Fallback used when CRAWLED_COMPANY_LOGOS / favicon resolution returns null. */
  logo?: string | null;
  /** Used by `resolveCompanyLogoUrl` / `resolveCompanyWebsiteHost` for accurate
   * domain-based favicon lookup — same fields the in-app SPA `JobCard` passes. */
  companyDomain?: string;
  url?: string;
}

export interface JobCardOptions {
  /** Pre-built absolute href to the job detail page (locale-aware). */
  href: string;
  /** Locale for contract/posted/badge labels. */
  locale: JobCardLocale;
  /**
   * Optional locale-aware city linkifier. Receives the raw (unescaped)
   * location and must return *escaped* HTML. When omitted, the location
   * is rendered as escaped text only.
   */
  linkifyLocation?: (raw: string, locale: JobCardLocale) => string;
  /** Explicit logo override; bypasses the auto-resolver. */
  logoUrl?: string | null;
}

// ── Locale labels ────────────────────────────────────────────────────

const CONTRACT_LABEL: Record<JobCardLocale, Record<string, string>> = {
  it: {
    'full-time': 'Tempo pieno',
    'part-time': 'Part-time',
    temporary: 'Temporaneo',
    internship: 'Stage',
    contract: 'Contratto',
    other: 'Altro',
  },
  en: {
    'full-time': 'Full-time',
    'part-time': 'Part-time',
    temporary: 'Temporary',
    internship: 'Internship',
    contract: 'Contract',
    other: 'Other',
  },
  de: {
    'full-time': 'Vollzeit',
    'part-time': 'Teilzeit',
    temporary: 'Befristet',
    internship: 'Praktikum',
    contract: 'Vertrag',
    other: 'Sonstige',
  },
  fr: {
    'full-time': 'Temps plein',
    'part-time': 'Temps partiel',
    temporary: 'Temporaire',
    internship: 'Stage',
    contract: 'Contrat',
    other: 'Autre',
  },
};

const NEW_BADGE_LABEL: Record<JobCardLocale, string> = {
  it: 'Nuovo',
  en: 'New',
  de: 'Neu',
  fr: 'Nouveau',
};

const RELATIVE_DATE_DICT: Record<JobCardLocale, {
  today: string;
  one: string;
  many: (n: number) => string;
}> = {
  it: { today: 'Oggi', one: '1 giorno fa', many: (n) => `${n} giorni fa` },
  en: { today: 'Today', one: '1 day ago', many: (n) => `${n} days ago` },
  de: { today: 'Heute', one: 'vor 1 Tag', many: (n) => `vor ${n} Tagen` },
  fr: {
    today: "Aujourd'hui",
    one: 'il y a 1 jour',
    many: (n) => `il y a ${n} jours`,
  },
};

export function localizedContract(
  contract: string | undefined,
  locale: JobCardLocale,
): string {
  const key = String(contract || '').toLowerCase().trim();
  if (!key) return '';
  return CONTRACT_LABEL[locale][key] || CONTRACT_LABEL[locale].other;
}

export function relativePostedLabel(
  dateStr: string | undefined,
  locale: JobCardLocale,
  now: Date = new Date(),
): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const diffDays = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000));
  const dict = RELATIVE_DATE_DICT[locale];
  if (diffDays <= 0) return dict.today;
  if (diffDays === 1) return dict.one;
  if (diffDays < 60) return dict.many(diffDays);
  return d.toISOString().slice(0, 10);
}

export function isJobNew(
  dateStr: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const diffDays = (now.getTime() - d.getTime()) / 86400000;
  return diffDays >= 0 && diffDays < 7;
}

// ── Logo resolution ──────────────────────────────────────────────────
// Helpers live in ./companyLogoResolver.ts (imported above).

// ── Inline icons (lucide-react parity) ───────────────────────────────

const ICON_EURO = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-euro w-3.5 h-3.5" aria-hidden="true"><path d="M4 10h12"></path><path d="M4 14h9"></path><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"></path></svg>';
const ICON_MAPPIN = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin w-3 h-3" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg>';
const ICON_CLOCK = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock w-3 h-3" aria-hidden="true"><path d="M12 6v6l4 2"></path><circle cx="12" cy="12" r="10"></circle></svg>';
const ICON_STAR = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-star inline-block w-3.5 h-3.5 ml-1.5 text-warning fill-warning" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path></svg>';
const ICON_SPARKLES = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles w-2.5 h-2.5" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path></svg>';

// ── Salary formatting ────────────────────────────────────────────────

function formatSalary(
  rawMin: number | string | null | undefined,
  rawMax: number | string | null | undefined,
): string {
  const min = Number(rawMin);
  const max = Number(rawMax);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
  if (min <= 0 || max < min) return '';
  return `CHF ${Math.round(min / 1000)}k – ${Math.round(max / 1000)}k`;
}

// ── Logo image markup ────────────────────────────────────────────────

function renderLogoSlot(job: JobCardJob, logoSrc: string): string {
  const company = String(job.company || '');
  const altText = company ? `Logo ${company}` : 'Logo azienda';
  const safeAlt = escHtml(altText);
  const safeSrc = escHtml(logoSrc);
  // Runtime onerror fallback to the deterministic initials data URI when the
  // primary src 404s (Google favicons sometimes miss for less-known domains)
  // — mirrors the SPA `handleCompanyLogoError` chain at static-HTML time so
  // the user never sees a broken-image icon. The handler swaps src once and
  // unhooks itself to avoid loops.
  const fallbackSrc = company
    ? generateInitialsLogo(company)
    : LOGO_FALLBACK_SRC;
  const safeFallback = escHtml(fallbackSrc);
  const onerror = `this.onerror=null;this.src=&quot;${safeFallback}&quot;`;
  // Atom classes defined in index.css (`.jc-logoslot`, `.jc-logoimg`) — see
  // there for the Tailwind @apply mapping. Saves ~180 B per card vs verbatim
  // utility strings.
  return `<div class="jc-logoslot"><img alt="${safeAlt}" class="jc-logoimg" width="40" height="40" loading="lazy" src="${safeSrc}" onerror="${onerror}"></div>`;
}

// ── Main renderer ────────────────────────────────────────────────────

/**
 * Render a single SPA-matching job card as HTML. Returns an `<article>`
 * element ready to be wrapped in a `<li>` (or used standalone).
 */
export function renderJobCardHtml(
  job: JobCardJob,
  opts: JobCardOptions,
): string {
  const { href, locale } = opts;

  const titleSource =
    (job.titleByLocale && job.titleByLocale[locale]) || job.title || '';
  const title = stripLiteralMarkdownFromTitle(
    String(titleSource).replace(/\s+/g, ' ').trim(),
  );
  const company = String(job.company || '').trim();
  const rawLocation = String(job.location || job.addressLocality || '').trim();
  const cantonStr = job.canton ? ` (${escHtml(String(job.canton))})` : '';

  const locationDisplay = opts.linkifyLocation
    ? opts.linkifyLocation(rawLocation, locale)
    : escHtml(rawLocation);

  const salary = formatSalary(job.salaryMin, job.salaryMax);
  const contractLbl = localizedContract(job.contract, locale);
  const postedRaw = String(job.postedDate || job.datePosted || '').trim();
  const postedLabel = relativePostedLabel(postedRaw, locale);
  const postedIso = postedRaw.slice(0, 10);
  const fresh = isJobNew(postedRaw);
  const featured = Boolean(job.featured);

  const logoSrc = opts.logoUrl !== undefined && opts.logoUrl !== null
    ? opts.logoUrl
    : resolveJobCardLogo(job);

  // Atom class names — see index.css `@layer components` block for the
  // Tailwind @apply mapping. Verbatim utility strings emitted ~900 B per
  // card; atom names ~70 B. Across ~16k hub pages × ~12 cards/page that's
  // ~150 MB of artifact saved at byte-identical visual output (Tailwind v4
  // expands @apply into the same utility CSS already in the SPA bundle).
  const articleClasses = featured ? 'jc-card jc-card-fea' : 'jc-card';

  const featuredBadge = featured ? ICON_STAR : '';
  const newBadge = fresh
    ? `<span class="jc-newbadge">${ICON_SPARKLES}${escHtml(NEW_BADGE_LABEL[locale])}</span>`
    : '';

  const salaryHtml = salary
    ? `<span class="jc-salary">${ICON_EURO}${escHtml(salary)}</span>`
    : '';

  const companyAndLocation = (() => {
    const parts: string[] = [];
    if (company) parts.push(escHtml(company));
    if (locationDisplay) parts.push(`${locationDisplay}${cantonStr}`);
    return parts.join(' · ');
  })();

  const locChip = rawLocation
    ? `<span class="jc-chip">${ICON_MAPPIN}${escHtml(rawLocation)}</span>`
    : '';
  const contractChip = contractLbl
    ? `<span class="jc-chip-pill">${escHtml(contractLbl)}</span>`
    : '';
  const postedChip = postedLabel
    ? `<span class="jc-chip" data-posted="${escHtml(postedIso)}">${ICON_CLOCK}${escHtml(postedLabel)}</span>`
    : '';

  // No `aria-label`: WCAG 2.5.3 (Label in Name) requires the accessible name
  // to contain the visible text. Letting the browser compute the name from
  // the visible content (title, company/location, chips) yields a richer,
  // compliant name than a hand-built label that omits parts of the visible
  // text and uses a separator (—) the visible UI does not show.

  return `<article class="${articleClasses}"><a href="${escHtml(href)}" class="jc-link"><div class="jc-row">${renderLogoSlot(job, logoSrc)}<div class="jc-meta"><h3 class="jc-title">${escHtml(title)}${featuredBadge}${newBadge}</h3><p class="jc-sub">${companyAndLocation}</p>${salaryHtml}</div></div><div class="jc-chips">${locChip}${contractChip}${postedChip}</div></a></article>`;
}

// ── List renderer ────────────────────────────────────────────────────

export interface JobCardListItem {
  job: JobCardJob;
  href: string;
}

export interface JobCardListOptions {
  locale: JobCardLocale;
  linkifyLocation?: (raw: string, locale: JobCardLocale) => string;
  /** Optional CSS class applied to the wrapping <ul>. */
  ulClassName?: string;
  /** Empty-state HTML when `items` is empty (must be safe HTML). */
  emptyStateHtml?: string;
}

const DEFAULT_UL_CLASS = 'list-none p-0 m-0 grid gap-3';

/**
 * Render a list of jobs as `<ul role="list">` of `<li>` containing the SPA
 * job cards. Returns the `emptyStateHtml` when the list is empty.
 */
export function renderJobCardListHtml(
  items: ReadonlyArray<JobCardListItem>,
  opts: JobCardListOptions,
): string {
  if (items.length === 0) return opts.emptyStateHtml ?? '';
  const ulClass = opts.ulClassName ?? DEFAULT_UL_CLASS;
  const cards = items
    .map(({ job, href }) =>
      `<li>${renderJobCardHtml(job, {
        href,
        locale: opts.locale,
        linkifyLocation: opts.linkifyLocation,
      })}</li>`,
    )
    .join('');
  return `<ul role="list" class="${escHtml(ulClass)}">${cards}</ul>`;
}
