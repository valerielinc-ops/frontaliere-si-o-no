import { resolveReportedPostingDate } from '../scripts/lib/job-posting-date.mjs';
import { resolveRolloutPostingDate } from '../scripts/lib/job-posting-date-rollout.mjs';
/**
 * Vite build plugin that emits static HTML for every registered sector-based
 * job hub in all 4 locales.
 *
 * Filters `data/jobs.json` to canton TI (via `resolveJobCanton`), then by
 * sector keyword pattern (title/description/category/tags), and emits a
 * dedicated landing that consolidates the signal for high-intent GSC queries
 * that currently land on random job detail pages.
 *
 * Writes `sitemap-sector.xml` and patches `sitemap.xml`.
 *
 * Kept standalone so it doesn't touch the much larger `jobsSeoPagesPlugin.ts`
 * (lower merge-conflict risk with parallel SEO work).
 */

// Import statici, NON `await import()` dentro closeBundle (#5001): closeBundle e'
// un hook Rollup async/parallelo, quindi quell'await sospende il plugin e un
// altro plugin `enforce:'post'` puo' girare per intero prima che questo
// riprenda. E' gia' costato due bug silenziosi (pdfWhitepapersPlugin,
// staticPagesPlugin): le hero card venivano drenate prima di essere registrate.
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { clampMetaDescription } from './shared/titleSuffix';
import { railGutters } from './shared/railGutters';
import { firstParsableMs } from './shared/firstParsableDate';
import {
  BASE_URL,
  FAVICON_LINKS,
  GTAG_SNIPPET,
  PARTNERIZE_TAG_SNIPPET,
  ADSENSE_SNIPPET,
  CDN_PRECONNECT_HINT,
  robotsMetaEnhancedForContent,
} from './constants';
import { asyncCssHeadBlock, rootShell } from './htmlTemplate';
import { jobBoardHeadTags } from './jobBoardGpt';
import { buildJobBoardUrl } from './cityJobsAggregate';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_CLASS,
  renderStatGrid,
  pickStatTileTone,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
  type JobCardListItem,
} from './shared/jobCardHtml';
import { renderJobBoardCommuterContext } from './shared/jobBoardCommuterContext';
import { inlineScriptJson } from './shared/inlineJsonScript';
import type { JobBoardLocale } from './jobBoardSeoPure';
import {
  SECTOR_HUB_KEYS,
  SECTOR_HUB_SLUG,
  SECTOR_HUB_SECTION,
  SECTOR_HUB_LOCALE_PREFIX,
  SECTOR_HUB_DISPLAY,
  buildSectorHubPath,
  buildSectorHubSeo,
  buildSectorProse,
  loadSectorProseData,
  filterSectorJobs,
  countSectorJobsByLocale,
  type SectorCountableJob,
  type SectorHubKey,
} from './jobSectorLanding';
import { SECTOR_HUB_EMOJI } from './shared/sectorHubEmoji';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { resolveSectorPagesFlushed } from './shared/buildSignals';
import { SECTOR_HUB_SIBLINGS } from './shared/sectorHubClusters';
import { buildProfessionLandingPath, type ProfessionId } from './professionLandingsData';
import { buildNursingLandingPath, type NursingLandingId } from './nursingLandingsData';
import { reportedSalarySummary } from './shared/realSalaryMedian';
import {
  buildProfessionJourneyAlertHref,
  buildProfessionJourneyNetHref,
  buildProfessionJourneySearchHref,
  PROFESSION_JOURNEY_ANCHORS,
  renderProfessionJourney,
} from './shared/professionJourney';
import {
  resolveJobCanton as sharedResolveJobCanton,
  resolveCantonSection as sharedResolveCantonSection,
} from './shared/cantonSection';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

type ProfessionJourneyTarget = {
  professionKey: string;
  roleLabel: Record<JobBoardLocale, string>;
  alertKeyword: Record<JobBoardLocale, string>;
  roleTitle?: RegExp;
  professionLanding?: ProfessionId;
  nursingLanding?: NursingLandingId;
  /** The company rail intentionally reflects the wider named sector. */
  companyScope: 'role' | 'sector';
};

