import { resolveRolloutSchemaPostingDate } from '../../scripts/lib/job-posting-date-rollout.mjs';
/**
 * Canonical `JobPosting` structured-data builder.
 *
 * Owner decision 2026-10-24: the schema is ALWAYS emitted for an active job,
 * and the JobPosting contract includes a safe value for every field required
 * by the site's rich-result completeness gate. Source values win; when a
 * crawler omits a non-critical field, the builder emits a deterministic,
 * locality-safe fallback rather than dropping the property.
 * Always present (guaranteed by `assertMandatoryFieldsComplete`):
 *
 *   1. title
 *   2. description (≥ 50 chars)
 *   3. datePosted (ISO 8601, provenance chain of resolveRolloutSchemaPostingDate)
 *   4. hiringOrganization.name
 *   5. jobLocation (Place + PostalAddress with addressLocality and addressCountry 'CH')
 *   6. jobLocation.address.streetAddress
 *   7. jobLocation.address.postalCode
 *   8. employmentType
 *   9. baseSalary
 *   10. validThrough
 *
 * Derived values are deliberately conservative: salary bands are marked as
 * estimates in the page data, addresses remain coherent with the resolved
 * locality/canton, and validThrough uses source-first date fallbacks.
 *
 * Shared by (as of this refactor):
 *   - `build-plugins/jobsSeoPagesPlugin.ts` (per-job active + soft-landing)
 *   - `build-plugins/weeklyEmployersPlugin.ts` (per-company × per-city hubs)
 *   - `services/seoService.ts` (runtime SPA JSON-LD injection)
 *
 * The builder also emits three further optional schema.org properties
 * when the source data supports them:
 *   - `industry` / `occupationalCategory` — derived from `job.sector`/
 *     `job.category` (already present on every job for the ONet mapping
 *     used elsewhere), so this is real signal, not invented data.
 *   - `applicantLocationRequirements` — only when `job.isRemote` is true
 *     (schema.org defines this property for TELECOMMUTE postings; stamping
 *     it on every job regardless of location type is a validator-visible
 *     but semantically wrong shortcut — see #jobLocationType below).
 *
 * `experienceRequirements` and `educationRequirements` are deliberately
 * NOT emitted: there is no reliable upstream source. A handful of ATS
 * parsers (`scripts/lib/fincons-job-parser.mjs`, `scripts/lib/board-job-
 * parser.mjs`) do scrape an `experienceRequirements` string, but it is
 * stashed in a per-crawler `metadata` bag that is never threaded into
 * `JobInput` and covers a tiny fraction of jobs/crawlers — wiring it in
 * would either fabricate the field for ~all other jobs or silently ship
 * inconsistent coverage. `educationRequirements` is mentioned only in a
 * doc comment (`scripts/lib/spitex-ch-job-parser.mjs`) describing what the
 * *source* JSON-LD contains — no parser actually extracts it. Revisit if a
 * crawler starts capturing either field consistently across companies.
 */

import {
  CANTON_CAPITAL_ADDRESSES,
  CITY_FALLBACK_ADDRESSES,
  COMPANY_HQ_ADDRESSES,
  deriveCantonFromCity,
  localityMatchesHq,
  regionLocalityCapital,
  resolveFallbackAddress,
} from './companyHqAddresses';
import {
  isKnownSwissCity,
  inferAnyCanton,
  normalizeCantonCode,
} from '../../scripts/lib/target-swiss-locations.mjs';
import {
  CANTON_CAPITAL_POSTAL,
  isPostalCodeCoherentWithCity,
  isValidPostalCode,
  normalizePostalCityKey,
  resolveLocalityPostalCode,
} from './postalCodes';
import { sameOrg } from '../../scripts/lib/prospector/registrable.mjs';
import { CANTON_LOCATION_FALLBACK } from '../../scripts/lib/canton-postal-fallback.mjs';
import { resolveSalaryBand, type SalaryBand } from './salaryDefaults';
import {
  employmentTypeJsonLdValue,
  resolveJobEmploymentTypes,
} from '../../scripts/lib/job-employment-type.mjs';
import { isSalaryReportedBySource, isSourceStreetAddress } from '../../scripts/lib/jobposting-field-provenance.mjs';
import { truncateCodeUnits } from './safeTruncate';
import { sanitizeBrowserJobTitle } from './literalMarkdown';
import {
  buildEmployerProfilePath,
  canonicalCompanyProfileSlug,
} from './companyProfileSlug.mjs';
export { MANDATORY_JOBPOSTING_FIELDS } from '../../scripts/lib/jobposting-mandatory-fields.mjs';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Permissive input shape. All fields optional — the builder fills
 * defaults when missing. Additional source-specific fields may be
 * attached; the builder ignores unknown keys.
 */
export interface JobInput {
  readonly id?: string | null;
  readonly slug?: string | null;

  readonly title?: string | null;
  readonly titleByLocale?: Partial<Record<string, string>> | null;

  readonly description?: string | null;
  readonly descriptionByLocale?: Partial<Record<string, string>> | null;

  readonly company?: string | null;
  readonly companyKey?: string | null;
  readonly companySlug?: string | null;
  /** Website used for hiringOrganization.sameAs; kept separate from the raw ownership domain. */
  readonly companyWebsite?: string | null;
  readonly companyDomain?: string | null;
  readonly companyLogoUrl?: string | null;

