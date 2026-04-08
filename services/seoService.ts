/**
 * SEO Service - Dynamic Meta Tags Management
 * Manages SEO metadata for different sections of the app
 */

import { getLocale, setLocale, t, type Locale } from './i18n';
import { parsePath, buildPath, buildAllLocalePaths, type AppRoute } from './router';
import { ALL_GLOSSARY_TERM_IDS, ALL_BORDER_CROSSING_IDS } from './router';
import { resolveCompanyLogoUrl } from './jobDataNormalization';
import { reportCaughtError } from './errorReporter';
import { translateFaqPage } from './seo/faq-translations';
import { translateHowToSchema } from './seo/howto-translations';

/**
 * Retry a dynamic import once after clearing SW caches.
 * Mirrors the logic in lazyRetry.ts but for non-React imports.
 */
async function retryImport<T>(factory: () => Promise<T>, label: string): Promise<T> {
  try {
    return await factory();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isChunkError =
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Loading chunk') ||
      msg.includes('Loading CSS chunk') ||
      msg.includes('error loading dynamically imported module');
    if (!isChunkError) throw err;

    // Clear SW caches and retry once
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
    try {
      return await factory();
    } catch (retryErr) {
      reportCaughtError(retryErr, `seo.chunkRetry.${label}`);
      throw retryErr;
    }
  }
}

export interface SEOMetadata {
  title: string;
  description: string;
  keywords: string;
  ogTitle: string;
  ogDescription: string;
  canonicalPath: string;
  structuredData?: Record<string, any> | Record<string, any>[];
}

const BASE_URL = 'https://frontaliereticino.ch';
const DEFAULT_DATASET_LICENSE = 'https://creativecommons.org/licenses/by-nc/4.0/';

/**
 * E-E-A-T Author & Publisher Schema for YMYL content.
 * Using Organization with expert-level knowsAbout signals.
 * Reused across all structured data to ensure consistency.
 *
 * Includes inline E-E-A-T fields (name, description, knowsAbout) alongside
 * the @id reference so that AI crawlers and schema validators see expertise
 * signals even without resolving the referenced #organization entity.
 */
export const SCHEMA_AUTHOR = {
  "@type": "Organization",
  "@id": `${BASE_URL}/#organization`,
  "name": "Redazione Frontaliere Ticino",
  "url": `${BASE_URL}/chi-siamo`,
  "description": "Team editoriale specializzato in fiscalità, previdenza e vita quotidiana dei lavoratori frontalieri in Ticino",
  "knowsAbout": [
    "Fiscalità frontalieri Svizzera-Italia",
    "Nuovo accordo fiscale 2026",
    "Previdenza sociale AVS/LPP",
    "Assicurazione malattia LAMal/CMB",
    "Permesso G e permesso B",
    "Mercato del lavoro Ticino",
  ],
} as const;

export const SCHEMA_PUBLISHER = {
  "@id": `${BASE_URL}/#organization`,
} as const;

/**
 * Organization author for blog articles and editorial content.
 * Uses the same enriched author object as SCHEMA_AUTHOR so that
 * AI systems see E-E-A-T signals (knowsAbout, description) inline,
 * while the @id still links to the standalone Organization in index.html
 * for knowledge graph consistency.
 */
export const SCHEMA_EXPERT_AUTHOR = {
  "@type": "Organization",
  "@id": `${BASE_URL}/#organization`,
  "name": "Redazione Frontaliere Ticino",
  "url": `${BASE_URL}/chi-siamo`,
  "description": "Team editoriale specializzato in fiscalità, previdenza e vita quotidiana dei lavoratori frontalieri in Ticino",
  "knowsAbout": [
    "Fiscalità frontalieri Svizzera-Italia",
    "Nuovo accordo fiscale 2026",
    "Previdenza sociale AVS/LPP",
    "Assicurazione malattia LAMal/CMB",
    "Permesso G e permesso B",
    "Mercato del lavoro Ticino",
  ],
} as const;

/**
 * SpeakableSpecification for article/FAQ pages — targets the most
 * citation-worthy content for voice assistants and AI summarization.
 */
export const SCHEMA_SPEAKABLE = {
  "@type": "SpeakableSpecification",
  "cssSelector": ["article h1", "article h2", "article p", ".faq-answer", "[data-speakable]"]
} as const;

const SERP_EXPERIMENT_CACHE_KEY = 'seo_serp_experiment_state_v1';
const SEARCH_ENGINES = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'ecosia.', 'yandex.'];
const SERP_EXPERIMENT_DEFAULTS = {
  enabled: true,
  variant: 'year_intent' as SerpExperimentVariant,
  targets: '*',
  year: '2026',
};

type SerpExperimentVariant = 'control' | 'year_intent' | 'intent_simulation';
type SerpExperimentState = {
  enabled: boolean;
  variant: SerpExperimentVariant;
  targets: Set<string>;
  year: string;
  loaded: boolean;
};

const serpExperimentState: SerpExperimentState = {
  enabled: false,
  variant: 'control',
  targets: new Set(),
  year: '2026',
  loaded: false,
};

let serpExperimentLoadPromise: Promise<void> | null = null;
let lastSerpExposureContext: { section: string; path: string; variant: SerpExperimentVariant } | null = null;
let serpOverrideWarned = false;
let jobsBySlugCache: Map<string, any> | null = null;
let jobsBySlugPromise: Promise<Map<string, any>> | null = null;
let totalActiveJobCount: number | null = null;

function normalizeSeoText(input: string): string {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function compactSeoDescription(input: string, maxChars = 320): string {
  const cleaned = normalizeSeoText(input).replace(/<[^>]+>/g, ' ');
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trim()}…`;
}

function companyLogoFromJob(job: any): string {
  const logo = resolveCompanyLogoUrl({
    company: String(job?.company || ''),
    companyKey: String(job?.companyKey || ''),
    companyDomain: String(job?.companyDomain || ''),
    url: String(job?.url || ''),
  });
  return logo || `${BASE_URL}/icons/icon-512x512.png`;
}

function parseRawDateToIso(raw = ''): string {
  const value = normalizeSeoText(raw);
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const safe = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
}

function addDaysIso(rawDate = '', days = 60): string {
  const d = new Date(parseRawDateToIso(rawDate));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function normalizeEmploymentType(contractRaw = ''): string {
  const v = normalizeSeoText(contractRaw).toLowerCase();
  if (v.includes('full')) return 'FULL_TIME';
  if (v.includes('permanent')) return 'FULL_TIME';
  if (v.includes('part')) return 'PART_TIME';
  if (v.includes('intern') || v.includes('stage') || v.includes('tirocin')) return 'INTERN';
  if (v.includes('temp')) return 'TEMPORARY';
  if (v.includes('contract')) return 'CONTRACTOR';
  return 'OTHER';
}

function numericValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveJobAddress(job: any): {
  locality: string;
  region: string;
  country: string;
  postalCode?: string;
  streetAddress?: string;
} {
  // Parameterized defaults — change when expanding beyond TI/GR
  const DEFAULT_CANTON = 'TI';
  const DEFAULT_CANTON_DISPLAY = 'Ticino';
  const locality = String(job?.addressLocality || job?.location || DEFAULT_CANTON_DISPLAY);
  const region = String(job?.addressRegion || job?.canton || DEFAULT_CANTON);
  const country = String(job?.addressCountry || 'CH');
  const postalCode = normalizeSeoText(String(job?.postalCode || ''));
  const streetAddress = normalizeSeoText(String(job?.streetAddress || ''));
  return {
    locality,
    region,
    country,
    ...(postalCode ? { postalCode } : {}),
    ...(streetAddress ? { streetAddress } : {}),
  };
}

function resolveJobSalary(job: any): { minValue: number; maxValue?: number; currency: string } | null {
  const minDirect = numericValue(job?.salaryMin);
  const maxDirect = numericValue(job?.salaryMax);
  const baseSalaryValue = job?.baseSalary?.value || {};
  const minFromBase = numericValue(baseSalaryValue?.minValue);
  const maxFromBase = numericValue(baseSalaryValue?.maxValue);
  const minValue = minDirect ?? minFromBase;
  if (minValue == null) return null;
  const maxValue = maxDirect ?? maxFromBase ?? undefined;
  const currency = String(
    job?.currency ||
    job?.baseSalary?.currency ||
    baseSalaryValue?.currency ||
    'CHF'
  ).toUpperCase();
  return { minValue, ...(maxValue ? { maxValue } : {}), currency };
}

function localizedJobKeywords(locale: Locale, title: string, company: string, location: string): string {
  const role = normalizeSeoText(title).toLowerCase();
  const org = normalizeSeoText(company).toLowerCase();
  const loc = normalizeSeoText(location).toLowerCase();
  const baseByLocale: Record<Locale, string> = {
    it: 'lavoro ticino, offerte lavoro frontalieri, lavoro svizzera frontalieri, impiego ticino, carriera svizzera',
    en: 'jobs ticino, cross-border jobs switzerland italy, job offers ticino, work in ticino',
    de: 'jobs tessin, stellenangebote grenzgaenger, arbeit im tessin, stellen schweiz italien',
    fr: 'emplois tessin, offres frontaliers, travail tessin, emploi suisse italie',
  };
  return `${role}, ${org}, ${loc}, ${baseByLocale[locale]}`;
}

async function loadJobsBySlug(): Promise<Map<string, any>> {
  if (jobsBySlugCache) return jobsBySlugCache;
  if (jobsBySlugPromise) return jobsBySlugPromise;
  jobsBySlugPromise = (async () => {
    const out = new Map<string, any>();
    try {
      const res = await fetch('/data/jobs.json', { cache: 'no-store' });
      if (!res.ok) return out;
      const list = await res.json();
      if (!Array.isArray(list)) return out;
      for (const item of list) {
        const slugCandidates = new Set<string>();
        const canonicalSlug = normalizeSeoText(String(item?.slug || ''));
        if (canonicalSlug) slugCandidates.add(canonicalSlug);
        const slugByLocale = item?.slugByLocale && typeof item.slugByLocale === 'object'
          ? Object.values(item.slugByLocale)
          : [];
        for (const localizedSlug of slugByLocale) {
          const normalized = normalizeSeoText(String(localizedSlug || ''));
          if (normalized) slugCandidates.add(normalized);
        }
        for (const slug of slugCandidates) {
          if (!out.has(slug)) out.set(slug, item);
        }
      }
    } catch {
      // Ignore runtime fetch failures; keep SEO fallback.
    }
    jobsBySlugCache = out;
    return out;
  })();
  return jobsBySlugPromise;
}

/**
 * Get the total number of unique active jobs from the loaded dataset.
 * Returns a rounded-down label like "1500+" for SEO titles, or null if
 * data hasn't loaded yet (fallback to static title).
 */
async function getActiveJobCountLabel(): Promise<string | null> {
  if (totalActiveJobCount !== null) {
    const rounded = Math.floor(totalActiveJobCount / 100) * 100;
    return `${rounded}+`;
  }
  try {
    const map = await loadJobsBySlug();
    // Count distinct job objects (map contains multiple slugs per job)
    const uniqueJobs = new Set<any>();
    for (const job of map.values()) uniqueJobs.add(job);
    totalActiveJobCount = uniqueJobs.size;
    const rounded = Math.floor(totalActiveJobCount / 100) * 100;
    return rounded > 0 ? `${rounded}+` : null;
  } catch {
    return null;
  }
}

async function resolveJobSeoBySlug(
  slug: string,
  locale: Locale,
  canonicalLocalePath: string
): Promise<{
  title: string;
  description: string;
  keywords: string;
  logoUrl: string;
  structuredData: Record<string, any>;
} | null> {
  const cleanSlug = normalizeSeoText(slug);
  if (!cleanSlug) return null;
  const map = await loadJobsBySlug();
  const job = map.get(cleanSlug);
  if (!job) return null;
  const localizedTitle = normalizeSeoText(String(job?.titleByLocale?.[locale] || job?.title || ''));
  const localizedDescription = compactSeoDescription(String(job?.descriptionByLocale?.[locale] || job?.description || ''), 360);
  if (!localizedTitle || !localizedDescription) return null;
  const logoUrl = companyLogoFromJob(job);
  const canonicalUrl = `${BASE_URL}${canonicalLocalePath}`;
  const address = resolveJobAddress(job);
  const salary = resolveJobSalary(job);
  return {
    title: `${localizedTitle} — ${job.company} | Frontaliere Ticino`,
    description: localizedDescription,
    keywords: localizedJobKeywords(locale, localizedTitle, String(job?.company || ''), String(job?.location || '')),
    logoUrl,
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: localizedTitle,
      description: String(job?.descriptionByLocale?.[locale] || job?.description || localizedDescription).slice(0, 5000),
      inLanguage: locale,
      datePosted: parseRawDateToIso(String(job?.postedDate || '')),
      validThrough: addDaysIso(String(job?.postedDate || ''), 60),
      employmentType: normalizeEmploymentType(String(job?.contract || '')),
      hiringOrganization: {
        '@type': 'Organization',
        name: String(job?.company || 'Frontaliere Ticino'),
        sameAs: BASE_URL,
        logo: logoUrl,
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: address.locality,
          addressRegion: address.region,
          addressCountry: address.country,
          ...(address.postalCode ? { postalCode: address.postalCode } : {}),
          ...(address.streetAddress ? { streetAddress: address.streetAddress } : {}),
        },
      },
      ...(salary
        ? {
          baseSalary: {
            '@type': 'MonetaryAmount',
            currency: salary.currency,
            value: {
              '@type': 'QuantitativeValue',
              minValue: salary.minValue,
              ...(salary.maxValue ? { maxValue: salary.maxValue } : {}),
              unitText: 'YEAR',
            },
          },
        }
        : {}),
      directApply: Boolean(job?.url),
      url: canonicalUrl,
      identifier: {
        '@type': 'PropertyValue',
        name: String(job?.company || 'Frontaliere Ticino'),
        value: String(job?.id || job?.slug || cleanSlug),
      },
    },
  };
}

function parseSerpExperimentTargets(raw: string): Set<string> {
  const normalized = (raw || '').trim();
  if (!normalized) return new Set();
  if (normalized === '*') return new Set(['*']);
  return new Set(
    normalized
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function restoreCachedSerpExperimentState(): void {
  if (typeof window === 'undefined') return;
  try {
    const cachedRaw = window.localStorage.getItem(SERP_EXPERIMENT_CACHE_KEY);
    if (!cachedRaw) return;
    const cached = JSON.parse(cachedRaw) as {
      enabled?: boolean;
      variant?: string;
      targets?: string;
      year?: string;
    };
    serpExperimentState.enabled = Boolean(cached.enabled);
    serpExperimentState.variant = (cached.variant === 'year_intent' || cached.variant === 'intent_simulation')
      ? cached.variant
      : 'control';
    serpExperimentState.targets = parseSerpExperimentTargets(cached.targets || '');
    serpExperimentState.year = (cached.year || '2026').trim() || '2026';
  } catch {
    // Ignore malformed cache
  }
}

function loadSerpExperimentState(): void {
  if (typeof window === 'undefined' || serpExperimentLoadPromise) return;
  restoreCachedSerpExperimentState();
  serpExperimentLoadPromise = (async () => {
    try {
      const { getConfigValue } = await import('./firebase');
      const [enabledRaw, variantRaw, targetsRaw, yearRaw] = await Promise.all([
        getConfigValue('SEO_SERP_EXPERIMENT_ENABLED'),
        getConfigValue('SEO_SERP_EXPERIMENT_VARIANT'),
        getConfigValue('SEO_SERP_EXPERIMENT_TARGETS'),
        getConfigValue('SEO_SERP_EXPERIMENT_YEAR'),
      ]);
      serpExperimentState.enabled = enabledRaw === 'true';
      serpExperimentState.variant = (variantRaw === 'year_intent' || variantRaw === 'intent_simulation')
        ? variantRaw
        : 'control';
      serpExperimentState.targets = parseSerpExperimentTargets(targetsRaw);
      serpExperimentState.year = (yearRaw || '2026').trim() || '2026';
      if (!serpOverrideWarned) {
        const normalizedTargets = (targetsRaw || '').trim() || '';
        const hasOverride =
          serpExperimentState.enabled !== SERP_EXPERIMENT_DEFAULTS.enabled ||
          serpExperimentState.variant !== SERP_EXPERIMENT_DEFAULTS.variant ||
          normalizedTargets !== SERP_EXPERIMENT_DEFAULTS.targets ||
          serpExperimentState.year !== SERP_EXPERIMENT_DEFAULTS.year;
        if (hasOverride) {
          console.warn('[SEO SERP Experiment] Remote Config override detected', {
            remoteConfig: {
              enabled: serpExperimentState.enabled,
              variant: serpExperimentState.variant,
              targets: normalizedTargets,
              year: serpExperimentState.year,
            },
            fallbackDefaults: SERP_EXPERIMENT_DEFAULTS,
          });
        }
        serpOverrideWarned = true;
      }
      try {
        window.localStorage.setItem(SERP_EXPERIMENT_CACHE_KEY, JSON.stringify({
          enabled: serpExperimentState.enabled,
          variant: serpExperimentState.variant,
          targets: Array.from(serpExperimentState.targets).join(','),
          year: serpExperimentState.year,
        }));
      } catch {
        // Storage not available; keep in-memory config only
      }
    } catch {
      // Keep fallback state from cache/defaults
    } finally {
      serpExperimentState.loaded = true;
    }
  })();
}

export function getSerpExperimentDiagnostics(): {
  loaded: boolean;
  runtime: { enabled: boolean; variant: SerpExperimentVariant; targets: string; year: string };
  defaults: { enabled: boolean; variant: SerpExperimentVariant; targets: string; year: string };
  hasRemoteOverride: boolean;
} {
  loadSerpExperimentState();
  const runtimeTargets = Array.from(serpExperimentState.targets).join(',');
  const normalizedTargets = runtimeTargets || '';
  const hasRemoteOverride =
    serpExperimentState.enabled !== SERP_EXPERIMENT_DEFAULTS.enabled ||
    serpExperimentState.variant !== SERP_EXPERIMENT_DEFAULTS.variant ||
    normalizedTargets !== SERP_EXPERIMENT_DEFAULTS.targets ||
    serpExperimentState.year !== SERP_EXPERIMENT_DEFAULTS.year;

  return {
    loaded: serpExperimentState.loaded,
    runtime: {
      enabled: serpExperimentState.enabled,
      variant: serpExperimentState.variant,
      targets: normalizedTargets,
      year: serpExperimentState.year,
    },
    defaults: SERP_EXPERIMENT_DEFAULTS,
    hasRemoteOverride,
  };
}

function shouldApplySerpExperiment(section: string): boolean {
  if (!serpExperimentState.enabled || serpExperimentState.variant === 'control') return false;
  if (serpExperimentState.targets.size === 0) return false;
  if (serpExperimentState.targets.has('*')) return true;
  return serpExperimentState.targets.has(section);
}

function getSerpIntentLabel(path: string, locale: Locale): string {
  const map = {
    it: {
      over20: 'oltre 20km',
      within20: 'entro 20km',
      exchange: 'cambio CHF EUR',
      pension: 'pensione frontalieri',
      simulation: 'simulazione',
    },
    en: {
      over20: 'over 20km',
      within20: 'within 20km',
      exchange: 'CHF EUR exchange',
      pension: 'cross-border pension',
      simulation: 'simulation',
    },
    de: {
      over20: 'ueber 20km',
      within20: 'innerhalb 20km',
      exchange: 'CHF EUR wechsel',
      pension: 'grenzgaenger rente',
      simulation: 'simulation',
    },
    fr: {
      over20: 'au-dela de 20km',
      within20: 'dans 20km',
      exchange: 'change CHF EUR',
      pension: 'retraite frontalier',
      simulation: 'simulation',
    },
  }[locale];

  if (path.includes('oltre-20km')) return map.over20;
  if (path.includes('entro-20km')) return map.within20;
  if (path.includes('cambio-franco-euro')) return map.exchange;
  if (path.includes('calcola-previdenza') || path.includes('tasse-e-pensione')) return map.pension;
  return map.simulation;
}

function applySerpTitleDescriptionVariant(
  section: string,
  path: string,
  locale: Locale,
  title: string,
  description: string,
): { title: string; description: string; variant: SerpExperimentVariant } {
  if (!shouldApplySerpExperiment(section)) {
    return { title, description, variant: 'control' };
  }

  const MAX_TITLE_LENGTH = 60;
  const MAX_DESCRIPTION_LENGTH = 160;
  const year = serpExperimentState.year;
  const intent = getSerpIntentLabel(path, locale);
  const cleanTitle = title.replace(/\s+\|\s+Frontaliere Ticino$/i, '').trim();

  if (serpExperimentState.variant === 'year_intent') {
    const suffix = ` ${year} | ${intent}`;
    let experimentTitle: string;
    if (cleanTitle.length + suffix.length <= MAX_TITLE_LENGTH) {
      experimentTitle = `${cleanTitle}${suffix}`;
    } else {
      const maxClean = MAX_TITLE_LENGTH - suffix.length;
      experimentTitle = maxClean >= 10 ? `${cleanTitle.slice(0, maxClean).trimEnd()}${suffix}` : title;
    }
    const experimentDesc = `${description} Aggiornato ${year} con focus: ${intent}.`;
    return {
      title: experimentTitle,
      description: experimentDesc.length <= MAX_DESCRIPTION_LENGTH ? experimentDesc : description,
      variant: 'year_intent',
    };
  }

  if (serpExperimentState.variant === 'intent_simulation') {
    const suffix = ` | ${intent} | ${year}`;
    let experimentTitle: string;
    if (cleanTitle.length + suffix.length <= MAX_TITLE_LENGTH) {
      experimentTitle = `${cleanTitle}${suffix}`;
    } else {
      const maxClean = MAX_TITLE_LENGTH - suffix.length;
      experimentTitle = maxClean >= 10 ? `${cleanTitle.slice(0, maxClean).trimEnd()}${suffix}` : title;
    }
    const experimentDesc = `${description} Simulazione aggiornata ${year} per ${intent}.`;
    return {
      title: experimentTitle,
      description: experimentDesc.length <= MAX_DESCRIPTION_LENGTH ? experimentDesc : description,
      variant: 'intent_simulation',
    };
  }

  return { title, description, variant: 'control' };
}

function isSearchReferrer(): { fromSearch: boolean; host: string } {
  if (typeof document === 'undefined' || !document.referrer) {
    return { fromSearch: false, host: 'direct' };
  }
  try {
    const host = new URL(document.referrer).hostname.toLowerCase();
    const fromSearch = SEARCH_ENGINES.some((engine) => host.includes(engine));
    return { fromSearch, host };
  } catch {
    return { fromSearch: false, host: 'unknown' };
  }
}

function addDatasetLicense(value: any): any {
  if (Array.isArray(value)) return value.map(addDatasetLicense);
  if (!value || typeof value !== 'object') return value;

  const cloned: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) cloned[k] = addDatasetLicense(v);

  const typeValue = cloned['@type'];
  const isDataset = typeValue === 'Dataset' || (Array.isArray(typeValue) && typeValue.includes('Dataset'));
  if (isDataset && !cloned.license) cloned.license = DEFAULT_DATASET_LICENSE;

  return cloned;
}

function withDatasetLicenses(map: Record<string, SEOMetadata>): Record<string, SEOMetadata> {
  const out: Record<string, SEOMetadata> = {};
  for (const [key, meta] of Object.entries(map)) {
    out[key] = meta.structuredData
      ? { ...meta, structuredData: addDatasetLicense(meta.structuredData) }
      : meta;
  }
  return out;
}

// ─── Auto-inject SpeakableSpecification into content schemas ────────────
// Adds speakable to WebApplication, CollectionPage, Dataset, DefinedTermSet,
// and WebPage schemas so voice assistants and AI readers can identify key
// passages for spoken answers across ALL content pages.
const SPEAKABLE_TARGET_TYPES = new Set([
  'WebApplication', 'CollectionPage', 'Dataset', 'DefinedTermSet',
  'WebPage', 'WebSite',
]);

function addSpeakable(value: any): any {
  if (Array.isArray(value)) return value.map(addSpeakable);
  if (!value || typeof value !== 'object') return value;

  const cloned: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) cloned[k] = addSpeakable(v);

  const typeValue = cloned['@type'];
  const isTarget = typeof typeValue === 'string' && SPEAKABLE_TARGET_TYPES.has(typeValue);
  if (isTarget && !cloned.speakable) {
    cloned.speakable = SCHEMA_SPEAKABLE;
  }
  return cloned;
}

function withSpeakable(map: Record<string, SEOMetadata>): Record<string, SEOMetadata> {
  const out: Record<string, SEOMetadata> = {};
  for (const [key, meta] of Object.entries(map)) {
    out[key] = meta.structuredData
      ? { ...meta, structuredData: addSpeakable(meta.structuredData) }
      : meta;
  }
  return out;
}

function titleizeGlossaryTermId(termId: string): string {
  // Converts camelCase / snake_case ids into a readable label (IT-friendly baseline)
  const base = termId
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/(\d+)/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();

  // Preserve common acronyms
  return base
    .replace(/\bavs\b/gi, 'AVS')
    .replace(/\blpp\b/gi, 'LPP')
    .replace(/\bcu\b/gi, 'CU')
    .replace(/\bral\b/gi, 'RAL')
    .replace(/\bssn\b/gi, 'SSN')
    .replace(/\bsepa\b/gi, 'SEPA')
    .replace(/\bccnl\b/gi, 'CCNL')
    .replace(/\bipg\b/gi, 'IPG')
    .replace(/\bac\b/gi, 'AC')
    .replace(/\bcmu\b/gi, 'CMU')
    .replace(/\blamal\b/gi, 'LAMal')
    .replace(/\bnaspi\b/gi, 'NASpI');
}

function buildGlossarySeoMetadata(): Record<string, SEOMetadata> {
  return Object.fromEntries(
    ALL_GLOSSARY_TERM_IDS.map((termId) => {
      const route = { activeTab: 'glossario' as const, glossaryTerm: termId as any };
      const canonicalPath = buildPath(route, 'it');
      const label = titleizeGlossaryTermId(termId);
      const title = `${label} (Glossario) | Frontaliere Ticino`;
      const description = `Definizione e spiegazione di ${label} per frontalieri (Svizzera–Italia): significato, contesto e impatto pratico.`;
      return [
        `glossario-${termId}`,
        {
          title,
          description,
          keywords: `glossario frontalieri, ${label}, significato ${label}, definizione ${label}, frontalieri ticino`,
          ogTitle: title,
          ogDescription: description,
          canonicalPath,
          structuredData: {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: `${label} (Glossario)`,
            url: `${BASE_URL}${canonicalPath}`,
            description,
          },
        } satisfies SEOMetadata,
      ];
    })
  ) as Record<string, SEOMetadata>;
}

function titleizeBorderCrossingId(crossingId: string): string {
  // Rough human-readable label from slug id
  return crossingId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function buildBorderCrossingSeoMetadata(): Record<string, SEOMetadata> {
  return Object.fromEntries(
    ALL_BORDER_CROSSING_IDS.map((crossingId) => {
      const route = { activeTab: 'guida' as const, guidaSubTab: 'border' as const, borderCrossing: crossingId as any };
      const canonicalPath = buildPath(route, 'it');
      const label = titleizeBorderCrossingId(crossingId);
      const title = `Traffico valico ${label} | Tempi attesa dogana`;
      const description = `Tempi di attesa e informazioni utili per il valico ${label}: orari, livello traffico tipico e consigli pratici per frontalieri.`;
      return [
        `valico-${crossingId}`,
        {
          title,
          description,
          keywords: `traffico valico ${label}, tempi attesa dogana ${label}, frontaliere ticino, valichi svizzera italia`,
          ogTitle: title,
          ogDescription: description,
          canonicalPath,
          structuredData: {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: `Traffico valico ${label}`,
            url: `${BASE_URL}${canonicalPath}`,
            description,
          },
        } satisfies SEOMetadata,
      ];
    })
  ) as Record<string, SEOMetadata>;
}


// ─── Core SEO entries (eagerly loaded) ───────────────────────────────
// Contains glossary + border-crossing entries (generated from data).
// Page, blog, and landing entries are lazy-loaded from services/seo/ chunks.
export const SEO_METADATA: Record<string, SEOMetadata> = withSpeakable(withDatasetLicenses({
  ...buildGlossarySeoMetadata(),
  ...buildBorderCrossingSeoMetadata(),
}));

// ─── Lazy-loaded SEO chunks ──────────────────────────────────────────
// Page (~90 entries), blog (~270 entries), and landing (~23 entries)
// are code-split into separate chunks and loaded on demand.
let _pagesChunkCache: Record<string, SEOMetadata> | null = null;
let _blogChunkCache: Record<string, SEOMetadata> | null = null;
let _landingChunkCache: Record<string, SEOMetadata> | null = null;

async function loadPagesSeoChunk(): Promise<Record<string, SEOMetadata>> {
  if (_pagesChunkCache) return _pagesChunkCache;
  const { default: entries } = await retryImport(() => import('./seo/seo-pages'), 'pages');
  _pagesChunkCache = withSpeakable(entries);
  return _pagesChunkCache;
}

async function loadBlogSeoChunk(): Promise<Record<string, SEOMetadata>> {
  if (_blogChunkCache) return _blogChunkCache;
  const [{ default: entries1 }, { default: entries2 }, { default: entries3 }] = await Promise.all([
    retryImport(() => import('./seo/seo-blog'), 'blog'),
    retryImport(() => import('./seo/seo-blog-2'), 'blog-2'),
    retryImport(() => import('./seo/seo-blog-3'), 'blog-3'),
  ]);
  _blogChunkCache = { ...entries1, ...entries2, ...entries3 };
  return _blogChunkCache;
}

async function loadLandingSeoChunk(): Promise<Record<string, SEOMetadata>> {
  if (_landingChunkCache) return _landingChunkCache;
  const { default: entries } = await retryImport(() => import('./seo/seo-landing'), 'landing');
  _landingChunkCache = withSpeakable(entries);
  return _landingChunkCache;
}

/**
 * Resolve SEO metadata for a given section key.
 * Core entries (glossary, border-crossing) are checked synchronously.
 * Page, blog, and landing entries are lazy-loaded from code-split chunks.
 */
async function getSeoEntry(sectionKey: string): Promise<SEOMetadata> {
  // 1. Check core entries (already in memory — glossary, border-crossing)
  if (SEO_METADATA[sectionKey]) return SEO_METADATA[sectionKey];

  // 2. Lazy-load blog chunk for blog-* keys
  if (sectionKey.startsWith('blog-')) {
    try {
      const blogEntries = await loadBlogSeoChunk();
      const entry = blogEntries[sectionKey];
      if (entry) return entry;
    } catch { /* fall through to default */ }
  }

  // 3. Lazy-load landing chunk for landing-* keys
  if (sectionKey.startsWith('landing-')) {
    try {
      const landingEntries = await loadLandingSeoChunk();
      const entry = landingEntries[sectionKey];
      if (entry) return entry;
    } catch { /* fall through to default */ }
  }

  // 4. Lazy-load pages chunk for all other keys (calculator, comparators, guide, etc.)
  try {
    const pagesEntries = await loadPagesSeoChunk();
    const entry = pagesEntries[sectionKey];
    if (entry) return entry;
  } catch { /* fall through to default */ }

  // 5. Fallback to calculator from pages chunk
  try {
    const pagesEntries = await loadPagesSeoChunk();
    if (pagesEntries.calculator) return pagesEntries.calculator;
  } catch { /* ignore */ }

  return SEO_METADATA.calculator ?? { title: 'Frontaliere Ticino', description: '', keywords: '', ogTitle: '', ogDescription: '', canonicalPath: '/' };
}

/**
 * Load ALL SEO metadata (core + blog + landing) for exhaustive iteration.
 * Used by tests and build-time tooling. NOT for runtime hot paths.
 */
export async function getAllSeoMetadata(): Promise<Record<string, SEOMetadata>> {
  const [pagesEntries, blogEntries, landingEntries] = await Promise.all([
    loadPagesSeoChunk(),
    loadBlogSeoChunk(),
    loadLandingSeoChunk(),
  ]);
  return {
    ...SEO_METADATA,
    ...pagesEntries,
    ...blogEntries,
    ...landingEntries,
  };
}

const SEO_SECTION_TITLE_KEY_MAP: Record<string, string> = {
  calculator: 'nav.simulator',
  whatif: 'simulator.whatif',
  payslip: 'payslip.title',
  ral: 'comparators.ral',
  bonus: 'comparators.bonus',
  'parental-leave': 'comparators.parentalLeave',
  residency: 'comparators.residency',
  salaryQuiz: 'salaryQuiz.navLabel',
  exchange: 'comparators.exchange',
  traffic: 'comparators.traffic',
  mobile: 'comparators.mobile',
  banks: 'comparators.banks',
  health: 'comparators.health',
  transport: 'comparators.transport',
  jobs: 'comparators.jobs',
  shopping: 'comparators.shopping',
  'cost-of-living': 'comparators.costOfLiving',
  'tax-return': 'comparators.taxReturn',
  'tax-return-italia': 'taxReturn.title.italia',
  'tax-return-svizzera': 'taxReturn.title.svizzera',
  nursery: 'comparators.nursery',
  renovation: 'comparators.renovation',
  fisco: 'nav.fisco',
  pension: 'pension.planner',
  pillar3: 'pension.pillar3',
  quiz: 'guide.tabs.quiz',
  taxCredit: 'taxCredit.title',
  withholdingRates: 'withholdingRates.title',
  guide: 'nav.guida',
  firstDay: 'guide.tabs.firstDay',
  permits: 'guide.tabs.permits',
  border: 'guide.tabs.border',
  unemployment: 'guide.tabs.unemployment',
  carTransfer: 'guide.tabs.carTransfer',
  'car-cost': 'carCost.title',
  'permit-compare': 'permitCompare.title',
  'border-map': 'comparators.borderMap',
  vita: 'nav.vita',
  livingCH: 'guide.tabs.livingCH',
  livingIT: 'guide.tabs.livingIT',
  companies: 'guide.tabs.companies',
  schools: 'guide.tabs.schools',
  places: 'guide.tabs.places',
  municipalities: 'guide.tabs.municipalities',
  calendar: 'guide.tabs.calendar',
  holidays: 'guide.tabs.holidays',
  morning: 'guide.tabs.morning',
  ristorni: 'guide.tabs.ristorni',
  stats: 'nav.stats',
  livability: 'livability.title',
  jobsObservatory: 'stats.tabJobsObservatory',
  salaryCompare: 'salaryCompare.title',
  trafficHistory: 'stats.trafficHistory',
  unemploymentStats: 'stats.tabUnemployment',
  mortgageComparison: 'stats.tabMortgage',
  fuelPrices: 'stats.tabFuelPrices',
  healthPremiums: 'stats.tabHealthPremiums',
  blog: 'nav.blog',
  glossario: 'glossary.title',
  faq: 'faq.title',
  dialetto: 'dialect.title',
  sitemap: 'sitemap.title',
  contracts: 'contracts.title',
  'tfr-calculator': 'tfr.title',
  'permit-quiz': 'permitQuiz.title',
  'tredicesima': 'tredicesima.title',
  'weekly-digest': 'weeklyDigest.title',
  'tool-of-week': 'toolOfWeek.title',
  feedback: 'footer.improveTitle',
  contact: 'contact.title',
  consulting: 'consulting.title',
  partners: 'partners.title',
  forum: 'forum.title',
  jobboard: 'jobBoard.title',
  dashboard: 'profile.title',
  gamification: 'gamification.title',
  privacy: 'consent.privacyLink',
};

const SEO_SECTION_DESCRIPTION_KEY_MAP: Record<string, string> = {
  calculator: 'app.subtitle',
  payslip: 'payslip.subtitle',
  'permit-compare': 'permitCompare.subtitle',
  residency: 'residency.subtitle',
  carTransfer: 'carTransfer.subtitle',
  'car-cost': 'carCost.subtitle',
  salaryCompare: 'salaryCompare.subtitle',
  livability: 'livability.subtitle',
  jobsObservatory: 'stats.jobsObservatory.subtitle',
  fuelPrices: 'fuelPrices.subtitle',
  healthPremiums: 'healthPremiums.subtitle',
  taxCredit: 'taxCredit.subtitle',
  withholdingRates: 'withholdingRates.subtitle',
  jobboard: 'jobBoard.subtitle',
  contact: 'contact.subtitle',
  consulting: 'consulting.subtitle',
  partners: 'partners.subtitle',
  holidays: 'holidays.seoDescription',
  health: 'seo.health.description',
  exchange: 'seo.exchange.description',
  traffic: 'seo.traffic.description',
  pension: 'seo.pension.description',
  pillar3: 'seo.pillar3.description',
  permits: 'seo.permits.description',
  'cost-of-living': 'seo.costOfLiving.description',
  'tax-return': 'seo.taxReturn.description',
  banks: 'seo.banks.description',
  mobile: 'seo.mobile.description',
  transport: 'seo.transport.description',
  shopping: 'seo.shopping.description',
  guide: 'seo.guide.description',
  fisco: 'seo.fisco.description',
  stats: 'seo.stats.description',
  vita: 'seo.vita.description',
  blog: 'seo.blog.description',
};

function translateIfExists(key: string | undefined): string | null {
  if (!key) return null;
  const value = t(key);
  return value && value !== key ? value : null;
}

function getLocalizedSeoKeywords(sectionTitle: string, locale: Locale, fallbackKeywords: string): string {
  if (locale === 'it') return fallbackKeywords;
  const normalizedTitle = sectionTitle.toLowerCase();
  if (locale === 'en') {
    return `${normalizedTitle}, cross-border workers ticino, swiss net salary, taxes switzerland italy, frontaliereticino`;
  }
  if (locale === 'de') {
    return `${normalizedTitle}, grenzgaenger tessin, nettolohn schweiz, steuern schweiz italien, frontaliereticino`;
  }
  if (locale === 'fr') {
    return `${normalizedTitle}, frontaliers tessin, salaire net suisse, impots suisse italie, frontaliereticino`;
  }
  return fallbackKeywords;
}

function buildLocalizedSeoFallbackDescription(sectionTitle: string, locale: Locale): string {
  const templates: Record<Locale, string> = {
    it: `${sectionTitle}. Strumenti pratici, dati aggiornati e guide affidabili per frontalieri tra Svizzera e Italia.`,
    en: `${sectionTitle}. Practical tools, updated data and reliable guides for cross-border workers between Switzerland and Italy.`,
    de: `${sectionTitle}. Praktische Tools, aktuelle Daten und verlässliche Ratgeber für Grenzgänger zwischen der Schweiz und Italien.`,
    fr: `${sectionTitle}. Outils pratiques, données à jour et guides fiables pour les frontaliers entre la Suisse et l'Italie.`,
  };
  return templates[locale];
}

