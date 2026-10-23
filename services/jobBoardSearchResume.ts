import { CANTON_CODES } from './cantonList';
import { CANTON_URL_SLUGS, JOB_BOARD_CANTON_AGGREGATE } from './jobBoardSlugs';

export const JOB_BOARD_SEARCH_RESUME_STORAGE_KEY = 'frontaliere_job_board_search_resume_v1';
export const JOB_BOARD_SEARCH_RESUME_VERSION = 1 as const;

const MAX_KEYWORD_LENGTH = 160;
const MAX_FILTER_VALUE_LENGTH = 120;
const CATEGORIES = new Set(['all', 'tech', 'finance', 'health', 'engineering', 'admin', 'hospitality', 'sales', 'other']);
const CONTRACTS = new Set(['all', 'full-time', 'part-time', 'temporary', 'contract', 'internship']);
const DATE_RANGES = new Set(['all', '24h', '3d', '7d', '30d', '90d']);
const VALID_CANTONS = new Set([
  ...CANTON_CODES,
  ...Object.keys(CANTON_URL_SLUGS.cantonGroups ?? {}),
  JOB_BOARD_CANTON_AGGREGATE,
]);
const LOCATION_ROUTE_SLUG = /^(?:localita|location|standort|localite)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface JobBoardSearchResumeInput {
  keyword: string;
  canton: string;
  category: string;
  contract: string;
  company: string;
  dateRange: string;
  location: string;
  sector: string;
  /** A supported city listing route, kept separate from the canton scope. */
  routeSlug?: string | null;
}

export interface JobBoardSearchResume extends Omit<JobBoardSearchResumeInput, 'routeSlug'> {
  routeSlug: string | null;
  version: typeof JOB_BOARD_SEARCH_RESUME_VERSION;
  savedAt: number;
}

export interface JobBoardSearchResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let volatileResumeSearch: JobBoardSearchResume | null = null;
let volatileResumeSearchCleared = false;
let volatileResumeSearchDirty = false;

function normalizeText(value: unknown, maxLength: number, lowerCase = false): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return lowerCase ? trimmed.toLocaleLowerCase('en') : trimmed;
}

function normalizeEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function normalizeCanton(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return VALID_CANTONS.has(normalized) ? normalized : null;
}

/**
 * Build a storage-safe snapshot from the exact JobBoard controls. The canton
 * must be a recognized canton route (or the existing aggregate sentinel), so
 * a city/locality can never be restored as a canton.
 */
export function buildJobBoardSearchResume(
  input: JobBoardSearchResumeInput,
  savedAt = Date.now(),
): JobBoardSearchResume | null {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;

  const keyword = normalizeText(input.keyword, MAX_KEYWORD_LENGTH);
  const canton = normalizeCanton(input.canton);
  const category = normalizeEnum(input.category, CATEGORIES);
  const contract = normalizeEnum(input.contract, CONTRACTS);
  const dateRange = normalizeEnum(input.dateRange, DATE_RANGES);
  const company = input.company === 'all' ? 'all' : normalizeText(input.company, MAX_FILTER_VALUE_LENGTH, true);
  const location = input.location === 'all' ? 'all' : normalizeText(input.location, MAX_FILTER_VALUE_LENGTH, true);
  const sector = input.sector === 'all' ? 'all' : normalizeText(input.sector, MAX_FILTER_VALUE_LENGTH, true);
  const routeSlug = input.routeSlug == null || input.routeSlug === ''
    ? null
    : normalizeText(input.routeSlug, MAX_FILTER_VALUE_LENGTH);

  if (
    keyword === null
    || canton === null
    || category === null
    || contract === null
    || dateRange === null
    || company === null
    || location === null
    || sector === null
    || (input.routeSlug != null && input.routeSlug !== '' && (routeSlug === null || !LOCATION_ROUTE_SLUG.test(routeSlug)))
  ) return null;

  return {
    version: JOB_BOARD_SEARCH_RESUME_VERSION,
    savedAt,
    keyword,
    canton,
    category,
    contract,
    company,
    dateRange,
    location,
    sector,
    routeSlug,
  };
}

export function hasUsefulJobBoardSearchResume(search: JobBoardSearchResume | null | undefined): search is JobBoardSearchResume {
  if (!search) return false;
  return Boolean(
    search.keyword
    || search.category !== 'all'
    || search.contract !== 'all'
    || search.company !== 'all'
    || search.dateRange !== 'all'
    || search.location !== 'all'
    || search.sector !== 'all'
    || search.routeSlug !== null,
  );
}

export function countJobBoardSearchResumeFilters(search: JobBoardSearchResume): number {
  return Number(search.category !== 'all')
    + Number(search.contract !== 'all')
    + Number(search.company !== 'all')
    + Number(search.dateRange !== 'all')
    + Number(search.location !== 'all' || search.routeSlug !== null)
    + Number(search.sector !== 'all');
}