  readonly city?: string | null;
  readonly location?: string | null;
  readonly addressLocality?: string | null;
  readonly addressRegion?: string | null;
  readonly canton?: string | null;
  readonly addressCountry?: string | null;
  readonly postalCode?: string | null;
  readonly streetAddress?: string | null;
  readonly address?: string | null;

  readonly postingDateSource?: string | null;
  readonly postedDate?: string | null;
  readonly datePosted?: string | null;
  /** First crawler observation, used only when no source publication date exists. */
  readonly firstSeenAt?: string | null;
  readonly crawledAt?: string | null;
  readonly scrapedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly validThrough?: string | null;
  readonly expiredAt?: string | null;

  readonly contract?: string | null;
  readonly contractType?: string | null;
  readonly employmentType?: string | null;

  readonly salary?: SalaryBand | null;
  readonly salaryMin?: number | null;
  readonly salaryMax?: number | null;
  readonly salaryCurrency?: string | null;
  readonly salaryPeriod?: string | null;
  /**
   * Salary provenance as persisted by the crawler pipeline. Reported values
   * reach `baseSalary` unchanged; estimates use the resolved fallback band.
   */
  readonly salarySource?: string | null;

  readonly sector?: string | null;
  readonly category?: string | null;

  readonly url?: string | null;
  readonly applyUrl?: string | null;

  readonly isRemote?: boolean | null;
}

/** Options for the canonical builder. */
export interface BuildJobPostingOptions {
  /** BCP-47 locale tag used for `inLanguage` and localised defaults. */
  readonly locale: string;
  /** Absolute canonical URL for the job page (`url` on the schema). */
  readonly url: string;
  /**
   * Optional site base URL — used to absolutize a same-origin (root-relative)
   * `hiringOrganization.logo` path. Never affects mandatory-field output.
   */
  readonly baseUrl?: string;
  /**
   * Canonical employer-profile slugs emitted by this build. A slug outside
   * this set must never be turned into a guessed `/aziende/<slug>/` URL.
   */
  readonly knownSlugs?: ReadonlySet<string>;
  /**
   * Optional build clock for deterministic SSG output. Callers that omit it
   * retain the historical wall-clock fallback (notably the runtime SPA).
   */
  readonly now?: Date;
}

/**
 * schema.org `PostalAddress` emitted by the builder. Street and CAP are
 * required by the site's completeness contract and are always resolved to a
 * coherent source, HQ, locality, or canton-capital fallback.
 */
export interface PostalAddressSchema {
  readonly '@type': 'PostalAddress';
  readonly streetAddress: string;
  readonly postalCode: string;
  readonly addressLocality: string;
  readonly addressRegion: string;
  readonly addressCountry: 'CH';
}

/** Strict schema.org `Place` shape emitted by the builder. */
export interface PlaceSchema {
  readonly '@type': 'Place';
  readonly address: PostalAddressSchema;
}

/**
 * schema.org `MonetaryAmount` emitted by the builder. `maxValue` is present
 * only when the source states an upper bound: a single reported figure is a
 * single figure, not a range the builder widens by 20 %.
 */
export interface BaseSalarySchema {
  readonly '@type': 'MonetaryAmount';
  readonly currency: string;
  readonly value: {
    readonly '@type': 'QuantitativeValue';
    readonly minValue: number;
    readonly maxValue?: number;
    readonly unitText: 'YEAR';
  };
}

/** Strict schema.org `Organization` shape emitted by the builder. */
export interface HiringOrganizationSchema {
  readonly '@type': 'Organization';
  /** Stable first-party identity shared by every locale and employer surface. */
  readonly '@id'?: string;
  readonly name: string;
  /** Canonical employer profile URL when the build knows that route exists. */
  readonly url?: string;
  readonly sameAs?: string;
  readonly logo?: string;
}

/**
 * Output shape. The site's mandatory structured-data contract is **required**
 * here so the compiler flags a regression. Other schema.org properties remain
 * optional and are emitted only when their source signal exists.
 */
export interface JobPostingSchema {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'JobPosting';
  readonly title: string;
  readonly description: string;
  readonly datePosted: string;
  readonly employmentType: EmploymentType | readonly EmploymentType[];
  readonly hiringOrganization: HiringOrganizationSchema;
  readonly jobLocation: PlaceSchema;
  readonly baseSalary: BaseSalarySchema;
  readonly url: string;
  readonly validThrough: string;
  readonly directApply?: boolean;
  readonly identifier?: {
    readonly '@type': 'PropertyValue';
    readonly name: string;
    readonly value: string;
  };
  readonly jobLocationType?: 'TELECOMMUTE';
  /** schema.org `industry` — Text, derived from `job.sector`/`job.category`. */
  readonly industry?: string;
  /** schema.org `occupationalCategory` — O*NET-SOC code, when the category maps. */
  readonly occupationalCategory?: string;
  /**
   * schema.org `applicantLocationRequirements` — only present alongside
   * `jobLocationType: 'TELECOMMUTE'` (i.e. `job.isRemote`); MUST be absent
   * for on-site postings.
   */
  readonly applicantLocationRequirements?: {
    readonly '@type': 'Country';
    readonly name: string;
  };
}

