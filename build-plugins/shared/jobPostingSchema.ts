/**
 * Canonical `JobPosting` structured-data builder.
 *
 * Produces a schema.org `JobPosting` block that always contains the 9
 * mandatory fields per CLAUDE.md rule #3:
 *
 *   1. baseSalary (with currency + minValue > 0 + maxValue + unitText)
 *   2. postalCode (nested inside `jobLocation.address`)
 *   3. streetAddress (nested inside `jobLocation.address`)
 *   4. title
 *   5. description (≥ 50 chars)
 *   6. datePosted (ISO 8601, date-only or date-time)
 *   7. hiringOrganization.name
 *   8. jobLocation (Place + PostalAddress with addressCountry 'CH')
 *   9. employmentType (schema.org token)
 *
 * Input shape is intentionally permissive — every field is optional and
 * the builder fills a realistic default when the source data is missing.
 * Output is strictly typed (all mandatory fields required).
 *
 * Shared by (as of this refactor):
 *   - `build-plugins/jobsSeoPagesPlugin.ts` (per-job active + soft-landing)
 *   - `build-plugins/weeklyEmployersPlugin.ts` (per-company × per-city hubs)
 *   - `services/seoService.ts` (runtime SPA JSON-LD injection)
 */

import {
  COMPANY_HQ_ADDRESSES,
  deriveCantonFromCity,
  resolveFallbackAddress,
} from './companyHqAddresses';
import {
  DEFAULT_POSTAL_CODE,
  isValidPostalCode,
  resolvePostalCode,
} from './postalCodes';
import {
  resolveSalaryBand,
  TICINO_MIN_ANNUAL_CHF,
  type SalaryBand,
} from './salaryDefaults';

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

  readonly postedDate?: string | null;
  readonly datePosted?: string | null;
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

  readonly sector?: string | null;
  readonly category?: string | null;

  readonly url?: string | null;

  readonly isRemote?: boolean | null;
}

/** Options for the canonical builder. */
export interface BuildJobPostingOptions {
  /** BCP-47 locale tag used for `inLanguage` and localised defaults. */
  readonly locale: string;
  /** Absolute canonical URL for the job page (`url` on the schema). */
  readonly url: string;
  /**
   * Optional site base URL — reserved for future use (e.g. emitting
   * `sameAs` for hiring org). Never affects mandatory-field output.
   */
  readonly baseUrl?: string;
}

/** Strict schema.org `PostalAddress` shape emitted by the builder. */
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

/** Strict schema.org `MonetaryAmount` shape emitted by the builder. */
export interface BaseSalarySchema {
  readonly '@type': 'MonetaryAmount';
  readonly currency: string;
  readonly value: {
    readonly '@type': 'QuantitativeValue';
    readonly minValue: number;
    readonly maxValue: number;
    readonly unitText: 'YEAR';
  };
}

/** Strict schema.org `Organization` shape emitted by the builder. */
export interface HiringOrganizationSchema {
  readonly '@type': 'Organization';
  readonly name: string;
  readonly sameAs?: string;
  readonly logo?: string;
}

/**
 * Output shape: a fully populated `JobPosting`. Every one of the 9
 * mandatory fields (CLAUDE.md rule #3) is **required** — the TypeScript
 * compiler will flag any future regression.
 */