function buildLocalizedUnknownSectionTitle(section: string, locale: Locale): string {
  const raw = section
    .replace(/^landing-/, '')
    .replace(/^blog-/, '')
    .replace(/^glossario-/, '')
    .replace(/^valico-/, '')
    .replace(/^jobboard-/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const human = raw ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : section;
  const prefix: Record<Locale, string> = {
    it: 'Pagina',
    en: 'Page',
    de: 'Seite',
    fr: 'Page',
  };
  return `${prefix[locale]} ${human}`;
}

function resolveLocalizedSeoContent(section: string, metadata: SEOMetadata, locale: Locale): {
  title: string;
  description: string;
  keywords: string;
} {
  if (locale === 'it') {
    return {
      title: metadata.title,
      description: metadata.description,
      keywords: metadata.keywords,
    };
  }

  const titleKey = SEO_SECTION_TITLE_KEY_MAP[section];
  const descriptionKey = SEO_SECTION_DESCRIPTION_KEY_MAP[section];
  const localizedTitle = translateIfExists(titleKey);
  const localizedDescription = translateIfExists(descriptionKey);

  if (!localizedTitle && !localizedDescription) {
    const fallbackTitle = buildLocalizedUnknownSectionTitle(section, locale);
    return {
      title: `${fallbackTitle} | Frontaliere Ticino`,
      description: buildLocalizedSeoFallbackDescription(fallbackTitle, locale),
      keywords: getLocalizedSeoKeywords(fallbackTitle, locale, metadata.keywords),
    };
  }

  const title = localizedTitle ? `${localizedTitle} | Frontaliere Ticino` : metadata.title;
  const description = localizedDescription || buildLocalizedSeoFallbackDescription(localizedTitle || metadata.title, locale);
  return {
    title,
    description,
    keywords: getLocalizedSeoKeywords(localizedTitle || metadata.title, locale, metadata.keywords),
  };
}

function getLocalizedSectionLabel(section: string, fallback: string): string {
  const key = SEO_SECTION_TITLE_KEY_MAP[section];
  const localized = translateIfExists(key);
  return localized || fallback;
}

/**
 * Build BreadcrumbList structured data for a given section
 */
function buildBreadcrumbs(section: string, route: AppRoute, locale: Locale, blogTitle?: string): Record<string, any> {
  const crumbs: { name: string; path: string }[] = [
    { name: ({ it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil' } as Record<Locale, string>)[locale] ?? 'Home', path: '/' },
  ];

  if (route.activeTab === 'blog') {
    const blogLabel = ({ it: 'Articoli Frontaliere', en: 'Frontier Articles', de: 'Grenzgaenger Artikel', fr: 'Articles Frontaliers' } as Record<Locale, string>)[locale] ?? 'Articoli Frontaliere';
    const blogPath = buildPath({ activeTab: 'blog' }, locale);
    crumbs.push({ name: blogLabel, path: blogPath });

    if (route.blogArticle) {
      const currentPath = buildPath(route, locale);
      const fallbackTitle = route.blogArticle.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      crumbs.push({ name: blogTitle || fallbackTitle, path: currentPath });
    }

    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": crumbs.map((crumb, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": crumb.name,
        "item": `${BASE_URL}${crumb.path}`,
      })),
    };
  }

  const sectionNames: Record<string, { name: string; path: string; parent?: string }> = {
    calculator: { name: 'Simulatore Fiscale', path: '/' },
    comparatori: { name: 'Comparatori Servizi', path: '/compara-servizi' },
    'comparatori-cambio': { name: 'Cambio Valuta', path: '/compara-servizi/cambio-franco-euro', parent: 'comparatori' },
    'comparatori-assicurazioni': { name: 'Assicurazioni Sanitarie', path: '/compara-servizi/confronta-casse-malati', parent: 'comparatori' },
    'comparatori-trasporti': { name: 'Calcolo Trasporti', path: '/vivere-in-ticino/trasporti-frontalieri', parent: 'vita' },
    'comparatori-operatori': { name: 'Operatori Mobili', path: '/compara-servizi/confronta-operatori-mobili', parent: 'comparatori' },
    'comparatori-banche': { name: 'Confronto Banche', path: '/compara-servizi/confronta-banche', parent: 'comparatori' },
    'comparatori-traffico': { name: 'Traffico Valichi', path: '/statistiche/traffico-dogane', parent: 'comparatori' },
    'comparatori-costo-vita': { name: 'Costo della Vita', path: '/compara-servizi/costo-della-vita', parent: 'comparatori' },
    'comparatori-lavoro': { name: 'Comparatore Lavoro', path: '/compara-servizi/confronta-offerte-lavoro', parent: 'comparatori' },
    'comparatori-spesa': { name: 'Calcolatore Spesa', path: '/compara-servizi/confronta-prezzi-spesa', parent: 'comparatori' },
    exchange: { name: 'Cambio Valuta', path: '/compara-servizi/cambio-franco-euro', parent: 'comparatori' },
    mobile: { name: 'Operatori Mobili', path: '/compara-servizi/confronta-operatori-mobili', parent: 'comparatori' },
    transport: { name: 'Trasporti', path: '/vivere-in-ticino/trasporti-frontalieri', parent: 'vita' },
    health: { name: 'Assicurazioni Sanitarie', path: '/compara-servizi/confronta-casse-malati', parent: 'comparatori' },
    banks: { name: 'Banche', path: '/compara-servizi/confronta-banche', parent: 'comparatori' },
    calcolatore: { name: 'Calcolatore', path: '/calcola-stipendio' },
    traffic: { name: 'Traffico Valichi', path: '/statistiche/traffico-dogane', parent: 'stats' },
    jobs: { name: 'Offerte Lavoro', path: '/compara-servizi/confronta-offerte-lavoro', parent: 'comparatori' },
    shopping: { name: 'Spesa Transfrontaliera', path: '/compara-servizi/confronta-prezzi-spesa', parent: 'comparatori' },
    'cost-of-living': { name: 'Costo della Vita', path: '/compara-servizi/costo-della-vita', parent: 'comparatori' },
    ral: { name: 'Confronto RAL', path: '/calcola-stipendio/confronta-retribuzione-ral', parent: 'calcolatore' },
    'parental-leave': { name: 'Congedo Genitoriale', path: '/calcola-stipendio/verifica-congedo-parentale', parent: 'calcolatore' },
    'border-map': { name: 'Mappa Comuni', path: '/guida-frontaliere/mappa-confine', parent: 'guide' },
    residency: { name: 'Cambio Residenza', path: '/calcola-stipendio/simula-cambio-residenza', parent: 'calcolatore' },
    'tax-return': { name: 'Dichiarazione Redditi', path: '/tasse-e-pensione/dichiarazione-redditi', parent: 'fisco' },
    'tax-return-italia': { name: 'Dichiarazione Redditi Italia', path: '/tasse-e-pensione/dichiarazione-redditi-italia', parent: 'fisco' },
    'tax-return-svizzera': { name: 'Dichiarazione Fiscale Svizzera', path: '/tasse-e-pensione/dichiarazione-redditi-svizzera', parent: 'fisco' },
    nursery: { name: 'Asili Nido', path: '/vivere-in-ticino/confronta-asili-nido', parent: 'vita' },
    bonus: { name: 'Calcolo Bonus', path: '/calcola-stipendio/stima-bonus-frontaliere', parent: 'calcolatore' },
    renovation: { name: 'Bonus Ristrutturazione', path: '/compara-servizi/calcola-bonus-ristrutturazione', parent: 'comparatori' },
    fisco: { name: 'Fisco & Previdenza', path: '/tasse-e-pensione' },
    pension: { name: 'Pianificatore Pensione', path: '/tasse-e-pensione/calcola-previdenza', parent: 'fisco' },
    pillar3: { name: 'Terzo Pilastro', path: '/tasse-e-pensione/simula-terzo-pilastro', parent: 'fisco' },
    guide: { name: 'Guida Frontalieri', path: '/guida-frontaliere' },
    vita: { name: 'Vita in Ticino', path: '/vivere-in-ticino' },
    livingCH: { name: 'Vivere in Svizzera', path: '/vivere-in-ticino/vivere-in-svizzera', parent: 'vita' },
    livingIT: { name: 'Vivere in Italia', path: '/vivere-in-ticino/vivere-in-italia', parent: 'vita' },
    border: { name: 'Valichi Frontiera', path: '/guida-frontaliere/tempi-attesa-dogana', parent: 'guide' },
    calendar: { name: 'Calendario Fiscale', path: '/tasse-e-pensione/scadenze-fiscali', parent: 'fisco' },
    holidays: { name: 'Festività Ticino', path: '/tasse-e-pensione/festivita-ticino', parent: 'fisco' },
    permits: { name: 'Permessi Lavoro', path: '/guida-frontaliere/permessi-di-lavoro', parent: 'guide' },
    companies: { name: 'Aziende Ticino', path: '/vivere-in-ticino/aziende-svizzera-italiana', parent: 'vita' },
    places: { name: 'Posti da Visitare', path: '/vivere-in-ticino/attrazioni-svizzera-italiana', parent: 'vita' },
    schools: { name: 'Scuole Ticino', path: '/vivere-in-ticino/scuole-svizzera-italiana', parent: 'vita' },
    unemployment: { name: 'Disoccupazione', path: '/guida-frontaliere/disoccupazione-transfrontaliera', parent: 'guide' },
    firstDay: { name: 'Primo Giorno', path: '/guida-frontaliere/primo-giorno-lavoro', parent: 'guide' },
    carTransfer: { name: 'Trasferimento Auto', path: '/guida-frontaliere/trasferire-auto-svizzera', parent: 'guide' },
    quiz: { name: 'Quiz Fiscale', path: '/tasse-e-pensione/quiz-fiscale', parent: 'fisco' },
    taxCredit: { name: 'Credito d\'Imposta', path: '/tasse-e-pensione/credito-imposta', parent: 'fisco' },
    withholdingRates: { name: 'Aliquote imposta alla fonte', path: '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026', parent: 'fisco' },
    newFrontierTaxSim: { name: 'Simulazione Tasse Nuovi Frontalieri', path: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri', parent: 'fisco' },
    stats: { name: 'Statistiche', path: '/statistiche' },
    salarySurvey: { name: 'Confronto Stipendi', path: '/statistiche/confronta-stipendi', parent: 'stats' },
    salaryCompare: { name: 'Confronto Stipendi', path: '/statistiche/confronta-stipendi', parent: 'stats' },
    jobsObservatory: { name: 'Osservatorio Stipendi e Lavori', path: '/statistiche/osservatorio-stipendi-lavori-ticino', parent: 'stats' },
    ristorni: { name: 'Ristorni Fiscali', path: '/tasse-e-pensione/ristorni-fiscali', parent: 'fisco' },
    feedback: { name: 'Feedback', path: '/supporto' },
    contact: { name: 'Contattaci', path: '/contattaci' },
    consulting: { name: 'Consulenza', path: '/consulenza' },
    partners: { name: 'Servizi Partner', path: '/servizi-partner' },
    morning: { name: 'Buongiorno Frontaliere', path: '/buongiorno-frontaliere' },
    forum: { name: 'Community', path: '/community' },
    jobboard: { name: 'Lavoro Ticino', path: '/cerca-lavoro-ticino' },
    whatif: { name: 'What If Simulator', path: '/calcola-stipendio/cosa-cambia-se', parent: 'calcolatore' },
    payslip: { name: 'Calcola Busta Paga', path: '/calcola-stipendio/simula-busta-paga', parent: 'calcolatore' },
    'permit-compare': { name: 'Confronto Permessi', path: '/guida-frontaliere/confronta-permesso-g-vs-b', parent: 'guide' },
    'car-cost': { name: 'Costi Auto', path: '/guida-frontaliere/costo-auto-pendolare', parent: 'guide' },
    livability: { name: 'Migliori Comuni', path: '/statistiche/migliori-comuni-frontiera', parent: 'stats' },
    trafficHistory: { name: 'Storico Traffico', path: '/statistiche/storico-traffico-dogane', parent: 'stats' },
    unemploymentStats: { name: 'Disoccupazione Svizzera', path: '/statistiche/disoccupazione-svizzera', parent: 'stats' },
    mortgageComparison: { name: 'Confronto Mutui', path: '/statistiche/confronto-mutui', parent: 'stats' },
    fuelPrices: { name: 'Prezzi Benzina Confine', path: '/statistiche/prezzi-benzina-confine', parent: 'stats' },
    healthPremiums: { name: 'Premi Malattia per Comune', path: '/statistiche/premi-malattia-comuni', parent: 'stats' },
    salaryQuiz: { name: 'Quiz Stipendio', path: '/calcola-stipendio/quanto-guadagneresti-in-svizzera', parent: 'calcolatore' },
    municipalities: { name: 'Comuni di Frontiera', path: '/vivere-in-ticino/comuni-di-frontiera', parent: 'vita' },
    dashboard: { name: 'Dashboard', path: '/profilo' },
    privacy: { name: 'Privacy', path: '/privacy' },
    gamification: { name: 'Gamification', path: '/gamificazione' },
    'api-status': { name: 'Stato API', path: '/stato-api' },
    'data-deletion': { name: 'Eliminazione Dati', path: '/eliminazione-dati' },
    blog: { name: 'Articoli Frontaliere', path: '/articoli-frontaliere' },
    glossario: { name: 'Glossario Frontaliere', path: '/glossario-frontaliere' },
    dialetto: {
      name: locale === 'en'
        ? 'Ticinese Dialect'
        : locale === 'de'
          ? 'Tessiner Dialekt'
          : locale === 'fr'
            ? 'Dialecte tessinois'
            : 'Dialetto Ticinese',
      path: '/dialetto-ticinese',
    },
    contracts: {
      name: locale === 'en'
        ? 'Employment Contracts'
        : locale === 'de'
          ? 'Arbeitsverträge'
          : locale === 'fr'
            ? 'Contrats de travail'
            : 'Contratti di Lavoro',
      path: '/contratti-lavoro-svizzera',
    },
    'tfr-calculator': {
      name: locale === 'en'
        ? 'TFR / Severance Calculator'
        : locale === 'de'
          ? 'TFR / Abfindungsrechner'
          : locale === 'fr'
            ? 'TFR / Calculateur indemnité'
            : 'TFR / Liquidazione',
      path: '/tfr-liquidazione-frontaliere',
    },
    'permit-quiz': {
      name: locale === 'en'
        ? 'Permit B or G Quiz'
        : locale === 'de'
          ? 'Quiz Bewilligung B oder G'
          : locale === 'fr'
            ? 'Quiz Permis B ou G'
            : 'Quiz Permesso B o G',
      path: '/quiz-permesso-b-o-g',
    },
    'tredicesima': {
      name: locale === 'en'
        ? '13th Salary Calculator'
        : locale === 'de'
          ? '13. Monatslohn Rechner'
          : locale === 'fr'
            ? 'Calculateur 13ème salaire'
            : 'Calcolo Tredicesima',
      path: '/calcolo-tredicesima-frontaliere',
    },
    'weekly-digest': {
      name: locale === 'en'
        ? 'Weekly Digest'
        : locale === 'de'
          ? 'Wöchentlicher Bericht'
          : locale === 'fr'
            ? 'Digest Hebdomadaire'
            : 'Digest Settimanale',
      path: '/digest-settimanale',
    },
    'tool-of-week': {
      name: locale === 'en'
        ? 'Tool of the Week'
        : locale === 'de'
          ? 'Werkzeug der Woche'
          : locale === 'fr'
            ? 'Outil de la Semaine'
            : 'Strumento della Settimana',
      path: '/strumento-della-settimana',
    },
    'blog-stipendio-netto-2026': { name: 'Stipendio Netto 2026', path: '/articoli-frontaliere/stipendio-netto-frontaliere-2026', parent: 'blog' },
    'blog-nuovo-accordo-fiscale': { name: 'Nuovo Accordo Fiscale', path: '/articoli-frontaliere/nuovo-accordo-fiscale-2024', parent: 'blog' },
    'blog-lamal-vs-cmi': { name: 'LAMal vs CMI', path: '/articoli-frontaliere/lamal-vs-cmi-frontaliere', parent: 'blog' },
    'blog-primo-giorno-frontaliere': { name: 'Primo Giorno', path: '/articoli-frontaliere/primo-giorno-lavoro-svizzera', parent: 'blog' },
    'blog-tredicesima-frontaliere': { name: 'Tredicesima Netta', path: '/articoli-frontaliere/tredicesima-netta-frontaliere', parent: 'blog' },
    'blog-pilastro-3a-frontaliere': { name: 'Terzo Pilastro 3a', path: '/articoli-frontaliere/terzo-pilastro-3a-frontaliere', parent: 'blog' },
    'blog-comuni-migliori-frontalieri': { name: 'Migliori Comuni', path: '/articoli-frontaliere/migliori-comuni-frontalieri', parent: 'blog' },
    'blog-costo-vita-ticino-vs-lombardia': { name: 'Costo Vita', path: '/articoli-frontaliere/costo-vita-ticino-vs-lombardia', parent: 'blog' },
    'blog-tassa-salute-tensioni-ticino': { name: 'Tassa Salute', path: '/articoli-frontaliere/tassa-salute-aumentano-tensioni-ticino', parent: 'blog' },
    'blog-casa-oltre-confine-ticino': { name: 'Casa oltre Confine', path: '/articoli-frontaliere/comprare-casa-italia-confine-ticino', parent: 'blog' },
    'blog-franco-forte-stipendio-frontalieri': { name: 'Franco Forte Stipendio', path: '/articoli-frontaliere/franco-forte-effetti-stipendio-frontalieri', parent: 'blog' },
    'blog-cu-2026-novita-frontalieri': { name: 'CU 2026', path: '/articoli-frontaliere/cu-2026-scadenze-telelavoro-frontalieri', parent: 'blog' },
    'blog-telelavoro-italia-svizzera-ratifica': { name: 'Telelavoro Italia-Svizzera', path: '/articoli-frontaliere/telelavoro-italia-svizzera-ratifica', parent: 'blog' },
    'blog-telelavoro-accordo-definitivo-italia': { name: 'Accordo Telelavoro', path: '/articoli-frontaliere/telelavoro-frontalieri-accordo-italia-svizzera-ratifica-definitiva', parent: 'blog' },
    'blog-stop-ristorni-tassa-salute': { name: 'Stop Ristorni Tassa Salute', path: '/articoli-frontaliere/tassa-salute-ticino-chiede-stop-ristorni-italia', parent: 'blog' },
    'blog-cu-telelavoro-regole-frontalieri': { name: 'Regole Telelavoro e CU', path: '/articoli-frontaliere/frontalieri-cu-2026-telelavoro-45-giorni-regole-definitive', parent: 'blog' },
    'blog-smood-chiusura-impatto-lavoro': { name: 'Chiusura Smood', path: '/articoli-frontaliere/smood-chiude-attivita-ticino-impatto-lavoro-frontalieri', parent: 'blog' },
    'blog-disoccupazione-svizzera-ticino-gennaio': { name: 'Dati Disoccupazione Gennaio', path: '/articoli-frontaliere/disoccupazione-svizzera-gennaio-2026-dati-ticino-frontalieri', parent: 'blog' },
    'blog-riscaldamento-casa-ticino-norme': { name: 'Casa e Risparmio', path: '/articoli-frontaliere/riscaldamento-casa-ticino-norme-energetiche-risparmio', parent: 'blog' },
    'blog-sostituzione-caldaia-ticino-2026': { name: 'Norme Riscaldamento 2026', path: '/articoli-frontaliere/sostituzione-caldaia-ticino-norme-2026-risparmio', parent: 'blog' },
    'blog-hic-sunt-leones-confini-ticino': { name: 'Mostra Confini Svizzeri', path: '/articoli-frontaliere/mostra-hic-sunt-leones-confini-svizzera-frontalieri', parent: 'blog' },
    'blog-carnevale-bambini-lugano-2026': { name: 'Carnevale Bambini Lugano', path: '/articoli-frontaliere/carnevale-2026-lugano-laboratori-creativi-figli-frontalieri', parent: 'blog' },
    'blog-arte-anima-ticino-frontalieri': { name: 'Arte e Cultura Ticino', path: '/articoli-frontaliere/mostra-arte-ticino-sentimento-osservazione-lac-lugano', parent: 'blog' },
    'blog-arca-russa-chiasso-cultura-frontaliere': { name: 'Cultura a Chiasso', path: '/articoli-frontaliere/arca-russa-chiasso-evento-culturale-frontalieri', parent: 'blog' },
    'blog-rsi-mostra-storia-ticino': { name: 'Mostra RSI Ticino', path: '/articoli-frontaliere/mostra-rsi-storia-ticino-frontalieri', parent: 'blog' },
    'blog-carnevale-bambini-lugano-tinguely': { name: 'Carnevale Bambini Lugano', path: '/articoli-frontaliere/vacanze-carnevale-bambini-ticino-laboratori-museo-erba-lugano', parent: 'blog' },
    'blog-daniela-rebuzzi-mostra-caslano': { name: 'Mostra Rebuzzi Caslano', path: '/articoli-frontaliere/mostra-daniela-rebuzzi-caslano-arte-ticino', parent: 'blog' },
    'blog-corpi-in-prestito-arte-agno': { name: 'Mostra "Corpi in Prestito"', path: '/articoli-frontaliere/mostra-arte-corpi-in-prestito-agno-ticino', parent: 'blog' },
    'blog-rsi-storia-svizzera-italiana-mostra': { name: 'Mostra RSI Airolo', path: '/articoli-frontaliere/rsi-mostra-storia-svizzera-italiana-foto-archivio-airolo', parent: 'blog' },
    'blog-rauschenberg-arte-mendrisiotto': { name: 'Mostra Rauschenberg Bruzella', path: '/articoli-frontaliere/mostra-rauschenberg-bruzella-mendrisiotto-arte-gratuita-frontalieri', parent: 'blog' },
    'blog-nakba-mostra-giubiasco-ticino': { name: 'Mostra Nakba Giubiasco', path: '/articoli-frontaliere/mostra-nakba-giubiasco-riflessione-culturale-ticino', parent: 'blog' },
    'blog-de-andre-anime-salve-locarno': { name: 'De André a Locarno', path: '/articoli-frontaliere/de-andre-a-locarno-conferenza-anime-salve-per-frontalieri', parent: 'blog' },
    'blog-sentimento-osservazione-masi-lugano': { name: 'Mostra MASI Lugano', path: '/articoli-frontaliere/masi-lugano-mostra-sentimento-osservazione-identita-ticino', parent: 'blog' },
    'blog-rsi-archivio-gottardo-2026': { name: 'Mostra RSI Airolo', path: '/articoli-frontaliere/rsi-mostra-una-storia-ticino-archivio-fotografico-airolo', parent: 'blog' },
    'blog-carnevale-blenio-chiescia-bosc': { name: 'Carnevale Chièscia Bòsc', path: '/articoli-frontaliere/carnevale-chiescia-bosc-2026-ludiano-valle-blenio', parent: 'blog' },
    'blog-tf-permesso-integrazione-ticino': { name: 'Permesso B e Integrazione', path: '/articoli-frontaliere/permesso-b-integrazione-tribunale-federale-ticino', parent: 'blog' },
    'blog-tassazione-individuale-lavoro-ticino': { name: 'Tassazione e Lavoro', path: '/articoli-frontaliere/tassazione-individuale-svizzera-impatto-lavoro-ticino-frontalieri', parent: 'blog' },
    'blog-ristorni-scontro-gobbi-berna': { name: 'Scontro Ristorni Ticino-Berna', path: '/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-berna-tassa-salute', parent: 'blog' },
    'blog-pendolarismo-affitto-tempo-ticino': { name: 'Affitto e Pendolarismo', path: '/articoli-frontaliere/pendolarismo-affitto-tempo-dilemma-frontalieri-ticino', parent: 'blog' },
    'blog-centrodestra-stop-ristorni-2026': { name: 'Stop Ristorni Tassa Salute', path: '/articoli-frontaliere/centrodestra-ticino-stop-ristorni-frontalieri-tassa-salute', parent: 'blog' },
    'blog-frontalieri-ticino-dati-q4-2025': { name: 'Dati Lavoro Q4 2025', path: '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025', parent: 'blog' },
    'blog-calo-entrate-irregolari-chiasso': { name: 'Ingressi Irregolari Chiasso', path: '/articoli-frontaliere/calo-entrate-irregolari-migranti-chiasso-ticino', parent: 'blog' },
    'blog-frontalieri-salari-polemica-ticino': { name: 'Polemica Salari Ticino', path: '/articoli-frontaliere/frontalieri-stipendi-ticino-polemica-crescente', parent: 'blog' },
    'blog-ristorni-frontalieri-scontro-ticino-lombardia': { name: 'Scontro Ristorni', path: '/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-lombardia-tassa-salute', parent: 'blog' },
    'blog-tredicesima-avs-iva-contributi': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-aumento-iva-contributi-salariali-frontaliere', parent: 'blog' },
    'blog-tredicesima-avs-finanziamento-misto': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-contributi-iva', parent: 'blog' },
    'blog-tredicesima-avs-finanziamento-scontro': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-scontro-iva-contributi', parent: 'blog' },
    'blog-ristorni-imprese-allarme-ticino': { name: 'Allarme Imprese Ristorni', path: '/articoli-frontaliere/blocco-ristorni-imprese-ticino-allarme-calo-frontalieri', parent: 'blog' },
    'blog-denaro-non-dichiarato-dogana-brogeda': { name: 'Contanti in Dogana', path: '/articoli-frontaliere/denaro-non-dichiarato-dogana-cosa-rischi-frontaliere', parent: 'blog' },
    'blog-frontalieri-salari-dibattito-ticino': { name: 'Salari e Dibattito', path: '/articoli-frontaliere/frontalieri-salari-dibattito-ticino-il-cane-che-si-morde-la-coda', parent: 'blog' },
    'blog-tredicesima-avs-stipendio-iva': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendio-iva', parent: 'blog' },
    'blog-stop-ristorni-mozione-partiti': { name: 'Stop Ristorni Mozione', path: '/articoli-frontaliere/tassa-salute-partiti-ticino-chiedono-stop-ristorni', parent: 'blog' },
    'blog-partiti-ticino-stop-ristorni': { name: 'Stop Ristorni Mozione', path: '/articoli-frontaliere/stop-ristorni-tassa-salute-mozione-politica-ticino', parent: 'blog' },
    'blog-conti-federali-aumento-iva-ticino': { name: 'Conti Federali e IVA', path: '/articoli-frontaliere/conti-federali-2025-aumento-iva-impatto-frontalieri-ticino', parent: 'blog' },
    'blog-tredicesima-avs-stipendi-iva': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri-ticino', parent: 'blog' },
    'blog-ristorni-lombardia-reazione': { name: 'Ristorni e Tassa Salute', path: '/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-tassa-salute', parent: 'blog' },
    'blog-truffa-falso-bancario-ticino': { name: 'Truffa Falso Bancario', path: '/articoli-frontaliere/truffa-falso-bancario-ticino-allarme-polizia', parent: 'blog' },
    'blog-dazi-usa-impatto-ticino': { name: 'Dazi USA e Ticino', path: '/articoli-frontaliere/dazi-usa-10-percento-conseguenze-economia-ticino', parent: 'blog' },
    'blog-sanita-ticino-tagli-orselina': { name: 'Sanità Ticino: posti a rischio', path: '/articoli-frontaliere/sanita-ticino-accordo-varini-hildebrand-8-posti-a-rischio', parent: 'blog' },
    'blog-dumping-salari-architetti-ticino': { name: 'Dumping Salariale Architetti', path: '/articoli-frontaliere/dumping-salariale-ticino-architetti-part-time-fittizi', parent: 'blog' },
    'blog-tredicesima-avs-finanziamento-contributi': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-2026', parent: 'blog' },
    'blog-tredicesima-avs-stipendio-trattenute': { name: '13a AVS e Stipendio', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri', parent: 'blog' },
    'blog-scambio-dati-polizia-ticino': { name: 'Scambio Dati Polizia', path: '/articoli-frontaliere/scambio-dati-polizia-svizzera-impatto-ticino', parent: 'blog' },
    'blog-tredicesima-avs-finanziamento-misto-proposta': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendi-iva', parent: 'blog' },
    'blog-frontalieri-ticino-dati-ingannevoli': { name: 'Dati frontalieri', path: '/articoli-frontaliere/frontalieri-ticino-calo-dati-settori-qualificati', parent: 'blog' },
    'blog-tredicesima-avs-finanziamento-busta-paga': { name: 'Finanziamento 13esima AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-iva-impatto-stipendio', parent: 'blog' },
    'blog-permesso-s-salari-bassi-ticino': { name: 'Permesso S e Salari', path: '/articoli-frontaliere/permesso-s-stipendi-bassi-impatto-lavoro-ticino', parent: 'blog' },
    'blog-ristorni-reazione-lombardia': { name: 'Ristorni: Reazione Lombardia', path: '/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-mozione-ticino', parent: 'blog' },
    'blog-tredicesima-avs-busta-paga-frontaliere': { name: 'Finanziamento 13a AVS', path: '/articoli-frontaliere/tredicesima-avs-finanziamento-contributi-iva-impatto-frontalieri', parent: 'blog' },
    'blog-acqua-mendrisiotto-prezzi-2026': { name: 'Costo Acqua Mendrisiotto', path: '/articoli-frontaliere/costo-acqua-mendrisiotto-aumento-tariffe-2026', parent: 'blog' },
    'blog-cooperazione-giudiziaria-svizzera-italia': { name: 'Cooperazione Giudiziaria', path: '/articoli-frontaliere/cooperazione-giudiziaria-svizzera-italia-impatto-frontalieri-ticino', parent: 'blog' },
    'blog-sanita-locarnese-licenziamenti': { name: 'Licenziamenti Sanità Locarno', path: '/articoli-frontaliere/sanita-locarnese-collaborazione-varini-hildebrand-licenziamenti', parent: 'blog' },
    'blog-legionellosi-ticino-allarme': { name: 'Allarme Legionellosi', path: '/articoli-frontaliere/legionellosi-ticino-tasso-piu-alto-svizzera', parent: 'blog' },
    'blog-prezzi-dinamici-ticino-futuro': { name: 'Prezzi Dinamici', path: '/articoli-frontaliere/prezzi-dinamici-ticino-rivoluzione-o-trappola-per-frontalieri', parent: 'blog' },
    'blog-lugano-manifestazioni-regole-polemica': { name: 'Polemica Manifestazioni Lugano', path: '/articoli-frontaliere/lugano-manifestazioni-polemica-regole-uguali-per-tutti', parent: 'blog' },
    'blog-addizionale-irpef-mappa-comuni': { name: 'Tasse Comunali Frontalieri', path: '/articoli-frontaliere/mappa-addizionale-irpef-comuni-confine-frontalieri-tasse', parent: 'blog' },
    'blog-mappa-fiscale-comuni-frontiera': { name: 'Mappa Addizionale IRPEF', path: '/articoli-frontaliere/addizionale-irpef-comuni-confine-mappa-tasse-frontalieri-2026', parent: 'blog' },
    'blog-maternita-paternita-frontaliere-guida': { name: 'Congedo Genitori', path: '/articoli-frontaliere/maternita-paternita-frontaliere-svizzera-italia-guida-2026', parent: 'blog' },
    'blog-guida-contributi-sociali-svizzera': { name: 'Guida Busta Paga', path: '/articoli-frontaliere/guida-contributi-sociali-svizzeri-busta-paga-frontaliere', parent: 'blog' },
    'blog-costo-vivere-lugano-trasferirsi': { name: 'Costo Vita Lugano 2026', path: '/articoli-frontaliere/quanto-costa-vivere-a-lugano-da-frontaliere-analisi-costi-2026', parent: 'blog' },
    'blog-permesso-g-pro-contro-2026': { name: 'Permesso G: Pro e Contro', path: '/articoli-frontaliere/permesso-g-vantaggi-svantaggi-frontalieri-ticino-2026', parent: 'blog' },
    'blog-calcolo-pensione-avs-inps': { name: 'Pensione Frontalieri AVS/INPS', path: '/articoli-frontaliere/calcolo-pensione-frontaliere-avs-inps-guida-completa', parent: 'blog' },
    'blog-simulazione-fiscale-frontaliere-2026': { name: 'Simulazione Fiscale 2026', path: '/articoli-frontaliere/frontaliere-nuovo-accordo-fiscale-2026-simulazione', parent: 'blog' },
    'blog-lamal-cmi-scelta-frontaliere-2026': { name: 'LAMal vs CMI 2026', path: '/articoli-frontaliere/lamal-o-cmi-frontaliere-quale-conviene-2026', parent: 'blog' },
    'blog-credito-imposta-doppia-tassazione': { name: 'Credito Imposta Frontalieri', path: '/articoli-frontaliere/frontaliere-doppia-imposizione-credito-imposta-come-funziona', parent: 'blog' },
    'blog-costo-reale-auto-frontaliere': { name: 'Costo Auto Pendolare', path: '/articoli-frontaliere/costo-auto-pendolare-frontaliere-ticino-2026', parent: 'blog' },
    'blog-congedo-genitori-frontaliere-ticino': { name: 'Congedo Genitori', path: '/articoli-frontaliere/congedo-parentale-frontaliere-svizzera-italia-guida-2026', parent: 'blog' },
    'blog-costo-pendolare-auto-ticino-2026': { name: 'Costo Auto Frontaliere', path: '/articoli-frontaliere/costo-auto-frontaliere-ticino-guida-completa-2026', parent: 'blog' },
    'blog-guida-dichiarazione-redditi-frontalieri': { name: 'Guida Fiscale 730', path: '/articoli-frontaliere/guida-dichiarazione-redditi-730-frontalieri-ticino', parent: 'blog' },
    'blog-checklist-documenti-lavoro-svizzera': { name: 'Documenti Lavoro Svizzera', path: '/articoli-frontaliere/documenti-necessari-lavoro-svizzera-frontaliere-ticino', parent: 'blog' },
    'blog-asilo-nido-frontaliere-ticino': { name: 'Guida Asili Nido', path: '/articoli-frontaliere/asilo-nido-svizzera-frontaliere-ticino-costi-guida', parent: 'blog' },
    'blog-locarno-stop-residenze-secondarie': { name: 'Stop Seconde Case Locarno', path: '/articoli-frontaliere/locarno-stop-nuove-residenze-secondarie-quota-20', parent: 'blog' },
    'blog-costo-vita-svizzera-mappa': { name: 'Costo Vita Svizzera', path: '/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-ticino', parent: 'blog' },
    'blog-sicurezza-lavoro-audit-suva': { name: 'Sicurezza Lavoro Audit', path: '/articoli-frontaliere/sicurezza-lavoro-svizzera-audit-federale-falle-conflitti-suva', parent: 'blog' },
    'blog-costo-vivere-mappa-comuni': { name: 'Costo Vita Comuni', path: '/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-cari-economici', parent: 'blog' },
    'blog-architetti-sottopagati-ticino': { name: 'Dumping Salari Architetti', path: '/articoli-frontaliere/architetti-sottopagati-ticino-mendrisio-testimonianza', parent: 'blog' },
    'blog-calo-frontalieri-non-tassa-salute': { name: 'Calo Frontalieri Economia', path: '/articoli-frontaliere/calo-frontalieri-ticino-economia-non-tassa-salute', parent: 'blog' },
    'blog-maternita-cassazione-diritti-frontalieri': { name: 'Maternità Frontalieri Cassazione', path: '/articoli-frontaliere/maternita-frontaliere-cassazione-riconosce-indennita-inps', parent: 'blog' },
    'blog-galenica-bichsel-ristrutturazione-lavoro': { name: 'Ristrutturazione Galenica', path: '/articoli-frontaliere/galenica-chiude-bichsel-170-posti-a-rischio-impatto-ticino', parent: 'blog' },
    'blog-dazi-trump-export-ticinese': { name: 'Dazi USA e Impatto Ticino', path: '/articoli-frontaliere/dazi-trump-usa-impatto-export-ticino-lavoro', parent: 'blog' },
    'blog-campione-italia-fine-dissesto': { name: 'Fine dissesto Campione', path: '/articoli-frontaliere/campione-italia-fuori-dissesto-finanziario-nuove-assunzioni', parent: 'blog' },
    'blog-gavetta-tossica-architetti-ticino': { name: 'Sfruttamento Architetti', path: '/articoli-frontaliere/gavetta-tossica-architetti-ticino-denuncia', parent: 'blog' },
    'blog-eurocity-bloccato-caos-pendolari': { name: 'Disagi Treno Eurocity', path: '/articoli-frontaliere/odissea-eurocity-milano-treno-bloccato-galleria-pendolari', parent: 'blog' },
    'blog-sicurezza-lavoro-controlli-svizzera': { name: 'Sicurezza Lavoro', path: '/articoli-frontaliere/sicurezza-lavoro-svizzera-controlli-insufficienti-suva', parent: 'blog' },
    'blog-startup-investimenti-boom-ticino': { name: 'Boom Investimenti Startup', path: '/articoli-frontaliere/startup-svizzera-boom-investimenti-ia-opportunita-ticino', parent: 'blog' },
    'blog-long-covid-malattia-professionale': { name: 'Long Covid Professionale', path: '/articoli-frontaliere/long-covid-malattia-professionale-sentenza-tribunale-federale', parent: 'blog' },
    'blog-accordo-ue-svizzera-mercato-interno': { name: 'Accordo UE-Svizzera', path: '/articoli-frontaliere/accordo-ue-svizzera-mercato-interno-impatto-frontalieri', parent: 'blog' },
    'blog-fonderie-svizzere-crisi-2025': { name: 'Crisi Fonderie 2025', path: '/articoli-frontaliere/fonderie-svizzere-crisi-produzione-2025-impatto-ticino', parent: 'blog' },
    'blog-salario-minimo-ticino-accordo': { name: 'Accordo Salario Minimo', path: '/articoli-frontaliere/salario-minimo-ticino-accordo-aumento-22-franchi', parent: 'blog' },
    'blog-trasporti-pubblici-crescita-svizzera': { name: 'Trasporti Pubblici Record', path: '/articoli-frontaliere/trasporti-pubblici-svizzera-crescita-fatturato-impatto-frontalieri', parent: 'blog' },
    'blog-cantieri-notturni-lugano-marzo-2026': { name: 'Lavori Notturni Lugano', path: '/articoli-frontaliere/lavori-notturni-lugano-marzo-2026-strade-chiuse', parent: 'blog' },
    'blog-supsi-nuova-direttrice-formazione': { name: 'Nomina SUPSI DFA', path: '/articoli-frontaliere/supsi-daniela-willi-piezzi-direttrice-dipartimento-formazione', parent: 'blog' },
    'blog-bps-suisse-risultati-bper': { name: 'BPS Suisse Risultati 2025', path: '/articoli-frontaliere/bps-suisse-risultati-solidi-2025-impatto-bper-frontalieri', parent: 'blog' },
    'blog-aiuti-energia-proroga-taglio': { name: 'Aiuti Energia Ridotti', path: '/articoli-frontaliere/aiuti-imprese-energetiche-proroga-taglio-fondi', parent: 'blog' },
    'blog-salario-minimo-sociale-ticino-dibattito': { name: 'Salario Minimo Sociale', path: '/articoli-frontaliere/salario-minimo-sociale-ticino-dibattito-frontalieri', parent: 'blog' },
    'blog-bps-suisse-utili-consigli-crisi': { name: 'BPS Suisse Risultati e Consigli', path: '/articoli-frontaliere/bps-suisse-utili-record-consigli-frontalieri', parent: 'blog' },
    'blog-accordo-ue-voto-obbligatorio-ticino': { name: 'Accordo UE Referendum', path: '/articoli-frontaliere/accordo-ue-svizzera-ticino-chiede-referendum-obbligatorio', parent: 'blog' },
    'blog-accordo-ue-svizzera-impatto-frontalieri': { name: 'Accordo Svizzera-UE', path: '/articoli-frontaliere/accordo-svizzera-ue-cosa-cambia-frontalieri-ticino', parent: 'blog' },
    'blog-locarno-stop-case-vacanza': { name: 'Stop Case Secondarie Locarno', path: '/articoli-frontaliere/locarno-stop-licenze-case-secondarie', parent: 'blog' },
    'blog-bilaterali-ue-svizzera-firma': { name: 'Accordi Svizzera-UE', path: '/articoli-frontaliere/accordi-ue-svizzera-firma-vicina-cosa-cambia-frontalieri', parent: 'blog' },
    'blog-aumento-iva-esercito-impatto-spesa': { name: 'Aumento IVA Esercito', path: '/articoli-frontaliere/aumento-iva-svizzera-esercito-impatto-stipendio-frontalieri', parent: 'blog' },
    'blog-maternita-paternita-ticino': { name: 'Congedo parentale', path: '/articoli-frontaliere/maternita-paternita-ticino', parent: 'blog' },
    'blog-referendum-ue-svizzera-ticino': { name: 'Referendum UDC', path: '/articoli-frontaliere/referendum-ue-svizzera-ticino', parent: 'blog' },
    'blog-valposchiavo-turismo-2025': { name: 'Valposchiavo turismo', path: '/articoli-frontaliere/turismo-valposchiavo-2025', parent: 'blog' },
    'blog-frontalieri-economia-ticino': { name: 'Frontalieri in calo', path: '/articoli-frontaliere/frontalieri-economia-ticino', parent: 'blog' },
    'blog-inflazione-frontalieri-ticino': { name: 'Inflazione frontalieri', path: '/articoli-frontaliere/inflazione-frontalieri-ticino', parent: 'blog' },
    'blog-aprire-conto-bancario-frontaliere': { name: 'Conto bancario frontaliere', path: '/articoli-frontaliere/aprire-conto-bancario-frontalieri', parent: 'blog' },
    'blog-ristorni-fiscali-ticino': { name: 'Ristorni fiscali', path: '/articoli-frontaliere/ristorni-fiscali-frontaliere', parent: 'blog' },
    'blog-contributi-sociali-busta-paga': { name: 'Contributi sociali', path: '/articoli-frontaliere/contributi-sociali-busta-paga', parent: 'blog' },
    'blog-strada-incidenti-vezia-cureglia': { name: 'Strada Vezia-Cureglia', path: '/articoli-frontaliere/strada-incidenti-vezia-cureglia', parent: 'blog' },
    'blog-assicurazione-malattia-famiglia': { name: 'Assicurazione malattia', path: '/articoli-frontaliere/assicurazione-malattia-famiglia', parent: 'blog' },
    'blog-calo-frontalieri-ragioni-economiche': { name: 'Frontalieri in calo', path: '/articoli-frontaliere/calo-frontalieri-ticino-economia', parent: 'blog' },
    'blog-frontalieri-calo-economia-ticinese': { name: 'Frontalieri in calo', path: '/articoli-frontaliere/frontalieri-calo-economia-ticinese', parent: 'blog' },
    'blog-usi-startup-centre-ranking': { name: 'USI Startup Centre', path: '/articoli-frontaliere/usi-centro-startup-classifica', parent: 'blog' },
    'blog-sciopero-treni-tilo-febbraio-2026': { name: 'Sciopero in Italia', path: '/articoli-frontaliere/sciopero-treni-tilo-febbraio-2026', parent: 'blog' },
    'blog-piscina-chiasso-copertura-2026': { name: 'Piscina Chiasso', path: '/articoli-frontaliere/piscina-chiasso-copertura', parent: 'blog' },
    'blog-centrale-elettrica-grono-attiva': { name: 'Centrale Grono', path: '/articoli-frontaliere/centrale-elettrica-grono-attiva', parent: 'blog' },
    'blog-naspi-frontaliere-italia-requisiti': { name: 'NASpI frontalieri', path: '/articoli-frontaliere/naspi-frontaliere-italia-requisiti', parent: 'blog' },
    'blog-prelievo-secondo-pilastro-frontaliere': { name: 'Prelievo del secondo pilastro LPP per fr', path: '/articoli-frontaliere/prelievo-secondo-pilastro-frontaliere', parent: 'blog' },
    'blog-accordo-ue-frontalieri-ticino': { name: 'Accordo Svizzera-UE, firma in arrivo per', path: '/articoli-frontaliere/accordo-ue-frontalieri-ticino', parent: 'blog' },
    'blog-ristorni-congelati-ticino-italia': { name: 'Ristorni fiscali', path: '/articoli-frontaliere/ristorni-congelati-ticino-italia', parent: 'blog' },
    'blog-naspi-ex-frontalieri-2026': { name: 'Indennità di disoccupazione NASpI per ex', path: '/articoli-frontaliere/naspi-ex-frontalieri-2026', parent: 'blog' },
    'blog-mutuo-casa-frontalieri-italia': { name: 'Mutuo casa Italia', path: '/articoli-frontaliere/mutuo-casa-frontalieri-italia', parent: 'blog' },
    'blog-piscina-chiasso-investimento': { name: 'Piscina Chiasso', path: '/articoli-frontaliere/piscina-chiasso-investimento', parent: 'blog' },
    'blog-ristorni-congelati-gobbi-2026': { name: 'Ristorni congelati', path: '/articoli-frontaliere/ristorni-congelati-gobbi-2026', parent: 'blog' },
    'blog-asilo-nido-ticino-guida-2026': { name: 'Asili nido Ticino', path: '/articoli-frontaliere/asilo-nido-ticino-guida-2026', parent: 'blog' },
    'blog-ristorni-salute-2026-ticino': { name: 'Ristorni salute', path: '/articoli-frontaliere/ristorni-salute-2026-ticino', parent: 'blog' },
    'blog-tassa-salute-scontro-ticino-berna': { name: 'Crisi Ristorni Ticino', path: '/articoli-frontaliere/tassa-salute-scontro-ticino-berna', parent: 'blog' },
    'blog-piscina-chiasso-rinnovo-sicurezza': { name: 'Piscina Chiasso Sicurezza', path: '/articoli-frontaliere/piscina-chiasso-rinnovo-copertura-sicurezza', parent: 'blog' },
    'blog-disagi-tilo-sciopero-italia': { name: 'Sciopero Tilo', path: '/articoli-frontaliere/sciopero-tilo-italia-disagi-frontalieri', parent: 'blog' },
    'blog-abbonamenti-sconti-treni-ticino': { name: 'Sconti trasporti', path: '/articoli-frontaliere/abbonamenti-sconti-treni-ticino', parent: 'blog' },
    'blog-bonus-famiglia-frontalieri-2026': { name: 'Bonus famiglia', path: '/articoli-frontaliere/bonus-famiglia-frontalieri-2026', parent: 'blog' },
    'blog-smart-working-frontalieri-2026': { name: 'Smart Working 2026', path: '/articoli-frontaliere/smart-working-frontalieri-regole', parent: 'blog' },
    'blog-confronto-assicurazioni-auto': { name: 'Assicurazioni auto', path: '/articoli-frontaliere/confronto-assicurazioni-auto', parent: 'blog' },
    'blog-permesso-b-vs-g-differenze': { name: 'Permesso B e G', path: '/articoli-frontaliere/permesso-b-vs-g-differenze', parent: 'blog' },
    'blog-spese-sanitarie-frontalieri': { name: 'Spese sanitarie', path: '/articoli-frontaliere/spese-sanitarie-frontalieri', parent: 'blog' },
    'blog-naspi-disoccupazione-frontalieri': { name: 'NASpI frontalieri', path: '/articoli-frontaliere/naspi-disoccupazione-frontalieri', parent: 'blog' },
    'blog-dichiarazione-redditi-ticino-2026': { name: 'Dichiarazione Redditi', path: '/articoli-frontaliere/dichiarazione-redditi-ticino-2026', parent: 'blog' },
    'blog-cantieri-traffico-a9-ticino': { name: 'Cantieri A9', path: '/articoli-frontaliere/cantieri-traffico-a9-ticino', parent: 'blog' },
    'blog-migranti-seghezzone-risparmi': { name: 'Migranti Seghezzone', path: '/articoli-frontaliere/migranti-seghezzone-risparmi', parent: 'blog' },
    'blog-cantieri-traffico-frontiera': { name: 'Traffico frontalieri', path: '/articoli-frontaliere/cantieri-traffico-frontiera', parent: 'blog' },
    'blog-salario-minimo-ps-compromesso': { name: 'Salario minimo PS', path: '/articoli-frontaliere/salario-minimo-ps-compromesso', parent: 'blog' },
    'blog-cocaina-lusso-perquisizioni-ticino': { name: 'Traffico Cocaina', path: '/articoli-frontaliere/traffico-cocaina-ticino-lusso', parent: 'blog' },
    'blog-calcolo-tasse-entro-confine': { name: 'Calcolo tasse frontalieri', path: '/articoli-frontaliere/calcolo-tasse-frontalieri-entro-20-km', parent: 'blog' },
    'blog-riforma-giustizia-pace-ticino': { name: 'Riforma Giustizia', path: '/articoli-frontaliere/riforma-giustizia-pace-ticino', parent: 'blog' },
    'blog-cantieri-a9-disagi-frontiera': { name: 'Cantieri A9 e disagi', path: '/articoli-frontaliere/cantieri-a9-disagi-frontiera', parent: 'blog' },
    'blog-revoca-uso-acqua-magliaso': { name: 'Magliaso acqua potabile', path: '/articoli-frontaliere/revoca-uso-acqua-magliaso', parent: 'blog' },
    'blog-malattie-rare-ticino-2026': { name: 'Malattie rare', path: '/articoli-frontaliere/malattie-rare-ticino', parent: 'blog' },
    'blog-frontaliers-sabotage-varese': { name: 'Frontaliers Sabotage', path: '/articoli-frontaliere/frontaliers-sabotage-varese', parent: 'blog' },
    'blog-ristorni-congelati-scontro-ticino': { name: 'Ristorni congelati', path: '/articoli-frontaliere/ristorni-congelati-scontro-ticino', parent: 'blog' },
    'blog-tassazione-individuale-lavoro-donne': { name: 'Tassazione individuale', path: '/articoli-frontaliere/tassazione-individuale-donne-lavoro', parent: 'blog' },
    'blog-diversita-religiosa-ticino-2026': { name: 'Pluralismo religioso', path: '/articoli-frontaliere/diversita-religiosa-ticino', parent: 'blog' },
    'blog-voto-corrispondenza-ticino-2026': { name: 'Voto corrispondenza Ticino', path: '/articoli-frontaliere/voto-corrispondenza-ticino-2026', parent: 'blog' },
    'blog-cantiere-viale-geno-como': { name: 'Lavori a Viale Geno', path: '/articoli-frontaliere/cantiere-viale-geno-rischi', parent: 'blog' },
    'blog-controlli-velocita-ticino-2026': { name: 'Controlli velocità', path: '/articoli-frontaliere/controlli-velocita-ticino-2026', parent: 'blog' },
    'blog-sanremo-2026-aiello-gassmann': { name: 'Sanremo 2026', path: '/articoli-frontaliere/sanremo-2026-aiello-gassmann', parent: 'blog' },
    'blog-violenza-adolescenti-ticino': { name: 'Violenza giovanile', path: '/articoli-frontaliere/violenza-adolescenti-ticino', parent: 'blog' },
    'blog-comuni-frontalieri-distanza': { name: 'Comuni frontalieri', path: '/articoli-frontaliere/comuni-frontalieri-distanza', parent: 'blog' },
    'blog-elezioni-comunali-ticino': { name: 'Elezioni Comunali', path: '/articoli-frontaliere/elezioni-comunali-ticino', parent: 'blog' },
    'blog-eroina-auto-chiasso-brogeda': { name: 'Eroina a Brogeda', path: '/articoli-frontaliere/eroina-auto-chiasso-brogeda', parent: 'blog' },
    'blog-olio-chimica-produzione': { name: 'Olio e chimica', path: '/articoli-frontaliere/olio-chimica-produzione-ticino', parent: 'blog' },
    'blog-incidente-mortale-frontaliere': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/incidente-mortale-frontaliere', parent: 'blog' },
    'blog-svizzera-mediazione-iran-2026': { name: 'Svizzera e Iran', path: '/articoli-frontaliere/svizzera-dovrebbe-rinunciare-mediazione', parent: 'blog' },
    'blog-sanremo-frontalieri-impatti': { name: 'Sanremo e frontalieri', path: '/articoli-frontaliere/sanremo-frontalieri-impatti', parent: 'blog' },
    'blog-lavorare-germania-educatori': { name: 'Educatori Germania', path: '/articoli-frontaliere/lavorare-germania-educatori', parent: 'blog' },
    'blog-porto-ceresio-lungolago-lavori': { name: 'Porto Ceresio lavori', path: '/articoli-frontaliere/porto-ceresio-lungolago-lavori', parent: 'blog' },
    'blog-casa-hockey-ticino-2026': { name: 'Casa dell\'Hockey', path: '/articoli-frontaliere/casa-hockey-ticino', parent: 'blog' },
    'blog-tassazione-individuale-svizzera': { name: 'Tassazione individuale', path: '/articoli-frontaliere/tassazione-individuale-svizzera', parent: 'blog' },
    'blog-cinema-frontaliers-ticino-varese': { name: 'Frontaliers Sabotage', path: '/articoli-frontaliere/film-frontaliers-sabotage-varese', parent: 'blog' },
    'blog-minimo-salariale-ticino-accordo-ps': { name: 'Salario Minimo Ticino', path: '/articoli-frontaliere/salario-minimo-ticino-accordo-ps', parent: 'blog' },
    'blog-chiasso-fede-adulti-integrazione': { name: 'Fede a Chiasso', path: '/articoli-frontaliere/chiasso-fede-adulti-integrazione', parent: 'blog' },
    'blog-sicurezza-confine-ticino-brogeda': { name: 'Controlli al Confine', path: '/articoli-frontaliere/sicurezza-confine-ticino-brogeda', parent: 'blog' },
    'blog-stipendi-manager-energia-ticino': { name: 'Salari Energia Ticino', path: '/articoli-frontaliere/stipendi-manager-energia-ticino', parent: 'blog' },
    'blog-lavoro-educatori-germania-alternativa': { name: 'Educatori Germania', path: '/articoli-frontaliere/lavoro-educatori-germania-alternativa-frontalieri', parent: 'blog' },
    'blog-gandria-lusso-immobiliare-ticino': { name: 'Gandria Lusso Immobiliare', path: '/articoli-frontaliere/gandria-lusso-immobiliare-ticino', parent: 'blog' },
    'blog-vandalismo-bus-frontalieri-ticino': { name: 'Vandalismo sui bus', path: '/articoli-frontaliere/vandalismo-bus-ticino-frontalieri', parent: 'blog' },
    'blog-ticino-voto-anti-dumping': { name: 'Voto Anti-Dumping', path: '/articoli-frontaliere/ticino-voto-anti-dumping-salariale', parent: 'blog' },
    'blog-controlli-stradali-ticino-frontalieri': { name: 'Controlli Velocità', path: '/articoli-frontaliere/controlli-stradali-ticino-frontalieri-marzo-2026', parent: 'blog' },
    'blog-comuni-confine-nuove-regole': { name: 'Comuni di Confine', path: '/articoli-frontaliere/comuni-confine-nuove-regole-fiscali', parent: 'blog' },
    'blog-tragedia-stradale-frontaliere': { name: 'Tragedia sul confine', path: '/articoli-frontaliere/tragedia-stradale-frontaliere-porlezza', parent: 'blog' },
    'blog-chiasso-como-cantieri-a9-disagi': { name: 'Chiusure A9 Confine', path: '/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri', parent: 'blog' },
    'blog-chiasso-comunita-evoluzione-sociale': { name: 'Fede a Chiasso', path: '/articoli-frontaliere/chiasso-comunita-evoluzione-sociale', parent: 'blog' },
    'blog-tragedia-pendolare-ticino': { name: 'Tragedia Porletta', path: '/articoli-frontaliere/tragedia-pendolare-frontaliere-porletta', parent: 'blog' },
    'blog-a9-como-chiasso-disagi-notturni': { name: 'Disagi A9 Confine', path: '/articoli-frontaliere/a9-como-chiasso-disagi-notturni-frontiera', parent: 'blog' },
    'blog-economia-svizzera-ripresa-2026': { name: 'Economia Svizzera', path: '/articoli-frontaliere/economia-svizzera-ripresa-2026', parent: 'blog' },
    'blog-confine-fiscale-nuovi-comuni': { name: 'Comuni di Confine', path: '/articoli-frontaliere/frontalieri-nuova-mappa-fiscale-comuni-confine', parent: 'blog' },
    'blog-confine-a9-disagi-marzo': { name: 'Chiusure A9 Marzo', path: '/articoli-frontaliere/chiusure-notturne-a9-chiasso-como-marzo-frontalieri', parent: 'blog' },
    'blog-autostrada-a9-disagi-frontalieri': { name: 'A9 Chiasso-Como', path: '/articoli-frontaliere/chiusura-notturna-a9-chiasso-como-frontalieri', parent: 'blog' },
    'blog-chiusure-a9-trasporti-speciali': { name: 'Chiusure A9', path: '/articoli-frontaliere/chiusure-a9-trasporti-speciali-como-chiasso', parent: 'blog' },
    'blog-iniziativa-salari-ticino': { name: 'Iniziativa salari Ticino', path: '/articoli-frontaliere/iniziativa-salari-ticino-voto-anti-dumping', parent: 'blog' },
    'blog-salari-ticino-voto-frontalieri': { name: 'Voto Anti-Dumping Ticino', path: '/articoli-frontaliere/dumping-salariale-ticino-voto-frontalieri', parent: 'blog' },
    'blog-lutto-porlezza-frontaliere': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/scontro-fatale-porlezza-frontaliere', parent: 'blog' },
    'blog-frontalieri-confine-disparita-fiscale': { name: 'Comuni Confine', path: '/articoli-frontaliere/frontalieri-confine-disparita-fiscale', parent: 'blog' },
    'blog-iniziativa-anti-dumping-voto': { name: 'Voto Anti-dumping', path: '/articoli-frontaliere/iniziativa-anti-dumping-salari-ticino-voto', parent: 'blog' },
    'blog-nestle-bonus-lombardia-welfare': { name: 'Bonus Nestlé', path: '/articoli-frontaliere/nestle-bonus-lombardia-welfare-frontalieri', parent: 'blog' },
    'blog-frontiera-a9-disagi-marzo-2026': { name: 'Disagi A9 Frontiera', path: '/articoli-frontaliere/a9-chiasso-como-chiusure-notturne-cantieri', parent: 'blog' },
    'blog-mercato-lavoro-ticino-frena-2025': { name: 'Lavoro Ticino 2025', path: '/articoli-frontaliere/mercato-lavoro-ticino-rallenta-2025', parent: 'blog' },
    'blog-confini-comunali-impatto-fiscale': { name: 'Comuni Confine', path: '/articoli-frontaliere/comuni-frontiera-nuove-regole-fiscali', parent: 'blog' },
    'blog-franco-forte-impatto-frontalieri': { name: 'Franco Forte', path: '/articoli-frontaliere/franco-forte-impatto-frontalieri', parent: 'blog' },
    'blog-incidente-giovane-frontaliere': { name: 'Incidente Porletta', path: '/articoli-frontaliere/tragedia-frontaliere-porlezza-via-ceresio', parent: 'blog' },
    'blog-a9-chiasso-como-cantieri-frontalieri': { name: 'Cantieri A9', path: '/articoli-frontaliere/chiusure-notturne-a9-frontalieri', parent: 'blog' },
    'blog-salario-minimo-compromesso-ticino': { name: 'Salario Minimo Ticino', path: '/articoli-frontaliere/salario-minimo-compromesso-ps-ticino', parent: 'blog' },
    'blog-compromesso-salario-minimo-condizioni': { name: 'Salario Minimo Compromesso', path: '/articoli-frontaliere/compromesso-salario-minimo-condizioni', parent: 'blog' },
    'blog-chiasso-comunita-cambiamento-valori': { name: 'Chiasso: Nuovi Valori', path: '/articoli-frontaliere/chiasso-comunita-cambiamento-valori', parent: 'blog' },
    'blog-pendolarismo-fatale-frontaliere-porlezza': { name: 'Incidente Porlezza', path: '/articoli-frontaliere/pendolarismo-fatale-frontaliere-porlezza', parent: 'blog' },
    'blog-salario-minimo-ticino-trattative': { name: 'Salario Minimo', path: '/articoli-frontaliere/salario-minimo-ticino-trattative-compromesso', parent: 'blog' },
    'blog-trevano-campus-riqualifica': { name: 'Trevano Riqualifica', path: '/articoli-frontaliere/trevano-campus-riqualifica-12-milioni-lavori', parent: 'blog' },
    'blog-lavena-sagrato-nuovo-investimento': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-nuovo-sagrato-chiesa', parent: 'blog' },
    'blog-sportello-lavoro-varese-frontalieri-ticino': { name: 'Sportello Lavoro Varese', path: '/articoli-frontaliere/sportello-lavoro-varese-frontalieri-ticino', parent: 'blog' },
    'blog-controlli-stradali-intensivi-frontiera': { name: 'Radar confine', path: '/articoli-frontaliere/controlli-stradali-intensivi-frontiera-ticino', parent: 'blog' },
    'blog-radar-confine-ticino-marzo': { name: 'Radar al Confine', path: '/articoli-frontaliere/settimana-di-controlli-radar-intensivi-confine-ticino-marzo', parent: 'blog' },
    'blog-controlli-frontiera-ticino-rafforzati': { name: 'Controlli Frontiera', path: '/articoli-frontaliere/controlli-frontiera-ticino-rafforzati', parent: 'blog' },
    'blog-lavori-risanamento-a13-cadenazzo-2026': { name: 'Lavori A13', path: '/articoli-frontaliere/lavori-risanamento-a13-cadenazzo-2026', parent: 'blog' },
    'blog-salario-minimo-ticino-intesa-storica': { name: 'Salario Minimo Accordo', path: '/articoli-frontaliere/salario-minimo-ticino-intesa-storica', parent: 'blog' },
    'blog-sicurezza-stradale-ticino-marzo': { name: 'Radar Mobili Ticino', path: '/articoli-frontaliere/sicurezza-stradale-ticino-marzo', parent: 'blog' },
    'blog-a13-cantieri-frontalieri-ticino': { name: 'Cantieri A13', path: '/articoli-frontaliere/a13-cantieri-frontalieri-ticino', parent: 'blog' },
    'blog-bns-utile-calo-2025-impatto-ticino': { name: 'BNS utile 2025', path: '/articoli-frontaliere/bns-utile-calo-2025-impatto-ticino', parent: 'blog' },
    'blog-polizia-cantonale-nuovi-gendarmi': { name: 'Nuovi Gendarmi', path: '/articoli-frontaliere/polizia-cantonale-nuovi-gendarmi', parent: 'blog' },
    'blog-competenze-tecniche-frontalieri-ticino': { name: 'Competenze Tecniche', path: '/articoli-frontaliere/competenze-tecniche-frontalieri-ticino', parent: 'blog' },
    'blog-polizia-cantonale-reclutamento-2026': { name: 'Scuola Polizia Ticino', path: '/articoli-frontaliere/polizia-cantonale-reclutamento-2026', parent: 'blog' },
    'blog-mercato-auto-febbraio-2026': { name: 'Mercato Auto', path: '/articoli-frontaliere/mercato-auto-febbraio-2026', parent: 'blog' },
    'blog-como-nuovi-poliziotti-2026': { name: 'Nuovi poliziotti Como', path: '/articoli-frontaliere/como-nuovi-poliziotti-2026', parent: 'blog' },
    'blog-sesto-calende-sicurezza-frontalieri': { name: 'Sicurezza Sesto Calende', path: '/articoli-frontaliere/sesto-calende-sicurezza-frontalieri', parent: 'blog' },
    'blog-nessun-prelievo-avs-sulle-mance': { name: 'Novità Mance', path: '/articoli-frontaliere/nessun-prelievo-avs-sulle-mance', parent: 'blog' },
    'blog-imposizione-individuale-donne-ticino': { name: 'Imposizione Individuale', path: '/articoli-frontaliere/imposizione-individuale-donne-ticino', parent: 'blog' },
    'blog-docenti-frontalieri-permesso-lavoro': { name: 'Docenti frontalieri', path: '/articoli-frontaliere/docenti-frontalieri-permesso-lavoro', parent: 'blog' },
    'blog-iniziativa-anti-dumping-ticino-2026': { name: 'Iniziativa Anti-Dumping', path: '/articoli-frontaliere/iniziativa-anti-dumping-ticino-2026', parent: 'blog' },
    'blog-comuni-confine-fiscalita-disparita': { name: 'Fiscalità Frontalieri', path: '/articoli-frontaliere/comuni-confine-fiscalita-disparita', parent: 'blog' },
    'blog-svizzera-ue-pacchetto-accordi': { name: 'Accordi Svizzera-UE', path: '/articoli-frontaliere/svizzera-ue-pacchetto-accordi', parent: 'blog' },
    'blog-tassa-salute-berna-ticino': { name: 'Tassa Salute Ticino', path: '/articoli-frontaliere/tassa-salute-berna-ticino', parent: 'blog' },
    'blog-ai-lombardia-impatto-ticino': { name: 'AI e Frontalieri', path: '/articoli-frontaliere/ai-lombardia-impatto-ticino', parent: 'blog' },
    'blog-crisi-golfo-carburanti-ticino': { name: 'Crisi Golfo Ticino', path: '/articoli-frontaliere/crisi-golfo-carburanti-ticino', parent: 'blog' },
    'blog-rincari-benzina-frontalieri-ticino': { name: 'Rincari benzina Ticino', path: '/articoli-frontaliere/rincari-benzina-frontalieri-ticino', parent: 'blog' },

    'blog-crisi-olio-prezzi-benzina-ticino': { name: 'Crisi benzina Ticino', path: '/articoli-frontaliere/crisi-olio-prezzi-benzina-ticino', parent: 'blog' },

    'blog-benzina-ticino-oriente': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/benzina-ticino-oriente', parent: 'blog' },

    'blog-ai-lombardia-ticino-frontaliere-2026': { name: 'AI Lombardia-Ticino', path: '/articoli-frontaliere/ai-lombardia-ticino-frontaliere-2026', parent: 'blog' },
    'blog-carpooling-ticino-corsie-frontaliere-2026': { name: 'Carpooling Ticino', path: '/articoli-frontaliere/carpooling-ticino-corsie-frontaliere-2026', parent: 'blog' },
    'blog-kuhne-nagel-tagli-posti-ticino-2026': { name: 'Tagli Kühne+Nagel', path: '/articoli-frontaliere/kuhne-nagel-tagli-posti-ticino-2026', parent: 'blog' },
    'blog-vini-ticinesi-collaborazione': { name: 'Vini ticinesi', path: '/articoli-frontaliere/vini-ticinesi-collaborazione', parent: 'blog' },
    'blog-hockey-chiasso-wild-boars-bis': { name: 'Hockey Chiasso', path: '/articoli-frontaliere/hockey-chiasso-wild-boars-bis', parent: 'blog' },
    'blog-svincolo-a2-biasca-rischi-frontaliere': { name: 'Sicurezza viaria Ticino', path: '/articoli-frontaliere/svincolo-a2-biasca-rischi-frontaliere', parent: 'blog' },
    'blog-accordi-svizzera-ue-parmelin-bruxelles': { name: 'Accordi Svizzera-UE', path: '/articoli-frontaliere/accordi-svizzera-ue-parmelin-bruxelles', parent: 'blog' },
    'blog-lavori-linea-locarno-cadenazzo-2026': { name: 'Lavori ferrovia Ticino', path: '/articoli-frontaliere/lavori-linea-locarno-cadenazzo-2026', parent: 'blog' },
    'blog-spirit-varesini-valico-tassa-2026': { name: 'Novità Tassazione', path: '/articoli-frontaliere/spirit-varesini-valico-tassa-2026', parent: 'blog' },
    'blog-borse-in-rosso-prezzo-petrolio-ticino': { name: 'Economia Borse Petrolio', path: '/articoli-frontaliere/borse-in-rosso-prezzo-petrolio-ticino', parent: 'blog' },
    'blog-frontaliers-sabotage-varese-successo': { name: 'Cinema frontalieri', path: '/articoli-frontaliere/frontaliers-sabotage-varese-successo', parent: 'blog' },
    'blog-disoccupazione-svizzera-2026': { name: 'Disoccupazione in Svizzera', path: '/articoli-frontaliere/disoccupazione-svizzera-2026', parent: 'blog' },
    'blog-infermieri-svizzera-frontalieri-ticino': { name: 'Lavoro frontaliero Ticino', path: '/articoli-frontaliere/infermieri-svizzera-frontalieri-ticino', parent: 'blog' },
    'blog-successo-farmaceutica-ticino': { name: 'Novità economiche', path: '/articoli-frontaliere/successo-farmaceutica-ticino', parent: 'blog' },
    'blog-utile-bns-2025-ticino': { name: 'Utile BNS 2025', path: '/articoli-frontaliere/utile-bns-2025-ticino', parent: 'blog' },
    'blog-banche-ticino-disoccupazione': { name: 'Novità lavoro', path: '/articoli-frontaliere/banche-ticino-disoccupazione', parent: 'blog' },
    'blog-medio-vedeggio-gruppo-lavoro-aggregazione': { name: 'Medio Vedeggio', path: '/articoli-frontaliere/medio-vedeggio-gruppo-lavoro-aggregazione', parent: 'blog' },
    'blog-lugano-airport-fondi-salvati-2026': { name: 'Lugano Airport', path: '/articoli-frontaliere/lugano-airport-fondi-salvati-2026', parent: 'blog' },
    'blog-made-in-italy-doganali-ticino-2026': { name: 'Made in Italy Dogane', path: '/articoli-frontaliere/made-in-italy-doganali-ticino-2026', parent: 'blog' },
    'blog-mercato-lavoro-ticino-q4-2025': { name: 'Mercato lavoro', path: '/articoli-frontaliere/mercato-lavoro-ticino-q4-2025', parent: 'blog' },
    'blog-dichiarazione-imposta-digitale-ticino-26': { name: 'Imposte Ticino', path: '/articoli-frontaliere/dichiarazione-imposta-digitale-ticino-26', parent: 'blog' },
    'blog-tilo-25-milioni-passeggeri-2025': { name: 'TILO 2025', path: '/articoli-frontaliere/tilo-25-milioni-passeggeri-2025', parent: 'blog' },
    'blog-tassa-salute-lombardia-rinvio': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-lombardia-rinvio', parent: 'blog' },
    'blog-tilo-record-passeggeri-2025': { name: 'Notizie TILO', path: '/articoli-frontaliere/tilo-record-passeggeri-2025', parent: 'blog' },
    'blog-frontalieri-tassa-salute-piemonte': { name: 'Frontalieri e Tassa Salute', path: '/articoli-frontaliere/frontalieri-tassa-salute-piemonte', parent: 'blog' },
    'blog-trasporti-lombardia-ticino-record-tilo': { name: 'Trasporti', path: '/articoli-frontaliere/trasporti-lombardia-ticino-record-tilo', parent: 'blog' },
    'blog-confusione-tassa-salute-frontalieri': { name: 'Frontalieri e tassa salute', path: '/articoli-frontaliere/confusione-tassa-salute-frontalieri', parent: 'blog' },
    'blog-neutralita-svizzera-parere-nazionale': { name: 'Neutralità svizzera', path: '/articoli-frontaliere/neutralita-svizzera-parere-nazionale', parent: 'blog' },
    'blog-carburante-ticino-costo-aumenti': { name: 'Il costo del carburante in Ticino si imp', path: '/articoli-frontaliere/carburante-ticino-costo-aumenti', parent: 'blog' },
    'blog-cpi-caso-hospita-rivalutazione-periti': { name: 'CPI e Caso Hospita', path: '/articoli-frontaliere/cpi-caso-hospita-rivalutazione-periti', parent: 'blog' },
    'blog-casellario-giudiziale-ue-ticino': { name: 'Canton Grigioni', path: '/articoli-frontaliere/casellario-giudiziale-ue-ticino', parent: 'blog' },
    'blog-salario-minimo-per-il-controprogetto-la-strada-e-in-discesa': { name: 'Salario minimo', path: '/articoli-frontaliere/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa', parent: 'blog' },
    'blog-tassa-salute-lombardia-frontalieri': { name: 'Tassa salute frontalieri', path: '/articoli-frontaliere/tassa-salute-lombardia-frontalieri', parent: 'blog' },
    'blog-franco-forte-problemi-economici': { name: 'Il franco forte', path: '/articoli-frontaliere/franco-forte-problemi-economici', parent: 'blog' },
    'blog-carburante-prezzo-salito-opportunismo': { name: 'Prezzo Benzina', path: '/articoli-frontaliere/carburante-prezzo-salito-opportunismo', parent: 'blog' },
    'blog-frontalieri-tassa-salute-teatro': { name: 'Frontalieri e tassa salute', path: '/articoli-frontaliere/frontalieri-tassa-salute-teatro', parent: 'blog' },
    'blog-disoccupazione-stabile-svizzera-2026': { name: 'Disoccupazione Svizzera', path: '/articoli-frontaliere/disoccupazione-stabile-svizzera-2026', parent: 'blog' },
    'blog-dazi-usa-rimborsi-ritardi': { name: 'Dazi USA', path: '/articoli-frontaliere/dazi-usa-rimborsi-ritardi', parent: 'blog' },
    'blog-votazioni-8-marzo-iniziativa-ssr-aperto': { name: 'Votazioni del 8 marzo', path: '/articoli-frontaliere/votazioni-8-marzo-iniziativa-ssr-aperto', parent: 'blog' },
    'blog-ticino-spitex-contributo-pressione': { name: 'Ticino Spitex', path: '/articoli-frontaliere/ticino-spitex-contributo-pressione', parent: 'blog' },
    'blog-stalking-swiss-2026-ticino': { name: 'Dal 2026', path: '/articoli-frontaliere/stalking-swiss-2026-ticino', parent: 'blog' },
    'blog-pirati-strada-ticino-italiani-2026': { name: 'Ticino', path: '/articoli-frontaliere/pirati-strada-ticino-italiani-2026', parent: 'blog' },
    'blog-comuni-locarno-futuro-aggregazione': { name: 'Sette Comuni del Locarnese sul Futuro', path: '/articoli-frontaliere/comuni-locarno-futuro-aggregazione', parent: 'blog' },
    'blog-costi-cure-domicilio-ticino-2026': { name: 'Ticino', path: '/articoli-frontaliere/costi-cure-domicilio-ticino-2026', parent: 'blog' },
    'blog-lugano-park-ride-bus-sovvenzioni-2026': { name: 'Lugano', path: '/articoli-frontaliere/lugano-park-ride-bus-sovvenzioni-2026', parent: 'blog' },
    'blog-crisi-turismo-golfo-persico': { name: 'Crisi Turismo', path: '/articoli-frontaliere/crisi-turismo-golfo-persico', parent: 'blog' },
    'blog-turisti-ticinesi-bloccati-medio-oriente': { name: 'Turisti bloccati', path: '/articoli-frontaliere/turisti-ticinesi-bloccati-medio-oriente', parent: 'blog' },
    'blog-svizzeri-bloccati-medio-oriente': { name: 'Svizzeri bloccati', path: '/articoli-frontaliere/svizzeri-bloccati-medio-oriente', parent: 'blog' },
    'blog-ticino-prevenzione-incendi-scuole-2026': { name: 'Sicurezza Scuole Ticino', path: '/articoli-frontaliere/ticino-prevenzione-incendi-scuole-2026', parent: 'blog' },
    'blog-varese-india-export-2026': { name: 'Varese India Export', path: '/articoli-frontaliere/varese-india-export-2026', parent: 'blog' },
    'blog-autotrasporto-rincari-confine-2026': { name: 'Carburante & Trasporti', path: '/articoli-frontaliere/autotrasporto-rincari-confine-2026', parent: 'blog' },
    'blog-carburanti-rincari-confine-ticino': { name: 'Carburanti Ticino', path: '/articoli-frontaliere/carburanti-rincari-confine-ticino', parent: 'blog' },
    'blog-votazioni-imposizione-ticino-2026': { name: 'Votazioni marzo 2026', path: '/articoli-frontaliere/votazioni-imposizione-ticino-2026', parent: 'blog' },
    'blog-imposizione-individuale-ticino-2026': { name: 'Imposizione 2026', path: '/articoli-frontaliere/imposizione-individuale-ticino-2026', parent: 'blog' },
    'blog-no-iniziativa-antidumping-ticino': { name: 'Ticino Iniziativa', path: '/articoli-frontaliere/no-iniziativa-antidumping-ticino', parent: 'blog' },
    'blog-dumping-salariale-ticino-no-iniziativa': { name: 'Il Ticino boccia l’iniziativa contro il', path: '/articoli-frontaliere/dumping-salariale-ticino-no-iniziativa', parent: 'blog' },
    'blog-incidente-viadotto-brogeda-como': { name: 'Incidente Viadotto Brogeda', path: '/articoli-frontaliere/incidente-viadotto-brogeda-como', parent: 'blog' },
    'blog-iniziativa-contro-dumping-ticino': { name: 'Iniziativa contro dumping', path: '/articoli-frontaliere/iniziativa-contro-dumping-ticino', parent: 'blog' },
    'blog-dumping-salariale-iniziativa-mps': { name: 'Dumping salariale', path: '/articoli-frontaliere/dumping-salariale-iniziativa-mps', parent: 'blog' },
    'blog-imposizione-individuale-rivoluzione-fiscale': { name: 'Imposizione Fiscale', path: '/articoli-frontaliere/imposizione-individuale-rivoluzione-fiscale', parent: 'blog' },
    'blog-svizzera-servizio-pubblico-canone-tv': { name: 'Svizzera', path: '/articoli-frontaliere/svizzera-servizio-pubblico-canone-tv', parent: 'blog' },
    'blog-votazioni-federali-tassazione-individuale': { name: 'Votazioni federali', path: '/articoli-frontaliere/votazioni-federali-tassazione-individuale', parent: 'blog' },
    'blog-universita-ticino-frontalieri': { name: 'Università Ticino', path: '/articoli-frontaliere/universita-ticino-frontalieri', parent: 'blog' },
    'blog-franco-svizzero-frontalieri-ricchi-2026': { name: 'Frontalieri e cambio', path: '/articoli-frontaliere/franco-svizzero-frontalieri-ricchi-2026', parent: 'blog' },
    'blog-energia-costi-ticino-rincari-2026': { name: 'Energia Ticino', path: '/articoli-frontaliere/energia-costi-ticino-rincari-2026', parent: 'blog' },
    'blog-ticino-carburante-alle-stelle-quadri-berna-riduca-tasse': { name: 'Carburante', path: '/articoli-frontaliere/ticino-carburante-alle-stelle-quadri-berna-riduca-tasse', parent: 'blog' },
    'blog-un-test-per-dare-un-nome-al-dolore': { name: 'Endometriosi', path: '/articoli-frontaliere/un-test-per-dare-un-nome-al-dolore', parent: 'blog' },
    'blog-aumentare-gia-il-prezzo-della-benzina': { name: 'Aumenti Benzina', path: '/articoli-frontaliere/aumentare-gia-il-prezzo-della-benzina', parent: 'blog' },
    'blog-furti-supermercati-ponte-tresa': { name: 'Sicurezza', path: '/articoli-frontaliere/furti-supermercati-ponte-tresa', parent: 'blog' },
    'blog-ladri-intercettati-lavena-ponte-tresa': { name: 'Ladri intercettati', path: '/articoli-frontaliere/ladri-intercettati-lavena-ponte-tresa', parent: 'blog' },
    'blog-dumping-salariale-ticino-no': { name: 'Dumping salariale', path: '/articoli-frontaliere/dumping-salariale-ticino-no', parent: 'blog' },
    'blog-sospensione-costi-utenti-ticino': { name: 'Governo Ticino', path: '/articoli-frontaliere/sospensione-costi-utenti-ticino', parent: 'blog' },
    'blog-investimento-pedone-bioggio': { name: 'Incidenti stradali', path: '/articoli-frontaliere/investimento-pedone-bioggio', parent: 'blog' },
    'blog-sicurezza-stazioni-treni-ticino-2026': { name: 'Sicurezza stazioni', path: '/articoli-frontaliere/sicurezza-stazioni-treni-ticino-2026', parent: 'blog' },
    'blog-tir-colonna-disagi-valico-brogeda': { name: 'Disagi Brogeda', path: '/articoli-frontaliere/tir-colonna-disagi-valico-brogeda', parent: 'blog' },
    'blog-iniziative-cassa-malati-costituzionalista-ticino': { name: 'Iniziative cassa malati, Gestione interp', path: '/articoli-frontaliere/iniziative-cassa-malati-costituzionalista-ticino', parent: 'blog' },
    'blog-investimenti-sicurezza-turismo-valsolda-26': { name: 'Investimenti Valsolda', path: '/articoli-frontaliere/investimenti-sicurezza-turismo-valsolda-26', parent: 'blog' },
    'blog-premio-la-rondine-2026-ticino': { name: 'Premio La Rondine', path: '/articoli-frontaliere/premio-la-rondine-2026-ticino', parent: 'blog' },
    'blog-tassi-ipotecari-ticino-medio-oriente-2026': { name: 'Tassi ipotecari', path: '/articoli-frontaliere/tassi-ipotecari-ticino-medio-oriente-2026', parent: 'blog' },
    'blog-aumento-export-bellico-svizzero-ticino': { name: 'Export Bellico Svizzero', path: '/articoli-frontaliere/aumento-export-bellico-svizzero-ticino', parent: 'blog' },
    'blog-assicurazione-auto-rincari-2026': { name: 'Assicurazione auto', path: '/articoli-frontaliere/assicurazione-auto-rincari-2026', parent: 'blog' },
    'blog-ticino-biglietti-senza-contanti': { name: 'Ticino', path: '/articoli-frontaliere/ticino-biglietti-senza-contanti', parent: 'blog' },
    'blog-aziende-como-assumono-lavoratori': { name: 'Lavoro e occupazione', path: '/articoli-frontaliere/aziende-como-assumono-lavoratori', parent: 'blog' },
    'blog-a2-giornico-cantiere-disagi-frontalieri': { name: 'Cantiere A2 Giornico', path: '/articoli-frontaliere/a2-giornico-cantiere-disagi-frontalieri', parent: 'blog' },
    'blog-tassa-traffico-pesante-camion-elettrici': { name: 'Fiscale', path: '/articoli-frontaliere/tassa-traffico-pesante-camion-elettrici', parent: 'blog' },
    'blog-logistica-sostenibile-a22': { name: 'Mobilità sostenibile', path: '/articoli-frontaliere/logistica-sostenibile-a22', parent: 'blog' },
    'blog-problemi-rotaia-bellinzona-lugano': { name: 'Trasporti', path: '/articoli-frontaliere/problemi-rotaia-bellinzona-lugano', parent: 'blog' },
    'blog-carpooling-aziendale-ticino': { name: 'Ticino e frontalieri', path: '/articoli-frontaliere/carpooling-aziendale-ticino', parent: 'blog' },
    'blog-energia-ets-von-der-leyen': { name: 'Novità', path: '/articoli-frontaliere/energia-ets-von-der-leyen', parent: 'blog' },
    'blog-permesso-g-apprendisti-frontali': { name: 'Permessi frontalieri', path: '/articoli-frontaliere/permesso-g-apprendisti-frontali', parent: 'blog' },
    'blog-assegni-familiari-frontalieri-ticino': { name: 'Assegni familiari ai frontalieri', path: '/articoli-frontaliere/assegni-familiari-frontalieri-ticino', parent: 'blog' },
    'blog-dagatra-incontro-migranti-chiasso': { name: 'A Chiasso apre ‘Dagatrà’', path: '/articoli-frontaliere/dagatra-incontro-migranti-chiasso', parent: 'blog' },
    'blog-ufficio-postale-chiasso-trasloco': { name: 'Trasloco ufficio postale', path: '/articoli-frontaliere/ufficio-postale-chiasso-trasloco', parent: 'blog' },
    'blog-confine-tesissimo-assegni-familiari': { name: 'Assegni familiari', path: '/articoli-frontaliere/confine-tesissimo-assegni-familiari', parent: 'blog' },
    'blog-chiasso-jazz-festival-2026': { name: 'Festival Jazz', path: '/articoli-frontaliere/chiasso-jazz-festival-2026', parent: 'blog' },
    'blog-apprendisti-frontalieri-riforma-permesso-g': { name: 'Riforma permesso G', path: '/articoli-frontaliere/apprendisti-frontalieri-riforma-permesso-g', parent: 'blog' },
    'blog-chiasso-piano-regolatore-telefonia': { name: 'Telefonia', path: '/articoli-frontaliere/chiasso-piano-regolatore-telefonia', parent: 'blog' },
    'blog-pensione-et-ticino-sentiero': { name: 'Aumentare l\'età di pensionamento in Tici', path: '/articoli-frontaliere/pensione-et-ticino-sentiero', parent: 'blog' },
    'blog-paradosso-ticino-lavoro': { name: 'Lavoro in Ticino', path: '/articoli-frontaliere/paradosso-ticino-lavoro', parent: 'blog' },
    'blog-lavena-ponte-tresa-giro-spaccio': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-giro-spaccio', parent: 'blog' },
    'blog-apertura-pesca-ticino': { name: 'Pesca in Ticino', path: '/articoli-frontaliere/apertura-pesca-ticino', parent: 'blog' },
    'blog-cassa-malati-franchigia-minima-ticino': { name: 'La franchigia minima dell\'assicurazione', path: '/articoli-frontaliere/cassa-malati-franchigia-minima-ticino', parent: 'blog' },
    'blog-frontalieri-tassa-salute-ritiro': { name: 'Tassa salute frontalieri Ticino', path: '/articoli-frontaliere/frontalieri-tassa-salute-ritiro', parent: 'blog' },
    'blog-trin-tunnel-grave-frontalieri': { name: 'Incidente stradale nel tunnel di Trin', path: '/articoli-frontaliere/trin-tunnel-grave-frontalieri', parent: 'blog' },
    'blog-chiasso-verde-sufficiente': { name: 'Chiasso', path: '/articoli-frontaliere/chiasso-verde-sufficiente', parent: 'blog' },
    'blog-comitati-malpensa-cuv-2026': { name: 'Malpensa', path: '/articoli-frontaliere/comitati-malpensa-cuv-2026', parent: 'blog' },
    'blog-borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta': { name: 'Borsa di Zurigo', path: '/articoli-frontaliere/borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta', parent: 'blog' },
    'blog-iran-tajani-non-tratta-navi': { name: 'Iran, Tajani assicura', path: '/articoli-frontaliere/iran-tajani-non-tratta-navi', parent: 'blog' },
    'blog-accordi-bilaterali-3-parlamento': { name: 'Accordi Bilaterali III, ora tocca al Par', path: '/articoli-frontaliere/accordi-bilaterali-3-parlamento', parent: 'blog' },
    'blog-viaggio-delle-batterie-verso-seconda-vita': { name: 'Riciclaggio batterie', path: '/articoli-frontaliere/viaggio-delle-batterie-verso-seconda-vita', parent: 'blog' },
    'blog-bilaterali-iii-parlamento-ticino-2026': { name: 'Bilaterali III, ora la palla passa al Pa', path: '/articoli-frontaliere/bilaterali-iii-parlamento-ticino-2026', parent: 'blog' },
    'blog-affitti-rialzo-crisi-ticino-2026': { name: 'Affitti Ticino', path: '/articoli-frontaliere/affitti-rialzo-crisi-ticino-2026', parent: 'blog' },
    'blog-bilaterali-iii-ticino-parlamento-2026': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-ticino-parlamento-2026', parent: 'blog' },
    'blog-truffa-lavoro-svizzera-anticipo-2026': { name: 'truffa lavoro svizzera', path: '/articoli-frontaliere/truffa-lavoro-svizzera-anticipo-2026', parent: 'blog' },
    'blog-ticino-carburanti-prezzo-potere-acquisto': { name: 'Carburanti Ticino', path: '/articoli-frontaliere/ticino-carburanti-prezzo-potere-acquisto', parent: 'blog' },
    'blog-aumento-franchigia-minima': { name: 'Ticino', path: '/articoli-frontaliere/aumento-franchigia-minima', parent: 'blog' },
    'blog-ticino-swissminiatur-inaugura-miniera-doro-sessa': { name: 'Ticino, Swissminiatur, Miniera d\'Oro', path: '/articoli-frontaliere/ticino-swissminiatur-inaugura-miniera-doro-sessa', parent: 'blog' },
    'blog-lavena-ponte-tresa-addio-antonio-cannavale': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-addio-antonio-cannavale', parent: 'blog' },
    'blog-gravincidente-stradale-regina-feriti': { name: 'Incidente stradale', path: '/articoli-frontaliere/gravincidente-stradale-regina-feriti', parent: 'blog' },
    'blog-scende-limite-nevicate-ticino': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/scende-limite-nevicate-ticino', parent: 'blog' },
    'blog-ticino-no-anti-dumping': { name: 'Di più In Ticino il \'no\' all\'iniziativa', path: '/articoli-frontaliere/ticino-no-anti-dumping', parent: 'blog' },
    'blog-chiusa-val-bedretto': { name: 'Notizie', path: '/articoli-frontaliere/chiusa-val-bedretto', parent: 'blog' },
    'blog-un-passaporto-di-fedelt': { name: 'Un passaporto di fedeltà', path: '/articoli-frontaliere/un-passaporto-di-fedelt', parent: 'blog' },
    'blog-baseball-italia-porto-rico-world-classic': { name: 'Notizie Sportive', path: '/articoli-frontaliere/baseball-italia-porto-rico-world-classic', parent: 'blog' },
    'blog-chiusure-autostrada-confine-ticino-2026': { name: 'Chiusure A9 Ticino', path: '/articoli-frontaliere/chiusure-autostrada-confine-ticino-2026', parent: 'blog' },
    'blog-swissminiatur-miniera-doro-sessa': { name: 'Ticino Economia', path: '/articoli-frontaliere/swissminiatur-miniera-doro-sessa', parent: 'blog' },
    'blog-sondaggio-tamedia-iva-esercito-avs': { name: 'Gli svizzeri contrari all\'aumento dell\'I', path: '/articoli-frontaliere/sondaggio-tamedia-iva-esercito-avs', parent: 'blog' },
    'blog-iran-conflitto-rincari-ticino': { name: 'Conflitto in Iran', path: '/articoli-frontaliere/iran-conflitto-rincari-ticino', parent: 'blog' },
    'blog-inverno-ticino-nevicate-2026': { name: 'Inverno in Ticino', path: '/articoli-frontaliere/inverno-ticino-nevicate-2026', parent: 'blog' },
    'blog-franchigia-minima-sanitario-ticino': { name: 'Franchigia Sanitaria', path: '/articoli-frontaliere/franchigia-minima-sanitario-ticino', parent: 'blog' },
    'blog-svizzera-recessione-cieslakiewicz': { name: 'Economia e Geopolitica', path: '/articoli-frontaliere/svizzera-recessione-cieslakiewicz', parent: 'blog' },
    'blog-valanghe-allerta-livello-4-ticino': { name: 'Allerta Valanghe', path: '/articoli-frontaliere/valanghe-allerta-livello-4-ticino', parent: 'blog' },
    'blog-nevicate-strade-bloccate-ticino': { name: 'Nevicate in Ticino', path: '/articoli-frontaliere/nevicate-strade-bloccate-ticino', parent: 'blog' },
    'blog-bilaterali-terza-fase-parlamento-ticino': { name: 'Bilaterali III Ticino', path: '/articoli-frontaliere/bilaterali-terza-fase-parlamento-ticino', parent: 'blog' },
    'blog-cane-morto-binarie-campo-calcio': { name: 'Cane morto Como', path: '/articoli-frontaliere/cane-morto-binarie-campo-calcio', parent: 'blog' },
    'blog-swissminiatur-miniera-sessa-2026': { name: 'Swissminiatur 2026', path: '/articoli-frontaliere/swissminiatur-miniera-sessa-2026', parent: 'blog' },
    'blog-crescita-misera-libera-circolazione': { name: 'Crescita svizzera', path: '/articoli-frontaliere/crescita-misera-libera-circolazione', parent: 'blog' },
    'blog-treni-varese-milano-ceresio-express': { name: 'Ceresio Express', path: '/articoli-frontaliere/treni-varese-milano-ceresio-express', parent: 'blog' },
    'blog-caro-carburante-benzina-ticino': { name: 'Caro-carburante', path: '/articoli-frontaliere/caro-carburante-benzina-ticino', parent: 'blog' },
    'blog-bilaterali-iii-cassis-ticino': { name: 'Bilaterali III', path: '/articoli-frontaliere/bilaterali-iii-cassis-ticino', parent: 'blog' },
    'blog-frontalieri-redditi-2026': { name: 'Dichiarazione dei redditi 2026', path: '/articoli-frontaliere/frontalieri-redditi-2026', parent: 'blog' },
    'blog-fermato-brogeda-cocaina': { name: 'Fermato a Brogeda con oltre 15 chili di', path: '/articoli-frontaliere/fermato-brogeda-cocaina', parent: 'blog' },
    'blog-dominicano-auto-svizzera-arresto': { name: 'Arresto a Chiasso', path: '/articoli-frontaliere/dominicano-auto-svizzera-arresto', parent: 'blog' },
    'blog-salari-bassi-rischio-povert': { name: 'Economia', path: '/articoli-frontaliere/salari-bassi-rischio-povert', parent: 'blog' },
    'blog-ticino-svolta-per-apprendisti': { name: 'Novità', path: '/articoli-frontaliere/ticino-svolta-per-apprendisti', parent: 'blog' },
    'blog-bellinzona-crescita-qualita-vita': { name: 'Economia', path: '/articoli-frontaliere/bellinzona-crescita-qualita-vita', parent: 'blog' },
    'blog-crisi-spermatozoi-svizzera-ticino': { name: 'Salute', path: '/articoli-frontaliere/crisi-spermatozoi-svizzera-ticino', parent: 'blog' },
    'blog-mercado-immobiliare-ticino': { name: 'La crisi degli alloggi in Ticino', path: '/articoli-frontaliere/mercado-immobiliare-ticino', parent: 'blog' },
    'blog-droga-brogeda-sequestro-cocaina': { name: 'Brogeda: Droga Sequestrata', path: '/articoli-frontaliere/droga-brogeda-sequestro-cocaina', parent: 'blog' },
    'blog-bellinzona-auscultazione-2026': { name: 'Bellinzona', path: '/articoli-frontaliere/bellinzona-auscultazione-2026', parent: 'blog' },
    'blog-lombardia-affitto-famiglie-varesine': { name: 'Fondo affitti Lombardia', path: '/articoli-frontaliere/lombardia-affitto-famiglie-varesine', parent: 'blog' },
    'blog-malcantone-fai-di-primavera-2026': { name: 'Malcantone Fai di Primavera 2026', path: '/articoli-frontaliere/malcantone-fai-di-primavera-2026', parent: 'blog' },
    'blog-sicurezza-privata-chiasso-nebiopoli': { name: 'Sicurezza privata', path: '/articoli-frontaliere/sicurezza-privata-chiasso-nebiopoli', parent: 'blog' },
    'blog-sfruttamento-corsieri-ticino-2026': { name: 'Sfruttamento corrieri', path: '/articoli-frontaliere/sfruttamento-corsieri-ticino-2026', parent: 'blog' },
    'blog-lavoro-economia-2026': { name: 'La fuga di talenti a Zurigo', path: '/articoli-frontaliere/lavoro-economia-2026', parent: 'blog' },
    'blog-sequestro-cocaina-brogeda-2026': { name: 'Sequestro cocaina', path: '/articoli-frontaliere/sequestro-cocaina-brogeda-2026', parent: 'blog' },
    'blog-infiltrazioni-criminali-ticino-grigioni': { name: 'Cultura, soldi, infiltrazioni criminali', path: '/articoli-frontaliere/infiltrazioni-criminali-ticino-grigioni', parent: 'blog' },
    'blog-turismo-luganese-formazione': { name: 'Turismo e formazione', path: '/articoli-frontaliere/turismo-luganese-formazione', parent: 'blog' },
    'blog-nevicata-record-bosco-gurin': { name: 'La nevicata record a Bosco Gurin', path: '/articoli-frontaliere/nevicata-record-bosco-gurin', parent: 'blog' },
    'blog-walter-bonatti-in-capo-al-mondo': { name: 'Walter Bonatti, Montegrino Valtravaglia', path: '/articoli-frontaliere/walter-bonatti-in-capo-al-mondo', parent: 'blog' },
    'blog-sargans-teenage-robbery-catch': { name: 'Notizie sicurezza frontiera', path: '/articoli-frontaliere/sargans-teenage-robbery-catch', parent: 'blog' },
    'blog-separazione-carriere-giudici': { name: 'Carriere giudiziarie', path: '/articoli-frontaliere/separazione-carriere-giudici', parent: 'blog' },
    'blog-com-aziende-lavoro-como': { name: 'Provincia di Como', path: '/articoli-frontaliere/com-aziende-lavoro-como', parent: 'blog' },
    'blog-cabov-precipita-forte-vento': { name: 'Cabinovia precipita a Engelberg', path: '/articoli-frontaliere/cabov-precipita-forte-vento', parent: 'blog' },
    'blog-agenzia-trasporto-nuovo': { name: 'Trasporti e confini', path: '/articoli-frontaliere/agenzia-trasporto-nuovo', parent: 'blog' },
    'blog-governo-tavolo-frontalieri-2026': { name: 'Frontaliere', path: '/articoli-frontaliere/governo-tavolo-frontalieri-2026', parent: 'blog' },
    'blog-gadda-incalza-governo-frontalieri': { name: 'Frontalieri', path: '/articoli-frontaliere/gadda-incalza-governo-frontalieri', parent: 'blog' },
    'blog-centovallina-riapertura-treni': { name: 'Trasporti', path: '/articoli-frontaliere/centovallina-riapertura-treni', parent: 'blog' },
    'blog-truffe-chiamate-shock-ticino': { name: 'Truffe', path: '/articoli-frontaliere/truffe-chiamate-shock-ticino', parent: 'blog' },
    'blog-spazi-verdi-in-citta-rilassamento': { name: 'Ambiente', path: '/articoli-frontaliere/spazi-verdi-in-citta-rilassamento', parent: 'blog' },
    'blog-camedo-buffet-eventi-ticino': { name: 'Eventi Ticino', path: '/articoli-frontaliere/camedo-buffet-eventi-ticino', parent: 'blog' },
    'blog-berna-discute-approvvigionamento-economico-e-13esima-avs': { name: 'Economia', path: '/articoli-frontaliere/berna-discute-approvvigionamento-economico-e-13esima-avs', parent: 'blog' },
    'blog-visita-ticinese-coira-criminalita-organizzata': { name: 'Economia', path: '/articoli-frontaliere/visita-ticinese-coira-criminalita-organizzata', parent: 'blog' },
    'blog-annunci-lavoro-dumping-ticino-governo': { name: 'Novità Lavoro', path: '/articoli-frontaliere/annunci-lavoro-dumping-ticino-governo', parent: 'blog' },
    'blog-controlli-cantieri-mendrisio': { name: 'Controlli cantieri', path: '/articoli-frontaliere/controlli-cantieri-mendrisio', parent: 'blog' },
    'blog-catastrofi-ticino-prontezza-2026': { name: 'Punti di raccolta d\'urgenza in Ticino', path: '/articoli-frontaliere/catastrofi-ticino-prontezza-2026', parent: 'blog' },
    'blog-tredicesima-avs-soluzione-mista-stati': { name: 'Tredicesima AVS', path: '/articoli-frontaliere/tredicesima-avs-soluzione-mista-stati', parent: 'blog' },
    'blog-lo-statuto-s-non-deve-trasformarsi-in-permesso-b': { name: 'Statuto S e permesso B', path: '/articoli-frontaliere/lo-statuto-s-non-deve-trasformarsi-in-permesso-b', parent: 'blog' },
    'blog-consiglio-stati-soluzione-mista-13esima-avs': { name: '13esima AVS', path: '/articoli-frontaliere/consiglio-stati-soluzione-mista-13esima-avs', parent: 'blog' },
    'blog-frode-cassa-compensazione-avs-ticino': { name: 'Frode AVS', path: '/articoli-frontaliere/frode-cassa-compensazione-avs-ticino', parent: 'blog' },
    'blog-deputazione-ticinese-italofoni-2024': { name: 'La deputazione ticinese', path: '/articoli-frontaliere/deputazione-ticinese-italofoni-2024', parent: 'blog' },
    'blog-kebab-case-turismo-ticino': { name: 'Turismo in Ticino', path: '/articoli-frontaliere/kebab-case-turismo-ticino', parent: 'blog' },
    'blog-droga-al-confine-ticino-2025': { name: 'Confine italo-svizzero', path: '/articoli-frontaliere/droga-al-confine-ticino-2025', parent: 'blog' },
    'blog-tassa-attraversamento-svizzera': { name: 'Tassa per le auto che attraversano la', path: '/articoli-frontaliere/tassa-attraversamento-svizzera', parent: 'blog' },
    'blog-incidente-stradale-laghi': { name: 'Varese', path: '/articoli-frontaliere/incidente-stradale-laghi', parent: 'blog' },
    'blog-vivere-piu-lungo-ticino': { name: 'Vivere più a lungo in Ticino', path: '/articoli-frontaliere/vivere-piu-lungo-ticino', parent: 'blog' },
    'blog-governo-getta-spugna-kebab-case': { name: 'Novità Ticino', path: '/articoli-frontaliere/governo-getta-spugna-kebab-case', parent: 'blog' },
    'blog-kebab-case-borse-freddo-2024': { name: 'Borse', path: '/articoli-frontaliere/kebab-case-borse-freddo-2024', parent: 'blog' },
    'blog-giustizia-in-bilico-2026': { name: 'Giustizia in Ticino', path: '/articoli-frontaliere/giustizia-in-bilico-2026', parent: 'blog' },
    'blog-ampliamento-parco-eolico-san-gottardo-digital-2026': { name: 'Ampliamento del Parco eolico del San', path: '/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo-digital-2026', parent: 'blog' },
    'blog-soggiorni-irregolari-2026-mendrisio': { name: 'Soggiorni irregolari a febbraio', path: '/articoli-frontaliere/soggiorni-irregolari-2026-mendrisio', parent: 'blog' },
    'blog-eolico-gottardo-ampliamento-2026': { name: 'Energia eolica', path: '/articoli-frontaliere/eolico-gottardo-ampliamento-2026', parent: 'blog' },
    'blog-contrabbando-ai-confine-aumentano-droga-e-sigarette': { name: 'Contrabbando ai confini', path: '/articoli-frontaliere/contrabbando-ai-confine-aumentano-droga-e-sigarette', parent: 'blog' },
    'blog-kebab-case-3-5-words-max-40-chars': { name: 'Notizie', path: '/articoli-frontaliere/kebab-case-3-5-words-max-40-chars', parent: 'blog' },
    'blog-salute-prevenzione-burocrazia-svizzera': { name: 'Salute Ticino', path: '/articoli-frontaliere/salute-prevenzione-burocrazia-svizzera', parent: 'blog' },
    'blog-telefonate-choc-truffa-anziani-ticino': { name: 'Telefonate choc', path: '/articoli-frontaliere/telefonate-choc-truffa-anziani-ticino', parent: 'blog' },
    'blog-ubs-fusione-credit-suisse-ticino': { name: 'Il cantiere di UBS a tre anni dal salvat', path: '/articoli-frontaliere/ubs-fusione-credit-suisse-ticino', parent: 'blog' },
    'blog-salari-minimi-ccl-ticino-2026': { name: 'Salari Minimi e CCL in Ticino', path: '/articoli-frontaliere/salari-minimi-ccl-ticino-2026', parent: 'blog' },
    'blog-strutture-dedicate-migranti-ticino': { name: 'Migranti in Ticino', path: '/articoli-frontaliere/strutture-dedicate-migranti-ticino', parent: 'blog' },
    'blog-contratti-collettivi-salari-ticino': { name: 'Contratti collettivi di lavoro in Ticino', path: '/articoli-frontaliere/contratti-collettivi-salari-ticino', parent: 'blog' },
    'blog-tutela-sovranita-dati-sanitari': { name: 'Sanità in Ticino', path: '/articoli-frontaliere/tutela-sovranita-dati-sanitari', parent: 'blog' },
    'blog-nomine-annullate-sims-tram': { name: 'Nomine alla SIMS annullate', path: '/articoli-frontaliere/nomine-annullate-sims-tram', parent: 'blog' },
    'blog-tassa-automobilisti-svizzera': { name: 'Mobilità transfrontaliera', path: '/articoli-frontaliere/tassa-automobilisti-svizzera', parent: 'blog' },
    'blog-lavoro-richiedenti-asilo-ucraini-ticino': { name: 'Richiedenti asilo e ucraini', path: '/articoli-frontaliere/lavoro-richiedenti-asilo-ucraini-ticino', parent: 'blog' },
    'blog-riforma-scolastica-ticino-difficolta': { name: 'Riforma scolastica in Ticino', path: '/articoli-frontaliere/riforma-scolastica-ticino-difficolta', parent: 'blog' },
    'blog-tassa-transito-parlamento-ticino': { name: 'La tassa di transito in Ticino tra appro', path: '/articoli-frontaliere/tassa-transito-parlamento-ticino', parent: 'blog' },
    'blog-inclusione-migranti-ticino': { name: 'Alis e Cir', path: '/articoli-frontaliere/inclusione-migranti-ticino', parent: 'blog' },
    'blog-franco-svizzero-impatti-ticino': { name: 'Economia Ticino', path: '/articoli-frontaliere/franco-svizzero-impatti-ticino', parent: 'blog' },
    'blog-tassa-transito-automobilisti-ticino': { name: 'Tassa di transito in Ticino', path: '/articoli-frontaliere/tassa-transito-automobilisti-ticino', parent: 'blog' },
    'blog-nubifragio-coira-mesolcina-ristoro': { name: 'Nubifragio Giugno 2024', path: '/articoli-frontaliere/nubifragio-coira-mesolcina-ristoro', parent: 'blog' },
    'blog-lotta-violenza-di-genere-ticino': { name: 'Ticino e Svizzera sotto l\'attenzione del', path: '/articoli-frontaliere/lotta-violenza-di-genere-ticino', parent: 'blog' },
    'blog-tassa-transito-svizzera-2023': { name: 'Tassa di transito Svizzera 2026', path: '/articoli-frontaliere/tassa-transito-svizzera-2023', parent: 'blog' },
    'blog-controlli-cantieri-mendrisiotto': { name: 'Operazione di controllo nei cantieri del', path: '/articoli-frontaliere/controlli-cantieri-mendrisiotto', parent: 'blog' },
    'blog-acinque-lancia-piano-genitorialita': { name: 'Lavoro', path: '/articoli-frontaliere/acinque-lancia-piano-genitorialita', parent: 'blog' },
    'blog-danni-riparati-centovallina': { name: 'Danni riparati, riapre la Centovallina-V', path: '/articoli-frontaliere/danni-riparati-centovallina', parent: 'blog' },
    'blog-porrentruy-piscina-comunale-divieto': { name: 'Novità', path: '/articoli-frontaliere/porrentruy-piscina-comunale-divieto', parent: 'blog' },
    'blog-sanita-fontana-fedriga': { name: 'Sanità', path: '/articoli-frontaliere/sanita-fontana-fedriga', parent: 'blog' },
    'blog-ampliamento-parco-eolico-san-gottardo': { name: 'San Gottardo', path: '/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo', parent: 'blog' },
    'blog-frontalieri-prezzi-carburanti-italia-svizzera': { name: 'Prezzi carburanti in Italia e Svizzera', path: '/articoli-frontaliere/frontalieri-prezzi-carburanti-italia-svizzera', parent: 'blog' },
    'blog-cure-a-domicilio-tassa-ticino': { name: 'Tassa sulle cure a domicilio', path: '/articoli-frontaliere/cure-a-domicilio-tassa-ticino', parent: 'blog' },
    'blog-kebab-case-ticino-nubifragio-grigioni': { name: 'Ticino: contributo cantonale per', path: '/articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni', parent: 'blog' },
    'blog-kebab-case-rossi-bruxelles-ticino': { name: 'Tassa di transito, Bruxelles', path: '/articoli-frontaliere/kebab-case-rossi-bruxelles-ticino', parent: 'blog' },
    'blog-bossi-voleva-bene-al-ticino': { name: 'Bossi e il Ticino', path: '/articoli-frontaliere/bossi-voleva-bene-al-ticino', parent: 'blog' },
    'blog-chiamate-shock-arresti-ticino': { name: 'Chiamate shock in Ticino', path: '/articoli-frontaliere/chiamate-shock-arresti-ticino', parent: 'blog' },
    'blog-rinnovo-concessioni-snl-2026': { name: 'Rinnovo delle concessioni e ampliamento', path: '/articoli-frontaliere/rinnovo-concessioni-snl-2026', parent: 'blog' },
    'blog-globalisti-fuga-medio-oriente-ticino': { name: 'Fuga dei Globalisti dal Medio Oriente', path: '/articoli-frontaliere/globalisti-fuga-medio-oriente-ticino', parent: 'blog' },
    'blog-guasto-tra-parabiago-e-rho': { name: 'Ritardi ferroviari e cancellazioni', path: '/articoli-frontaliere/guasto-tra-parabiago-e-rho', parent: 'blog' },
    'blog-tassa-transito-ticino-pedemontana': { name: 'Tassa di transito in Svizzera', path: '/articoli-frontaliere/tassa-transito-ticino-pedemontana', parent: 'blog' },
    'blog-franco-svizzero-a-valori-record-2026': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/franco-svizzero-a-valori-record-2026', parent: 'blog' },
    'blog-taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi': { name: 'Tessin', path: '/articoli-frontaliere/taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi', parent: 'blog' },
    'blog-farmaci-competitiva-europa': { name: 'Industria farmaceutica', path: '/articoli-frontaliere/farmaci-competitiva-europa', parent: 'blog' },
    'blog-controlli-cantieri-mendrisiotto-2026': { name: 'Controlli Cantieri', path: '/articoli-frontaliere/controlli-cantieri-mendrisiotto-2026', parent: 'blog' },
    'blog-byd-expansion-ticino-2026': { name: 'BYD si espande in Ticino', path: '/articoli-frontaliere/byd-expansion-ticino-2026', parent: 'blog' },
    'blog-controllo-affitti-nazionale-ticino': { name: 'Caro affitti', path: '/articoli-frontaliere/controllo-affitti-nazionale-ticino', parent: 'blog' },
    'blog-cioccolato-meno-ma-pagato-di-piu': { name: 'Cioccolato in Svizzera', path: '/articoli-frontaliere/cioccolato-meno-ma-pagato-di-piu', parent: 'blog' },
    'blog-diesel-aumento-prezzi-svizzera-2026': { name: 'Prezzi Diesel', path: '/articoli-frontaliere/diesel-aumento-prezzi-svizzera-2026', parent: 'blog' },
    'blog-sanita-manifesto-varese-2026': { name: 'A Varese nasce il Manifesto per il welfa', path: '/articoli-frontaliere/sanita-manifesto-varese-2026', parent: 'blog' },
    'blog-iva-bassa-svizzera-immagine-ingannevole': { name: 'IVA Svizzera', path: '/articoli-frontaliere/iva-bassa-svizzera-immagine-ingannevole', parent: 'blog' },
    'blog-divieto-smartphone-scuola-ticino': { name: 'Divieto di smartphone nelle scuole del T', path: '/articoli-frontaliere/divieto-smartphone-scuola-ticino', parent: 'blog' },
    'blog-la-navigazione-rafforza-offerta-2026': { name: 'Navigazione Ticino', path: '/articoli-frontaliere/la-navigazione-rafforza-offerta-2026', parent: 'blog' },
    'blog-sanita-integrativa-lombardia-ticino': { name: 'Sanità Integrativa', path: '/articoli-frontaliere/sanita-integrativa-lombardia-ticino', parent: 'blog' },
    'blog-fatture-mediche-gonfiate-ticino': { name: 'Fatture Mediche', path: '/articoli-frontaliere/fatture-mediche-gonfiate-ticino', parent: 'blog' },
    'blog-divieto-cellulari-scuola-ticino': { name: 'Divieto Cellulari', path: '/articoli-frontaliere/divieto-cellulari-scuola-ticino', parent: 'blog' },
    'blog-violenza-donne-consiglio-europa-ticino': { name: 'Violenza Donne', path: '/articoli-frontaliere/violenza-donne-consiglio-europa-ticino', parent: 'blog' },
    'blog-trojani-capo-servizi-esercito-ticino': { name: 'Esercito', path: '/articoli-frontaliere/trojani-capo-servizi-esercito-ticino', parent: 'blog' },
    'blog-funivia-monteviasco-orari-corsi': { name: 'Funivia Monteviasco', path: '/articoli-frontaliere/funivia-monteviasco-orari-corsi', parent: 'blog' },
    'blog-ricchi-fuga-medio-oriente-ticino': { name: 'Ricchi in fuga', path: '/articoli-frontaliere/ricchi-fuga-medio-oriente-ticino', parent: 'blog' },
    'blog-divieto-cellulari-scuola-ticino-2024': { name: 'No Natel Ticino', path: '/articoli-frontaliere/divieto-cellulari-scuola-ticino-2024', parent: 'blog' },
    'blog-sindacati-contro-snl-ticino-2026': { name: 'Sindacati e SNL', path: '/articoli-frontaliere/sindacati-contro-snl-ticino-2026', parent: 'blog' },
    'blog-aumento-iva-costo-ticino-2026': { name: 'Quanto costerà l’aumento dell’IVA per le', path: '/articoli-frontaliere/aumento-iva-costo-ticino-2026', parent: 'blog' },
    'blog-acquarossa-nuovo-polo-filovia-2026': { name: 'Acquarossa investimenti', path: '/articoli-frontaliere/acquarossa-nuovo-polo-filovia-2026', parent: 'blog' },
    'blog-ritardo-sconto-carburante-ticino-2026': { name: 'Sconto carburante', path: '/articoli-frontaliere/ritardo-sconto-carburante-ticino-2026', parent: 'blog' },
    'blog-lavori-a8-castellanza-notturni-2026': { name: 'Lavori A8 Castellanza', path: '/articoli-frontaliere/lavori-a8-castellanza-notturni-2026', parent: 'blog' },
    'blog-quanto-costa-la-discriminazione': { name: 'Discriminazione', path: '/articoli-frontaliere/quanto-costa-la-discriminazione', parent: 'blog' },
    'blog-divieto-smartphone-scuola-ticino-2026': { name: 'Divieto smartphone', path: '/articoli-frontaliere/divieto-smartphone-scuola-ticino-2026', parent: 'blog' },
    'blog-carenza-farmaci-ticino': { name: 'Carenza farmaci', path: '/articoli-frontaliere/carenza-farmaci-ticino', parent: 'blog' },
    'blog-lago-maggiore-accesso-tutto-l-anno': { name: 'Lago Maggiore', path: '/articoli-frontaliere/lago-maggiore-accesso-tutto-l-anno', parent: 'blog' },
    'blog-cure-domicilio-ticino': { name: 'Protesta Ticino', path: '/articoli-frontaliere/cure-domicilio-ticino', parent: 'blog' },
    'blog-spiagge-libere-sul-lago-maggiore': { name: 'Spiagge libere', path: '/articoli-frontaliere/spiagge-libere-sul-lago-maggiore', parent: 'blog' },
    'blog-snl-stagione-green-concessione': { name: 'Stagione SNL', path: '/articoli-frontaliere/snl-stagione-green-concessione', parent: 'blog' },
    'blog-smartphone-a-scuola-e-nuove-direttive': { name: 'Smartphone a scuola', path: '/articoli-frontaliere/smartphone-a-scuola-e-nuove-direttive', parent: 'blog' },
    'blog-infortuni-sul-lavoro-protesi-hi-tech': { name: 'Infortuni sul lavoro', path: '/articoli-frontaliere/infortuni-sul-lavoro-protesi-hi-tech', parent: 'blog' },
    'blog-bellinzona-scomparsa-ricerche-ticino-piemonte': { name: 'Bellinzona', path: '/articoli-frontaliere/bellinzona-scomparsa-ricerche-ticino-piemonte', parent: 'blog' },
    'blog-cure-domicilio-ticino-politica': { name: 'Cure a domicilio in Ticino', path: '/articoli-frontaliere/cure-domicilio-ticino-politica', parent: 'blog' },
    'blog-navigazione-lago-lugano-2026': { name: 'Navigazione Lago', path: '/articoli-frontaliere/navigazione-lago-lugano-2026', parent: 'blog' },
    'blog-parco-vedeggio-comuni-firman': { name: 'Firmata la nascita del Parco del Vedeggi', path: '/articoli-frontaliere/parco-vedeggio-comuni-firman', parent: 'blog' },
    'blog-stop-export-materiale-bellico': { name: 'Ticino sospende esportazioni di material', path: '/articoli-frontaliere/stop-export-materiale-bellico', parent: 'blog' },
    'blog-gestione-scontri-frontali-ticino': { name: 'Scontri violenti tra uomini nel Ticino', path: '/articoli-frontaliere/gestione-scontri-frontali-ticino', parent: 'blog' },
    'blog-auto-intrusione-frontalieri-ticino': { name: 'Controlli frontiera', path: '/articoli-frontaliere/auto-intrusione-frontalieri-ticino', parent: 'blog' },
    'blog-rischio-lugano-young-boys': { name: 'Rischio-Lugano in casa dello Young Boys', path: '/articoli-frontaliere/rischio-lugano-young-boys', parent: 'blog' },
    'blog-bossi-morto-ticino-frontalieri': { name: 'Morte Bossi', path: '/articoli-frontaliere/bossi-morto-ticino-frontalieri', parent: 'blog' },
    'blog-ogm-fallimento-ticino': { name: 'Fallimento dell’iniziativa contro gli OG', path: '/articoli-frontaliere/ogm-fallimento-ticino', parent: 'blog' },
    'blog-referendum-giustizia-ticino-2026': { name: 'Referendum sulla giustizia in Ticino', path: '/articoli-frontaliere/referendum-giustizia-ticino-2026', parent: 'blog' },
    'blog-passaggio-statuto-s-permesso-b': { name: 'Dallo statuto S al permesso B in Ticino', path: '/articoli-frontaliere/passaggio-statuto-s-permesso-b', parent: 'blog' },
    'blog-chiusure-notturne-autostrada': { name: 'Chiusure notturne autostrada', path: '/articoli-frontaliere/chiusure-notturne-autostrada', parent: 'blog' },
    'blog-morte-bimbo-efamilia-ticino': { name: 'Morte figlio', path: '/articoli-frontaliere/morte-bimbo-efamilia-ticino', parent: 'blog' },
    'blog-fondi-hcap-restituiti': { name: 'Economia', path: '/articoli-frontaliere/fondi-hcap-restituiti', parent: 'blog' },
    'blog-bellinzona-paese-dormitorio': { name: 'Economia', path: '/articoli-frontaliere/bellinzona-paese-dormitorio', parent: 'blog' },
    'blog-tragedia-titlis-raffica-vento': { name: 'Ticino', path: '/articoli-frontaliere/tragedia-titlis-raffica-vento', parent: 'blog' },
    'blog-accesso-libero-alle-rive': { name: 'Economia', path: '/articoli-frontaliere/accesso-libero-alle-rive', parent: 'blog' },
    'blog-ticino-attenti-ai-radar-2026': { name: 'Ticino, attenti ai radar', path: '/articoli-frontaliere/ticino-attenti-ai-radar-2026', parent: 'blog' },
    'blog-sequestro-stupefacenti-ecuador': { name: 'Sequestro di sostanze stupefacenti', path: '/articoli-frontaliere/sequestro-stupefacenti-ecuador', parent: 'blog' },
    'blog-nuovi-radar-ticino-multe': { name: 'Radar Ticino', path: '/articoli-frontaliere/nuovi-radar-ticino-multe', parent: 'blog' },
    'blog-rifugiati-ucraini-assistenza-2027': { name: 'Rifugiati', path: '/articoli-frontaliere/rifugiati-ucraini-assistenza-2027', parent: 'blog' },
    'blog-cannabis-sequestro-ticino': { name: 'Sequestro record di cannabis in Argovia', path: '/articoli-frontaliere/cannabis-sequestro-ticino', parent: 'blog' },
    'blog-pfaffikon-kanton-schwyz-franzosi-einbrecher': { name: 'Notizie', path: '/articoli-frontaliere/pfaffikon-kanton-schwyz-franzosi-einbrecher', parent: 'blog' },
    'blog-riapertura-casetta-chiosco-davesco': { name: 'Riapre la Casetta a Davesco-Soragno', path: '/articoli-frontaliere/riapertura-casetta-chiosco-davesco', parent: 'blog' },
    'blog-giovani-ticino-comuni-innovazioni': { name: 'I giovani non tornano', path: '/articoli-frontaliere/giovani-ticino-comuni-innovazioni', parent: 'blog' },
    'blog-domeniche-senza-auto-ticino-2026': { name: 'Domeniche senza auto in Svizzera', path: '/articoli-frontaliere/domeniche-senza-auto-ticino-2026', parent: 'blog' },
    'blog-chiusure-notturne-a4-ticino': { name: 'Lavori autostradali A4 Milano-Brescia', path: '/articoli-frontaliere/chiusure-notturne-a4-ticino', parent: 'blog' },
    'blog-svizzera-frontalieri-franco-lavoro': { name: 'Novità', path: '/articoli-frontaliere/svizzera-frontalieri-franco-lavoro', parent: 'blog' },
    'blog-svizzera-cern-ricerca-chip': { name: 'Ricerca sui chip', path: '/articoli-frontaliere/svizzera-cern-ricerca-chip', parent: 'blog' },
    'blog-cannabis-sequestro-ticino-2026': { name: 'Sequestro Cannabis', path: '/articoli-frontaliere/cannabis-sequestro-ticino-2026', parent: 'blog' },
    'blog-svizzeri-dubitano-difesa-paese': { name: 'Difesa Svizzera', path: '/articoli-frontaliere/svizzeri-dubitano-difesa-paese', parent: 'blog' },
    'blog-referendum-varese-ticino-2026': { name: 'Referendum Varese', path: '/articoli-frontaliere/referendum-varese-ticino-2026', parent: 'blog' },
    'blog-controlli-radar-ticino': { name: 'Controlli radar in Ticino', path: '/articoli-frontaliere/controlli-radar-ticino', parent: 'blog' },
    'blog-frontalieri-casa-zurigo': { name: 'Frontalieri', path: '/articoli-frontaliere/frontalieri-casa-zurigo', parent: 'blog' },
    'blog-lugano-sicurezza-2025': { name: 'Sicurezza a Lugano', path: '/articoli-frontaliere/lugano-sicurezza-2025', parent: 'blog' },
    'blog-migranti-dublino-ticino': { name: 'Migranti Dublino', path: '/articoli-frontaliere/migranti-dublino-ticino', parent: 'blog' },
    'blog-chiasso-ora-terra-2026': { name: 'Ora della Terra Chiasso', path: '/articoli-frontaliere/chiasso-ora-terra-2026', parent: 'blog' },
    'blog-radar-ticino-riduzione': { name: 'Riduzione radar', path: '/articoli-frontaliere/radar-ticino-riduzione', parent: 'blog' },
    'blog-nomine-sims-illegittime': { name: 'Nomine SIMS', path: '/articoli-frontaliere/nomine-sims-illegittime', parent: 'blog' },
    'blog-funivia-monte-lema-stagione-2026': { name: 'Funivia Monte Lema', path: '/articoli-frontaliere/funivia-monte-lema-stagione-2026', parent: 'blog' },
    'blog-crescita-economica-ticino-2026': { name: 'Crescita economica', path: '/articoli-frontaliere/crescita-economica-ticino-2026', parent: 'blog' },
    'blog-giustizia-referendum-ticino': { name: 'Referendum sulla giustizia in Italia', path: '/articoli-frontaliere/giustizia-referendum-ticino', parent: 'blog' },
    'blog-ora-legale-permanente-ticino': { name: 'Ora legale permanente in Ticino', path: '/articoli-frontaliere/ora-legale-permanente-ticino', parent: 'blog' },
    'blog-como-asfaltature-war-costs': { name: 'Como, Rapinese', path: '/articoli-frontaliere/como-asfaltature-war-costs', parent: 'blog' },
    'blog-referendum-opposizione-ticino': { name: 'Referendum in Ticino', path: '/articoli-frontaliere/referendum-opposizione-ticino', parent: 'blog' },
    'blog-apprendisti-frontalieri-permessi-g': { name: 'Frontalieri: permesso G per tutta la', path: '/articoli-frontaliere/apprendisti-frontalieri-permessi-g', parent: 'blog' },
    'blog-crescita-sicurezza-ticino-2025': { name: 'Sicurezza', path: '/articoli-frontaliere/crescita-sicurezza-ticino-2025', parent: 'blog' },
    'blog-sesto-calende-centro-sportivo': { name: 'Sesto Calende centro sportivo', path: '/articoli-frontaliere/sesto-calende-centro-sportivo', parent: 'blog' },
    'blog-chiasso-missione-emergenza': { name: 'Chiasso', path: '/articoli-frontaliere/chiasso-missione-emergenza', parent: 'blog' },
    'blog-ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio': { name: 'Ticinesi e frontalieri', path: '/articoli-frontaliere/ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio', parent: 'blog' },
    'blog-lavena-ponte-tresa-verde': { name: 'Annaffiatoi e aiuole, il centro si cura', path: '/articoli-frontaliere/lavena-ponte-tresa-verde', parent: 'blog' },
    'blog-chiasso-missione-emergenza-luci-blu': { name: 'Chiasso Missione emergenza', path: '/articoli-frontaliere/chiasso-missione-emergenza-luci-blu', parent: 'blog' },
    'blog-aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica': { name: 'Aggregazione Basso Mendrisiotto', path: '/articoli-frontaliere/aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica', parent: 'blog' },
    'blog-carburanti-prezzo-rialzo-ticino': { name: 'Prezzo carburanti', path: '/articoli-frontaliere/carburanti-prezzo-rialzo-ticino', parent: 'blog' },
    'blog-guida-michelin-ticino': { name: 'Guida Michelin Ticino', path: '/articoli-frontaliere/guida-michelin-ticino', parent: 'blog' },
    'blog-eurospin-luino-occhio-al-cambio': { name: 'Colpo di stiletto / "Eurospin" di Luino,', path: '/articoli-frontaliere/eurospin-luino-occhio-al-cambio', parent: 'blog' },
    'blog-lavena-ponte-tresa-territorio-poroso': { name: 'territorio poroso', path: '/articoli-frontaliere/lavena-ponte-tresa-territorio-poroso', parent: 'blog' },
    'blog-fusione-valle-calanca-comuni': { name: 'Val Calanca, quattro Comuni studiano una', path: '/articoli-frontaliere/fusione-valle-calanca-comuni', parent: 'blog' },
    'blog-lavoro-carceri-ticino': { name: 'Lavoro in carcere', path: '/articoli-frontaliere/lavoro-carceri-ticino', parent: 'blog' },
    'blog-avs-saronno-referendum': { name: 'Politica', path: '/articoli-frontaliere/avs-saronno-referendum', parent: 'blog' },
    'blog-lavena-ponte-tresa-annaffiatoi': { name: 'Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-annaffiatoi', parent: 'blog' },
    'blog-bossi-commemorazione-bagarrata': { name: 'Ticino', path: '/articoli-frontaliere/bossi-commemorazione-bagarrata', parent: 'blog' },
    'blog-corsi-a-b-scuola-media-ticino': { name: 'Scuola media Ticino', path: '/articoli-frontaliere/corsi-a-b-scuola-media-ticino', parent: 'blog' },
    'blog-ticino-confine-droga': { name: 'Spaccio di droga', path: '/articoli-frontaliere/ticino-confine-droga', parent: 'blog' },
    'blog-franco-svizzero-minimi-euro': { name: 'Innovazioni economiche', path: '/articoli-frontaliere/franco-svizzero-minimi-euro', parent: 'blog' },
    'blog-benzina-conveniente': { name: 'Benzina conveniente', path: '/articoli-frontaliere/benzina-conveniente', parent: 'blog' },
    'blog-piu-interventi-soccorso-meno-vittime-montagna-ticino-2025': { name: 'Più interventi di soccorso, ma meno', path: '/articoli-frontaliere/piu-interventi-soccorso-meno-vittime-montagna-ticino-2025', parent: 'blog' },
    'blog-nei-test-neonati-ticinesi': { name: 'Test neonati', path: '/articoli-frontaliere/nei-test-neonati-ticinesi', parent: 'blog' },
    'blog-aggregazione-rischio-basso-mendrisiotto': { name: 'Aggregazione a rischio', path: '/articoli-frontaliere/aggregazione-rischio-basso-mendrisiotto', parent: 'blog' },
    'blog-congresso-svizzera-italia-varese-2026': { name: 'Congresso 2026', path: '/articoli-frontaliere/congresso-svizzera-italia-varese-2026', parent: 'blog' },
    'blog-processo-mendrisio-19-capit': { name: 'Processo Mendrisio', path: '/articoli-frontaliere/processo-mendrisio-19-capit', parent: 'blog' },
    'blog-prezzi-carburanti-ticino-marzo-2026': { name: 'Prezzi del carburante in Europa', path: '/articoli-frontaliere/prezzi-carburanti-ticino-marzo-2026', parent: 'blog' },
    'blog-via-francisca-cammino': { name: 'Via Francisca del Lucomagno', path: '/articoli-frontaliere/via-francisca-cammino', parent: 'blog' },
    'blog-lavoro-sommerso-varesotto': { name: 'Lavoro ‘sommerso’', path: '/articoli-frontaliere/lavoro-sommerso-varesotto', parent: 'blog' },
    'blog-rissa-lavena-ponte-tres': { name: 'Sicurezza', path: '/articoli-frontaliere/rissa-lavena-ponte-tres', parent: 'blog' },
    'blog-magliaso-zona-educativa-ripresa': { name: 'Scuola elementare Magliaso', path: '/articoli-frontaliere/magliaso-zona-educativa-ripresa', parent: 'blog' },
    'blog-cassa-malati-leghista-applicata-subito': { name: 'Cassa malati', path: '/articoli-frontaliere/cassa-malati-leghista-applicata-subito', parent: 'blog' },
    'blog-ronte-tresa-rissa': { name: 'Ponte Tresa', path: '/articoli-frontaliere/ronte-tresa-rissa', parent: 'blog' },
    'blog-a9-chiasso-como-chiusure-frontalieri': { name: 'Chiusure A9', path: '/articoli-frontaliere/a9-chiasso-como-chiusure-frontalieri', parent: 'blog' },
    'blog-code-nord-san-gottardo': { name: 'Code al San Gottardo', path: '/articoli-frontaliere/code-nord-san-gottardo', parent: 'blog' },
    'blog-trattative-acordo-usa-oltre-31-marzo': { name: 'Trattative commercio Usa Svizzera', path: '/articoli-frontaliere/trattative-acordo-usa-oltre-31-marzo', parent: 'blog' },
    'blog-occhiali-intelligenti-ticino-innovazione': { name: 'Innovazione Ticino', path: '/articoli-frontaliere/occhiali-intelligenti-ticino-innovazione', parent: 'blog' },
    'blog-trattative-dazi-non-valido-31-marzo': { name: 'Trattative sui dazi', path: '/articoli-frontaliere/trattative-dazi-non-valido-31-marzo', parent: 'blog' },
    'blog-trippa-dogana-novazzano': { name: 'Dogana e Frontiere', path: '/articoli-frontaliere/trippa-dogana-novazzano', parent: 'blog' },
    'blog-lavori-rete-ferroviaria-tilo': { name: 'Lavori sulla rete ferroviaria italiana,', path: '/articoli-frontaliere/lavori-rete-ferroviaria-tilo', parent: 'blog' },
    'blog-tassa-mensa-asilo-chiasso': { name: 'Tasse scolastiche', path: '/articoli-frontaliere/tassa-mensa-asilo-chiasso', parent: 'blog' },
    'blog-sindacati-ticino-leonardo-cascina-costa': { name: 'Sindacati in Ticino', path: '/articoli-frontaliere/sindacati-ticino-leonardo-cascina-costa', parent: 'blog' },
    'blog-chiasso-tassa-refezione-scuola-infanzia': { name: 'Notizie Ticino', path: '/articoli-frontaliere/chiasso-tassa-refezione-scuola-infanzia', parent: 'blog' },
    'blog-ict-reatto-commissione-tri': { name: 'Lavoro TIC in Ticino', path: '/articoli-frontaliere/ict-reatto-commissione-tri', parent: 'blog' },
    'blog-furbata-dogana-argento': { name: 'Tenta la furbata in dogana tra Como e Sv', path: '/articoli-frontaliere/furbata-dogana-argento', parent: 'blog' },
    'blog-sicurezza-lago-maggiore': { name: 'Sicurezza Lago Maggiore', path: '/articoli-frontaliere/sicurezza-lago-maggiore', parent: 'blog' },
    'blog-ambasciatore-italiano-ritorno-berna': { name: 'Rientro dell\'ambasciatore italiano a Ber', path: '/articoli-frontaliere/ambasciatore-italiano-ritorno-berna', parent: 'blog' },
    'blog-pazienti-ticino-protesta': { name: 'Petizione cure a domicilio', path: '/articoli-frontaliere/pazienti-ticino-protesta', parent: 'blog' },
    'blog-aumento-contingente-uova-svizzera': { name: 'Economia', path: '/articoli-frontaliere/aumento-contingente-uova-svizzera', parent: 'blog' },
    'blog-lavori-notturni-via-lavizzari': { name: 'Viabilità', path: '/articoli-frontaliere/lavori-notturni-via-lavizzari', parent: 'blog' },
    'blog-limite-popolazione-10-milioni-ticino': { name: 'Limitare la popolazione in Ticino a 10 m', path: '/articoli-frontaliere/limite-popolazione-10-milioni-ticino', parent: 'blog' },
    'blog-settanta-chili-di-mozzarella': { name: 'Novita in Ticino', path: '/articoli-frontaliere/settanta-chili-di-mozzarella', parent: 'blog' },
    'blog-contrabbando-ticino-2026': { name: 'Contrabbando in Ticino', path: '/articoli-frontaliere/contrabbando-ticino-2026', parent: 'blog' },
    'blog-mobilita-infermieri-ticino': { name: 'Mobilità internazionale', path: '/articoli-frontaliere/mobilita-infermieri-ticino', parent: 'blog' },
    'blog-san-gottardo-code-giovedi-santo': { name: 'San Gottardo, code da Giovedì Santo', path: '/articoli-frontaliere/san-gottardo-code-giovedi-santo', parent: 'blog' },
    'blog-como-lago-pasqua-boom-prenotazioni': { name: 'Como e il Lago', path: '/articoli-frontaliere/como-lago-pasqua-boom-prenotazioni', parent: 'blog' },
    'blog-camion-panne-san-gottardo-traffico-bloccato': { name: 'Camion in panne al San Gottardo', path: '/articoli-frontaliere/camion-panne-san-gottardo-traffico-bloccato', parent: 'blog' },
    'blog-aumento-inchieste-penali-2025': { name: 'Aumento inchieste penali', path: '/articoli-frontaliere/aumento-inchieste-penali-2025', parent: 'blog' },
    'blog-ticino-lombardia-manifatturiero': { name: 'Ticino e Lombardia', path: '/articoli-frontaliere/ticino-lombardia-manifatturiero', parent: 'blog' },
    'blog-dogana-chiasso-centro-tecnologico': { name: 'Economia', path: '/articoli-frontaliere/dogana-chiasso-centro-tecnologico', parent: 'blog' },
    'blog-permessi-dubbi-roveredo-insoddisfatta': { name: 'Permessi dubbi, Roveredo insoddisfatta e', path: '/articoli-frontaliere/permessi-dubbi-roveredo-insoddisfatta', parent: 'blog' },
    'blog-permessi-dimora-diversi-opinioni': { name: 'Permessi di dimora', path: '/articoli-frontaliere/permessi-dimora-diversi-opinioni', parent: 'blog' },
    'blog-chiasso-zanzara-tigre-strategia-2026': { name: 'Chiasso & Zanzara Tigre', path: '/articoli-frontaliere/chiasso-zanzara-tigre-strategia-2026', parent: 'blog' },
    'blog-trasferimento-ufficio-postale-chiasso': { name: 'Trasferimento Ufficio Postale', path: '/articoli-frontaliere/trasferimento-ufficio-postale-chiasso', parent: 'blog' },
    'blog-esame-complementare-passerella-aperte-pre-iscrizioni': { name: 'Esame complementare passerella', path: '/articoli-frontaliere/esame-complementare-passerella-aperte-pre-iscrizioni', parent: 'blog' },
    'blog-gasolio-costi-pullman-ticino-lago-como': { name: 'Lago di Como', path: '/articoli-frontaliere/gasolio-costi-pullman-ticino-lago-como', parent: 'blog' },
    'blog-tram-treno-luganese-passo-avanti': { name: 'Tram-treno Luganese', path: '/articoli-frontaliere/tram-treno-luganese-passo-avanti', parent: 'blog' },
    'blog-turismo-pasquale-ticino-2026': { name: 'Turismo pasquale in Ticino', path: '/articoli-frontaliere/turismo-pasquale-ticino-2026', parent: 'blog' },
    'blog-mozzarella-clandestina-2026-ricerca': { name: 'Mozzarella clandestina in Ticino', path: '/articoli-frontaliere/mozzarella-clandestina-2026-ricerca', parent: 'blog' },
    'blog-varese-soroptimist-studio-fibrosi-polmonare': { name: 'Varese - Frontaliere Ticino', path: '/articoli-frontaliere/varese-soroptimist-studio-fibrosi-polmonare', parent: 'blog' },
    'blog-accordi-svizzera-ue-2026': { name: 'Accordi Svizzera-UE verso ratifica nel 2', path: '/articoli-frontaliere/accordi-svizzera-ue-2026', parent: 'blog' },
    'blog-vacanze-di-pasqua-san-gottardo': { name: 'Vacanze di Pasqua: colonna al San Gottardo', path: '/articoli-frontaliere/vacanze-di-pasqua-san-gottardo', parent: 'blog' },
    'blog-medici-manca-verbano-ticino-2026': { name: 'Medici in Ticino e Varese', path: '/articoli-frontaliere/medici-manca-verbano-ticino-2026', parent: 'blog' },
    'blog-italia-taglia-accise-benzinai-preoccupati': { name: 'L\'Italia taglia le accise, benzinai preo', path: '/articoli-frontaliere/italia-taglia-accise-benzinai-preoccupati', parent: 'blog' },
    'blog-aumento-mezzi-pubblici-ticino': { name: 'Aumento prezzi mezzi pubblici Ticino', path: '/articoli-frontaliere/aumento-mezzi-pubblici-ticino', parent: 'blog' },
    'blog-addiofrontalierelongo': { name: 'Necrologie', path: '/articoli-frontaliere/addiofrontalierelongo', parent: 'blog' },
    'blog-ladri-di-auto-scappano-con-40-chiavi-e-una-skoda': { name: 'Ticino', path: '/articoli-frontaliere/ladri-di-auto-scappano-con-40-chiavi-e-una-skoda', parent: 'blog' },
    'blog-incendi-boschivi-ticino-2026': { name: 'Ambiente', path: '/articoli-frontaliere/incendi-boschivi-ticino-2026', parent: 'blog' },
    'blog-benzina-ticino-taglio-accise': { name: 'Benzina Ticino Taglio Accise', path: '/articoli-frontaliere/benzina-ticino-taglio-accise', parent: 'blog' },
    'blog-abolizione-imposta-valore-locativo-2029': { name: 'Fisco Ticino', path: '/articoli-frontaliere/abolizione-imposta-valore-locativo-2029', parent: 'blog' },
    'blog-contrabbando-pokemon-ticino': { name: 'Contrabbando di Pokémon', path: '/articoli-frontaliere/contrabbando-pokemon-ticino', parent: 'blog' },
    'blog-sconto-benzina-ticino': { name: 'Sconto benzina', path: '/articoli-frontaliere/sconto-benzina-ticino', parent: 'blog' },
    'blog-anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare': { name: 'Frontalieri Ticino', path: '/articoli-frontaliere/anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare', parent: 'blog' },
    'blog-supsi-bachelor-sostenibilita-2027': { name: 'SUPSI Sostenibilità', path: '/articoli-frontaliere/supsi-bachelor-sostenibilita-2027', parent: 'blog' },
    'blog-lavena-ponte-tresa-bicicletta-grave': { name: 'Frontalieri Ticino - Lavena Ponte Tresa', path: '/articoli-frontaliere/lavena-ponte-tresa-bicicletta-grave', parent: 'blog' },
    'blog-roveredo-permessi-anticrimine': { name: 'Roveredo denuncia', path: '/articoli-frontaliere/roveredo-permessi-anticrimine', parent: 'blog' },
    'blog-pasqua-messaggio-di-avvenire': { name: 'Pasqua', path: '/articoli-frontaliere/pasqua-messaggio-di-avvenire', parent: 'blog' },
    'blog-tramonto-a-cadenazzo': { name: 'Tramonto a Cadenazzo', path: '/articoli-frontaliere/tramonto-a-cadenazzo', parent: 'blog' },
    'blog-traffico-san-gottardo-2026': { name: 'Traffico paralizzato al San Gottardo', path: '/articoli-frontaliere/traffico-san-gottardo-2026', parent: 'blog' },
    'blog-auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate': { name: 'Auto si ribalta sulla SP1 tra Varese e G', path: '/articoli-frontaliere/auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate', parent: 'blog' },
    'blog-nestle-200-posti-lombardia': { name: 'Nestle apre sede in Lombardia e offre 20', path: '/articoli-frontaliere/nestle-200-posti-lombardia', parent: 'blog' },
    'blog-la-quinta-svizzera-che-ha-un-debole-per-milano': { name: 'La \'Quinta Svizzera\' e la Lombardia', path: '/articoli-frontaliere/la-quinta-svizzera-che-ha-un-debole-per-milano', parent: 'blog' },
    'blog-comuni-investono-turismo-ticino': { name: 'Comuni ticinesi investono nel settore tu', path: '/articoli-frontaliere/comuni-investono-turismo-ticino', parent: 'blog' },
    'blog-agriscambio': { name: 'Tanti agricoltori verso la pensione', path: '/articoli-frontaliere/agriscambio', parent: 'blog' },
    'blog-frontaliere-ticino-10-milioni-voto': { name: 'Iniziativa 10 milioni', path: '/articoli-frontaliere/frontaliere-ticino-10-milioni-voto', parent: 'blog' },
    'blog-congestione-a2-san-gottardo-frontalieri': { name: 'Congestione A2 - San Gottardo', path: '/articoli-frontaliere/congestione-a2-san-gottardo-frontalieri', parent: 'blog' },
    'blog-galleria-del-ceneri-chiusa-per-problemi-tecnici': { name: 'Viabilità', path: '/articoli-frontaliere/galleria-del-ceneri-chiusa-per-problemi-tecnici', parent: 'blog' },
    'blog-corso-pastori-ticino': { name: 'Corso pastori Ticino', path: '/articoli-frontaliere/corso-pastori-ticino', parent: 'blog' },
    'blog-diventare-pastore-ticino': { name: 'Formazione pastore', path: '/articoli-frontaliere/diventare-pastore-ticino', parent: 'blog' },
    'blog-varese-si-ubriaca-infortuna': { name: 'Varese: si ubriaca, s\'infortuna, ferisce', path: '/articoli-frontaliere/varese-si-ubriaca-infortuna', parent: 'blog' },
    'blog-trump-intesa-o-inferno': { name: 'Tensione tra Stati Uniti e Cina', path: '/articoli-frontaliere/trump-intesa-o-inferno', parent: 'blog' },
    'blog-coop-richiama-formaggi-salmonelle': { name: 'Frontaliere Ticino', path: '/articoli-frontaliere/coop-richiama-formaggi-salmonelle', parent: 'blog' },
    'blog-scambio-abiti-bellinzona': { name: 'Bellinzona', path: '/articoli-frontaliere/scambio-abiti-bellinzona', parent: 'blog' },
    'blog-protesta-costi-cure-domicilio': { name: 'Protesta contro i costi per le cure a', path: '/articoli-frontaliere/protesta-costi-cure-domicilio', parent: 'blog' },
    'blog-acqua-non-potabile-lavizzara': { name: 'Lavizzara', path: '/articoli-frontaliere/acqua-non-potabile-lavizzara', parent: 'blog' },
    'blog-nuova-direttrice-servizi-sociali-bellinzona': { name: 'Servizi sociali Bellinzona', path: '/articoli-frontaliere/nuova-direttrice-servizi-sociali-bellinzona', parent: 'blog' },
    'blog-riaperta-galleria-monte-ceneri': { name: 'Riaperta la galleria del Monte Ceneri', path: '/articoli-frontaliere/riaperta-galleria-monte-ceneri', parent: 'blog' },
    'blog-ucraini-in-ticino-aiuti-incognite': { name: 'Ucraini in Ticino', path: '/articoli-frontaliere/ucraini-in-ticino-aiuti-incognite', parent: 'blog' },
    'blog-fuga-da-dubai-ticino-alternativa': { name: 'Fuga da Dubai, il Ticino come alternativ', path: '/articoli-frontaliere/fuga-da-dubai-ticino-alternativa', parent: 'blog' },
    'blog-traffico-san-gottardo-attesa': { name: 'Traffico', path: '/articoli-frontaliere/traffico-san-gottardo-attesa', parent: 'blog' },
    'blog-tax-free-come-cresce': { name: 'Economia', path: '/articoli-frontaliere/tax-free-come-cresce', parent: 'blog' },
    'blog-traffico-san-gottardo-pasquetta-2026': { name: 'Traffico Gottardo', path: '/articoli-frontaliere/traffico-san-gottardo-pasquetta-2026', parent: 'blog' },
    'blog-controlli-auto-immatricolate-grigioni': { name: 'Controlli auto Grigioni', path: '/articoli-frontaliere/controlli-auto-immatricolate-grigioni', parent: 'blog' },
    'blog-locarno-magadino-trasporto': { name: 'Trasporto lacustre', path: '/articoli-frontaliere/locarno-magadino-trasporto', parent: 'blog' },
    'blog-prezzi-benzina-ticino': { name: 'Prezzi benzina', path: '/articoli-frontaliere/prezzi-benzina-ticino', parent: 'blog' },
    'blog-lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone': { name: 'Lavizzara', path: '/articoli-frontaliere/lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone', parent: 'blog' },
    'blog-raffica-chiusure-a9-2026': { name: 'Chiusure e deviazioni sulla A9', path: '/articoli-frontaliere/raffica-chiusure-a9-2026', parent: 'blog' },
    'blog-conflitto-medio-oriente-energia-ticino': { name: 'Energia e rincari', path: '/articoli-frontaliere/conflitto-medio-oriente-energia-ticino', parent: 'blog' },
    'blog-lavoro-notte-lincendio-laveno-mombello': { name: 'Notizie', path: '/articoli-frontaliere/lavoro-notte-lincendio-laveno-mombello', parent: 'blog' },
    'blog-prevenzione-maschile-centro-beccaria': { name: 'Salute', path: '/articoli-frontaliere/prevenzione-maschile-centro-beccaria', parent: 'blog' },
    'blog-controlli-varese-esposto-espulsione': { name: 'Controlli nel cuore di Varese', path: '/articoli-frontaliere/controlli-varese-esposto-espulsione', parent: 'blog' },
    'blog-incidente-arogno-31enne-gravi-condizioni': { name: 'Incidente Arogno', path: '/articoli-frontaliere/incidente-arogno-31enne-gravi-condizioni', parent: 'blog' },
    'blog-carburanti-ticino-aumento-prezzi': { name: 'Prezzi carburanti in Ticino', path: '/articoli-frontaliere/carburanti-ticino-aumento-prezzi', parent: 'blog' },
    'blog-provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026': { name: 'Provincia di Varese: investimenti in', path: '/articoli-frontaliere/provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026', parent: 'blog' },
    'blog-turisti-in-como-ztl': { name: 'La famigliola di turisti investita in ce', path: '/articoli-frontaliere/turisti-in-como-ztl', parent: 'blog' },
    'blog-niederlander-droga-ticino': { name: 'Traffico di droga', path: '/articoli-frontaliere/niederlander-droga-ticino', parent: 'blog' },
    'blog-stop-agli-artigiani-per-caso': { name: 'Economia', path: '/articoli-frontaliere/stop-agli-artigiani-per-caso', parent: 'blog' },
    'blog-incendi-nel-luganese-arrestato-un-piromane': { name: 'Incendi nel Luganese', path: '/articoli-frontaliere/incendi-nel-luganese-arrestato-un-piromane', parent: 'blog' },
    'blog-front-alieri-soci-sagl-nodi-fiscali-2026': { name: 'Frontalieri fiscali', path: '/articoli-frontaliere/front-alieri-soci-sagl-nodi-fiscali-2026', parent: 'blog' },
    'blog-benzina-cara-ticino': { name: 'Benzina più cara in Svizzera', path: '/articoli-frontaliere/benzina-cara-ticino', parent: 'blog' },
  };

  const info = sectionNames[section];
  if (info) {
    if (info.parent && sectionNames[info.parent]) {
      const parentInfo = sectionNames[info.parent];
      const { route: parentRoute } = parsePath(parentInfo.path);
      crumbs.push({
        name: getLocalizedSectionLabel(info.parent, parentInfo.name),
        path: buildPath(parentRoute, locale),
      });
    }
    if (info.path !== '/') {
      const { route: infoRoute } = parsePath(info.path);
      crumbs.push({
        name: getLocalizedSectionLabel(section, info.name),
        path: buildPath(infoRoute, locale),
      });
    }
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": crumb.name,
      "item": `${BASE_URL}${crumb.path}`,
    })),
  };
}