/**
 * Return true only when the apply destination belongs to the employer domain.
 * A merely present `url`/`applyUrl` is not proof of a direct employer flow:
 * crawled records commonly point at an aggregator or a hosted ATS. Missing
 * employer-domain evidence therefore stays conservatively false.
 */
export function isEmployerOwnedApplyUrl(
  job: Pick<JobInput, 'applyUrl' | 'companyDomain'>,
): boolean {
  const applyUrl = String(job?.applyUrl || '').trim();
  const companyDomain = String(job?.companyDomain || '').trim();
  if (!applyUrl || !companyDomain) return false;
  return sameOrg(applyUrl, companyDomain);
}

/** Schema.org `JobPosting.employmentType` closed set. */
export type EmploymentType =
  | 'FULL_TIME'
  | 'PART_TIME'
  | 'CONTRACTOR'
  | 'TEMPORARY'
  | 'INTERN'
  | 'VOLUNTEER'
  | 'PER_DIEM'
  | 'OTHER';

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Canonical prod origin — fallback base for absolutizing a same-origin
 * (root-relative) `hiringOrganization.logo` path when the caller omits
 * `opts.baseUrl` (publisherAdPagesPlugin relies on this fallback; all
 * other callers pass it explicitly).
 */
const CANONICAL_ORIGIN = 'https://frontaliereticino.ch';

/**
 * Contract types the listing states, as schema.org tokens (see
 * scripts/lib/job-employment-type.mjs). Empty when the source says nothing
 * recognisable: visible facts preserve that absence, while the canonical
 * JobPosting emitter adds its deterministic FULL_TIME fallback at the final
 * serialization boundary.
 */
export function resolveEmploymentTypes(
  job: Pick<JobInput, 'employmentType' | 'contract' | 'contractType'>,
  title?: string | null,
): EmploymentType[] {
  return resolveJobEmploymentTypes(job, title) as EmploymentType[];
}

/**
 * `job.category`/`job.sector` → O*NET-SOC major-group code, for the
 * schema.org `occupationalCategory` property. Relocated here (from the
 * single previous call site in `jobsSeoPagesPlugin.ts`) so every caller of
 * `buildJobPostingSchema` — including the SPA path in `services/seoService.ts`
 * — emits the same field instead of drifting per-caller copies (AGENTS.md
 * anti-duplication rule).
 */
const CATEGORY_TO_ONET: Record<string, string> = {
  tech: '15-0000', technology: '15-0000', it: '15-0000', development: '15-0000',
  devops: '15-0000', analysis: '15-2000', 'IT / Software Development': '15-0000',
  'Corporate and Staff Functions/Information Technology': '15-0000',
  engineering: '17-0000', 'Ingegneria & Tecnica': '17-0000', impiantistica: '17-0000',
  meccanica: '17-0000', metallo: '17-0000', drafting: '17-3000', technician: '17-3000',
  architecture: '17-1000', 'Robotica & Automazione': '17-0000',
  health: '29-0000', healthcare: '29-0000', 'Life Science & Tecnologia Medica': '29-0000',
  'Chimica & Analisi': '19-0000', science: '19-0000', researcher: '19-0000',
  phd: '19-0000', sustainability: '19-0000',
  finance: '13-0000', finanza: '13-0000', assicurazioni: '13-0000', insurance: '13-0000',
  'Corporate and Staff Functions/Finance & Control': '13-0000', accounting: '13-2000',
  management: '11-0000', consulting: '11-0000', 'Consulenza gestionale': '11-0000',
  operations: '11-0000',
  admin: '43-0000', Administration: '43-0000', 'Servizi Aziendali': '43-0000',
  staff: '43-0000', general: '43-0000', 'public-administration': '43-0000',
  sales: '41-0000', vendita: '41-0000', 'Vendita & Commercio': '41-0000',
  'Commercio al dettaglio': '41-0000',
  logistics: '53-0000', 'Logistica & Trasporti': '53-0000', 'Logistica & Magazzino': '53-0000',
  Logistik: '53-0000', aviation: '53-0000',
  marketing: '27-3000', design: '27-1000', translation: '27-3000',
  hr: '13-1000', 'risorse-umane': '13-1000',
  legal: '23-0000',
  education: '25-0000', professor: '25-0000',
  'social-services': '21-0000', 'real-estate': '13-0000',
  'Turismo & Ospitalità': '35-0000', hospitality: '35-0000', gastronomy: '35-0000',
  cucina: '35-0000', servizio: '35-0000',
  'Agricoltura & Commercio': '45-0000',
  edilizia: '47-0000', cantiere: '47-0000',
  production: '51-0000', manufacturing: '51-0000',
  security: '33-0000', safety: '33-0000',
};

/** Resolve `job.sector`/`job.category` to an O*NET-SOC code, if known. */
function resolveOccupationalCategory(job: JobInput): string | undefined {
  const cat = String(job.sector || job.category || '').trim();
  return cat ? CATEGORY_TO_ONET[cat] : undefined;
}

/**
 * Resolve schema.org `industry` (Text) from the same category/sector
 * signal used for `occupationalCategory` — no separate source needed.
 */
function resolveIndustry(job: JobInput): string | undefined {
  const raw = String(job.sector || job.category || '').trim();
  return raw.length > 0 ? raw : undefined;
}

