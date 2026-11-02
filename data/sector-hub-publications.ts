export type SectorPublicationLocale = 'it' | 'en' | 'de' | 'fr';

export type SectorHubPublicationStatus = 'active' | 'cooling-off' | 'retired';

export const AUTO_SECTOR_HUB_MIN_JOBS = 5;
export const AUTO_SECTOR_HUB_MIN_EMPLOYERS = 2;
// Recovery uses the existing "promising candidate" inventory floor as a
// hysteresis band above first publication. A retired page needs headroom to
// return automatically, so small 4/5 inventory swings do not oscillate.
export const AUTO_SECTOR_HUB_REACTIVATION_MIN_JOBS = 8;
export const AUTO_SECTOR_HUB_REACTIVATION_MIN_EMPLOYERS = 3;
export const AUTO_SECTOR_HUB_REACTIVATION_MIN_WEEKS = 2;

export interface SectorHubPublication {
  slug: string;
  routeKind: 'dynamic' | 'static-category';
  label: string;
  labelByLocale: Partial<Record<SectorPublicationLocale, string>>;
  sourceFields: Array<'category' | 'sector'>;
  matchLabels: string[];
  firstPublishedAt: string;
  status: SectorHubPublicationStatus;
  /**
   * A non-empty value marks an explicit, owner-directed retirement and blocks
   * automatic recovery. Omit it for retirements produced by the inventory
   * lifecycle; legacy retired entries without this field are automatic.
   */
  retirementReason?: string;
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
  const automaticallyRecovered = publication.status === 'retired'
    && !publication.retirementReason?.trim()
    && activeJobCount >= AUTO_SECTOR_HUB_REACTIVATION_MIN_JOBS
    && employerCount >= AUTO_SECTOR_HUB_REACTIVATION_MIN_EMPLOYERS;
  return !publication.retirementReason?.trim()
    && (publication.status === 'active' || automaticallyRecovered)
    && (locale === undefined || Boolean(publication.labelByLocale[locale]?.trim()))
    && activeJobCount >= AUTO_SECTOR_HUB_MIN_JOBS
    && employerCount >= AUTO_SECTOR_HUB_MIN_EMPLOYERS;
}