export function areJobBoardSearchResumesEqual(
  left: JobBoardSearchResume | null | undefined,
  right: JobBoardSearchResume | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.keyword === right.keyword
    && left.canton === right.canton
    && left.category === right.category
    && left.contract === right.contract
    && left.company === right.company
    && left.dateRange === right.dateRange
    && left.location === right.location
    && left.sector === right.sector
    && left.routeSlug === right.routeSlug;
}

export function shouldOfferJobBoardSearchResume(options: {
  saved: JobBoardSearchResume | null | undefined;
  current: JobBoardSearchResume | null | undefined;
  currentCanton: string;
  currentRouteSlug?: string | null;
  canChangeRoute: boolean;
}): boolean {
  const { saved, current, currentCanton, currentRouteSlug = null, canChangeRoute } = options;
  if (!hasUsefulJobBoardSearchResume(saved) || areJobBoardSearchResumesEqual(saved, current)) return false;
  return (currentCanton === saved.canton && currentRouteSlug === saved.routeSlug) || canChangeRoute;
}

function parseStoredResumeSearch(raw: string, now: number): JobBoardSearchResume | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== JOB_BOARD_SEARCH_RESUME_VERSION) return null;
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt) || parsed.savedAt <= 0 || parsed.savedAt > now) return null;
    const search = buildJobBoardSearchResume({
      keyword: parsed.keyword as string,
      canton: parsed.canton as string,
      category: parsed.category as string,
      contract: parsed.contract as string,
      company: parsed.company as string,
      dateRange: parsed.dateRange as string,
      location: parsed.location as string,
      sector: parsed.sector as string,
      routeSlug: parsed.routeSlug == null ? null : parsed.routeSlug as string,
    }, parsed.savedAt);
    return hasUsefulJobBoardSearchResume(search) ? search : null;
  } catch {
    return null;
  }
}

/** Safely get browser localStorage. Accessing the property itself can throw. */
export function getJobBoardSearchResumeStorage(): JobBoardSearchResumeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Read a valid saved search; storage errors degrade to this tab's memory copy. */
export function readJobBoardSearchResume(
  storage: JobBoardSearchResumeStorage | null,
  now = Date.now(),
): JobBoardSearchResume | null {
  if (volatileResumeSearchCleared) return null;
  if (volatileResumeSearchDirty) return volatileResumeSearch ? { ...volatileResumeSearch } : null;
  if (!storage) return volatileResumeSearch ? { ...volatileResumeSearch } : null;
  try {
    const raw = storage.getItem(JOB_BOARD_SEARCH_RESUME_STORAGE_KEY);
    if (!raw) return volatileResumeSearch ? { ...volatileResumeSearch } : null;
    try {
      const marker = JSON.parse(raw) as Record<string, unknown>;
      if (marker.version === JOB_BOARD_SEARCH_RESUME_VERSION && marker.cleared === true) {
        volatileResumeSearch = null;
        volatileResumeSearchCleared = true;
        volatileResumeSearchDirty = false;
        return null;
      }
    } catch {
      // The regular parser below rejects malformed storage and can still use
      // this tab's last known copy if it has one.
    }
    const search = parseStoredResumeSearch(raw, now);
    if (search) {
      volatileResumeSearch = search;
      volatileResumeSearchCleared = false;
      volatileResumeSearchDirty = false;
    }
    return search || (volatileResumeSearch ? { ...volatileResumeSearch } : null);
  } catch {
    return volatileResumeSearch ? { ...volatileResumeSearch } : null;
  }
}

/** Persist a useful search. A storage exception is contained and kept in memory. */
export function writeJobBoardSearchResume(
  search: JobBoardSearchResume,
  storage: JobBoardSearchResumeStorage | null,
): boolean {
  if (!hasUsefulJobBoardSearchResume(search)) return false;
  const normalized = buildJobBoardSearchResume(search, search.savedAt);
  if (!normalized) return false;
  volatileResumeSearch = normalized;
  volatileResumeSearchCleared = false;
  volatileResumeSearchDirty = true;
  if (!storage) return false;
  try {
    storage.setItem(JOB_BOARD_SEARCH_RESUME_STORAGE_KEY, JSON.stringify(normalized));
    volatileResumeSearchDirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Clear both persistent and in-memory copies, even if storage is blocked. */
export function clearJobBoardSearchResume(
  storage: JobBoardSearchResumeStorage | null,
): boolean {
  volatileResumeSearch = null;
  volatileResumeSearchCleared = true;
  volatileResumeSearchDirty = true;
  if (!storage) return false;
  try {
    storage.removeItem(JOB_BOARD_SEARCH_RESUME_STORAGE_KEY);
    volatileResumeSearchDirty = false;
    return true;
  } catch {
    // If removal alone is blocked, a tombstone can still prevent the stale
    // saved query from resurfacing on the next visit.
    try {
      storage.setItem(JOB_BOARD_SEARCH_RESUME_STORAGE_KEY, JSON.stringify({
        version: JOB_BOARD_SEARCH_RESUME_VERSION,
        cleared: true,
      }));
      volatileResumeSearchDirty = false;
      return true;
    } catch {
      return false;
    }
  }
}