/**
 * Resolve `applicantLocationRequirements` — schema.org restricts this
 * property to TELECOMMUTE postings; it must be omitted for on-site jobs
 * (#applicantLocationRequirements hardcode fix). Country is always 'CH'
 * because this board only lists Swiss-based (frontalieri) remote roles.
 */
function resolveApplicantLocationRequirements(
  job: JobInput,
): { readonly '@type': 'Country'; readonly name: string } | undefined {
  return job.isRemote ? { '@type': 'Country', name: 'CH' } : undefined;
}

/** Normalise any date-ish input to an ISO 8601 string; `null` on failure. */
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Keep a derived active deadline in the future so Google does not treat a
 * still-published listing as already expired. Explicit source deadlines stay
 * authoritative, including past values on expired-job pages. */
function floorToFuture(computed: Date, now?: Date): string {
  const floor = new Date(now || new Date());
  floor.setUTCDate(floor.getUTCDate() + 30);
  return (computed.getTime() < floor.getTime() ? floor : computed).toISOString();
}

/** Resolve a deadline for every emitted JobPosting, with source-first fallbacks. */
function computeValidThrough(
  explicit: string | null | undefined,
  crawledAt: string | null | undefined,
  datePosted: string,
  now?: Date,
): string {
  const explicitIso = toIsoDate(explicit);
  if (explicitIso) return explicitIso;

  const crawledIso = toIsoDate(crawledAt);
  if (crawledIso) {
    const out = new Date(crawledIso);
    out.setUTCDate(out.getUTCDate() + 60);
    return floorToFuture(out, now);
  }

  const posted = new Date(datePosted);
  if (!Number.isNaN(posted.getTime())) {
    const out = new Date(posted);
    out.setUTCDate(out.getUTCDate() + 90);
    return floorToFuture(out, now);
  }

  const fallback = new Date(now || new Date());
  fallback.setUTCDate(fallback.getUTCDate() + 60);
  return fallback.toISOString();
}

/** Public so the active-page HTML reuse path shares the exact builder logic. */
export function resolveJobPostingValidThrough(
  job: JobInput,
  datePosted: string,
  now?: Date,
): string {
  return computeValidThrough(
    job.validThrough,
    job.crawledAt || job.scrapedAt || job.updatedAt || null,
    datePosted,
    now,
  );
}

/** Build a locale-aware fallback description ≥ 50 chars. */
function buildDescriptionFallback(
  title: string,
  company: string,
  city: string,
  locale: string,
): string {
  const short = (locale || 'it').slice(0, 2).toLowerCase();
  switch (short) {
    case 'en':
      return `${title} at ${company} in ${city}. Apply directly through Frontaliere Ticino — full details, requirements and information are available on the job posting page.`;
    case 'de':
      return `${title} bei ${company} in ${city}. Direkte Bewerbung über Frontaliere Ticino mit allen Details, Anforderungen und Informationen auf der Stellenanzeige.`;
    case 'fr':
      return `${title} chez ${company} à ${city}. Candidature directe via Frontaliere Ticino, avec tous les détails, exigences et informations sur la page de l'offre.`;
    case 'it':
    default:
      return `${title} presso ${company} a ${city}. Candidatura diretta tramite Frontaliere Ticino, con dettagli, requisiti e informazioni complete sulla pagina dell'offerta di lavoro.`;
  }
}

/** Pick the locale-specific title (and generate a fallback if missing). */
function resolveTitle(job: JobInput, locale: string): string {
  const short = (locale || 'it').slice(0, 2).toLowerCase();
  const byLocale = job.titleByLocale?.[short] || job.titleByLocale?.[locale];
  // Runtime callers must stay browser-parseable on the supported WebKit floor.
  // Narrative AI-title recovery remains a build-time concern in
  // stripLiteralMarkdown.ts; the corpus already publishes normalized titles.
  const base = sanitizeBrowserJobTitle(String(byLocale || job.title || '').trim());
  if (base.length > 0) return base;
  const company = (job.company || '').trim();
  switch (short) {
    case 'en':
      return `Open position${company ? ` — ${company}` : ''}`;
    case 'de':
      return `Offene Stelle${company ? ` — ${company}` : ''}`;
    case 'fr':
      return `Poste ouvert${company ? ` — ${company}` : ''}`;
    case 'it':
    default:
      return `Posizione non specificata${company ? ` — ${company}` : ''}`;
  }
}

/** Pick the locale-specific description with a ≥ 50-char guarantee. */
function resolveDescription(
  job: JobInput,
  title: string,
  company: string,
  city: string,
  locale: string,
): string {
  const short = (locale || 'it').slice(0, 2).toLowerCase();
  const byLocale = job.descriptionByLocale?.[short] || job.descriptionByLocale?.[locale];
  const base = String(byLocale || job.description || '').trim();
  // Surrogate-safe cap: a raw 5000-char slice can split an emoji pair (jobs are
  // crawled from ATS bodies that contain emoji) and leave a lone surrogate that
  // breaks JSON-LD parsing. truncateCodeUnits drops the dangling half whole.
  if (base.length >= 50) return truncateCodeUnits(base, 5000);
  return truncateCodeUnits(buildDescriptionFallback(title, company, city, locale), 5000);
}