/**
 * Check if the non-IT locale translation chunk has been loaded.
 * IT is always available synchronously via it-critical.ts.
 * For other locales, we test a known core key — if it returns the
 * Italian fallback, the locale chunk hasn't loaded yet.
 */
function isLocaleChunkLoaded(locale: Locale): boolean {
  if (locale === 'it') return true;
  const testKey = 'nav.simulator';
  const value = t(testKey);
  const italianFallbacks = new Set(['Calcolatore', testKey]);
  return !italianFallbacks.has(value);
}

/**
 * Updates document meta tags dynamically.
 * Uses the i18n router to build locale-aware canonical and hreflang URLs.
 */
export async function updateMetaTags(section: string): Promise<void> {
  // If the non-IT locale chunk hasn't loaded yet, t() falls back to Italian.
  // Preserve the correct static HTML metadata until the chunk arrives.
  const currentLocale = getLocale();
  if (currentLocale !== 'it' && !isLocaleChunkLoaded(currentLocale)) {
    return;
  }

  loadSerpExperimentState();
  const sectionKey = section.startsWith('jobboard-') ? 'jobboard' : section;
  const metadata = await getSeoEntry(sectionKey);

  // Build locale-aware canonical path from current URL
  const { route, locale: pathLocale } = parsePath(window.location.pathname);
  if (getLocale() !== pathLocale) {
    setLocale(pathLocale);
  }
  const locale = pathLocale;
  const localePath = buildPath(route, locale);
  const canonicalLocalePath = withTrailingSlashPath(localePath);
  const pathnameSnapshot = window.location.pathname;
  const isJobDetailPage = section.startsWith('jobboard-') && Boolean(route.jobSlug);
  const isBlogArticle = section.startsWith('blog-');
  const blogArticleId = isBlogArticle ? section.slice(5) : '';
  const jobSeo = isJobDetailPage && route.jobSlug
    ? await resolveJobSeoBySlug(route.jobSlug, locale, canonicalLocalePath)
    : null;
  if (window.location.pathname !== pathnameSnapshot) return;

  // FRO: Expired job soft-landing pages — preserve static HTML metadata.
  // When the SPA loads on an expired job URL, the build plugin already injected
  // correct title, meta description, canonical, and JobPosting JSON-LD into the
  // static HTML. If the job is NOT in the active dataset (jobSeo === null) and
  // the build plugin seeded expired job data, skip all dynamic metadata updates
  // to prevent overwriting with generic listing-page defaults.
  if (isJobDetailPage && !jobSeo) {
    try {
      const expiredData = (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
      if (expiredData && typeof expiredData === 'object' && 'slug' in (expiredData as Record<string, unknown>)) {
        return; // Preserve static HTML metadata for expired job pages
      }
    } catch { /* SSR or missing — continue with dynamic metadata */ }
    // For active job detail pages where the job couldn't be resolved from
    // /data/jobs.json (async load race, or job not in the global dataset),
    // preserve whatever metadata JobBoard.tsx already set (title, OG tags,
    // canonical with job slug) instead of overwriting with generic listing
    // defaults like "Offerte di Lavoro per Frontalieri".
    return;
  }

  const localizedTitle = isBlogArticle ? t(`blog.article.${blogArticleId}.title`) : '';
  const localizedExcerpt = isBlogArticle ? t(`blog.article.${blogArticleId}.excerpt`) : '';
  const localizedImageAlt = isBlogArticle ? t(`blog.article.${blogArticleId}.imageAlt`) : '';

  const hasLocalizedTitle = isBlogArticle && localizedTitle !== `blog.article.${blogArticleId}.title`;
  const hasLocalizedExcerpt = isBlogArticle && localizedExcerpt !== `blog.article.${blogArticleId}.excerpt`;
  const hasLocalizedImageAlt = isBlogArticle && localizedImageAlt !== `blog.article.${blogArticleId}.imageAlt`;

  const isDialectPage = section === 'dialetto';
  const localizedSeoContent = resolveLocalizedSeoContent(sectionKey, metadata, locale);
  const dialectTitleByLocale: Record<Locale, string> = {
    it: 'Dialetto Ticinese | 64 Espressioni e Proverbi | Frontaliere Ticino',
    en: 'Ticinese Dialect | 64 Expressions and Proverbs | Frontaliere Ticino',
    de: 'Tessiner Dialekt: 64 Ausdrücke, Redewendungen und Sprichwörter',
    fr: 'Dialecte tessinois | 64 expressions et proverbes | Frontaliere Ticino',
  };
  const dialectDescriptionByLocale: Record<Locale, string> = {
    it: 'Scopri 64 parole, espressioni e proverbi del dialetto ticinese. Saluti, cibo, lavoro, natura e proverbi per la vita da frontaliere.',
    en: 'Discover 64 words, expressions and proverbs from Ticinese dialect. Greetings, food, work and nature terms for cross-border life.',
    de: 'Tessiner Dialekt lernen: 64 Wörter, Ausdrücke und Sprichwörter aus dem Tessin. Grüsse, Essen, Arbeit und Natur — für Grenzgänger im Alltag.',
    fr: 'Découvrez 64 mots, expressions et proverbes du dialecte tessinois pour la vie quotidienne des frontaliers.',
  };

  // Dynamic job count for the main job board listing page title.
  // At runtime, replace the static "Offerte di Lavoro Ticino 2026" with
  // a count like "1500+ Offerte di Lavoro Ticino 2026" when data is available.
  const isJobboardListing = sectionKey === 'jobboard' && !isJobDetailPage;
  let jobCountLabel: string | null = null;
  if (isJobboardListing) {
    try { jobCountLabel = await getActiveJobCountLabel(); } catch { /* keep null */ }
  }

  const baseMetaTitle = jobSeo
    ? jobSeo.title
    : isDialectPage
      ? dialectTitleByLocale[locale]
      : isJobboardListing && jobCountLabel && locale === 'it'
        ? `${jobCountLabel} Offerte di Lavoro Ticino ${new Date().getFullYear()} | Aggiornate Ogni Giorno`
        : (hasLocalizedTitle ? localizedTitle : localizedSeoContent.title);
  const baseMetaDescription = jobSeo
    ? jobSeo.description
    : isDialectPage
      ? dialectDescriptionByLocale[locale]
      : isJobboardListing && jobCountLabel && locale === 'it'
        ? `Offerte di lavoro Ticino: ${jobCountLabel} posti vacanti aggiornati ogni giorno. Cerca lavoro in banche, tech, farmaceutica e sanità da 100+ aziende. Candidatura diretta.`
        : (hasLocalizedExcerpt ? localizedExcerpt : localizedSeoContent.description);
  // Never apply SERP experiment suffixes ("| simulazione | 2026") to individual
  // job detail pages — these have their own structured title pattern:
  // "{JobTitle} — {Company} | Frontaliere Ticino"
  const serpVariant = isJobDetailPage
    ? { title: baseMetaTitle, description: baseMetaDescription, variant: 'control' as const }
    : applySerpTitleDescriptionVariant(
      section,
      canonicalLocalePath,
      locale,
      baseMetaTitle,
      baseMetaDescription,
    );
  const metaTitle = serpVariant.title;
  const metaDescription = serpVariant.description;
  const metaOgTitle = metaTitle;
  const metaOgDescription = metaDescription;
  const metaKeywords = jobSeo
    ? jobSeo.keywords
    : (isBlogArticle && locale !== 'it' && hasLocalizedTitle)
    ? `${metaOgTitle}, ${locale === 'fr' ? 'travailleurs frontaliers tessin, salaire net suisse, impots frontalier, cout de la vie lugano' : locale === 'de' ? 'grenzgaenger tessin, nettolohn schweiz, steuern grenzgaenger, lebenshaltungskosten lugano' : 'cross-border workers ticino, swiss net salary, cross-border taxes, cost of living lugano'}`
    : localizedSeoContent.keywords;

  lastSerpExposureContext = {
    section,
    path: canonicalLocalePath,
    variant: serpVariant.variant,
  };

  // Update title
  document.title = metaTitle;

  // Update or create meta tags
  updateOrCreateMetaTag('name', 'description', metaDescription);
  updateOrCreateMetaTag('name', 'keywords', metaKeywords);

  // Bing & AI-friendly directives: allow large snippets and image previews
  updateOrCreateMetaTag('name', 'robots', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

  // Update Open Graph tags (used by Bing, Facebook, LinkedIn)
  updateOrCreateMetaTag('property', 'og:title', metaOgTitle);
  updateOrCreateMetaTag('property', 'og:description', metaOgDescription);
  updateOrCreateMetaTag('property', 'og:url', `${BASE_URL}${canonicalLocalePath}`);
  updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
  updateOrCreateMetaTag('property', 'og:type', (isBlogArticle || isJobDetailPage) ? 'article' : 'website');
  updateOrCreateMetaTag('property', 'og:site_name', 'Frontaliere Ticino');

  // Use article-specific image for blog posts, generic OG image for other pages
  if (isBlogArticle && metadata.structuredData && !Array.isArray(metadata.structuredData)) {
    const sd = metadata.structuredData as Record<string, any>;
    const imgUrl = typeof sd.image === 'string' ? sd.image : sd.image?.url;
    if (imgUrl) {
      const resolvedImgUrl = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
      updateOrCreateMetaTag('property', 'og:image', resolvedImgUrl);
      const imgW = typeof sd.image === 'object' ? String(sd.image.width ?? '1344') : '1200';
      const imgH = typeof sd.image === 'object' ? String(sd.image.height ?? '756') : '630';
      updateOrCreateMetaTag('property', 'og:image:width', imgW);
      updateOrCreateMetaTag('property', 'og:image:height', imgH);
      const imgAlt = hasLocalizedImageAlt
        ? localizedImageAlt
        : typeof sd.image === 'object'
          ? (sd.image.caption || metaOgTitle)
          : metaOgTitle;
      updateOrCreateMetaTag('property', 'og:image:alt', imgAlt);
      updateOrCreateMetaTag('name', 'twitter:image', resolvedImgUrl);
    } else {
      updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
      updateOrCreateMetaTag('property', 'og:image:width', '1200');
      updateOrCreateMetaTag('property', 'og:image:height', '630');
      updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
    }
  } else {
    if (jobSeo) {
      // Use branded og-image.png (1200×630) instead of tiny company logos (128px).
      // Google News/Discover require ≥1200px; social platforms recommend ≥600px.
      updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
      updateOrCreateMetaTag('property', 'og:image:width', '1200');
      updateOrCreateMetaTag('property', 'og:image:height', '630');
      updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
      updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
    } else {
      updateOrCreateMetaTag('property', 'og:image', `${BASE_URL}/og-image.png`);
      updateOrCreateMetaTag('property', 'og:image:width', '1200');
      updateOrCreateMetaTag('property', 'og:image:height', '630');
      updateOrCreateMetaTag('property', 'og:image:alt', metaOgTitle);
      updateOrCreateMetaTag('name', 'twitter:image', `${BASE_URL}/og-image.png`);
    }
  }

  // Article-specific OG tags for Google News & Bing News indexing
  if (isBlogArticle && metadata.structuredData && !Array.isArray(metadata.structuredData)) {
    const sd = metadata.structuredData as Record<string, any>;
    if (sd.datePublished) updateOrCreateMetaTag('property', 'article:published_time', sd.datePublished);
    if (sd.dateModified) updateOrCreateMetaTag('property', 'article:modified_time', sd.dateModified);
    if (sd.articleSection) updateOrCreateMetaTag('property', 'article:section', sd.articleSection);
    updateOrCreateMetaTag('property', 'article:author', `${BASE_URL}/chi-siamo/`);
  } else {
    // Remove article OG tags for non-article pages
    ['article:published_time', 'article:modified_time', 'article:section', 'article:author'].forEach(prop => {
      const el = document.querySelector(`meta[property="${prop}"]`);
      if (el) el.remove();
    });
  }

  // Update Twitter Card tags
  updateOrCreateMetaTag('name', 'twitter:card', 'summary_large_image');
  updateOrCreateMetaTag('name', 'twitter:title', metaOgTitle);
  updateOrCreateMetaTag('name', 'twitter:description', metaOgDescription);
  updateOrCreateMetaTag('name', 'twitter:url', `${BASE_URL}${canonicalLocalePath}`);

  // Update canonical URL (uses current locale path)
  updateCanonicalLink(`${BASE_URL}${canonicalLocalePath}`);

  // Update hreflang tags with locale-specific paths
  updateHreflangTags(route);

  // Update structured data if provided, always include breadcrumbs
  const breadcrumbs = buildBreadcrumbs(sectionKey, route, locale, hasLocalizedTitle ? localizedTitle : undefined);
  if (jobSeo?.structuredData) {
    updateStructuredData([jobSeo.structuredData, breadcrumbs]);
  } else if (metadata.structuredData) {
    const existingData = Array.isArray(metadata.structuredData)
      ? metadata.structuredData
      : [metadata.structuredData];
    const localizedData = existingData.map(item => {
      const clone = JSON.parse(JSON.stringify(item)) as Record<string, any>;
      if (clone && typeof clone === 'object') {
        clone.inLanguage = locale;
        if (typeof clone.url === 'string' && clone.url.startsWith(BASE_URL)) clone.url = `${BASE_URL}${canonicalLocalePath}`;
        if (typeof clone.mainEntityOfPage === 'string' && clone.mainEntityOfPage.startsWith(BASE_URL)) {
          clone.mainEntityOfPage = `${BASE_URL}${canonicalLocalePath}`;
        }
        if (isBlogArticle) {
          if (hasLocalizedTitle && typeof clone.headline === 'string') clone.headline = metaOgTitle;
          if (hasLocalizedExcerpt && typeof clone.description === 'string') clone.description = metaDescription;
          if (hasLocalizedImageAlt && clone.image && typeof clone.image === 'object') clone.image.caption = localizedImageAlt;
        }
        if (!isBlogArticle) {
          if (typeof clone.name === 'string') clone.name = metaOgTitle.replace(' | Frontaliere Ticino', '');
          if (typeof clone.headline === 'string') clone.headline = metaOgTitle;
          if (typeof clone.description === 'string') clone.description = metaDescription;
        }
        if (isDialectPage) {
          if (typeof clone.name === 'string') clone.name = metaOgTitle.replace(' | Frontaliere Ticino', '');
          if (typeof clone.description === 'string') clone.description = metaDescription;
        }
        if (clone['@type'] === 'FAQPage' && locale !== 'it') {
          translateFaqPage(clone, locale as 'en' | 'de' | 'fr');
        }
        if (clone['@type'] === 'HowTo' && locale !== 'it') {
          translateHowToSchema(clone, locale as 'en' | 'de' | 'fr');
        }
      }
      return clone;
    });
    // Filter out redundant WebPage schemas when more specific types exist.
    // Bing flags "conflicting markups" when WebPage coexists with FAQPage,
    // WebApplication, Dataset, etc. on the same page.
    const SPECIFIC_SD_TYPES = new Set(['FAQPage', 'WebApplication', 'Dataset', 'ItemList', 'Organization', 'Article', 'NewsArticle', 'HowTo', 'Product', 'SoftwareApplication', 'CollectionPage']);
    const hasSpecificSdType = localizedData.some(item => SPECIFIC_SD_TYPES.has(String(item?.['@type'] || '')));
    const filteredData = hasSpecificSdType
      ? localizedData.filter(item => String(item?.['@type'] || '') !== 'WebPage')
      : localizedData;
    updateStructuredData([...filteredData, breadcrumbs]);
  } else {
    updateStructuredData(breadcrumbs);
  }
}

/**
 * Update document language attribute and OG locale based on current i18n locale
 */
export function updateDocumentLanguage(locale: string): void {
  document.documentElement.lang = locale;
  updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
}

/**
 * Get OG locale format from current document lang
 */
function getOgLocale(): string {
  const lang = document.documentElement.lang || 'it';
  const localeMap: Record<string, string> = {
    'it': 'it_IT', 'en': 'en_US', 'de': 'de_CH', 'fr': 'fr_CH',
  };
  return localeMap[lang] || 'it_IT';
}

/**
 * Update hreflang link tags for multilingual SEO.
 * Now uses locale-specific paths from the i18n router
 * instead of ?lang= query parameters.
 */
function updateHreflangTags(route: import('./router').AppRoute): void {
  // Remove existing hreflang tags
  document.querySelectorAll('link[hreflang]').forEach(el => el.remove());

  // Get locale-specific paths from the router
  const paths = buildAllLocalePaths(route);

  // Add hreflang for each locale
  (['it', 'en', 'de', 'fr'] as const).forEach((lang) => {
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.hreflang = lang;
    link.href = `${BASE_URL}${withTrailingSlashPath(paths[lang])}`;
    document.head.appendChild(link);
  });

  // Add x-default (Italian as default)
  const xDefault = document.createElement('link');
  xDefault.rel = 'alternate';
  xDefault.setAttribute('hreflang', 'x-default');
  xDefault.href = `${BASE_URL}${withTrailingSlashPath(paths.it)}`;
  document.head.appendChild(xDefault);
}

function withTrailingSlashPath(path: string): string {
  if (!path || path === '/') return '/';
  const clean = path.replace(/\/+$/, '');
  return clean ? `${clean}/` : '/';
}

/**
 * Helper function to update or create meta tags
 */
function updateOrCreateMetaTag(attrName: string, attrValue: string, content: string): void {
  let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);

  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.appendChild(element);
  }

  element.setAttribute('content', content);
}

