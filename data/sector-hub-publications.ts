export type SectorPublicationLocale = 'it' | 'en' | 'de' | 'fr';

export type SectorHubPublicationStatus = 'active' | 'cooling-off' | 'retired';

export const AUTO_SECTOR_HUB_MIN_JOBS = 5;
export const AUTO_SECTOR_HUB_MIN_EMPLOYERS = 2;

export interface SectorHubPublication {
  slug: string;
  routeKind: 'dynamic' | 'static-category';
  label: string;
  labelByLocale: Partial<Record<SectorPublicationLocale, string>>;
  sourceFields: Array<'category' | 'sector'>;
  matchLabels: string[];
  firstPublishedAt: string;
  status: SectorHubPublicationStatus;
}

export interface SectorHubPublicationRegistry {
  schemaVersion: 1;
  generatedAt: string;
  sourceWeek: string;
  hubs: SectorHubPublication[];
}

export interface SectorHubJobLike {
  id?: unknown;
  slug?: unknown;
  slugByLocale?: Partial<Record<SectorPublicationLocale, string>>;
  title?: unknown;
  titleByLocale?: Partial<Record<SectorPublicationLocale, string>>;
  category?: unknown;
  sector?: unknown;
  company?: unknown;
  companyKey?: unknown;
  companyDomain?: unknown;
  location?: unknown;
  addressLocality?: unknown;
  canton?: unknown;
  description?: unknown;
  descriptionByLocale?: Partial<Record<SectorPublicationLocale, string>>;
  sourceLang?: SectorPublicationLocale;
  contract?: unknown;
  postingDateSource?: unknown;
  postedDate?: unknown;
  datePosted?: unknown;
  firstSeenAt?: unknown;
  crawledAt?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  salarySource?: unknown;
  currency?: unknown;
  url?: unknown;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<SectorPublicationLocale, boolean>>;
}

export function normalizeSectorHubLabel(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/&/g, ' e ').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

export function sectorHubMatchesJob(
  publication: SectorHubPublication,
  job: SectorHubJobLike,
): boolean {
  const labels = new Set(publication.matchLabels.map(normalizeSectorHubLabel).filter(Boolean));
  return publication.sourceFields.some((field) => labels.has(normalizeSectorHubLabel(job[field])));
}

export function isIndexableSectorHubPublication(
  publication: SectorHubPublication,
  activeJobCount: number,
  employerCount: number,
  locale?: SectorPublicationLocale,
): boolean {
  return publication.status === 'active'
    && (locale === undefined || Boolean(publication.labelByLocale[locale]?.trim()))
    && activeJobCount >= AUTO_SECTOR_HUB_MIN_JOBS
    && employerCount >= AUTO_SECTOR_HUB_MIN_EMPLOYERS;
}
