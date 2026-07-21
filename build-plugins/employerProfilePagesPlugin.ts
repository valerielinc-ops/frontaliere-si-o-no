/**
 * employerProfilePagesPlugin — evergreen employer-profile page per company at
 * `/aziende/<slug>/` (+ `/en|/de|/fr` locale variants). Epic #4462 / sub #4464.
 *
 * WHY: navigational + transactional intent ("lavorare in <azienda>", "<azienda>
 * stipendio", "<azienda> posizioni aperte") has no landing surface today —
 * weeklyEmployers pages are weekly/volatile. These pages are the evergreen home
 * for a company's active jobs, salary median, work locations and hiring trend,
 * and the natural surface for the publisher-acquisition CTA (epic #4445).
 *
 * Source of truth: data/employer-profiles.json (scripts/build-employer-profiles.mjs)
 * — corpus-derived FACTS only, no editorial judgement, no PII (brand-safety).
 * The live active-job listings + JobPosting structured data come from the
 * assembled corpus data/jobs.json (via loadJobsJson), grouped by the SAME
 * canonicalCompanyProfileSlug the dataset uses (build-plugins/shared/
 * companyProfileSlug.mjs — one definition, no slug drift).
 *
 * Contract (repo SSG rules): apply:'build', enforce:'post', emit in
 * closeBundle(), pass distDir. Every page via buildSeoPageHtml (SPA shell +
 * lite-shell hydration). JSON-LD JobPosting via the shared buildJobPostingSchema
 * (guarantees AGENTS #3 mandatory fields). Sitemap written as
 * dist/sitemap-employer-profiles.xml (sitemapAliasPlugin auto-discovers it).
 *
 * Floor: companies with >= MIN_ACTIVE_JOBS active postings get a full,
 * indexable page. Companies in the bridge band get a noindex,follow bridge at
 * the SAME URL (emitEmployerBelowFloorBridge) instead of a silent 404 — and
 * build-plugins/searchConsoleCompat.ts self-maps every emitted slug (both
 * bands) so a stale GSC 404 for a live /aziende/ URL stops being dropped.
 *
 * Namespace: distinct from publisherAdPagesPlugin (`/lavoro/<slug>/`) — no
 * collision. Gate: SKIP_EMPLOYER_PROFILE_PAGES=1 fast-exits local builds.
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { renderJobCardHtml, JOB_CARD_ICON_SYMBOLS, localizedContract, type JobCardJob } from './shared/jobCardHtml';
import { buildListItemJobPosting } from './shared/jobPostingListItem';
import { renderEmployerCtaBlock } from './shared/employerCtaBlock';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { escHtml as esc } from './shared/htmlEscape';
import { WriteCollector } from './batchWrite';
import { loadJobsJson } from './shared/loadJobsJson';
import { resolveCantonSection, resolveJobCanton, legacyTiSectionRoot } from './shared/cantonSection';
import { buildCurrentWeekPath } from './weeklyEmployersData';
import { buildSectorHubPath, SECTOR_HUB_KEYS, type SectorHubKey } from './jobSectorLanding';
import { canonicalCompanyProfileSlug } from './shared/companyProfileSlug.mjs';
import { MIN_ACTIVE_JOBS } from './shared/employerProfileConfig.mjs';
import { resolveEmployerProfilesFlushed, type EmittedEmployerProfile } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

const OG_LOCALE: Record<Locale, string> = { it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH' };

/** IT is unprefixed (site convention); a single literal `/aziende/` segment for
 * every locale (same approach as publisher's `/lavoro/`) keeps the router match,
 * the hreflang set and the compat self-map trivial. */
const localePrefix = (locale: Locale): string => (locale === 'it' ? '' : `/${locale}`);
const profilePath = (locale: Locale, slug: string): string => `${localePrefix(locale)}/aziende/${slug}/`;

/** Max active jobs listed (cards + structured data) per page — keeps HTML +
 * JSON-LD within the page-weight budget; the full list lives on the hubs.
 * Was 24 (audit:text-html-ratio regression #4593: at 24 cards + a full
 * JobPosting ItemList per card, markup outweighs visible text ~25:1 even
 * with a fully expanded intro — verified against real data/employer-
 * profiles.json profiles, no card count got a typical profile over the 10%
 * floor without gutting the list to 1-2 items). 8 matches the sibling
 * per-company job cap already used by weeklyEmployersPlugin.ts
 * (`limitJobs = 10`) — a curated top-N preview, "see all" lives in
 * exploreLinksHtml's canton/weekly links, same UX pattern as those pages. */
const MAX_JOBS_LISTED = 8;

interface EmployerProfile {
  slug: string;
  name: string;
  companyKey?: string | null;
  sector?: string | null;
  activeJobs: number;
  cantons: Array<{ name: string; count: number }>;
  cities: Array<{ name: string; count: number }>;
  salaryMedianChf?: number | null;
  salarySamples?: number;
  trend?: { added: number; removed: number; net: number; windowDays: number } | null;
}

interface BelowFloorRecord {
  slug: string;
  name: string;
  activeJobs: number;
  sector?: string | null;
  canton?: string | null;
}

interface EmployerDataset {
  profiles?: EmployerProfile[];
  belowFloor?: BelowFloorRecord[];
}