/** Resolve the hiring organisation name with a localised fallback. */
function resolveCompanyName(job: JobInput, locale: string): string {
  const explicit = String(job.company || '').trim();
  if (explicit) return explicit;
  const short = (locale || 'it').slice(0, 2).toLowerCase();
  switch (short) {
    case 'en':
      return 'Confidential employer';
    case 'de':
      return 'Vertrauliches Unternehmen';
    case 'fr':
      return 'Employeur confidentiel';
    case 'it':
    default:
      return 'Azienda riservata';
  }
}

export interface BuildCompanyOrganizationOptions {
  /** Locale is used only for the localized confidential-employer fallback. */
  readonly locale: string;
  /** First-party origin used to build the canonical employer profile URL. */
  readonly baseUrl?: string;
  /** Real page URL used when the source does not carry a company identity. */
  readonly fallbackUrl?: string;
  /** Canonical employer-profile slugs emitted by this build. */
  readonly knownSlugs?: ReadonlySet<string>;
}

/**
 * Build one stable Organization identity for every job/company emitter.
 *
 * Employer pages exist under `/aziende/<canonical-slug>/` for full profiles
 * and below-floor bridges. The profile URL is used only when its slug is in
 * the build's emitted-profile registry; source records often contain an
 * employer that has no profile page, and inventing that URL creates a broken
 * entity identity. Such callers can provide their real canonical page as
 * `fallbackUrl`. The source website remains `sameAs` so the schema keeps its
 * external provenance without making a locale-specific page URL the identity
 * of the company.
 */
export function buildCompanyOrganization(
  job: JobInput,
  opts: BuildCompanyOrganizationOptions,
): HiringOrganizationSchema {
  if (!opts?.locale) throw new Error('buildCompanyOrganization: opts.locale is required');

  const baseUrl = String(opts.baseUrl || CANONICAL_ORIGIN).replace(/\/+$/, '');
  const companyName = resolveCompanyName(job, opts.locale);
  const rawCompany = String(job.company || job.companySlug || job.companyKey || '').trim();
  const companySlug = rawCompany
    ? canonicalCompanyProfileSlug(String(job.company || job.companySlug || rawCompany), String(job.companyKey || ''))
    : '';
  const profileUrl = companySlug && opts.knownSlugs?.has(companySlug)
    ? `${baseUrl}${buildEmployerProfilePath('it', companySlug)}`
    : '';
  const fallbackUrl = String(opts.fallbackUrl || '').trim();
  const identityUrl = profileUrl || (fallbackUrl ? (fallbackUrl.endsWith('/') ? fallbackUrl : `${fallbackUrl}/`) : '');

  const rawWebsite = String(job.companyWebsite || job.companyDomain || '').trim();
  const sameAs = rawWebsite
    ? (/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`)
    : undefined;
  const rawLogo = job.companyLogoUrl && String(job.companyLogoUrl).trim().length > 0
    ? String(job.companyLogoUrl).trim()
    : undefined;
  const logo = rawLogo && rawLogo.startsWith('/') && !rawLogo.startsWith('//')
    ? `${baseUrl}${rawLogo}`
    : rawLogo;

  return {
    '@type': 'Organization',
    name: companyName,
    ...(identityUrl ? { '@id': `${identityUrl}#organization`, url: identityUrl } : {}),
    ...(sameAs ? { sameAs } : {}),
    ...(logo ? { logo } : {}),
  };
}

/** Derive the schema.org canton code for the job. */
function resolveCanton(job: JobInput): string {
  const explicit = normalizeCantonCode(String(job.addressRegion || job.canton || ''));
  if (explicit) return explicit;
  const locationText = String(job.addressLocality || job.city || job.location || '');
  return inferAnyCanton(locationText) || deriveCantonFromCity(locationText);
}

/**
 * Reject a locality candidate that is not a real, known Swiss city (BFS
 * registry, all 26 cantons) or that names a city belonging to a DIFFERENT
 * canton than `region` — otherwise a JobPosting/visible page pairs an
 * incoherent locality with its region (e.g. "Bellinzona" text next to
 * addressRegion "BE"). A region name shipped as locality ("Ticino") is
 * substituted with the canton capital's coherent locality first. Garbage or
 * leaked free-text fails `isKnownSwissCity`; a real-but-wrong-canton city
 * fails the canton-agreement check. Returns '' when the raw value must NOT
 * be trusted — callers supply their own fallback (company HQ, city lookup,
 * canton-capital).
 *
 * `region` doubles as the canton hint for `isKnownSwissCity`: 161 BFS
 * municipalities exist only in the "<City> (XX)" disambiguated form (e.g.
 * "Küsnacht (ZH)"), so their bare name fails the unscoped check — but with
 * `region` already known here, the retry is unambiguous. See #6147.
 */
export function sanitizeLocalityForRegion(rawLocality: string, region: string): string {
  let cityRaw = String(rawLocality || '').trim();
  const regionCapital = regionLocalityCapital(cityRaw);
  if (regionCapital) cityRaw = regionCapital.addressLocality;
  if (!cityRaw || !isKnownSwissCity(cityRaw, region)) return '';
  const cityCanton = inferAnyCanton(cityRaw);
  if (cityCanton && cityCanton.toUpperCase() !== String(region || '').toUpperCase()) return '';
  return cityRaw;
}

