import { beforeEach, describe, expect, it } from 'vitest';
import {
  areJobBoardSearchResumesEqual,
  buildJobBoardSearchResume,
  clearJobBoardSearchResume,
  countJobBoardSearchResumeFilters,
  hasUsefulJobBoardSearchResume,
  readJobBoardSearchResume,
  shouldOfferJobBoardSearchResume,
  writeJobBoardSearchResume,
  type JobBoardSearchResumeStorage,
} from '@/services/jobBoardSearchResume';

const SAVED_AT = Date.parse('2026-10-20T10:00:00.000Z');

function search(overrides: Partial<{
  keyword: string;
  canton: string;
  category: string;
  contract: string;
  company: string;
  dateRange: string;
  location: string;
  sector: string;
  routeSlug: string | null;
}> = {}) {
  return buildJobBoardSearchResume({
    keyword: 'infermiere',
    canton: 'TI',
    category: 'health',
    contract: 'part-time',
    company: 'ospedale regionale',
    dateRange: '7d',
    location: 'lugano',
    sector: 'sanità',
    ...overrides,
  }, SAVED_AT);
}

function memoryStorage(initial: string | null = null): JobBoardSearchResumeStorage & { value: () => string | null } {
  let stored = initial;
  return {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
    removeItem: () => { stored = null; },
    value: () => stored,
  };
}

describe('job board search resume', () => {
  beforeEach(() => clearJobBoardSearchResume(null));

  it('keeps the exact supported query, canton and filter values', () => {
    const saved = search();
    expect(saved).toMatchObject({
      keyword: 'infermiere',
      canton: 'TI',
      category: 'health',
      contract: 'part-time',
      company: 'ospedale regionale',
      dateRange: '7d',
      location: 'lugano',
      sector: 'sanità',
    });
    expect(hasUsefulJobBoardSearchResume(saved)).toBe(true);
    expect(countJobBoardSearchResumeFilters(saved!)).toBe(6);
  });

  it('does not save a canton-only visit as a useful search', () => {
    const browse = search({
      keyword: '',
      category: 'all',
      contract: 'all',
      company: 'all',
      dateRange: 'all',
      location: 'all',
      sector: 'all',
    });
    expect(browse?.canton).toBe('TI');
    expect(hasUsefulJobBoardSearchResume(browse)).toBe(false);
  });

  it('keeps a city landing distinct from its canton and counts it as a useful filter', () => {
    const citySearch = search({
      keyword: '',
      category: 'all',
      contract: 'all',
      company: 'all',
      dateRange: 'all',
      location: 'all',
      sector: 'all',
      routeSlug: 'localita-basel',
    });

    expect(citySearch).toMatchObject({ canton: 'TI', routeSlug: 'localita-basel' });
    expect(hasUsefulJobBoardSearchResume(citySearch)).toBe(true);
    expect(countJobBoardSearchResumeFilters(citySearch!)).toBe(1);
    expect(search({ routeSlug: 'lavoro-basel' })).toBeNull();
  });

  it('accepts canonical half-canton URL groups with their city landing', () => {
    const baselSearch = search({
      canton: 'BASILEA',
      keyword: 'infermiere',
      routeSlug: 'localita-basel',
    });
    const appenzellSearch = search({
      canton: 'APPENZELLO',
      keyword: 'cuoco',
    });

    expect(baselSearch).toMatchObject({ canton: 'BASILEA', routeSlug: 'localita-basel' });
    expect(appenzellSearch).toMatchObject({ canton: 'APPENZELLO' });
  });

  it('rejects unknown filter values and prevents a locality from becoming a canton', () => {
    expect(search({ canton: 'lugano' })).toBeNull();
    expect(search({ canton: 'XX' })).toBeNull();
    expect(search({ category: 'nursing' })).toBeNull();
    expect(search({ dateRange: 'yesterday' })).toBeNull();
  });

  it('round-trips through storage and clears persistent and in-memory copies', () => {
    const storage = memoryStorage();
    const saved = search()!;

    expect(writeJobBoardSearchResume(saved, storage)).toBe(true);
    expect(storage.value()).toContain('"version":1');
    const read = readJobBoardSearchResume(storage, SAVED_AT + 10);
    expect(read).not.toBeNull();
    expect(areJobBoardSearchResumesEqual(read, saved)).toBe(true);

    expect(clearJobBoardSearchResume(storage)).toBe(true);
    expect(storage.value()).toBeNull();
    expect(readJobBoardSearchResume(null)).toBeNull();
  });

  it('contains blocked storage errors and keeps the search available in memory', () => {
    const blocked: JobBoardSearchResumeStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const saved = search()!;

    expect(writeJobBoardSearchResume(saved, blocked)).toBe(false);
    expect(areJobBoardSearchResumesEqual(readJobBoardSearchResume(blocked, SAVED_AT + 10), saved)).toBe(true);
    expect(clearJobBoardSearchResume(blocked)).toBe(false);
    expect(readJobBoardSearchResume(null)).toBeNull();
  });

  it('keeps a failed write in memory and persists a clear marker when remove is blocked', () => {
    const saved = search()!;
    const writeBlocked: JobBoardSearchResumeStorage = {
      getItem: () => JSON.stringify(search({ keyword: 'older search' })),
      setItem: () => { throw new Error('blocked write'); },
      removeItem: () => undefined,
    };
    const newer = search({ keyword: 'newer search' })!;
    expect(writeJobBoardSearchResume(newer, writeBlocked)).toBe(false);
    expect(areJobBoardSearchResumesEqual(readJobBoardSearchResume(writeBlocked, SAVED_AT + 10), newer)).toBe(true);

    const removeBlocked = memoryStorage(JSON.stringify(saved)) as JobBoardSearchResumeStorage & { value: () => string | null };
    removeBlocked.removeItem = () => { throw new Error('blocked remove'); };
    expect(clearJobBoardSearchResume(removeBlocked)).toBe(true);
    expect(JSON.parse(removeBlocked.value() || '{}')).toMatchObject({ version: 1, cleared: true });
    expect(readJobBoardSearchResume(removeBlocked, SAVED_AT + 10)).toBeNull();
  });

  it('offers only a different saved search, and requires route support across cantons', () => {
    const saved = search({ canton: 'ZH', routeSlug: 'location-basel' })!;
    const current = search({ canton: 'TI' })!;

    expect(shouldOfferJobBoardSearchResume({
      saved,
      current: { ...saved, savedAt: SAVED_AT + 1 },
      currentCanton: 'ZH',
      currentRouteSlug: 'location-basel',
      canChangeRoute: true,
    })).toBe(false);
    expect(shouldOfferJobBoardSearchResume({
      saved,
      current,
      currentCanton: 'TI',
      currentRouteSlug: null,
      canChangeRoute: false,
    })).toBe(false);
    expect(shouldOfferJobBoardSearchResume({
      saved,
      current,
      currentCanton: 'TI',
      currentRouteSlug: null,
      canChangeRoute: true,
    })).toBe(true);
    expect(shouldOfferJobBoardSearchResume({
      saved,
      current: search({ canton: 'ZH', routeSlug: 'location-basel', keyword: 'designer' }),
      currentCanton: 'ZH',
      currentRouteSlug: 'location-basel',
      canChangeRoute: false,
    })).toBe(true);
  });
});