/**
 * Update canonical link
 */
function updateCanonicalLink(url: string): void {
  let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;

  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }

  canonical.href = url;
}

/**
 * Update structured data (JSON-LD)
 */
function updateStructuredData(data: Record<string, any> | Record<string, any>[]): void {
  // Remove only dynamically-injected JSON-LD scripts (those with data-dynamic-ld attribute).
  // Preserve static JSON-LD from staticPagesPlugin/ogPagesPlugin so Google always sees
  // structured data even before JS executes.
  document.querySelectorAll('script[type="application/ld+json"][data-dynamic-ld]').forEach(el => el.remove());

  // Collect @type values already present in static JSON-LD (from build plugins).
  // Skip injecting dynamic JSON-LD for types already covered by static scripts
  // to avoid duplicate structured data that confuses Google Rich Results.
  const existingStaticTypes = new Set<string>();
  document.querySelectorAll('script[type="application/ld+json"]:not([data-dynamic-ld])').forEach((el) => {
    try {
      const parsed = JSON.parse(el.textContent || '');
      if (parsed?.['@type']) existingStaticTypes.add(parsed['@type']);
    } catch { /* malformed — ignore */ }
  });

  const items = Array.isArray(data) ? data : [data];
  items.forEach((item, i) => {
    // Skip if a static JSON-LD with the same @type already exists
    if (item?.['@type'] && existingStaticTypes.has(item['@type'])) return;
    const s = document.createElement('script') as HTMLScriptElement;
    s.type = 'application/ld+json';
    s.setAttribute('data-dynamic-ld', 'true');
    if (i === 0) s.id = 'dynamic-structured-data';
    s.textContent = JSON.stringify(item);
    document.head.appendChild(s);
  });
}