// ── Localized copy (factual; no per-company editorial judgement) ────────────

const HOME_LABEL: Record<Locale, string> = { it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil' };
const HUB_LABEL: Record<Locale, string> = { it: 'Aziende', en: 'Companies', de: 'Unternehmen', fr: 'Entreprises' };

const H1_PREFIX: Record<Locale, string> = {
  it: 'Lavorare in', en: 'Working at', de: 'Arbeiten bei', fr: 'Travailler chez',
};
const OPEN_ROLES_LABEL: Record<Locale, string> = {
  it: 'Posizioni aperte', en: 'Open positions', de: 'Offene Stellen', fr: 'Postes ouverts',
};
const MEDIAN_SALARY_LABEL: Record<Locale, string> = {
  it: 'Stipendio mediano', en: 'Median salary', de: 'Median­gehalt', fr: 'Salaire médian',
};
const LOCATIONS_LABEL: Record<Locale, string> = {
  it: 'Sedi', en: 'Locations', de: 'Standorte', fr: 'Sites',
};
const SECTOR_LABEL: Record<Locale, string> = {
  it: 'Settore', en: 'Sector', de: 'Branche', fr: 'Secteur',
};
const NEW_ROLES_LABEL: Record<Locale, string> = {
  it: 'Nuove offerte', en: 'New postings', de: 'Neue Stellen', fr: 'Nouvelles annonces',
};
const JOBS_HEADING: Record<Locale, string> = {
  it: 'Offerte di lavoro attive', en: 'Active job openings', de: 'Aktive Stellenangebote', fr: 'Offres d’emploi actives',
};
const EXPLORE_HEADING: Record<Locale, string> = {
  it: 'Esplora', en: 'Explore', de: 'Entdecken', fr: 'Explorer',
};
const WEEKLY_LINK_LABEL: Record<Locale, string> = {
  it: 'Aziende che assumono questa settimana',
  en: 'Employers hiring this week',
  de: 'Arbeitgeber, die diese Woche einstellen',
  fr: 'Employeurs qui recrutent cette semaine',
};
const ALL_JOBS_IN: Record<Locale, string> = {
  it: 'Tutte le offerte in', en: 'All jobs in', de: 'Alle Stellen in', fr: 'Toutes les offres à',
};
const SECTOR_JOBS_LABEL: Record<Locale, string> = {
  it: 'Offerte del settore', en: 'Jobs in sector', de: 'Stellen der Branche', fr: 'Offres du secteur',
};
const JOB_BOARD_LABEL: Record<Locale, string> = {
  it: 'Bacheca offerte Ticino', en: 'Ticino job board', de: 'Stellenbörse Tessin', fr: 'Offres d’emploi Tessin',
};
const TITLE_SUFFIX: Record<Locale, string> = {
  it: 'posizioni aperte e stipendi',
  en: 'open positions and salaries',
  de: 'offene Stellen und Gehälter',
  fr: 'postes ouverts et salaires',
};
// Short last-resort suffix — MUST differ from the bare "{H1_PREFIX} {name}"
// string used for <h1> (see renderProfileBody). composePlaceTitle's fallback
// candidate used to be that exact bare string, so any company name whose
// full TITLE_SUFFIX candidate overflowed TITLE_MAX_CHARS fell back to a
// <title> byte-identical to <h1>, tripping audit:h1-title-duplicates (157
// offenders, validate-dist run 29794187475 — regression from PR #4611's
// title-length fix). Keeping a (however short) suffix on every candidate
// guarantees title !== h1 by construction: if even this short candidate
// overflows, composePlaceTitle's truncateHeadline() fallback always appends
// "…", which also never equals the untruncated h1 text.
const TITLE_SUFFIX_SHORT: Record<Locale, string> = {
  it: 'offerte', en: 'jobs', de: 'Jobs', fr: 'offres',
};

/** Format a CHF annual amount with Swiss grouping (e.g. "CHF 86’250"). */
function fmtChf(v: number): string {
  return `CHF ${Math.round(v).toLocaleString('de-CH')}`;
}

/** Canton-display: keep the 2-letter code (factual, locale-neutral). */
function locationsSummary(profile: EmployerProfile): string {
  const cityNames = profile.cities.slice(0, 3).map((c) => c.name);
  if (cityNames.length > 0) return cityNames.join(', ');
  return profile.cantons.slice(0, 3).map((c) => c.name).join(', ');
}

/** Sector string → sector-hub key when it maps to a real hub, else null. */
function sectorHubKeyFor(sector: string | null | undefined): SectorHubKey | null {
  if (!sector) return null;
  const slug = canonicalCompanyProfileSlug(sector);
  return (SECTOR_HUB_KEYS as readonly string[]).includes(slug) ? (slug as SectorHubKey) : null;
}

/** First parsable epoch ms across candidate date fields; -Infinity when none. */
function firstDateMs(...candidates: Array<string | undefined | null>): number {
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(String(c));
    if (Number.isFinite(t)) return t;
  }
  return -Infinity;
}

