#!/usr/bin/env node
/**
 * tl (Transports publics de la région lausannoise) job parser.
 *
 * Company: tl SA — urban public transport operator for the Lausanne
 * region (bus, trolleybus, m2 metro, LEB regional train). HQ: Chemin du
 * Closel 15-17, 1020 Renens (VD).
 *
 * ATS discovery: the source table listed "Custom" — WRONG. The corporate
 * domain is `t-l.ch` (NOT `tl.ch`, which does not resolve), and it sits
 * behind an F5 Distributed Cloud Bot Defense JS challenge (`TSPD` cookie,
 * `re.security.f5aas.com`) that rejects every plain curl request with a
 * ~6.6 KB anti-bot page regardless of path. But the career site is a
 * SEPARATE tenant at `carrieres.t-l.ch` — a SAP SuccessFactors Recruiting
 * Marketing (RMK) deployment (`rmkcdn.successfactors.com` asset host,
 * confirmed via an archive.org snapshot of the 2024 `/carrieres` page) —
 * NOT behind the same WAF. Its job board is the "Career Site Builder /
 * html-jobreq" flavor: server-rendered `/search/?startrow=N` listing HTML
 * + `/job/{slug}/{jobId}/` detail pages, confirmed reachable live and
 * carrying full schema.org itemprop microdata (title/description/
 * datePosted/validThrough/hiringOrganization/jobLocation/streetAddress) —
 * no `data-careersite-propertyid` attributes, so extraction relies on the
 * shared factory's itemprop fallback path.
 *
 * Reuses the shared SuccessFactors CSB factory
 * (./successfactors-shared-job-parser-common.mjs) for the actual fetch —
 * same engine ZURZACHCare/SIX Group/Tecan/Bachem/etc already use — but
 * defines its OWN isCompanyJob/isTrustedDomain here instead of re-exporting
 * the factory's. Reason: the factory derives a fuzzy brand token from
 * `companyDomain` (`t-l.ch` → brand `t-l` → hyphen-to-space `t l`) and
 * matches via `company.includes(brandSpaced)`. That 2-letter, hyphenated
 * abbreviation is exactly the kind of token this campaign has repeatedly
 * flagged as collision-prone: `scripts/lib/volksschule-luzern-job-parser.mjs`
 * ships `VOLKSSCHULE_LUZERN_COMPANY_NAME = 'Volksschule Stadt Luzern'`,
 * which normalized ("volksschule stadt luzern") CONTAINS the substring
 * "t l" (…"stad**t l**uzern"…) — the factory's fuzzy matcher would
 * misclassify a Volksschule Stadt Luzern job as belonging to tl. Our own
 * matchers below use ONLY an exact companyKey match, an exact normalized
 * company-name match, and explicit `t-l.ch` hostname checks — no fuzzy
 * substring matching on the short brand token — so this (and any other
 * "…tl…"-containing employer, e.g. Nestlé) can never be mis-claimed.
 *
 * Also post-processes the factory's hardcoded `sector: 'Sanità / Ospedali'`
 * default and its German-only fallback description boilerplate ("...ist
 * ein etablierter Schweizer Gesundheitsdienstleister...", only used when
 * the real job description text is too thin) — both wrong for a transit
 * operator in a French-speaking canton. Done client-side here rather than
 * editing the shared factory (used unmodified by 9 other tenants — see
 * GitNexus impact: MEDIUM risk, 9 direct callers — so this stays
 * behavior-identical for them).
 *
 * Exports the 4 functions the crawler template expects:
 *   - fetchAllTlLausanneJobs() — Fetch and parse all jobs
 *   - isTlLausanneJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { slugify, stripHtml } from './crawler-template.mjs';
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export { slugify, stripHtml };

/* ── Constants ─────────────────────────────────────────────── */

export const TL_LAUSANNE_KEY = 'tl-lausanne';
export const TL_LAUSANNE_COMPANY_NAME = 'tl (Transports publics de la région lausannoise)';
export const TL_LAUSANNE_COMPANY_DOMAIN = 't-l.ch';

const CAREER_URL = 'https://carrieres.t-l.ch';
const CAREER_HOST = 'carrieres.t-l.ch';
const CORPORATE_HOST = 't-l.ch';