/** Existing sector hubs prioritized for the role-to-application journey. */
const PROFESSION_JOURNEY_TARGETS: Partial<Record<SectorHubKey, ProfessionJourneyTarget>> = {
  infermieri: {
    professionKey: 'infermiere',
    roleLabel: { it: 'infermieri', en: 'nursing jobs', de: 'Pflegefachberufe', fr: 'métiers infirmiers' },
    alertKeyword: { it: 'infermiere', en: 'nurse', de: 'Pflegefachfrau', fr: 'infirmier' },
    roleTitle: /infermier|nurse|pflegefach|krankenpfleg|krankensch|infirmier/i,
    professionLanding: 'infermiere',
    companyScope: 'role',
  },
  'case-anziani': {
    professionKey: 'case-anziani',
    roleLabel: { it: 'lavorare nelle case anziani', en: 'elderly-care jobs', de: 'Stellen in der Altenpflege', fr: 'emplois en maison de retraite' },
    alertKeyword: { it: 'case anziani', en: 'elderly care', de: 'Altenpflege', fr: 'maison de retraite' },
    nursingLanding: 'healthcare-ticino',
    companyScope: 'sector',
  },
  educatori: {
    professionKey: 'educatore',
    roleLabel: { it: 'educatori', en: 'educators', de: 'Erzieher', fr: 'éducateurs' },
    alertKeyword: { it: 'educatore', en: 'educator', de: 'Erzieher', fr: 'éducateur' },
    roleTitle: /educator|educatric|erzieher|p[aä]dagog|social[ -]pedagog|[eé]ducateur|operatore[ -]socio[ -]educativ/i,
    professionLanding: 'educatore',
    companyScope: 'role',
  },
  autisti: {
    professionKey: 'autista',
    roleLabel: { it: 'autisti', en: 'drivers', de: 'Fahrer', fr: 'chauffeurs' },
    alertKeyword: { it: 'autista', en: 'driver', de: 'Fahrer', fr: 'chauffeur' },
    roleTitle: /\bautist[aie]\b|\bautotrasport|\bcamionist|\bdriver\b|\btrucker\b|\bchauffeur\b|\bfahrer\b|\bconducteur[ -]?routier\b|\bdelivery[ -]driver\b/i,
    professionLanding: 'autista',
    companyScope: 'role',
  },
  hotel: {
    professionKey: 'receptionist',
    roleLabel: { it: 'receptionist', en: 'receptionists', de: 'Rezeptionisten', fr: 'réceptionnistes' },
    alertKeyword: { it: 'receptionist', en: 'receptionist', de: 'Rezeptionist', fr: 'réceptionniste' },
    roleTitle: /\breceptionist\b|\breception\b|\brezeption(?:ist|istin)?\b|\br[eé]ceptionniste\b|\bfront[ -]office\b|\bricevimento\b|\baccueil\b|\bempfang\b/i,
    companyScope: 'sector',
  },
  ristorazione: {
    professionKey: 'pasticciere',
    roleLabel: { it: 'pasticcieri', en: 'pastry chefs', de: 'Konditoren', fr: 'pâtissiers' },
    alertKeyword: { it: 'pasticciere', en: 'pastry chef', de: 'Konditor', fr: 'pâtissier' },
    roleTitle: /pasticcier|pasticcer|pastry[ -]chef|konditor|p[aâ]tissier|confectioner/i,
    companyScope: 'sector',
  },
};

const CALCULATOR_PATH: Record<JobBoardLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

const ROLE_REQUIREMENTS_COPY: Record<'hotel' | 'ristorazione', Record<JobBoardLocale, { title: string; body: string }>> = {
  hotel: {
    it: { title: 'Cosa verificare negli annunci da receptionist', body: 'Prima di candidarti, confronta per ogni offerta le lingue, l’esperienza, i turni e le attività di ricevimento indicate dal datore. I criteri cambiano da un annuncio all’altro: verifica sempre i dettagli della posizione.' },
    en: { title: 'What to check in receptionist listings', body: 'Before applying, compare the languages, experience, shifts and front-desk duties stated in each listing. Details vary by employer, so check the posting for the specific role.' },
    de: { title: 'Was Sie in Anzeigen für den Empfang prüfen sollten', body: 'Vergleichen Sie vor der Bewerbung die in jeder Anzeige genannten Sprachen, Erfahrungen, Schichten und Empfangsaufgaben. Die Angaben unterscheiden sich je nach Arbeitgeber; prüfen Sie deshalb die konkrete Stelle.' },
    fr: { title: 'À vérifier dans les offres de réceptionniste', body: 'Avant de postuler, comparez les langues, l’expérience, les horaires et les tâches d’accueil indiqués dans chaque offre. Les détails varient selon l’employeur : vérifiez l’annonce du poste concerné.' },
  },
  ristorazione: {
    it: { title: 'Cosa verificare negli annunci da pasticciere', body: 'Prima di candidarti, controlla per ogni offerta la formazione, l’esperienza, i turni e le mansioni descritti dal datore. Le condizioni dipendono dalla posizione: fai riferimento ai dettagli dell’annuncio.' },
    en: { title: 'What to check in pastry-chef listings', body: 'Before applying, check the training, experience, shifts and duties described in each listing. Conditions depend on the role, so use the details in the specific posting.' },
    de: { title: 'Was Sie in Anzeigen für Konditoren prüfen sollten', body: 'Prüfen Sie vor der Bewerbung die in jeder Anzeige beschriebenen Ausbildungen, Erfahrungen, Schichten und Aufgaben. Die Bedingungen hängen von der Stelle ab; maßgeblich sind die Angaben in der konkreten Anzeige.' },
    fr: { title: 'À vérifier dans les offres de pâtissier', body: 'Avant de postuler, vérifiez la formation, l’expérience, les horaires et les tâches décrits dans chaque offre. Les conditions dépendent du poste : reportez-vous aux détails de l’annonce.' },
  },
};

const JOURNEY_COMPANY_COPY: Record<JobBoardLocale, {
  roleHeading: string;
  sectorHeadings: Record<'case-anziani' | 'hotel' | 'ristorazione', string>;
  empty: string;
}> = {
  it: {
    roleHeading: 'Datori presenti negli annunci che corrispondono al ruolo',
    sectorHeadings: {
      'case-anziani': 'Aziende presenti negli annunci delle case anziani',
      hotel: 'Aziende presenti negli annunci del settore alberghiero',
      ristorazione: 'Aziende presenti negli annunci della ristorazione',
    },
    empty: 'Gli annunci disponibili non riportano nomi azienda per questo elenco.',
  },
  en: {
    roleHeading: 'Employers named in listings matching this role',
    sectorHeadings: {
      'case-anziani': 'Employers named in elderly-care listings',
      hotel: 'Employers named in hotel-sector listings',
      ristorazione: 'Employers named in restaurant-sector listings',
    },
    empty: 'The available listings do not include employer names for this list.',
  },
  de: {
    roleHeading: 'Arbeitgeber aus Anzeigen, die zu dieser Rolle passen',
    sectorHeadings: {
      'case-anziani': 'Arbeitgeber aus Anzeigen der Altenpflege',
      hotel: 'Arbeitgeber aus Anzeigen der Hotelbranche',
      ristorazione: 'Arbeitgeber aus Anzeigen der Gastronomie',
    },
    empty: 'Die verfügbaren Anzeigen enthalten für diese Liste keine Arbeitgebernamen.',
  },
  fr: {
    roleHeading: 'Employeurs cités dans les offres correspondant au métier',
    sectorHeadings: {
      'case-anziani': 'Employeurs cités dans les offres de maisons de retraite',
      hotel: 'Employeurs cités dans les offres du secteur hôtelier',
      ristorazione: 'Employeurs cités dans les offres de restauration',
    },
    empty: 'Les offres disponibles ne mentionnent pas de noms d’employeurs pour cette liste.',
  },
};