/** Resolve the PostalAddress with every field guaranteed non-empty. */
function resolveAddress(
  job: JobInput,
  _companyName: string,
  locale: string,
): PostalAddressSchema {
  const companySlug = job.companySlug || job.companyKey || '';
  const rawCity = String(
    job.addressLocality || job.city || job.location || '',
  ).trim();

  // resolveCanton() always resolves (deriveCantonFromCity defaults to
  // DEFAULT_CANTON_REGION when nothing else matches), so it is the sole
  // source of `region` here.
  const region = resolveCanton(job);
  const cityRaw = sanitizeLocalityForRegion(rawCity, region);

  const hqEntry = companySlug
    ? COMPANY_HQ_ADDRESSES[companySlug.toLowerCase()]
    : undefined;

  const fallback = resolveFallbackAddress(
    companySlug ? companySlug.toLowerCase() : undefined,
    cityRaw ? cityRaw.toLowerCase() : undefined,
    region,
  );

  const addressLocality =
    cityRaw.length > 0 ? cityRaw : fallback.addressLocality;

  // A curated company HQ address is only trustworthy for jobs with no own
  // city or in the HQ's own CITY (#3513). Canton-level matching is not
  // enough: a Lugano posting for a Bellinzona-seat employer (same canton)
  // must not pair the HQ street/CAP with the Lugano locality. Fall through to
  // the city lookup instead, which anchors on the job's own city.
  const hqUsable =
    !!hqEntry &&
    String(hqEntry.addressRegion || '').toUpperCase() === String(region || '').toUpperCase() &&
    localityMatchesHq(cityRaw, hqEntry);

  // The fallback tuple is the complete address of ONE locality: the curated HQ
  // (same city only), the city table, or, as a last resort, the canton
  // capital. Its street and CAP may complete this address only when they
  // describe the same locality. The capital's street/CAP next to another real
  // locality is the incoherent tuple of issue 9852 (Pully + Place de la
  // Palud 2 + 1003, which are Lausanne's).
  const fallbackDescribesLocality = cityRaw.length === 0
    || fallback === hqEntry
    || fallback === CITY_FALLBACK_ADDRESSES[cityRaw.toLowerCase()]
    || normalizePostalCityKey(fallback.addressLocality) === normalizePostalCityKey(cityRaw);

  // A source CAP can be formally valid and still belong to another known
  // locality (for example 6500 on a Lugano posting). Treat that pair as
  // unusable by construction so every JobPosting consumer shares the same guard.
  const sourcePostalCode = isValidPostalCode(job.postalCode)
    ? String(job.postalCode).trim()
    : '';
  const localityPostalCode = resolveLocalityPostalCode(addressLocality, region);
  // Crawler fallbacks stamp a canton-level default CAP on jobs of other
  // localities: the capital's (Arisdorf BL with Liestal's 4410, Grand-Lancy
  // with Genève's 1204) or the representative one of canton-postal-fallback
  // (Brütten ZH with Zürich's 8000). isPostalCodeCoherentWithCity() does not
  // know those CAPs, so the pair would pass as coherent: reject it unless the
  // locality is the place that default stands for, or the CAP is its own.
  const sourcePostalIsCantonFallback = sourcePostalCode.length > 0
    && sourcePostalCode !== localityPostalCode
    && cantonFallbackPostalTuples(region).some(({ postalCode, locality }) => (
      postalCode === sourcePostalCode
      && normalizePostalCityKey(locality) !== normalizePostalCityKey(addressLocality)
    ));
  const sourcePostalIsCoherent = sourcePostalCode.length === 0
    || (isPostalCodeCoherentWithCity(addressLocality, sourcePostalCode) && !sourcePostalIsCantonFallback);
  const sourcePostal = sourcePostalIsCoherent ? sourcePostalCode : '';

  // The listing's own street, when it reads as a street of this locality. An
  // incoherent source CAP drops the street travelling with it: that tuple is
  // usually an HQ address stamped on a vacancy in another city (#9108).
  const streetAddressRaw = String(job.streetAddress || job.address || '').trim();
  const sourceStreet = sourcePostalIsCoherent && isSourceStreetAddress(streetAddressRaw, addressLocality)
    ? streetAddressRaw
    : '';

  // The HQ tuple completes the address only as a whole, and only when the
  // listing does not name another CAP of the same city (6912 on a Lugano HQ
  // listed at 6900 is another site, not the HQ).
  const hqPostal = hqUsable && isValidPostalCode(hqEntry.postalCode) ? String(hqEntry.postalCode).trim() : '';
  const useHq = !sourceStreet
    && hqUsable
    && String(hqEntry.streetAddress || '').trim().length > 0
    && (sourcePostal.length === 0 || sourcePostal === hqPostal);

  const postalCode = sourcePostalIsCoherent && sourcePostalCode.length > 0
    ? sourcePostalCode
    : (hqUsable && hqEntry.postalCode && isValidPostalCode(hqEntry.postalCode) ? hqEntry.postalCode : '') ||
      localityPostalCode ||
      // Safe default: when the source locality has no postal entry, borrow the
      // fallback tuple's CAP while keeping the page's own locality. The street
      // below remains the locality's own fallback, never a mismatched capital.
      fallback.postalCode;

  const streetAddress = sourceStreet
    || (useHq ? String(hqEntry.streetAddress).trim() : '')
    || (fallbackDescribesLocality ? fallback.streetAddress : '')
    || localisedCentro(addressLocality, locale);

  if (!streetAddress || !postalCode || !addressLocality || !region) {
    throw new Error(
      `buildJobPostingSchema: could not resolve complete address for job ` +
      `"${job.id || job.slug || job.title || _companyName}"`,
    );
  }

  return {
    '@type': 'PostalAddress',
    streetAddress,
    postalCode,
    addressLocality,
    addressRegion: region,
    addressCountry: 'CH',
  };
}