// HQ fallback (Renens, VD) — company registry address. Per-job addresses on
// the CSB detail pages are coarse ("Lausanne, CH" — no street/postal code),
// so most jobs fall back to this.
const HQ = {
  city: 'Renens',
  canton: 'VD',
  postalCode: '1020',
  streetAddress: 'Chemin du Closel 15-17',
};

const SECTOR = 'Trasporto pubblico urbano (TPL)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers (deliberately NOT reusing the factory's fuzzy
 *    brand-token matcher — see module docblock) ─────────────────────── */

/**
 * Check if a job belongs to tl. Exact companyKey / exact normalized
 * company-name / explicit t-l.ch hostname only — no substring fuzzing on
 * the short "tl" brand, to avoid mis-claiming employers whose name merely
 * contains "tl" as a substring (e.g. "Volksschule Stadt Luzern", "Nestlé").
 */
export function isTlLausanneJob(job) {
  const key = normalize(job?.companyKey || '');
  if (key === TL_LAUSANNE_KEY) return true;

  const company = normalize(job?.company || '');
  if (company === normalize(TL_LAUSANNE_COMPANY_NAME)) return true;
  if (company === 'tl') return true; // exact short-brand match only, no .includes()

  return isTrustedDomain(job?.url || '');
}

/**
 * Validate that a URL belongs to tl's domain (corporate site or the
 * carrieres.t-l.ch RMK career tenant).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === CORPORATE_HOST || host.endsWith(`.${CORPORATE_HOST}`)) return true;
    if (host === CAREER_HOST) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Localized fallback (replaces the factory's German healthcare
 *    boilerplate for the rare case where the real description is too
 *    thin) ────────────────────────────────────────────────────────── */

// Exact marker string the shared factory uses for its fallback boilerplate
// (successfactors-shared-job-parser-common.mjs) — used to detect and
// replace it below without editing the shared file.
const FACTORY_FALLBACK_MARKER = 'ist ein etablierter Schweizer Gesundheitsdienstleister';

function localizedFallbackDescription(title = '', city = '') {
  const where = city || HQ.city;
  return `${title} chez ${TL_LAUSANNE_COMPANY_NAME} à ${where}.\n\n` +
    `${TL_LAUSANNE_COMPANY_NAME} est l'entreprise de transports publics de la région lausannoise ` +
    `(bus, trolleybus, métro m2 et trains régionaux LEB). Ce poste offre un environnement de travail ` +
    `moderne, des conditions d'engagement attractives et de réelles perspectives de formation.`;
}

/* ── SuccessFactors RMK / Career Site Builder factory ─────────────────
 * sfCompanyId is only used by the factory's OWN isCompanyJob (not reused
 * here) and in a log line — the real internal SF tenant code isn't public,
 * so the label 'tl' is a display-only placeholder.
 */
const parser = createSuccessFactorsParser({
  companyKey: TL_LAUSANNE_KEY,
  companyName: TL_LAUSANNE_COMPANY_NAME,
  companyDomain: TL_LAUSANNE_COMPANY_DOMAIN,
  sfCompanyId: 'tl',
  publicCareerUrl: CAREER_URL,
  defaultCanton: HQ.canton,
  defaultCity: HQ.city,
  defaultPostalCode: HQ.postalCode,
  defaultSourceLang: 'fr',
  sourceLabel: `${TL_LAUSANNE_COMPANY_NAME} Dedicated Parser (SuccessFactors CSB)`,
});

/**
 * Fetch all tl (Lausanne) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Wraps the shared factory's fetchAllJobs() to correct two hardcoded
 * defaults that are wrong for this (non-healthcare, French-speaking)
 * tenant — see module docblock.
 */
export async function fetchAllTlLausanneJobs() {
  const jobs = await parser.fetchAllJobs();

  for (const job of jobs) {
    job.sector = SECTOR;

    // safe default: street address never comes from the source (CSB emits
    // only "City, CH"), so every job needs the HQ street address per the
    // job-page structured-data contract (baseSalary/postalCode/
    // streetAddress/... must never be omitted).
    if (!job.streetAddress) job.streetAddress = HQ.streetAddress;

    if (typeof job.description === 'string' && job.description.includes(FACTORY_FALLBACK_MARKER)) {
      const desc = localizedFallbackDescription(job.title, job.location);
      job.description = desc;
      job.descriptionByLocale = { ...(job.descriptionByLocale || {}), [job.sourceLang || 'fr']: desc };
    }
  }

  return jobs;
}
