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
import { firstParsableDateStr } from './firstParsableDate';
import { stripLiteralMarkdown as stripLiteralMarkdownFromTitle } from './stripLiteralMarkdown';
import { resolveJobLogoSrc as resolveJobCardLogo } from './companyLogoResolver';
import { LOGO_FALLBACK_SCRIPT } from './logoFallbackScript';
import { infeedAdListItemHtml } from '../lib/adSlotHtml';
import { shouldPlaceInfeedAd } from '../../services/adsenseSlots';

export { resolveJobCardLogo, escHtml };

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
  /**
   * Provenance of salaryMin/Max persisted by scripts/re-enrich-jobs.mjs:
   * `'reported'` (extracted from the posting text), `'existing'` (structured
   * salary already on the record) or `'estimated'` (sector-median band).
   * `'estimated'` renders the range with a per-locale "(stima)" suffix so the
   * band is never presented as a real offer. Absent on records not yet
   * re-enriched → output stays byte-identical to the pre-flag behaviour.
   */
  salarySource?: 'reported' | 'existing' | 'estimated';
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

// ── Inline icons (lucide-react parity, SVG-symbol form) ─────────────
//
// Pre-2026-05-27 each card emitted ~5 full <svg>…</svg> blocks (~500 B
// each) inline. Across ~30 k pages × ~30 cards × ~4 icons/card the wire
// cost was ~1.5 GB of identical SVG markup. The new form emits the symbol
// DEFS once per page (`JOB_CARD_ICON_SYMBOLS`, prepended by
// `renderJobCardListHtml`), and each card uses `<svg …><use href="#i-jc-…"/></svg>`
// (~150 B vs ~500 B). Net save ≈ 350 B × ~100 icons/page × ~30 k pages
// ≈ ~1 GB on the dist artifact. Computed render is identical: `<use>` pulls
// in the path elements from the matching `<symbol>` and inherits stroke,
// fill, etc. from the parent `<svg>` — same visual output as the prior
// inline form.

// The deterministic coloured-initials logo fallback used to be inlined in
// every card's `onerror` (~586 B/card). It now lives in the shared
// `LOGO_FALLBACK_SCRIPT` (see logoFallbackScript.ts), appended once to the
// icon DEFS below so every page that injects the symbols also defines `jcLF`,
// the global the per-card `onerror="jcLF(this)"` calls. Shared with
// employerCardHtml.ts so the client logic exists in exactly one place.
export const JOB_CARD_ICON_SYMBOLS = '<svg class="hidden" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><symbol id="i-jc-bkn" viewBox="0 0 24 24"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01"/><path d="M18 12h.01"/></symbol><symbol id="i-jc-mp" viewBox="0 0 24 24"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></symbol><symbol id="i-jc-cl" viewBox="0 0 24 24"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="10"/></symbol><symbol id="i-jc-st" viewBox="0 0 24 24"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></symbol><symbol id="i-jc-sp" viewBox="0 0 24 24"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></symbol></svg>' + LOGO_FALLBACK_SCRIPT;

// Currency-neutral banknote (lucide `banknote`) — the salary values are CHF,
// so the previous euro glyph (lucide `euro`) was factually wrong. Same wrapper
// dims (14×14, w-3.5 h-3.5) and stroke pattern as every other card icon.
const ICON_BANKNOTE = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-banknote w-3.5 h-3.5" aria-hidden="true"><use href="#i-jc-bkn"/></svg>';
const ICON_MAPPIN = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin w-3 h-3" aria-hidden="true"><use href="#i-jc-mp"/></svg>';
const ICON_CLOCK = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock w-3 h-3" aria-hidden="true"><use href="#i-jc-cl"/></svg>';
const ICON_STAR = '<svg width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-star inline-block w-3.5 h-3.5 ml-1.5 text-warning fill-warning" aria-hidden="true"><use href="#i-jc-st"/></svg>';
const ICON_SPARKLES = '<svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles w-2.5 h-2.5" aria-hidden="true"><use href="#i-jc-sp"/></svg>';

// ── Salary formatting ────────────────────────────────────────────────