interface CorpusJob {
  slug?: string;
  slugByLocale?: Partial<Record<string, string>>;
  company?: string;
  companyKey?: string;
  title?: string;
  titleByLocale?: Partial<Record<string, string>>;
  location?: string;
  addressLocality?: string;
  canton?: string;
  contract?: string;
  employmentType?: string;
  postedDate?: string;
  datePosted?: string;
  crawledAt?: string;
  firstSeenAt?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salarySource?: 'reported' | 'existing' | 'estimated';
  companyDomain?: string;
  url?: string;
  [k: string]: unknown;
}

function localizedJobSlug(job: CorpusJob, locale: Locale): string {
  const byLocale = job.slugByLocale?.[locale];
  if (byLocale && typeof byLocale === 'string' && byLocale.length > 0) return byLocale;
  return String(job.slug || '');
}

/** On-site canonical job detail path (canton-aware section), locale-prefixed. */
function jobDetailPath(job: CorpusJob, locale: Locale): string {
  const slug = localizedJobSlug(job, locale);
  if (!slug) return '';
  const section = resolveCantonSection(locale, resolveJobCanton(job));
  return `${localePrefix(locale)}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Per-locale sentence builders for the intro prose — one map, shared assembly
 * (no 4× duplicated filter/join). Templated FACTS only; the job cards + these
 * sentences keep every locale's page well above MIN_INDEXABLE_WORDS. */
interface ProseTemplate {
  readonly intro: (name: string, n: number, cantonCount: number) => string;
  readonly cantonsSingle: (canton: string, count: number) => string;
  readonly cantonsMulti: (first: string, firstCount: number, rest: string) => string;
  readonly citiesSingle: (city: string) => string;
  readonly citiesMulti: (first: string, firstCount: number, rest: string) => string;
  readonly salary: (sal: string) => string;
  readonly trend: (added: number, win: number) => string;
  /** Contract-type majority among the CURRENTLY listed postings — real
   * per-build aggregate, distinct from the per-job contract badge already
   * shown on each card (see contractMixProse). */
  readonly contractMix: (label: string, count: number, total: number) => string;
  /** Real salary min–max range across postings with a reported/estimated
   * figure — distinct from the single median stat tile. */
  readonly salaryRange: (min: string, max: string) => string;
  readonly outro: string;
}
const PROSE_TEMPLATES: Record<Locale, ProseTemplate> = {
  it: {
    intro: (name, n, cantonCount) => `${name} ha attualmente ${n} posizioni aperte pubblicate su Frontaliere Ticino, distribuite in ${cantonCount} canton${cantonCount === 1 ? 'e' : 'i'} svizzer${cantonCount === 1 ? 'o' : 'i'}.`,
    cantonsSingle: (canton, count) => `Tutte le posizioni sono concentrate nel canton ${canton} (${count} offerte).`,
    cantonsMulti: (first, firstCount, rest) => `Il canton ${first} conta il maggior numero di offerte (${firstCount}), seguito da ${rest}.`,
    citiesSingle: (city) => `La sede principale con offerte attive è ${city}.`,
    citiesMulti: (first, firstCount, rest) => `A livello di città, le sedi con più posizioni aperte sono ${first} (${firstCount} offerte), seguita da ${rest}.`,
    salary: (sal) => `Lo stipendio mediano stimato per queste offerte è di ${sal} lordi all’anno.`,
    trend: (added, win) => `Negli ultimi ${win} giorni sono state pubblicate ${added} nuove offerte.`,
    contractMix: (label, count, total) => count === total
      ? `Tutte le posizioni attive sono a ${label}.`
      : `${count} delle ${total} posizioni attive pubblicate sono a ${label}.`,
    salaryRange: (min, max) => `Gli stipendi pubblicati per queste posizioni vanno da ${min} a ${max} lordi all’anno.`,
    outro: 'Consulta qui sotto le posizioni attive e candidati direttamente sul sito del datore di lavoro.',
  },
  en: {
    intro: (name, n, cantonCount) => `${name} currently has ${n} open positions published on Frontaliere Ticino, across ${cantonCount} Swiss canton${cantonCount === 1 ? '' : 's'}.`,
    cantonsSingle: (canton, count) => `All positions are concentrated in canton ${canton} (${count} openings).`,
    cantonsMulti: (first, firstCount, rest) => `Canton ${first} has the most openings (${firstCount}), followed by ${rest}.`,
    citiesSingle: (city) => `The main location with open positions is ${city}.`,
    citiesMulti: (first, firstCount, rest) => `By city, the locations with the most open positions are ${first} (${firstCount} openings), followed by ${rest}.`,
    salary: (sal) => `The estimated median salary for these roles is ${sal} gross per year.`,
    trend: (added, win) => `In the last ${win} days, ${added} new postings were published.`,
    contractMix: (label, count, total) => count === total
      ? `All active positions are ${label}.`
      : `${count} of the ${total} active postings are ${label}.`,
    salaryRange: (min, max) => `Published salaries for these roles range from ${min} to ${max} gross per year.`,
    outro: 'Browse the active roles below and apply directly on the employer’s own site.',
  },
  de: {
    intro: (name, n, cantonCount) => `${name} hat aktuell ${n} offene Stellen auf Frontaliere Ticino, verteilt auf ${cantonCount} Schweizer Kanton${cantonCount === 1 ? '' : 'e'}.`,
    cantonsSingle: (canton, count) => `Alle Stellen konzentrieren sich auf den Kanton ${canton} (${count} Stellen).`,
    cantonsMulti: (first, firstCount, rest) => `Der Kanton ${first} hat die meisten Stellen (${firstCount}), gefolgt von ${rest}.`,
    citiesSingle: (city) => `Der wichtigste Standort mit offenen Stellen ist ${city}.`,
    citiesMulti: (first, firstCount, rest) => `Nach Stadt betrachtet haben ${first} (${firstCount} Stellen) die meisten offenen Stellen, gefolgt von ${rest}.`,
    salary: (sal) => `Das geschätzte Median­gehalt für diese Stellen beträgt ${sal} brutto pro Jahr.`,
    trend: (added, win) => `In den letzten ${win} Tagen wurden ${added} neue Stellen veröffentlicht.`,
    contractMix: (label, count, total) => count === total
      ? `Alle aktiven Stellen sind ${label}.`
      : `${count} der ${total} aktiven Stellen sind ${label}.`,
    salaryRange: (min, max) => `Die veröffentlichten Gehälter für diese Stellen reichen von ${min} bis ${max} brutto pro Jahr.`,
    outro: 'Sehen Sie sich unten die aktiven Stellen an und bewerben Sie sich direkt auf der Website des Arbeitgebers.',
  },
  fr: {
    intro: (name, n, cantonCount) => `${name} compte actuellement ${n} postes ouverts publiés sur Frontaliere Ticino, répartis dans ${cantonCount} canton${cantonCount === 1 ? '' : 's'} suisse${cantonCount === 1 ? '' : 's'}.`,
    cantonsSingle: (canton, count) => `Tous les postes sont concentrés dans le canton de ${canton} (${count} offres).`,
    cantonsMulti: (first, firstCount, rest) => `Le canton de ${first} compte le plus grand nombre d’offres (${firstCount}), suivi de ${rest}.`,
    citiesSingle: (city) => `Le site principal avec des postes ouverts est ${city}.`,
    citiesMulti: (first, firstCount, rest) => `Par ville, les sites avec le plus de postes ouverts sont ${first} (${firstCount} offres), suivi de ${rest}.`,
    salary: (sal) => `Le salaire médian estimé pour ces postes est de ${sal} brut par an.`,
    trend: (added, win) => `Au cours des ${win} derniers jours, ${added} nouvelles annonces ont été publiées.`,
    contractMix: (label, count, total) => count === total
      ? `Tous les postes actifs sont en ${label}.`
      : `${count} des ${total} postes actifs publiés sont en ${label}.`,
    salaryRange: (min, max) => `Les salaires publiés pour ces postes vont de ${min} à ${max} brut par an.`,
    outro: 'Parcourez les postes actifs ci-dessous et postulez directement sur le site de l’employeur.',
  },
};

/** Full canton breakdown sentence (all cantons, not just top-3) — real,
 * varying-length content proportional to the company's actual footprint. */
function cantonsProse(profile: EmployerProfile, locale: Locale): string {
  const t = PROSE_TEMPLATES[locale];
  const c = profile.cantons;
  if (c.length === 0) return '';
  if (c.length === 1) return t.cantonsSingle(c[0].name, c[0].count);
  const rest = c.slice(1).map((x) => `${x.name} (${x.count})`).join(', ');
  return t.cantonsMulti(c[0].name, c[0].count, rest);
}

/** Full city breakdown sentence (all cities, not just top-3). */
function citiesProse(profile: EmployerProfile, locale: Locale): string {
  const t = PROSE_TEMPLATES[locale];
  const c = profile.cities;
  if (c.length === 0) return '';
  if (c.length === 1) return t.citiesSingle(c[0].name);
  const rest = c.slice(1).map((x) => `${x.name} (${x.count})`).join(', ');
  return t.citiesMulti(c[0].name, c[0].count, rest);
}

/** Real contract-type majority across the company's FULL active-job set
 * (not just the ≤MAX_JOBS_LISTED cards shown) — genuine aggregate fact,
 * distinct from the per-job contract badge already on each card. Returns
 * '' when the data is too sparse/fragmented to say anything meaningful
 * (no single contract type reaches a majority), same graceful-skip pattern
 * as cantonsProse/citiesProse when there's nothing real to report. */
function contractMixProse(jobs: CorpusJob[], locale: Locale): string {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const label = localizedContract(job.contract, locale);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return '';
  const [topLabel, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCount / total < 0.5) return '';
  return PROSE_TEMPLATES[locale].contractMix(topLabel.toLowerCase(), topCount, total);
}

/** Real salary min–max range across postings with a reported/estimated
 * figure — distinct from the single median stat tile, and from the
 * per-card salary line (this is the FULL active-job range, not just the
 * ≤MAX_JOBS_LISTED shown). Returns '' when there isn't a genuine range
 * (fewer than 2 data points, or min === max — nothing to compare). */
function salaryRangeProse(jobs: CorpusJob[], locale: Locale): string {
  const values = jobs
    .flatMap((j) => [j.salaryMin, j.salaryMax])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min >= max) return '';
  return PROSE_TEMPLATES[locale].salaryRange(fmtChf(min), fmtChf(max));
}

/** Localized intro prose — templated FACTS only, now with the FULL
 * canton/city breakdown (was top-3 `locationsSummary`, still used for the
 * compact stat tile), plus a real contract-mix and salary-range sentence
 * computed from the company's full active-job set. Real per-company detail,
 * not filler — length scales with the company's actual canton/city
 * footprint (data/employer-profiles.json caps both arrays at 6, so this
 * never runs away). Part of the audit:text-html-ratio fix (#4593): PR
 * #4611's MAX_JOBS_LISTED reduction (24→8) + earlier prose expansion
 * narrowed the gap but the LIVE measured ratio (~5%, validate-dist run
 * 29794187475) was roughly half PR #4611's own local estimate (~9.8%) —
 * this adds genuine additional facts rather than re-tuning MAX_JOBS_LISTED
 * again (that lever was already verified NOT to help: more cards add more
 * per-job JobPosting JSON-LD, mandated complete by Non-Negotiable #3, far
 * faster than they add visible card text — see MAX_JOBS_LISTED comment).
 * Does not guarantee every one of the ~1860 profiles clears the 10% floor
 * (a handful with no contract/salary data at all get none of the two new
 * sentences); see PR body for the honest remaining gap. */
function introProse(profile: EmployerProfile, jobs: CorpusJob[], locale: Locale): string {
  const t = PROSE_TEMPLATES[locale];
  const sal = profile.salaryMedianChf ? fmtChf(profile.salaryMedianChf) : null;
  const added = profile.trend?.added ?? null;
  const win = profile.trend?.windowDays ?? 30;
  return [
    t.intro(profile.name, profile.activeJobs, profile.cantons.length),
    cantonsProse(profile, locale),
    citiesProse(profile, locale),
    sal ? t.salary(sal) : '',
    added ? t.trend(added, win) : '',
    contractMixProse(jobs, locale),
    salaryRangeProse(jobs, locale),
    t.outro,
  ].filter(Boolean).join(' ');
}

function statTile(label: string, value: string): string {
  return `<div class="rounded-xl border border-edge bg-surface-alt px-3.5 py-2.5"><div class="text-xs text-muted">${esc(label)}</div><div class="text-sm font-semibold text-strong">${value}</div></div>`;
}

function breadcrumbHtml(locale: Locale, name: string): string {
  return `<nav aria-label="breadcrumb" class="text-[13px] text-muted mb-4">
<a href="${localePrefix(locale) || '/'}" class="text-inherit">${esc(HOME_LABEL[locale])}</a> ·
<span>${esc(HUB_LABEL[locale])}</span> ·
<span>${esc(name)}</span>
</nav>`;
}

/** Explore cross-links (weekly employers, canton board, sector hub, job board). */
function exploreLinksHtml(profile: EmployerProfile, locale: Locale): string {
  const primaryCanton = profile.cantons[0]?.name || 'TI';
  const cantonSection = resolveCantonSection(locale, primaryCanton);
  const cantonPath = `${localePrefix(locale)}/${cantonSection}/`.replace(/\/+/g, '/');
  const sectorKey = sectorHubKeyFor(profile.sector);
  const links: Array<{ href: string; label: string }> = [
    { href: buildCurrentWeekPath(locale, 'ticino'), label: WEEKLY_LINK_LABEL[locale] },
    { href: cantonPath, label: `${ALL_JOBS_IN[locale]} ${primaryCanton}` },
  ];
  if (sectorKey) {
    links.push({ href: buildSectorHubPath(locale, sectorKey), label: `${SECTOR_JOBS_LABEL[locale]}: ${profile.sector}` });
  }
  links.push({ href: `${legacyTiSectionRoot(locale)}/`.replace(/\/+/g, '/'), label: JOB_BOARD_LABEL[locale] });
  const items = links
    .map((l) => `<li><a href="${esc(l.href)}" class="text-sm font-semibold text-link">${esc(l.label)} →</a></li>`)
    .join('\n');
  return `<section class="mt-8" aria-label="${esc(EXPLORE_HEADING[locale])}">
<h2 class="text-base font-bold text-strong mb-3">${esc(EXPLORE_HEADING[locale])}</h2>
<ul class="space-y-2 list-none p-0 m-0">
${items}
</ul>
</section>`;
}

function renderProfileBody(
  profile: EmployerProfile,
  jobs: CorpusJob[],
  locale: Locale,
  allActiveJobs: CorpusJob[] = jobs,
): string {
  const name = profile.name;
  const tiles = [
    statTile(OPEN_ROLES_LABEL[locale], String(profile.activeJobs)),
    profile.salaryMedianChf ? statTile(MEDIAN_SALARY_LABEL[locale], fmtChf(profile.salaryMedianChf)) : '',
    statTile(LOCATIONS_LABEL[locale], esc(locationsSummary(profile)) || String(profile.cantons.length)),
    profile.sector ? statTile(SECTOR_LABEL[locale], esc(profile.sector)) : '',
    profile.trend?.added ? statTile(`${NEW_ROLES_LABEL[locale]} (${profile.trend.windowDays}g)`, `+${profile.trend.added}`) : '',
  ].filter(Boolean).join('');

  const cards = jobs
    .map((job) => {
      const href = jobDetailPath(job, locale);
      if (!href) return '';
      const cardJob: JobCardJob = {
        title: job.title,
        titleByLocale: job.titleByLocale,
        company: job.company,
        companyKey: job.companyKey,
        location: job.location,
        addressLocality: job.addressLocality,
        canton: job.canton,
        contract: job.contract,
        postedDate: job.postedDate,
        datePosted: job.datePosted,
        salaryMin: job.salaryMin ?? null,
        salaryMax: job.salaryMax ?? null,
        salarySource: job.salarySource,
        companyDomain: job.companyDomain,
        url: job.url,
      };
      return renderJobCardHtml(cardJob, { href, locale });
    })
    .filter(Boolean)
    .join('\n');

  return `<main class="seo-static-content max-w-[820px] mx-auto px-5 pt-6 pb-14 leading-relaxed text-body">
${breadcrumbHtml(locale, name)}
<header class="rounded-2xl border border-edge bg-surface-alt p-5 mb-5">
<h1 class="text-[26px] font-bold text-strong leading-tight m-0 mb-1.5">${esc(H1_PREFIX[locale])} ${esc(name)}</h1>
<p class="text-[15px] text-muted m-0">${esc(introProse(profile, allActiveJobs, locale).split('. ')[0])}.</p>
<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">${tiles}</div>
</header>
<section class="mb-7"><p class="my-2.5 leading-relaxed text-body">${esc(introProse(profile, allActiveJobs, locale))}</p></section>
<section class="mb-2">
<h2 class="text-lg font-bold text-strong mb-3">${esc(JOBS_HEADING[locale])} (${profile.activeJobs})</h2>
${JOB_CARD_ICON_SYMBOLS}
<div class="grid gap-3">
${cards}
</div>
</section>
${exploreLinksHtml(profile, locale)}
${renderEmployerCtaBlock(locale, 'employer_profile')}
</main>`;
}

/**
 * Below-floor bridge — noindex,follow thin shell at the SAME /aziende/<slug>/
 * URL for a company that fell below the indexable floor. Prevents a silent 404
 * (AGENTS.md § Static SEO Pages) and channels crawl equity (follow) to the live
 * canton / weekly-employers hubs. Paired with the searchConsoleCompat self-map.
 */
function emitEmployerBelowFloorBridge(rec: BelowFloorRecord, locale: Locale): string {
  const canton = rec.canton || 'TI';
  const cantonSection = resolveCantonSection(locale, canton);
  const cantonPath = `${localePrefix(locale)}/${cantonSection}/`.replace(/\/+/g, '/');
  const weekly = buildCurrentWeekPath(locale, 'ticino');
  const jobBoard = `${legacyTiSectionRoot(locale)}/`.replace(/\/+/g, '/');
  const lede: Record<Locale, string> = {
    it: `${rec.name} ha attualmente ${rec.activeJobs} posizioni aperte. Esplora tutte le offerte in ${canton} e gli employer che assumono questa settimana.`,
    en: `${rec.name} currently has ${rec.activeJobs} open positions. Explore all jobs in ${canton} and the employers hiring this week.`,
    de: `${rec.name} hat aktuell ${rec.activeJobs} offene Stellen. Entdecken Sie alle Stellen in ${canton} und die Arbeitgeber, die diese Woche einstellen.`,
    fr: `${rec.name} compte actuellement ${rec.activeJobs} postes ouverts. Explorez toutes les offres à ${canton} et les employeurs qui recrutent cette semaine.`,
  };
  return `<main class="seo-static-content max-w-[760px] mx-auto px-5 pt-8 pb-14 text-body">
${breadcrumbHtml(locale, rec.name)}
<h1 class="text-2xl font-bold text-strong mb-3">${esc(rec.name)}</h1>
<p class="text-body mb-5">${esc(lede[locale])}</p>
<ul class="space-y-2 list-none p-0 m-0">
<li><a href="${esc(cantonPath)}" class="text-sm font-semibold text-link">${esc(ALL_JOBS_IN[locale])} ${esc(canton)} →</a></li>
<li><a href="${esc(weekly)}" class="text-sm font-semibold text-link">${esc(WEEKLY_LINK_LABEL[locale])} →</a></li>
<li><a href="${esc(jobBoard)}" class="text-sm font-semibold text-link">${esc(JOB_BOARD_LABEL[locale])} →</a></li>
</ul>
</main>`;
}

/** hreflang `<link>` set for a slug. `locales` restricts the alternates to the
 * subset that is actually indexable so an index page never points an alternate
 * at a noindex sibling (reviewer adversarial check, PR #4511). x-default → IT
 * only when IT itself is in the set. */
function hreflangFor(slug: string, locales: readonly Locale[] = LOCALES): string {
  const lines = locales.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${profilePath(alt, slug)}">`,
  );
  if (locales.includes('it')) {
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${profilePath('it', slug)}">`);
  }
  return lines.join('\n');
}