/**
 * Canton-level default CAPs with the locality each one belongs to: the
 * capital tuple, the capital CAP table and the crawler-side representative
 * location. A job carrying one of them next to another locality carries a
 * stamped default, not its own CAP.
 */
function cantonFallbackPostalTuples(region: string): Array<{ postalCode: string; locality: string }> {
  const capital = CANTON_CAPITAL_ADDRESSES[region];
  const crawlerFallback = (CANTON_LOCATION_FALLBACK as Record<string, { city: string; postalCode: string }>)[region];
  return [
    ...(capital ? [
      { postalCode: capital.postalCode, locality: capital.addressLocality },
      { postalCode: CANTON_CAPITAL_POSTAL[region] || '', locality: capital.addressLocality },
    ] : []),
    ...(crawlerFallback ? [{ postalCode: crawlerFallback.postalCode, locality: crawlerFallback.city }] : []),
  ].filter(({ postalCode }) => postalCode.length > 0);
}

/** Localised "<city> centro" fallback for streetAddress. */
function localisedCentro(city: string, locale: string): string {
  const short = (locale || 'it').slice(0, 2).toLowerCase();
  switch (short) {
    case 'en':
      return `${city} city centre`;
    case 'de':
      return `${city} Stadtzentrum`;
    case 'fr':
      return `${city} centre-ville`;
    case 'it':
    default:
      return `${city} centro`;
  }
}

/**
 * Salary as the visible page states it: the listing's own figures, or the
 * pipeline's sector estimate flagged `isEstimate`. A job without any salary
 * value gets the sector band of salaryDefaults, also flagged: the page may
 * show an estimate, labelled as one; the same positive band is used for the
 * mandatory `baseSalary` fallback.
 */
export interface JobSalaryFact {
  readonly currency: string;
  readonly minValue: number;
  /** Present only when the source states an upper bound above minValue. */
  readonly maxValue?: number;
  readonly isEstimate: boolean;
}

export function resolveSalaryFact(job: JobInput): JobSalaryFact {
  const reported = isSalaryReportedBySource(job);
  if (job.salary && Number.isFinite(job.salary.minValue) && job.salary.minValue > 0) {
    const min = job.salary.minValue;
    return {
      currency: String(job.salary.currency || 'CHF').toUpperCase(),
      minValue: min,
      ...(Number.isFinite(job.salary.maxValue) && job.salary.maxValue > min ? { maxValue: job.salary.maxValue } : {}),
      isEstimate: !reported,
    };
  }
  if (Number.isFinite(job.salaryMin) && Number(job.salaryMin) > 0) {
    const min = Number(job.salaryMin);
    const max = Number(job.salaryMax);
    return {
      currency: String(job.salaryCurrency || 'CHF').toUpperCase(),
      minValue: min,
      ...(Number.isFinite(max) && max > min ? { maxValue: max } : {}),
      isEstimate: !reported,
    };
  }
  const band = resolveSalaryBand(job.sector || job.category || '', resolveCanton(job));
  return { currency: band.currency, minValue: band.minValue, maxValue: band.maxValue, isEstimate: true };
}