/**
 * Per-locale suffix appended to the salary range when `salarySource` is
 * `'estimated'` — declares the band as a sector estimate, not a real offer.
 */
export const SALARY_ESTIMATE_SUFFIX: Record<JobCardLocale, string> = {
  it: '(stima)',
  en: '(est.)',
  de: '(Schätzung)',
  fr: '(est.)',
};

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

// ── Locality display ─────────────────────────────────────────────────

/**
 * Defensive display-only title-casing for crawler localities persisted in
 * slug-style lowercase («quartino», «castel san pietro»). Applies ONLY when
 * the string contains no uppercase letter at all — anything already
 * capitalised («Lugano», «SUPSI / DTI», «S. Antonino») passes through
 * byte-identical. Word boundaries include spaces, hyphens, apostrophes,
 * dots and slashes so «s. antonino» → «S. Antonino» and
 * «lugano-besso» → «Lugano-Besso». Data is never mutated — this runs at
 * render time only.
 */
export function titleCaseLocalityIfLowercase(raw: string): string {
  if (!raw || raw !== raw.toLowerCase()) return raw;
  return raw.replace(
    /(^|[\s\-'’./(])(\p{Ll})/gu,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );
}

// ── Logo image markup ────────────────────────────────────────────────

function renderLogoSlot(job: JobCardJob, logoSrc: string): string {
  const company = String(job.company || '');
  const altText = company ? `Logo ${company}` : 'Logo azienda';
  const safeAlt = escHtml(altText);
  const safeSrc = escHtml(logoSrc);
  // Runtime fallback when the primary src 404s (Google favicons sometimes miss
  // for less-known domains) — mirrors the SPA `handleCompanyLogoError` chain so
  // the user never sees a broken-image icon.
  //
  // Previously the full deterministic initials data URI was inlined verbatim in
  // the handler (`onerror="this.onerror=null;this.src=&quot;data:…543 B…&quot;"`
  // ≈ 586 B/card; ~314 k cards ⇒ ~184 MB of byte-near-identical markup). The
  // handler now calls the tiny global `jcLF()` (defined once per page in
  // JOB_CARD_ICON_SYMBOLS) which rebuilds the *same* initials SVG client-side
  // from the company name carried in `alt="Logo {company}"` — byte-identical
  // visual output, ~565 B/card saved on the dist artifact.
  //
  // Company-less cards already resolve their primary src to the static
  // `LOGO_FALLBACK_SRC` (see `resolveJobLogoSrc`), so an onerror that re-points
  // to the same file would be a no-op — we omit it there.
  const onerror = company ? ' onerror="jcLF(this)"' : '';
  // Atom classes defined in index.css (`.jc-logoslot`, `.jc-logoimg`) — see
  // there for the Tailwind @apply mapping. Saves ~180 B per card vs verbatim
  // utility strings.
  return `<div class="jc-logoslot"><img alt="${safeAlt}" class="jc-logoimg" width="40" height="40" loading="lazy" src="${safeSrc}"${onerror}></div>`;
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
  // Company + location are crawler-/AI-sourced free text rendered into the
  // indexed `<main class="seo-static-content">` (jc-sub / jc-chip) on every
  // hub / sector / recency page. HTML-escaping does NOT touch `**bold**` or
  // `_`/`=`/`~` separator runs, so — exactly like the title above — they must
  // be scrubbed or a company like `ACME___GmbH` trips the 0-tolerance
  // audit:no-literal-markdown gate (CLAUDE.md rule #1). Idempotent /
  // byte-identical on the clean-string majority.
  const company = stripLiteralMarkdownFromTitle(String(job.company || '').trim());
  // Display-only title-case for all-lowercase crawler localities; already
  // capitalised strings pass through untouched (byte-identical output). The
  // city linkifiers downstream match case-insensitively, so handing them the
  // cased string is safe.
  const rawLocation = titleCaseLocalityIfLowercase(
    stripLiteralMarkdownFromTitle(String(job.location || job.addressLocality || '').trim()),
  );
  const cantonStr = job.canton ? ` (${escHtml(String(job.canton))})` : '';

  const locationDisplay = opts.linkifyLocation
    ? opts.linkifyLocation(rawLocation, locale)
    : escHtml(rawLocation);

  const salary = formatSalary(job.salaryMin, job.salaryMax);
  // Estimated bands are declared as such; missing salarySource (records not
  // yet re-enriched) keeps the legacy unsuffixed label byte-identical.
  const salaryLabel =
    salary && job.salarySource === 'estimated'
      ? `${salary} ${SALARY_ESTIMATE_SUFFIX[locale]}`
      : salary;
  const contractLbl = localizedContract(job.contract, locale);
  // First PARSEABLE date string, not first truthy: a malformed postedDate must
  // not shadow a valid datePosted and feed "Invalid Date" into the relative
  // label / "new" freshness badge on indexed job cards.
  const postedRaw = firstParsableDateStr(job.postedDate, job.datePosted).trim();
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

  const salaryHtml = salaryLabel
    ? `<span class="jc-salary">${ICON_BANKNOTE}${escHtml(salaryLabel)}</span>`
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

  // Site-relative href in the body anchor (browser resolves against the
  // current document URL → same destination). Spec-required absolute URLs
  // (canonical, OG, JSON-LD `@id`/`url`, hreflang) live in the page <head>
  // and are unaffected. Saves ~28 B × ~30 cards/page × ~30 k pages
  // ≈ ~25 MB on the dist artifact.
  const relativeHref = href.replace(/^https:\/\/frontaliereticino\.ch/, '');

  return `<article class="${articleClasses}"><a href="${escHtml(relativeHref)}" class="jc-link"><div class="jc-row">${renderLogoSlot(job, logoSrc)}<div class="jc-meta"><h3 class="jc-title">${escHtml(title)}${featuredBadge}${newBadge}</h3><p class="jc-sub">${companyAndLocation}</p>${salaryHtml}</div></div><div class="jc-chips">${locChip}${contractChip}${postedChip}</div></a></article>`;
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
  /** Inject a device-split in-feed ad after every Nth card (`JOBLIST_AD_EVERY_N`).
   *  Defaults `true` so every static job-list surface (sector / profession /
   *  recency / orphan-query / nursing / career landings) gets between-card ads,
   *  matching the SPA JobBoard. Set `false` to opt a list out. */
  interleaveInfeedAds?: boolean;
  /** When the list renders as a multi-column grid, make each ad item span every
   *  column so the ad keeps full width. Default `false` (single-column lists). */
  adSpanFullGrid?: boolean;
  /** Absolute number of cards rendered before this block. Keeps shared in-feed
   *  cadence stable when one logical result list is split by editorial content. */
  positionOffset?: number;
  /** Treat the final card in this block as non-final because another result
   *  block follows. Default `false`, preserving the no-ad-after-list rule. */
  hasFollowingItems?: boolean;
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
  const interleave = opts.interleaveInfeedAds ?? true;
  const positionOffset = opts.positionOffset ?? 0;
  const cards = items
    .map(({ job, href }, i) => {
      const card = `<li>${renderJobCardHtml(job, {
        href,
        locale: opts.locale,
        linkifyLocation: opts.linkifyLocation,
      })}</li>`;
      // In-feed ad after every Nth card, never after the last one (the
      // end-of-list multiplex already sits there). A split logical list can
      // declare that more cards follow in a later block and retain the same
      // absolute cadence through `positionOffset`.
      const position = positionOffset + i + 1;
      const hasLaterItem = i + 1 < items.length || !!opts.hasFollowingItems;
      const ad =
        interleave && hasLaterItem && shouldPlaceInfeedAd(position)
          ? infeedAdListItemHtml({ spanFull: opts.adSpanFullGrid })
          : '';
      return card + ad;
    })
    .join('');
  // Prepend the SVG symbol DEFS once per list. Each card's `<svg><use>` then
  // references these symbols by ID. If a page contains more than one card
  // list the defs appear multiple times — duplicate <symbol> IDs are
  // tolerated by browsers (first match wins, all are identical) but
  // increase wire by ~700 B per extra list. The vast majority of hub pages
  // emit a single list so the cost is one-off per page.
  return `${JOB_CARD_ICON_SYMBOLS}<ul role="list" class="${escHtml(ulClass)}">${cards}</ul>`;
}
