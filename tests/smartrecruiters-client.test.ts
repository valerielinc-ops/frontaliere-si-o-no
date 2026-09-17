import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSmartRecruitersJobs } from '../scripts/lib/ats-clients/smartrecruiters-client.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SmartRecruiters strict source pagination', () => {
  it('does not prove a complete source when a repeated page reaches totalFound by raw count', async () => {
    const firstPage = [
      { id: 'posting-a', name: 'Role A', location: { city: 'Zürich', country: { code: 'CH' } } },
      { id: 'posting-b', name: 'Role B', location: { city: 'Basel', country: { code: 'CH' } } },
    ];
    const requestedOffsets: string[] = [];
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      requestedOffsets.push(url.searchParams.get('offset') || '');
      return new Response(JSON.stringify({
        totalFound: 4,
        content: firstPage,
      }), { status: 200 });
    }));

    const rows = [];
    for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
      minDelayMs: 0,
      onComplete: (info) => { outcome = info; },
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(requestedOffsets).toEqual(['0', '2']);
    expect(outcome).toMatchObject({
      terminationProven: false,
      recordsSeen: 2,
      rawRecordsSeen: 4,
      paginationIntegrityProven: false,
      totalFound: 4,
    });
  });
});