function breadcrumbLd(locale: Locale, slug: string, name: string): string {
  return inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: HOME_LABEL[locale], item: `${BASE_URL}${localePrefix(locale)}/` },
      { '@type': 'ListItem', position: 2, name: `${H1_PREFIX[locale]} ${name}`, item: `${BASE_URL}${profilePath(locale, slug)}` },
    ],
  });
}

export function employerProfilePagesPlugin(rootDir: string): Plugin {
  return {
    name: 'employer-profile-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_EMPLOYER_PROFILE_PAGES === '1') {
        console.log('\x1b[33m[employer-profile-pages]\x1b[0m Skipped (SKIP_EMPLOYER_PROFILE_PAGES=1)');
        resolveEmployerProfilesFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveEmployerProfilesFlushed([]);
        return;
      }

      const dsPath = np.resolve(rootDir, 'data/employer-profiles.json');
      if (!fs.existsSync(dsPath)) {
        console.log('\x1b[33m[employer-profile-pages]\x1b[0m no employer-profiles.json — nothing to emit.');
        resolveEmployerProfilesFlushed([]);
        return;
      }
      let dataset: EmployerDataset;
      try {
        dataset = JSON.parse(fs.readFileSync(dsPath, 'utf-8')) as EmployerDataset;
      } catch (err) {
        console.warn('\x1b[33m[employer-profile-pages]\x1b[0m dataset parse failed:', err);
        resolveEmployerProfilesFlushed([]);
        return;
      }
      const profiles = dataset.profiles || [];
      const belowFloor = dataset.belowFloor || [];
      if (profiles.length === 0 && belowFloor.length === 0) {
        console.log('\x1b[33m[employer-profile-pages]\x1b[0m empty dataset — nothing to emit.');
        resolveEmployerProfilesFlushed([]);
        return;
      }

      // Group active jobs by the SAME canonical slug the dataset uses.
      const jobs = loadJobsJson<CorpusJob>(rootDir);
      const bySlug = new Map<string, CorpusJob[]>();
      for (const job of jobs) {
        const company = String(job.company || '').trim();
        if (!company) continue;
        const slug = canonicalCompanyProfileSlug(company, job.companyKey);
        if (!slug) continue;
        const arr = bySlug.get(slug);
        if (arr) arr.push(job);
        else bySlug.set(slug, [job]);
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'employerProfilePagesPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      const emittedProfiles: EmittedEmployerProfile[] = [];
      let profilePages = 0;
      let bridgePages = 0;
      let thinDowngraded = 0;

      for (const profile of profiles) {
        const slug = profile.slug;
        if (!slug) continue;
        const group = (bySlug.get(slug) || [])
          .slice()
          .sort((a, b) =>
            firstDateMs(b.postedDate, b.datePosted, b.crawledAt, b.firstSeenAt) -
            firstDateMs(a.postedDate, a.datePosted, a.crawledAt, a.firstSeenAt),
          );
        const listed = group.slice(0, MAX_JOBS_LISTED);
        // Display the LIVE active count (corpus at build time) rather than the
        // committed snapshot, and gate indexability on it — so a dataset that
        // has drifted below the floor since it was generated auto-downgrades to
        // noindex instead of shipping a thin/empty indexable page.
        const liveActive = group.length;
        const liveProfile: EmployerProfile = { ...profile, activeJobs: liveActive };

        // Pre-pass: render each locale's body once and decide indexability, so
        // the hreflang/alternate set lists ONLY indexable locales — an index
        // page never points an alternate at a noindex sibling (reviewer
        // adversarial check). Rendering is reused in the emit loop below.
        const rendered = LOCALES.map((locale) => {
          const bodyHtml = renderProfileBody(liveProfile, listed, locale, group);
          const indexable = liveActive >= MIN_ACTIVE_JOBS && countHtmlBodyWords(bodyHtml) >= MIN_INDEXABLE_WORDS;
          return { locale, bodyHtml, indexable };
        });
        const indexableLocales = rendered.filter((r) => r.indexable).map((r) => r.locale);
        const hreflangHtml = hreflangFor(slug, indexableLocales);
        const alternates = [
          ...indexableLocales.map((alt) => `${alt}|${BASE_URL}${profilePath(alt, slug)}`),
          ...(indexableLocales.includes('it') ? [`x-default|${BASE_URL}${profilePath('it', slug)}`] : []),
        ];

        for (const { locale, bodyHtml, indexable } of rendered) {
          const urlPath = profilePath(locale, slug);
          const canonicalUrl = `${BASE_URL}${urlPath}`;

          // JobPosting ItemList (supplementary list-page signal; the
          // authoritative per-job JobPosting also lives on each linked detail
          // page). Kept as full buildListItemJobPosting output — an earlier
          // draft of this fix lightened it to plain name+url to help
          // audit:text-html-ratio, but tests/employer-profile-pages.test.ts
          // ("embeds COMPLETE JobPosting structured data (Non-Negotiable #3)")
          // asserts every mandatory JobPosting field on THIS page's ItemList
          // items too — that test is the project's actual encoded contract
          // for this page, overriding the "list pages don't need full
          // JobPosting" Google-policy argument. Reverted; the ratio fix here
          // is MAX_JOBS_LISTED (24→8) + the expanded real prose only (see
          // that constant's comment) — text-html-ratio still needs an honest
          // baseline for this bucket regardless (see PR body).
          const itemListElements = listed
            .map((job) => {
              // Same guard as the job cards (renderProfileBody): a job whose
              // slug is missing has no detail page — without this skip, jobUrl
              // would collapse to the bare BASE_URL and the JobPosting in the
              // ItemList would point at the homepage (reviewer 🔴, PR #4511).
              const detail = jobDetailPath(job, locale);
              if (!detail) return null;
              const posting = buildListItemJobPosting(job, { locale, url: `${BASE_URL}${detail}`, baseUrl: BASE_URL });
              return posting ?? null;
            })
            .filter((p): p is Record<string, unknown> => p !== null)
            .map((posting, idx) => ({ '@type': 'ListItem', position: idx + 1, item: posting }));
          const jsonLdScripts = [breadcrumbLd(locale, slug, profile.name)];
          if (itemListElements.length > 0) {
            jsonLdScripts.push(inlineScriptJson({
              '@context': 'https://schema.org',
              '@type': 'ItemList',
              name: `${H1_PREFIX[locale]} ${profile.name}`,
              numberOfItems: itemListElements.length,
              itemListElement: itemListElements,
            }));
          }

          if (!indexable) thinDowngraded++;

          // End-of-content multiplex — gated on `indexable`, so below-floor /
          // thin profiles (noindex) never carry a manual slot (MFA-safety).
          const bodyWithAd = `${bodyHtml}${endOfContentMultiplexHtml({ indexable })}`;

          // Budget-aware cascade (composePlaceTitle) — was a single fixed
          // `<prefix> <name>: <suffix>` template with no fallback; a longer
          // legal company name overflowed TITLE_MAX_CHARS (66) with no
          // recovery (audit:title-length regression #4593, 393 offenders —
          // every profile whose name alone left <21-25 chars of budget).
          // Longest-first candidates, name never truncated (composePlaceTitle
          // policy) — same "shrink the boilerplate, never the place/name"
          // pattern as job titles (composeSerpJobTitle) and comune titles.
          //
          // The last candidate must NEVER be the bare `${H1_PREFIX} ${name}`
          // string — that's byte-identical to <h1> (see renderProfileBody),
          // so falling back to it trips audit:h1-title-duplicates (157
          // offenders, validate-dist run 29794187475). Short-suffix middle
          // candidate keeps title != h1 for virtually every name; the
          // TITLE_SUFFIX_SHORT comment explains why this holds even on
          // further overflow.
          const titleCandidates = [
            `${H1_PREFIX[locale]} ${profile.name}: ${TITLE_SUFFIX[locale]}`,
            `${H1_PREFIX[locale]} ${profile.name} · ${TITLE_SUFFIX_SHORT[locale]}`,
          ];
          const html = buildSeoPageHtml({
            locale,
            title: composePlaceTitle(titleCandidates, TITLE_MAX_CHARS, (s) => esc(s).length),
            description: introProse(liveProfile, group, locale).slice(0, 160),
            canonicalUrl,
            robots: indexable ? 'index,follow' : 'noindex,follow',
            ogType: 'website',
            ogLocale: OG_LOCALE[locale],
            hreflangHtml,
            jsonLdScripts,
            bodyHtml: bodyWithAd,
            distDir,
            skipMainWrap: true,
          });

          collector.add(np.join(distDir, urlPath, 'index.html'), html);
          collector.add(np.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          profilePages++;

          if (indexable) {
            emittedProfiles.push({ locale, path: urlPath, label: profile.name });
          }

          if (locale === 'it' && indexable) {
            sitemapEntries.push({ canonical: urlPath, alternates });
          }
        }
      }

      for (const rec of belowFloor) {
        const slug = rec.slug;
        if (!slug) continue;
        const hreflangHtml = hreflangFor(slug);
        for (const locale of LOCALES) {
          const urlPath = profilePath(locale, slug);
          const canonicalUrl = `${BASE_URL}${urlPath}`;
          const bodyHtml = emitEmployerBelowFloorBridge(rec, locale);
          const html = buildSeoPageHtml({
            locale,
            title: `${H1_PREFIX[locale]} ${rec.name}`,
            description: `${rec.name} — ${rec.activeJobs} ${OPEN_ROLES_LABEL[locale].toLowerCase()}.`,
            canonicalUrl,
            robots: 'noindex,follow',
            ogType: 'website',
            ogLocale: OG_LOCALE[locale],
            hreflangHtml,
            jsonLdScripts: [breadcrumbLd(locale, slug, rec.name)],
            bodyHtml,
            distDir,
            skipMainWrap: true,
          });
          collector.add(np.join(distDir, urlPath, 'index.html'), html);
          collector.add(np.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          bridgePages++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const urls = sitemapEntries
            .map(({ canonical, alternates }) => {
              const alts = alternates
                .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`)
                .join('\n');
              return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
            })
            .join('\n');
          const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
          fs.writeFileSync(np.join(distDir, 'sitemap-employer-profiles.xml'), xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[employer-profile-pages]\x1b[0m sitemap write failed:', err);
        }
      }

      const written = await collector.flush();
      console.log(
        `\x1b[36m[employer-profile-pages]\x1b[0m ${profiles.length} profiles + ${belowFloor.length} below-floor → ` +
        `${profilePages} profile pages (${thinDowngraded} noindex-thin) + ${bridgePages} bridge pages ` +
        `— flushed ${written} files.`,
      );
      resolveEmployerProfilesFlushed(emittedProfiles);
    },
  };
}
