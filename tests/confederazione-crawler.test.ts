import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNationalListings } from '../scripts/update-confederazione-jobs.mjs';

describe('Confederazione national pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails when a repeated page does not add unique source records', async () => {
    const repeatedRecord = {
      id: 'federal-1',
      viewkey: 'federal-1',
      title: 'Posto federale',
      attributes: { arbeitsort: ['Lugano'], region: ['Ticino'] },
      szas: {},
      links: { directlink: 'https://jobs.admin.ch/it/lugano/federal-1' },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      total: 2,
      jobs: [repeatedRecord],
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchNationalListings()).rejects.toThrow(/repeated source identity|no unique progress/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