/** Resolve a positive salary band, preserving estimates as schema data. */
function resolveBaseSalary(job: JobInput): BaseSalarySchema {
  const fact = resolveSalaryFact(job);
  return {
    '@type': 'MonetaryAmount',
    currency: fact.currency || 'CHF',
    value: {
      '@type': 'QuantitativeValue',
      minValue: fact.minValue,
      ...(fact.maxValue !== undefined ? { maxValue: fact.maxValue } : {}),
      unitText: 'YEAR',
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The JobPosting `PostalAddress` alone, with the same locality sanitizer and
 * coherence rules as `buildJobPostingSchema`. For emitters that assemble their
 * own JobPosting (the SPA JobBoard) and must not pair a locality with another
 * place's street or CAP (issue 9852).
 */
export function resolveJobPostingAddress(job: JobInput, locale: string): PostalAddressSchema {
  return resolveAddress(job, resolveCompanyName(job, locale), locale);
}

/**
 * Facts used by visible FAQ content. Unlike the schema they may carry an
 * estimated salary (flagged) and an empty contract list: the FAQ then says
 * so in words instead of presenting a guess as the employer's statement.
 */
export interface JobPostingFacts {
  readonly salary: JobSalaryFact;
  readonly employmentTypes: readonly EmploymentType[];
  readonly hiringOrganization: HiringOrganizationSchema;
  readonly jobLocation: PlaceSchema;
}

export interface BuildJobPostingFactsOptions {
  readonly baseUrl?: string;
  readonly fallbackUrl?: string;
  readonly knownSlugs?: ReadonlySet<string>;
}

export function buildJobPostingFacts(
  job: JobInput,
  locale: string,
  opts: BuildJobPostingFactsOptions = {},
): JobPostingFacts {
  const companyName = resolveCompanyName(job, locale);
  const title = resolveTitle(job, locale);
  return {
    salary: resolveSalaryFact(job),
    employmentTypes: resolveEmploymentTypes(job, title),
    hiringOrganization: buildCompanyOrganization(job, {
      locale,
      baseUrl: opts.baseUrl || CANONICAL_ORIGIN,
      fallbackUrl: opts.fallbackUrl,
      knownSlugs: opts.knownSlugs,
    }),
    jobLocation: { '@type': 'Place', address: resolveAddress(job, companyName, locale) },
  };
}

/**
 * Build a JobPosting for an active job. Never returns null (owner decision
 * 2026-10-24: an active job ALWAYS emits JobPosting). `datePosted` follows the
 * provenance chain of resolveSchemaPostingDate(): reported source date ->
 * first-seen -> earliest crawler observation -> build date. The return type is
 * non-nullable so a future "withhold the schema" branch fails type-checking at
 * every caller instead of silently dropping Google for Jobs eligibility (the
 * 2026-10-04 regression of PR 11394).
 */
export function buildJobPostingSchema(
  job: JobInput,
  opts: BuildJobPostingOptions,
): JobPostingSchema {
  if (!opts || !opts.locale || !opts.url) {
    throw new Error('buildJobPostingSchema: opts.locale and opts.url are required');
  }

  const { value: datePosted } = resolveRolloutSchemaPostingDate(job, opts.now);

  const companyName = resolveCompanyName(job, opts.locale);
  const title = resolveTitle(job, opts.locale);
  const address = resolveAddress(job, companyName, opts.locale);
  const description = resolveDescription(
    job,
    title,
    companyName,
    address.addressLocality,
    opts.locale,
  );
  const validThrough = resolveJobPostingValidThrough(job, datePosted, opts.now);
  const resolvedEmploymentTypes = resolveEmploymentTypes(job, title);
  const employmentType = employmentTypeJsonLdValue(
    resolvedEmploymentTypes.length > 0 ? resolvedEmploymentTypes : ['FULL_TIME'],
  ) as JobPostingSchema['employmentType'];
  const baseSalary = resolveBaseSalary(job);
  const industry = resolveIndustry(job);
  const occupationalCategory = resolveOccupationalCategory(job);
  const applicantLocationRequirements = resolveApplicantLocationRequirements(job);

  const hiringOrganization = buildCompanyOrganization(job, {
    locale: opts.locale,
    baseUrl: opts.baseUrl,
    fallbackUrl: opts.url,
    knownSlugs: opts.knownSlugs,
  });

  const schema: JobPostingSchema = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title,
    description,
    datePosted,
    employmentType,
    hiringOrganization,
    jobLocation: {
      '@type': 'Place',
      address,
    },
    baseSalary,
    url: opts.url,
    validThrough,
    directApply: isEmployerOwnedApplyUrl(job),
    ...(job.id || job.slug
      ? {
          identifier: {
            '@type': 'PropertyValue',
            name: companyName,
            value: String(job.id || job.slug),
          },
        }
      : {}),
    ...(job.isRemote ? { jobLocationType: 'TELECOMMUTE' as const } : {}),
    ...(industry ? { industry } : {}),
    ...(occupationalCategory ? { occupationalCategory } : {}),
    ...(applicantLocationRequirements ? { applicantLocationRequirements } : {}),
  };

  assertMandatoryFieldsComplete(schema);
  return schema;
}

/**
 * Paranoid sanity-check — fails loudly if a future code change ever produces
 * an empty or malformed field in the site's mandatory structured-data
 * contract.
 */
function assertMandatoryFieldsComplete(schema: JobPostingSchema): void {
  const missing: string[] = [];
  if (!schema.title) missing.push('title');
  if (!schema.description || schema.description.length < 50) missing.push('description');
  if (!schema.datePosted) missing.push('datePosted');
  if (!schema.employmentType) missing.push('employmentType');
  if (!schema.hiringOrganization?.name) missing.push('hiringOrganization.name');

  const addr = schema.jobLocation?.address;
  if (!addr) missing.push('jobLocation');
  else {
    if (!addr.addressLocality) missing.push('jobLocation.address.addressLocality');
    if (!addr.addressRegion) missing.push('jobLocation.address.addressRegion');
    if (addr.addressCountry !== 'CH') missing.push('jobLocation.address.addressCountry');
    if (!addr.streetAddress) missing.push('jobLocation.address.streetAddress');
    if (!isValidPostalCode(addr.postalCode)) missing.push('jobLocation.address.postalCode');
  }

  const types = Array.isArray(schema.employmentType) ? schema.employmentType : [schema.employmentType];
  if (types.length === 0) missing.push('employmentType');

  const sal = schema.baseSalary;
  if (!sal) missing.push('baseSalary');
  else {
    if (!sal.currency) missing.push('baseSalary.currency');
    if (!(sal.value?.minValue > 0)) missing.push('baseSalary.value.minValue');
    if (sal.value?.maxValue !== undefined && !(sal.value.maxValue >= sal.value.minValue)) missing.push('baseSalary.value.maxValue');
    if (sal.value?.unitText !== 'YEAR') missing.push('baseSalary.value.unitText');
  }

  if (!schema.validThrough || !toIsoDate(schema.validThrough)) missing.push('validThrough');

  if (missing.length > 0) {
    throw new Error(
      `buildJobPostingSchema produced a schema with missing/invalid fields: ${missing.join(', ')}`,
    );
  }
}
