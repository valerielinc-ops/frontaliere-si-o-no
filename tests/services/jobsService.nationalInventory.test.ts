import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGGREGATE_CANTON_CODE, fetchJobsForCanton } from '../../services/jobsService';
import { selectJobBoardInventory } from '../../services/jobBoardInventory';

const inventory = [
  { id: 'ticino', canton: 'TI' },
  { id: 'st-gallen', canton: 'SG' },
  { id: 'aargau', canton: 'AG' },
  { id: 'jura', canton: 'JU' },
  { id: 'unassigned' },
  { id: 'st-gallen', canton: 'SG' },
];

afterEach(() => vi.unstubAllGlobals());

describe('national job-board inventory', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('loads every canton from the same %s slim snapshot used by SEO', async (locale) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(inventory), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await fetchJobsForCanton(AGGREGATE_CANTON_CODE, locale);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/data/jobs-${locale}-index.json`);
    expect(loaded).toEqual(inventory);
    expect(selectJobBoardInventory(loaded, AGGREGATE_CANTON_CODE).map((job) => job.id))
      .toEqual(['ticino', 'st-gallen', 'aargau', 'jura', 'unassigned']);
  });

  it('continues to fetch only the requested shard for a canton route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([inventory[0]]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('indexedDB', undefined);

    expect(await fetchJobsForCanton('TI', 'it')).toEqual([inventory[0]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/data/jobs-by-canton/TI-it.json');
  });
});