interface SectorJourneySalaryJob extends SectorCountableJob {
  salaryMin?: number | null;
  salaryMax?: number | null;
  salarySource?: string;
  currency?: string;
}

function matchesJourneyRole(job: SectorCountableJob, roleTitle: RegExp): boolean {
  const titles = [job.title, ...Object.values(job.titleByLocale ?? {})]
    .map((title) => String(title || '').trim())
    .filter(Boolean);
  return roleTitle.test(titles.join(' '));
}

function renderJourneyRoleRequirements(sector: SectorHubKey, locale: JobBoardLocale): string {
  if (sector !== 'hotel' && sector !== 'ristorazione') return '';
  const copy = ROLE_REQUIREMENTS_COPY[sector][locale];
  return `<section id="${PROFESSION_JOURNEY_ANCHORS.requirements}" class="s-KZc0LQ"><h2 class="s-BEjFo9">${esc(copy.title)}</h2><p class="s-Poj6T0">${esc(copy.body)}</p></section>`;
}

function renderJourneyCompanies(
  jobs: ReadonlyArray<SectorCountableJob>,
  sector: SectorHubKey,
  locale: JobBoardLocale,
  target: ProfessionJourneyTarget,
  roleJobs: ReadonlyArray<SectorCountableJob>,
): string {
  const sourceJobs = target.companyScope === 'role' ? roleJobs : jobs;
  const companyCounts = new Map<string, { name: string; count: number }>();
  for (const job of sourceJobs) {
    const name = String(job.company || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const previous = companyCounts.get(key);
    if (previous) companyCounts.set(key, { ...previous, count: previous.count + 1 });
    else companyCounts.set(key, { name, count: 1 });
  }
  const names = [...companyCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale))
    .slice(0, 8);
  const copy = JOURNEY_COMPANY_COPY[locale];
  const heading = target.companyScope === 'sector' && (sector === 'case-anziani' || sector === 'hotel' || sector === 'ristorazione')
    ? copy.sectorHeadings[sector]
    : copy.roleHeading;
  const list = names.length > 0
    ? `<ul class="s-Bidr8Y">${names.map(({ name, count }) => `<li class="s-Pkexk_">${esc(name)} <span class="text-subtle">(${count})</span></li>`).join('')}</ul>`
    : `<p class="s-Poj6T0">${esc(copy.empty)}</p>`;
  return `<section id="${PROFESSION_JOURNEY_ANCHORS.companies}" class="s-KZc0LQ"><h2 class="s-BEjFo9">${esc(heading)}</h2>${list}</section>`;
}

/**
 * Sector landings are primary job-listing pages, not three-card previews: the
 * headline count and the visible inventory must describe the same set. Keep
 * the build-time guard aligned with the site's 260 KB page-weight budget so a
 * growing corpus fails loudly instead of silently hiding matching jobs.
 */
const SECTOR_PAGE_HARD_BUDGET_BYTES = 260 * 1024;

const LOCALE_OG: Record<JobBoardLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SECTION_NAME: Record<JobBoardLocale, string> = {
  it: 'Cerca lavoro in Ticino',
  en: 'Find jobs in Ticino',
  de: 'Jobs im Tessin',
  fr: 'Trouver un emploi au Tessin',
};