export interface JobPostingSchema {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'JobPosting';
  readonly title: string;
  readonly description: string;
  readonly datePosted: string;
  readonly employmentType: EmploymentType;
  readonly hiringOrganization: HiringOrganizationSchema;
  readonly jobLocation: PlaceSchema;
  readonly baseSalary: BaseSalarySchema;
  readonly url: string;
  readonly inLanguage?: string;
  readonly validThrough?: string;
  readonly directApply?: boolean;
  readonly identifier?: {
    readonly '@type': 'PropertyValue';
    readonly name: string;
    readonly value: string;
  };
  readonly jobLocationType?: 'TELECOMMUTE';
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

const EMPLOYMENT_TYPE_MAP: Record<string, EmploymentType> = {
  permanent: 'FULL_TIME',
  'full-time': 'FULL_TIME',
  full_time: 'FULL_TIME',
  fulltime: 'FULL_TIME',
  cdi: 'FULL_TIME',
  indeterminato: 'FULL_TIME',
  'part-time': 'PART_TIME',
  part_time: 'PART_TIME',
  parttime: 'PART_TIME',
  temporary: 'TEMPORARY',
  temp: 'TEMPORARY',
  temporaneo: 'TEMPORARY',
  determinato: 'TEMPORARY',
  cdd: 'TEMPORARY',
  fixed_term: 'TEMPORARY',
  'fixed-term': 'TEMPORARY',
  interim: 'TEMPORARY',
  internship: 'INTERN',
  intern: 'INTERN',
  stage: 'INTERN',
  stagiaire: 'INTERN',
  tirocinio: 'INTERN',
  apprendista: 'INTERN',
  apprentice: 'INTERN',
  apprenticeship: 'INTERN',
  contract: 'CONTRACTOR',
  contractor: 'CONTRACTOR',
  freelance: 'CONTRACTOR',
  mandato: 'CONTRACTOR',
  volunteer: 'VOLUNTEER',
  volontario: 'VOLUNTEER',
  'per-diem': 'PER_DIEM',
  per_diem: 'PER_DIEM',
};

/** Normalise a contract/employment-type string to a schema.org token. */
function normaliseEmploymentType(raw: string | null | undefined): EmploymentType {
  if (!raw) return 'FULL_TIME';
  const key = String(raw).toLowerCase().trim().replace(/\s+/g, '_');
  return EMPLOYMENT_TYPE_MAP[key] || 'FULL_TIME';
}

/** Normalise any date-ish input to an ISO 8601 string; `null` on failure. */
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Return today's ISO 8601 date (UTC, date-only). */
function todayIso(): string {
  return new Date().toISOString();
}

/** Compute a future `validThrough` given a `datePosted` ISO string. */
function computeValidThrough(
  explicit: string | null | undefined,
  crawledAt: string | null | undefined,
  datePosted: string,
): string {
  const explicitIso = toIsoDate(explicit);
  if (explicitIso) return explicitIso;

  const crawledIso = toIsoDate(crawledAt);
  if (crawledIso) {
    const out = new Date(crawledIso);
    out.setUTCDate(out.getUTCDate() + 60);
    return out.toISOString();
  }

  const posted = new Date(datePosted);
  if (!Number.isNaN(posted.getTime())) {
    const out = new Date(posted);
    out.setUTCDate(out.getUTCDate() + 90);
    return out.toISOString();
  }

  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 60);
  return fallback.toISOString();
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
  const base = String(byLocale || job.title || '').trim();
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
  if (base.length >= 50) return base.slice(0, 5000);
  return buildDescriptionFallback(title, company, city, locale).slice(0, 5000);
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

/** Derive the schema.org canton code for the job. */
function resolveCanton(job: JobInput): string {
  const explicit = String(job.addressRegion || job.canton || '').toUpperCase().trim();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  return deriveCantonFromCity(job.addressLocality || job.city || job.location || '');
}

/** Resolve the PostalAddress with every field guaranteed non-empty. */
function resolveAddress(
  job: JobInput,
  _companyName: string,
  locale: string,
): PostalAddressSchema {
  const companySlug = job.companySlug || job.companyKey || '';
  const cityRaw = String(
    job.addressLocality || job.city || job.location || '',
  ).trim();

  const hqEntry = companySlug
    ? COMPANY_HQ_ADDRESSES[companySlug.toLowerCase()]
    : undefined;

  const fallback = resolveFallbackAddress(
    companySlug ? companySlug.toLowerCase() : undefined,
    cityRaw ? cityRaw.toLowerCase() : undefined,
  );

  const region = resolveCanton(job) || fallback.addressRegion;

  const addressLocality =
    cityRaw.length > 0 ? cityRaw : fallback.addressLocality;

  // Precedence: explicit source value → company HQ (when known) → city
  // lookup → canton-capital fallback. Company HQ wins over city lookup
  // because the HQ registry is curated and therefore more accurate than
  // a generic-city postal code.
  const postalCode = isValidPostalCode(job.postalCode)
    ? String(job.postalCode).trim()
    : (hqEntry?.postalCode && isValidPostalCode(hqEntry.postalCode) ? hqEntry.postalCode : '') ||
      resolvePostalCode(addressLocality, region) ||
      fallback.postalCode ||
      DEFAULT_POSTAL_CODE;

  const streetAddressRaw = String(job.streetAddress || job.address || '').trim();
  const streetAddress =
    streetAddressRaw.length > 0
      ? streetAddressRaw
      : (hqEntry?.streetAddress && hqEntry.streetAddress.length > 0 ? hqEntry.streetAddress : '') ||
        fallback.streetAddress ||
        localisedCentro(addressLocality, locale);

  // Final guard — if anything is still empty, throw. Should never happen:
  // every branch above has a non-empty fallback.
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

/** Resolve a guaranteed-positive salary band. */
function resolveBaseSalary(job: JobInput): BaseSalarySchema {
  let min = 0;
  let max = 0;
  let currency = 'CHF';

  if (job.salary && Number.isFinite(job.salary.minValue) && job.salary.minValue > 0) {
    min = job.salary.minValue;
    max = job.salary.maxValue > min ? job.salary.maxValue : Math.round(min * 1.2);
    currency = job.salary.currency || 'CHF';
  } else if (Number.isFinite(job.salaryMin) && Number(job.salaryMin) > 0) {
    min = Number(job.salaryMin);
    max =
      Number.isFinite(job.salaryMax) && Number(job.salaryMax) > min
        ? Number(job.salaryMax)
        : Math.round(min * 1.2);
    currency = String(job.salaryCurrency || 'CHF').toUpperCase();
  } else {
    const band = resolveSalaryBand(job.sector || job.category || '');
    min = band.minValue;
    max = band.maxValue;
    currency = band.currency;
  }

  // Hard floor: never emit an obvious placeholder.
  if (!(min > 0)) min = TICINO_MIN_ANNUAL_CHF;
  if (!(max > min)) max = Math.round(min * 1.2);
  if (!currency) currency = 'CHF';

  return {
    '@type': 'MonetaryAmount',
    currency,
    value: {
      '@type': 'QuantitativeValue',
      minValue: min,
      maxValue: max,
      unitText: 'YEAR',
    },
  };
}

/** Resolve datePosted to an ISO-8601 string (never empty). */
function resolveDatePosted(job: JobInput): string {
  return (
    toIsoDate(job.datePosted) ||
    toIsoDate(job.postedDate) ||
    toIsoDate(job.scrapedAt) ||
    toIsoDate(job.crawledAt) ||
    todayIso()
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a fully populated `JobPosting` schema with every mandatory field
 * present and non-empty. Throws if the input is unusable (e.g. neither a
 * city nor a canton could be derived).
 *
 * The throw is defensive — every default above is realistic, so in
 * practice the function always returns a valid schema.
 */
export function buildJobPostingSchema(
  job: JobInput,
  opts: BuildJobPostingOptions,
): JobPostingSchema {
  if (!opts || !opts.locale || !opts.url) {
    throw new Error('buildJobPostingSchema: opts.locale and opts.url are required');
  }

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
  const datePosted = resolveDatePosted(job);
  const validThrough = computeValidThrough(
    job.validThrough,
    job.crawledAt || job.scrapedAt || null,
    datePosted,
  );
  const employmentType = normaliseEmploymentType(
    job.employmentType || job.contractType || job.contract,
  );
  const baseSalary = resolveBaseSalary(job);

  const logo = job.companyLogoUrl && String(job.companyLogoUrl).trim().length > 0
    ? String(job.companyLogoUrl).trim()
    : undefined;
  const sameAs = job.companyDomain && String(job.companyDomain).trim().length > 0
    ? `https://${String(job.companyDomain).replace(/^https?:\/\//, '').trim()}`
    : undefined;

  const hiringOrganization: HiringOrganizationSchema = {
    '@type': 'Organization',
    name: companyName,
    ...(sameAs ? { sameAs } : {}),
    ...(logo ? { logo } : {}),
  };

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
    inLanguage: (opts.locale || 'it').slice(0, 2).toLowerCase(),
    validThrough,
    directApply: Boolean(job.url),
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
  };

  assertMandatoryFieldsComplete(schema);
  return schema;
}

/**
 * Paranoid sanity-check — fails loudly if a future code change ever
 * produces an empty mandatory field. Intended to catch regressions at
 * build time rather than during Semrush crawl.
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
    if (!addr.streetAddress) missing.push('jobLocation.address.streetAddress');
    if (!addr.postalCode) missing.push('jobLocation.address.postalCode');
    if (!addr.addressLocality) missing.push('jobLocation.address.addressLocality');
    if (!addr.addressRegion) missing.push('jobLocation.address.addressRegion');
    if (addr.addressCountry !== 'CH') missing.push('jobLocation.address.addressCountry');
  }

  const sal = schema.baseSalary;
  if (!sal) missing.push('baseSalary');
  else {
    if (!sal.currency) missing.push('baseSalary.currency');
    if (!(sal.value?.minValue > 0)) missing.push('baseSalary.value.minValue');
    if (!(sal.value?.maxValue >= sal.value?.minValue)) missing.push('baseSalary.value.maxValue');
    if (sal.value?.unitText !== 'YEAR') missing.push('baseSalary.value.unitText');
  }

  if (missing.length > 0) {
    throw new Error(
      `buildJobPostingSchema produced a schema with missing/invalid fields: ${missing.join(', ')}`,
    );
  }
}

/**
 * Ordered list of all 9 mandatory JobPosting field paths. Exposed for
 * use by external validators (e.g. `scripts/validate-jobposting-schema.mjs`).
 */
export const MANDATORY_JOBPOSTING_FIELDS: readonly string[] = [
  'title',
  'description',
  'datePosted',
  'employmentType',
  'hiringOrganization.name',
  'jobLocation',
  'jobLocation.address.postalCode',
  'jobLocation.address.streetAddress',
  'baseSalary',
];