/**
 * Apply noindex SEO tags for 404 / not-found pages.
 * Called when the SPA detects an unrecognized route so Google doesn't
 * index the soft-404 as a real page with homepage content.
 *
 * Sets:
 * - robots = noindex
 * - 404-specific title
 * - canonical to self (the current unrecognized URL)
 * - removes hreflang tags (no alternate versions exist)
 * - removes dynamic structured data (no schema for 404 pages)
 */
export function applyNotFoundSeo(path: string): void {
  const notFoundTitle = 'Pagina non trovata — Frontaliere Ticino';

  // Set noindex to prevent Google from indexing this soft-404
  updateOrCreateMetaTag('name', 'robots', 'noindex');

  // Set 404-specific title
  document.title = notFoundTitle;
  updateOrCreateMetaTag('property', 'og:title', notFoundTitle);
  updateOrCreateMetaTag('name', 'description', 'La pagina richiesta non esiste o è stata spostata.');
  updateOrCreateMetaTag('property', 'og:description', 'La pagina richiesta non esiste o è stata spostata.');

  // Set canonical to self (the current URL) so it doesn't point to homepage
  const selfCanonical = `${BASE_URL}${path.replace(/\/+$/, '') || '/'}`;
  updateCanonicalLink(selfCanonical);
  updateOrCreateMetaTag('property', 'og:url', selfCanonical);

  // Remove hreflang tags — no alternate locale versions for a 404 page
  document.querySelectorAll('link[hreflang]').forEach(el => el.remove());

  // Remove dynamically-injected structured data — no schema for 404 pages
  document.querySelectorAll('script[type="application/ld+json"][data-dynamic-ld]').forEach(el => el.remove());
}

/**
 * Track section view for analytics
 */
export function trackSectionView(_section: string): void {
  const context = lastSerpExposureContext;
  if (!context || context.variant === 'control') return;
  if (typeof window === 'undefined') return;

  const dedupeKey = `seo-serp-exp:${context.path}:${context.variant}`;
  try {
    if (window.sessionStorage.getItem(dedupeKey)) return;
    window.sessionStorage.setItem(dedupeKey, '1');
  } catch {
    // Continue without dedupe if storage is unavailable
  }

  const { fromSearch, host } = isSearchReferrer();
  import('./analytics')
    .then((m) => m.Analytics.trackSerpExperimentExposure(context.variant, context.section, context.path, fromSearch, host))
    .catch(() => undefined);
}