function esc(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

function slugify(input: unknown): string {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function localizedJobSlug(job: SectorCountableJob, locale: JobBoardLocale): string {
  const slugByLocale = job.slugByLocale as Record<string, string> | undefined;
  const explicit = String(slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job.slug || '').trim();
  if (canonical) return canonical;
  const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
  const localizedTitle = String(titleByLocale?.[locale] || job.title || '');
  return slugify(`${localizedTitle}-${job.company || ''}-${job.location || ''}`) || slugify(localizedTitle);
}

function buildJobHref(
  locale: JobBoardLocale,
  job: SectorCountableJob,
): string {
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const slug = localizedJobSlug(job, locale);
  return `${BASE_URL}${prefix}/${section}/${slug}/`.replace(/([^:])\/+/g, '$1/');
}

/** Localized heading for the sibling-sector rail. */
const SIBLING_RAIL_HEADING: Record<JobBoardLocale, string> = {
  it: 'Settori correlati',
  en: 'Related sectors',
  de: 'Verwandte Branchen',
  fr: 'Secteurs connexes',
};

/**
 * Render a small `<nav>` rail linking the current sector hub to its 3-5
 * nearest siblings (same vertical) so each hub is mutually reachable in the
 * BFS-from-`/` graph instead of being an orphan with ~0 internal links.
 *
 * Hrefs come from {@link buildSectorHubPath} (trailing-slash by construction)
 * and labels from {@link SECTOR_HUB_DISPLAY} (auto-localized). Returns an empty
 * string when the sector has no curated siblings, so unmapped long-tail hubs
 * simply render nothing rather than weak cross-links. The rail markup is a few
 * hundred bytes — well inside the 260 KB page-weight budget.
 */
export function filterSectorHubSiblings(
  sector: SectorHubKey,
  siblingCounts?: Readonly<Partial<Record<SectorHubKey, number>>>,
): readonly SectorHubKey[] {
  const siblings = SECTOR_HUB_SIBLINGS[sector] ?? [];
  if (!siblingCounts) return siblings;
  return siblings.filter((sibling) => Number(siblingCounts[sibling] ?? 0) > 0);
}

function renderSiblingSectorRail(
  locale: JobBoardLocale,
  sector: SectorHubKey,
  siblingCounts?: Readonly<Partial<Record<SectorHubKey, number>>>,
): string {
  const siblings = filterSectorHubSiblings(sector, siblingCounts);
  if (!siblings || siblings.length === 0) return '';
  const items = siblings
    .map((sib) => {
      const href = buildSectorHubPath(locale, sib);
      const label = SECTOR_HUB_DISPLAY[locale][sib];
      return `<li class="s-sib-li"><a class="s-sib-a" href="${esc(href)}">${esc(label)}</a></li>`;
    })
    .join('');
  return `<nav class="s-sib-rail" aria-label="${esc(SIBLING_RAIL_HEADING[locale])}"><p class="s-sib-h">${esc(SIBLING_RAIL_HEADING[locale])}</p><ul class="s-sib-ul">${items}</ul></nav>`;
}

/** Curated cross-link targets (Issue #4303 item 2b) so a "same profession in
 * other cantons" link from a Ticino sector hub always lands on a page
 * carrying genuine context rather than a bare thin combo shell. Small
 * standalone copy (not imported from jobsSeoPagesPlugin.ts's
 * CROSS_CANTON_PROMO_CANTONS) — this plugin is intentionally
 * dependency-light, see file header; only 3 entries, kept in lockstep by
 * comment cross-reference rather than a shared import. */
const CROSS_CANTON_LINK_TARGETS: ReadonlyArray<{ code: string; label: Record<JobBoardLocale, string> }> = [
  { code: 'ZH', label: { it: 'Zurigo', en: 'Zürich', de: 'Zürich', fr: 'Zurich' } },
  { code: 'BE', label: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' } },
  { code: 'BASILEA', label: { it: 'Basilea', en: 'Basel', de: 'Basel', fr: 'Bâle' } },
];

/** Minimum TI active-job count for the sector before showing the
 * cross-canton rail — "professioni con più inventory" (item 2b): a hub with
 * near-zero TI jobs isn't a strong enough profession signal to promote
 * other-canton alternatives from. Mirrors REAL_DATA_SECTOR_MIN_JOBS in
 * jobsSeoPagesPlugin.ts (same stability-floor convention, independent copy). */
const CROSS_CANTON_MIN_INVENTORY = 3;

const CROSS_CANTON_RAIL_HEADING: Record<JobBoardLocale, string> = {
  it: 'Stessa professione in altri cantoni',
  en: 'Same profession in other cantons',
  de: 'Gleicher Beruf in anderen Kantonen',
  fr: 'Même métier dans d’autres cantons',
};

/**
 * Render a small `<nav>` rail linking the current Ticino sector hub to the
 * matching per-canton-sector combo page (`/{canton-section}/{sectorSlug}/`,
 * emitted unconditionally by jobsSeoPagesPlugin.ts, PR #4254) in each of the
 * 3 curated CROSS_CANTON_LINK_TARGETS cantons. Gated on `count >= CROSS_CANTON_MIN_INVENTORY`
 * so thin sectors don't push traffic toward alternatives the hub itself
 * barely justifies. Returns '' when the sector has no slug for the locale
 * or the target canton doesn't resolve — never a dead link.
 *
 * `count === 0` is the deliberate exception (#5203). The owner decided on
 * 2026-07-16 that TI sector hubs carry no minimum-inventory threshold, so a
 * sector with genuinely no Ticino listings — `camerieri`, `sicurezza` and
 * `agricoltura` are really empty, not mis-matched — stays live and indexed.
 * At exactly zero the "don't dilute a weak signal" rationale above does not
 * apply: there is no signal to dilute and no listing to compete with, and the
 * only useful thing the page can offer a high-intent visitor is where the same
 * work IS available. Suppressing the rail there leaves a dead end. The 1-2
 * band keeps the original gate: those hubs do have listings to show.
 */
function renderCrossCantonSectorRail(locale: JobBoardLocale, sector: SectorHubKey, count: number): string {
  if (count > 0 && count < CROSS_CANTON_MIN_INVENTORY) return '';
  const slug = SECTOR_HUB_SLUG[locale]?.[sector];
  if (!slug) return '';
  const items = CROSS_CANTON_LINK_TARGETS.map(({ code, label }) => {
    const section = sharedResolveCantonSection(locale, code);
    if (!section) return '';
    const href = `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${section}/${slug}/`.replace(/\/+/g, '/');
    return `<li class="s-sib-li"><a class="s-sib-a" href="${esc(href)}">${esc(label[locale])}</a></li>`;
  })
    .filter(Boolean)
    .join('');
  if (!items) return '';
  return `<nav class="s-xcanton-rail" aria-label="${esc(CROSS_CANTON_RAIL_HEADING[locale])}"><p class="s-sib-h">${esc(CROSS_CANTON_RAIL_HEADING[locale])}</p><ul class="s-sib-ul">${items}</ul></nav>`;
}

export interface BuildSectorLandingHtmlOptions {
  sector: SectorHubKey;
  locale: JobBoardLocale;
  /** Pre-filtered complete job list for this sector and locale. */
  matchingJobs: ReadonlyArray<SectorCountableJob>;
  /** Total active job count for the sector (the H1/stat-tile number). */
  count: number;
  year: number;
  /** YYYY-MM-DD date stamp for the "updated" label. */
  dateStamp: string;
  /** Pre-loaded sector prose data map (or empty `{}`). */
  sectorProseData: Parameters<typeof buildSectorProse>[3];
  /** Stable SPA entry asset filenames from resolveSpaBundle. Optional for callsites (e.g. tests) that omit the SPA shell entirely. */
  entryJs?: string;
  entryCss?: string;
  /**
   * Full-set stat-tile metrics, computed by the caller over ALL matching jobs
   * so the tiles stay honest for popular sectors. When omitted (e.g. the
   * byte-weight unit test), company/city counts fall back to the visible
   * `matchingJobs` set and the fresh tile is dropped.
   */
  companyCount?: number;
  cityCount?: number;
  freshCount?: number;
  /** Full per-locale inventory, used to suppress links to empty sibling hubs. */
  siblingCounts?: Readonly<Partial<Record<SectorHubKey, number>>>;
}

/**
 * Pure HTML builder for a single sector landing page. Extracted so the
 * regression unit test (`tests/seo/job-sector-page-weight.test.ts`) can
 * exercise the exact byte-for-byte output without driving a full Vite
 * build. Callers pass the complete matching set. The 260 KB guard is the
 * safety net for corpus growth; truncating the list here would make the
 * count and cards disagree again.
 */
export function buildSectorLandingHtml(opts: BuildSectorLandingHtmlOptions): string {
  const { sector, locale, matchingJobs, count, year, dateStamp, sectorProseData } = opts;
  const uniqCount = (vals: ReadonlyArray<unknown>): number =>
    new Set(vals.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)).size;
  const companyCount = opts.companyCount ?? uniqCount(matchingJobs.map((j) => j.company));
  const cityCount = opts.cityCount ?? uniqCount(matchingJobs.map((j) => j.location));
  const freshCount = opts.freshCount ?? 0;
  const entryJs = opts.entryJs || '';
  const entryCss = opts.entryCss || '';
  const hasSpaBundle = !!(entryJs && entryCss);

  const seo = buildSectorHubSeo(locale, sector, count, year);
  const proseDisplayName = SECTOR_HUB_DISPLAY[locale][sector];
  const prose = buildSectorProse(sector, locale, proseDisplayName, sectorProseData);

  const canonicalPath = buildSectorHubPath(locale, sector);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const alternates = LOCALES.map((altLocale) => {
    const altPath = buildSectorHubPath(altLocale, sector);
    return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}">`;
  }).join('\n');
  const xDefaultPath = buildSectorHubPath('it', sector);

  const cardItems: JobCardListItem[] = matchingJobs.map((job) => ({
    job: job as JobCardJob,
    href: buildJobHref(locale, job),
  }));

  const jobCards = cardItems.map(({ job, href }) => {
    const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
    const localizedTitle = String(titleByLocale?.[locale] || job.title || 'Offerta lavoro');
    return {
      title: String(localizedTitle).replace(/\s+/g, ' ').trim(),
      company: String(job.company || '').replace(/\s+/g, ' ').trim(),
      location: String(job.location || '').replace(/\s+/g, ' ').trim(),
      href,
      datePosted: resolveRolloutPostingDate(job, () => job.datePosted || job.postedDate || null) || undefined,
    };
  });

  const noResultsLabel = {
    it: 'Nessuna offerta al momento. Torna a breve — la lista si aggiorna più volte al giorno.',
    en: 'No listings right now. Check back soon — the list refreshes multiple times per day.',
    de: 'Aktuell keine Angebote. Schauen Sie bald wieder vorbei — die Liste wird mehrmals täglich aktualisiert.',
    fr: "Aucune offre pour l'instant. Revenez bientôt — la liste est mise à jour plusieurs fois par jour.",
  }[locale];
  const emptyStateHtml = `<p class="s-_Ig0vF">${esc(noResultsLabel)}</p>`;
  const firstResultBlock = cardItems.slice(0, 3);
  const remainingResults = cardItems.slice(3);
  const categorySummaryLabel: Record<JobBoardLocale, string> = {
    it: 'Requisiti e contesto della professione',
    en: 'Role requirements and context',
    de: 'Anforderungen und Berufskontext',
    fr: 'Exigences et contexte du métier',
  };
  const categorySummaryHtml = `<details class="s-card" data-sector-summary>
    <summary class="s-HBR0NM">${esc(categorySummaryLabel[locale])}</summary>
    <p class="s-bOIp6r">${esc(seo.intro)}</p>
  </details>`;
  const jobsHtml = [
    renderJobCardListHtml(firstResultBlock, {
      locale,
      emptyStateHtml,
      hasFollowingItems: remainingResults.length > 0,
    }),
    categorySummaryHtml,
    remainingResults.length > 0
      ? renderJobCardListHtml(remainingResults, { locale, positionOffset: firstResultBlock.length })
      : '',
  ].join('');

  const faqHtml = seo.faq.length > 0
    ? `<section class="s-m_ILbB">
    <h2 class="s-sOn5-B">FAQ</h2>
    ${seo.faq.map((f) => `<details class="s-card" style="margin-bottom:8px"><summary class="s-HBR0NM">${esc(f.question)}</summary><p class="s-bOIp6r">${esc(f.answer)}</p></details>`).join('')}
  </section>`
    : '';

  // Crawler-facing commuter-context prose in a collapsed accordion below
  // the real content (CLAUDE.md rule #14, mobile-first). Bumps the
  // text-to-HTML ratio above the 10% Semrush floor — sector hub pages have
  // ~45 KB of JobCard markup with ~5 KB of prose, landing at 5-7% ratio
  // without this.
  const hubContextSummary: Record<JobBoardLocale, string> = {
    it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
    en: 'Cross-border guide: salary, G permit, tax, weekly return',
    de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
    fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
  };
  const sectorContextHtml = `<details class="hub-seo-context s-mxdIN0">
    <summary class="s-1yn7b_">${hubContextSummary[locale]}</summary>
    <div class="s-yZU6bn">
      <section class="s-p_RJwm">
        ${renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true, sectorOrType: proseDisplayName })}
      </section>
    </div>
  </details>`;

  // Sibling-sector rail — links this hub to its 3-5 nearest siblings so the
  // Registered sector hubs are mutually reachable in the BFS graph (the orphan fix).
  // Empty string for unmapped long-tail sectors.
  const siblingRailHtml = renderSiblingSectorRail(locale, sector, opts.siblingCounts);

  // Issue #4303 item 2b: from this Ticino sector hub, link the same
  // profession's combo page in the curated CROSS_CANTON_LINK_TARGETS cantons — only when
  // this hub itself has meaningful inventory (see CROSS_CANTON_MIN_INVENTORY).
  const crossCantonRailHtml = renderCrossCantonSectorRail(locale, sector, count);

  const sectionRootUrl = `${BASE_URL}${withSlash(
    `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}`.replace(/\/+/g, '/'),
  )}`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: SECTION_NAME[locale], item: sectionRootUrl },
      { '@type': 'ListItem', position: 3, name: seo.h1, item: canonicalUrl },
    ],
  });

  const itemListLd = jobCards.length > 0
    ? inlineScriptJson({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: seo.h1,
        numberOfItems: jobCards.length,
        itemListElement: jobCards.map((j, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          name: j.title,
          url: j.href,
        })),
      })
    : '';

  const collectionLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: seo.h1,
    url: canonicalUrl,
    description: seo.desc,
    inLanguage: locale,
    isPartOf: sectionRootUrl,

  });

  const faqLd = seo.faq.length > 0
    ? inlineScriptJson({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: seo.faq.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      })
    : '';

  const countsLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Offerte attive',
    en: 'Active jobs',
    de: 'Aktive Stellen',
    fr: 'Offres actives',
  };
  const updatedLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Aggiornato',
    en: 'Updated',
    de: 'Aktualisiert',
    fr: 'Mis à jour',
  };
  const jobsSectionLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Annunci disponibili',
    en: 'Available listings',
    de: 'Verfügbare Angebote',
    fr: 'Annonces disponibles',
  };
  const openAllByLocale: Record<JobBoardLocale, string> = {
    it: 'Vedi tutte le offerte di lavoro in Ticino',
    en: 'See all jobs in Ticino',
    de: 'Alle Stellenangebote im Tessin ansehen',
    fr: "Voir toutes les offres d'emploi au Tessin",
  };
  const freshLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Nuove · 7gg',
    en: 'New · 7d',
    de: 'Neu · 7T',
    fr: 'Récent · 7j',
  };
  const companiesLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Aziende',
    en: 'Companies',
    de: 'Unternehmen',
    fr: 'Entreprises',
  };
  const citiesLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Località',
    en: 'Locations',
    de: 'Standorte',
    fr: 'Localités',
  };

  // Stat tiles — headline count is always shown; secondary tiles only when
  // they carry a non-zero signal, so an empty sector degrades to a single
  // clean tile instead of a row of zeros. Tones colour the row (green = many
  // openings / fresh listings) so the hero reads lively rather than flat.
  const statTiles: Array<{ label: string; value: string; tone: ReturnType<typeof pickStatTileTone> }> = [
    { label: countsLabelByLocale[locale], value: String(count), tone: pickStatTileTone('openings', count) },
  ];
  if (freshCount > 0) {
    statTiles.push({ label: freshLabelByLocale[locale], value: `+${freshCount}`, tone: pickStatTileTone('fresh', freshCount) });
  }
  if (companyCount > 0) {
    statTiles.push({ label: companiesLabelByLocale[locale], value: String(companyCount), tone: 'neutral' });
  }
  if (cityCount > 0) {
    statTiles.push({ label: citiesLabelByLocale[locale], value: String(cityCount), tone: 'neutral' });
  }
  const statGridHtml = renderStatGrid(statTiles);
  const ctaHtml = `<a href="${sectionRootUrl}" class="${CTA_PRIMARY_CLASS}" style="margin:0 0 24px">${esc(openAllByLocale[locale])} →</a>`;

  const journeyTarget = PROFESSION_JOURNEY_TARGETS[sector];
  const roleJobs = journeyTarget?.roleTitle
    ? matchingJobs.filter((job) => matchesJourneyRole(job, journeyTarget.roleTitle!))
    : [];
  const roleSalary = reportedSalarySummary(roleJobs.map((job) => job as SectorJourneySalaryJob));
  const roleSearchHref = journeyTarget
    ? buildProfessionJourneySearchHref(buildJobBoardUrl(locale), journeyTarget.alertKeyword[locale])
    : '';
  const journeyHtml = journeyTarget
    ? renderProfessionJourney({
        locale,
        professionKey: journeyTarget.professionKey,
        hrefs: {
          // Hotel and restaurant pages carry broad sector inventories, so the
          // role link must enter the exact receptionist/pastry-chef search.
          offers: journeyTarget.roleTitle && journeyTarget.companyScope === 'sector'
            ? roleSearchHref
            : `#${PROFESSION_JOURNEY_ANCHORS.offers}`,
          requirements: journeyTarget.professionLanding
            ? `${buildProfessionLandingPath(locale, journeyTarget.professionLanding)}#${PROFESSION_JOURNEY_ANCHORS.requirements}`
            : journeyTarget.nursingLanding
              ? `${buildNursingLandingPath(locale, journeyTarget.nursingLanding)}#${PROFESSION_JOURNEY_ANCHORS.requirements}`
              : `#${PROFESSION_JOURNEY_ANCHORS.requirements}`,
          net: buildProfessionJourneyNetHref(CALCULATOR_PATH[locale], roleSalary.medianChf),
          companies: `#${PROFESSION_JOURNEY_ANCHORS.companies}`,
          alert: buildProfessionJourneyAlertHref(buildJobBoardUrl(locale), journeyTarget.alertKeyword[locale]),
        },
        roleLabel: journeyTarget.roleLabel[locale],
        netSalaryPrefilled: roleSalary.medianChf !== null,
      })
    : '';
  const journeyRequirementsHtml = journeyTarget
    ? renderJourneyRoleRequirements(sector, locale)
    : '';
  const journeyCompaniesHtml = journeyTarget
    ? renderJourneyCompanies(matchingJobs, sector, locale, journeyTarget, roleJobs)
    : '';

  // No upstream inventory floor gates this page (unlike the canton/city
  // editorial hubs in jobsSeoPagesPlugin.ts) -- SECTOR_HUB_KEYS x LOCALES
  // emits unconditionally regardless of job count, so the robots tag must be
  // computed per-render from the actual assembled body content instead of
  // assumed indexable.
  const sectorBodyHtml = `${jobsHtml}${prose.html}${journeyRequirementsHtml}${journeyCompaniesHtml}${faqHtml}${sectorContextHtml}${siblingRailHtml}${crossCantonRailHtml}`;
  const sectorRobotsTag = robotsMetaEnhancedForContent(sectorBodyHtml);

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n    ` : ''}${FAVICON_LINKS}
    <title>${esc(seo.title)}</title>
    <meta name="description" content="${esc(clampMetaDescription(seo.desc, undefined, locale))}">${sectorRobotsTag}
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(seo.ogT)}">
    <meta property="og:description" content="${esc(clampMetaDescription(seo.ogD, undefined, locale))}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${esc(seo.ogT)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${faqLd ? `\n    <script type="application/ld+json">${faqLd}</script>` : ''}
    ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
    ${GTAG_SNIPPET}
    ${ADSENSE_SNIPPET}
    ${PARTNERIZE_TAG_SNIPPET}
    ${jobBoardHeadTags(canonicalUrl)}
  </head>
  <body>
    ${rootShell(hasSpaBundle)}
    ${railGutters(true).open}
    <main class="seo-static-content s-Ziv1Xn" data-sector-hub="${esc(sector)}" data-sector-inventory-count="${String(count)}">
        <nav class="s-bcr">
          <a href="/" class="s-bcl">Home</a>
          <span> / </span>
          <a href="${sectionRootUrl}" class="s-bcl">${esc(SECTION_NAME[locale])}</a>
          <span> / </span>
          <span>${esc(seo.h1)}</span>
        </nav>
        <header class="s-sy52lX">
          <p style="${HERO_EYEBROW_STYLE}"><span aria-hidden="true" style="font-size:15px">${SECTOR_HUB_EMOJI[sector]}</span> ${esc(updatedLabelByLocale[locale])} · ${dateStamp}</p>
          <h1 style="${H1_STYLE}">${esc(seo.h1)}</h1>
          <p style="${LEDE_STYLE}">${esc(seo.desc)}</p>
        </header>
        ${statGridHtml}
        ${ctaHtml}
        ${journeyHtml}
        <section id="${PROFESSION_JOURNEY_ANCHORS.offers}" class="s-ziawP1">
          <div class="s-r2QmTP">
            <h2 class="s-CqexyJ">${esc(jobsSectionLabelByLocale[locale])}</h2>
          </div>
          ${jobsHtml}
        </section>
        ${prose.html}
        ${journeyRequirementsHtml}
        ${journeyCompaniesHtml}
        ${faqHtml}
        ${sectorContextHtml}
        ${siblingRailHtml}
        ${crossCantonRailHtml}
      </main>${railGutters(true).close}
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

export function jobSectorPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'job-sector-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      const jobsPath = np.resolve(rootDir, 'data/jobs.json');

      // `dateStamp` is fixed once per build and baked into HTML.
      const dateStamp = new Date().toISOString().slice(0, 10);
      const year = new Date().getUTCFullYear();

      // Read jobs.json (gitignored in dev; present in CI).
      let jobs: SectorCountableJob[] = [];
      try {
        if (fs.existsSync(jobsPath)) {
          const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
          if (Array.isArray(raw)) jobs = raw as SectorCountableJob[];
        }
      } catch (err) {
        console.warn('[job-sector-pages] failed to read data/jobs.json', err);
      }

      // These pages are branded "Cerca lavoro in Ticino" — scope to TI jobs only.
      // Without this, sector counts/listings ingest every canton in Switzerland
      // (same bug class as #3232, fixed for employer hubs in jobsSeoPagesPlugin.ts).
      jobs = jobs.filter((job) => sharedResolveJobCanton(job) === 'TI');

      const counts = countSectorJobsByLocale(jobs);
      const sectorProseData = loadSectorProseData(rootDir);

      // Race-free SPA bundle hash extraction. See spaBundleResolver.ts.
      const { resolveSpaBundle } = await import('./spaBundleResolver');
      const spaBundle = resolveSpaBundle(distDir);
      const entryJs = spaBundle.entryJs;
      const entryCss = spaBundle.entryCss;
      const hasSpaBundle = spaBundle.hasSpaBundle;

      const sitemapEntries: string[] = [];

      const ensuredDirs = new Set<string>();
      const ensureDir = (dir: string): void => {
        if (ensuredDirs.has(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
      };

      for (const sector of SECTOR_HUB_KEYS) {
        for (const locale of LOCALES) {
          // Per-locale shard render-skip (BUILD_LOCALE matrix builds). The full
          // page render below (buildSectorLandingHtml + the two fs.writeFileSync
          // emits) is the bulk of this plugin's ~150s closeBundle cost, and on a
          // shard build 3 of every 4 locales it produces are deleted afterwards
          // by scripts/ci/prune-locale-shard.mjs. Skipping the non-owned locales
          // here removes that wasted render. SAFE for cross-locale SEO: the
          // sitemap-sector.xml entry (with its 4-locale xhtml:link alternates) is
          // built ONLY in the `locale === 'it'` branch below from buildSectorHubPath
          // path-builders — independent of whether en/de/fr iterations ran — and
          // the it/main shard never skips `it`, so its sitemap stays complete.
          // No-op (always true) on the default all-locale build.
          if (!shouldEmitLocale(locale)) continue;
          const count = counts[locale][sector];
          // Render the complete matching set. The previous 30-card slice made
          // pages such as Banca/finanza announce 60 offers while exposing only
          // half of them. The global page-weight audit remains the guardrail.
          const matchingJobs = filterSectorJobs(jobs, sector, locale, Number.MAX_SAFE_INTEGER);

          // The same complete set feeds both the cards and the secondary
          // metrics, so a page can no longer report one inventory and show
          // another.
          const allMatching = matchingJobs;
          const normKey = (v: unknown): string => String(v ?? '').trim().toLowerCase();
          const companyCount = new Set(allMatching.map((j) => normKey(j.company)).filter(Boolean)).size;
          const cityCount = new Set(allMatching.map((j) => normKey(j.location)).filter(Boolean)).size;
          const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
          const freshStamp = Date.parse(`${dateStamp}T00:00:00Z`);
          const freshCutoff = freshStamp - FRESH_WINDOW_MS;
          // A WINDOW, not a half-line: with only the lower bound a job dated in
          // the FUTURE (crawler clock skew, misparsed postedDate) counts as
          // "published in the last 7 days" on a public page, forever. Upper
          // bound is the END of the build day, so a listing posted later today
          // still counts.
          const freshMax = freshStamp + 24 * 60 * 60 * 1000;
          const freshCount = allMatching.filter((j) => {
            // Only source-verified publication dates contribute to the fresh tile.
            const t = firstParsableMs(resolveReportedPostingDate(j));
            return t >= freshCutoff && t <= freshMax;
          }).length;

          const canonicalPath = buildSectorHubPath(locale, sector);
          const canonicalUrl = `${BASE_URL}${canonicalPath}`;

          const html = buildSectorLandingHtml({
            sector,
            locale,
            matchingJobs,
            count,
            year,
            dateStamp,
            sectorProseData,
            entryJs,
            entryCss,
            companyCount,
            cityCount,
            freshCount,
            siblingCounts: counts[locale],
          });

          // Hard budget gate — prevents future regressions from quietly
          // breaking the site's page-weight gate. If the complete inventory
          // outgrows the budget, split the listing or compress the card
          // markup; never silently drop offers.
          const htmlBytes = Buffer.byteLength(html, 'utf-8');
          if (htmlBytes > SECTOR_PAGE_HARD_BUDGET_BYTES) {
            throw new Error(
              `[job-sector-pages] HTML for ${canonicalPath} is ${(htmlBytes / 1024).toFixed(1)} KB, ` +
                `exceeds hard budget of ${SECTOR_PAGE_HARD_BUDGET_BYTES / 1024} KB. ` +
                `Compress card markup or split the listing before changing the page-weight budget.`,
            );
          }

          // Write both /path/index.html and /path.html
          const outDir = np.join(distDir, canonicalPath.slice(1));
          ensureDir(outDir);
          const indexFile = np.join(outDir, 'index.html');
          fs.writeFileSync(indexFile, html, 'utf-8');
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            ensureDir(np.dirname(flatFile));
            fs.writeFileSync(flatFile, html, 'utf-8');
          }

          // Every locale gets its own reciprocal <loc> entry (all 4 carry the
          // same alternate set) — an IT-only push here would leave en/de/fr
          // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
          const altLinks = LOCALES.map((altLocale) => {
            const altPath = buildSectorHubPath(altLocale, sector);
            return `    <xhtml:link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}" />`;
          }).join('\n');
          // x-default always anchors to the IT canonical, regardless of which
          // locale this <url> block itself represents.
          const itUrl = `${BASE_URL}${buildSectorHubPath('it', sector)}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${canonicalUrl}</loc>\n${altLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${itUrl}" />\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`,
          );
        }
      }

      // Write sitemap-sector.xml.
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
        try {
          const sitemapPath = np.join(distDir, 'sitemap-sector.xml');
          fs.writeFileSync(sitemapPath, sitemapXml, 'utf-8');
        } catch (err) {
          console.warn('[job-sector-pages] failed to write sitemap-sector.xml', err);
        }
      }

      const totalPages = LOCALES.length * SECTOR_HUB_KEYS.length;
      console.log(
        `\x1b[36m[job-sector-pages]\x1b[0m Generated ${totalPages} sector hubs (${jobs.length} candidate jobs)`,
      );

      // Always-run: patch sitemap.xml index lastmod entry. Other plugins
      // regenerate sitemap.xml every build, so our entry's <lastmod> would
      // otherwise drop out. Runs whether the cache hit or miss, but only
      // when our sitemap actually exists (freshly written or restored).
      if (fs.existsSync(np.join(distDir, 'sitemap-sector.xml'))) {
        try {
          const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
          if (fs.existsSync(sitemapIndexPath)) {
            let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
            if (!idx.includes('sitemap-sector.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-sector.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-sector\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('[job-sector-pages] sitemap-index patch failed', err);
        }
      }

      // Signal downstream consumers (sectorHubLinksPlugin) that every sector-
      // hub landing is on disk, so the injector can safely add anchors to them
      // from the 4 job-board root hubs. Same fail-fast contract as
      // resolveJobsSeoPagesFlushed: closeBundle has no early return, so this is
      // reached on every normal exit. A thrown budget-error above propagates to
      // Vite and fails the build (consumer terminates — not a deadlock).
      resolveSectorPagesFlushed();
    },
  };
}

// Re-export for tests/consumers
export { SECTOR_HUB_SLUG, SECTOR_HUB_KEYS, buildSectorHubPath };
export type { SectorHubKey };
