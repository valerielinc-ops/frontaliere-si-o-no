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

  it('does not prove a complete source when totalFound changes between pages', async () => {
    const pages = [
      {
        totalFound: 4,
        content: [
          { id: 'posting-a', name: 'Role A', location: { city: 'Zürich', country: { code: 'CH' } } },
          { id: 'posting-b', name: 'Role B', location: { city: 'Basel', country: { code: 'CH' } } },
        ],
      },
      {
        totalFound: 2,
        content: [
          { id: 'posting-c', name: 'Role C', location: { city: 'Lugano', country: { code: 'CH' } } },
          { id: 'posting-d', name: 'Role D', location: { city: 'Bern', country: { code: 'CH' } } },
        ],
      },
    ];
    const requestedOffsets: string[] = [];
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      requestedOffsets.push(url.searchParams.get('offset') || '');
      const page = pages[Math.min(requestedOffsets.length - 1, pages.length - 1)];
      return new Response(JSON.stringify(page), { status: 200 });
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
      rawRecordsSeen: 2,
      paginationIntegrityProven: false,
      totalFound: 4,
    });
  });

  it('does not prove an empty strict source when an empty page has no declared total', async () => {
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200 })));

    const rows = [];
    for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
      minDelayMs: 0,
      onComplete: (info) => { outcome = info; },
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(0);
    expect(outcome).toMatchObject({
      terminationProven: false,
      recordsSeen: 0,
      rawRecordsSeen: 0,
      paginationIntegrityProven: true,
      totalFound: null,
    });
  });

  it.each([-1, 1.5, 'not-a-number', null, ''])('fails when totalFound is present but malformed (%s)', async (malformedTotal) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      totalFound: malformedTotal,
      content: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      const rows = [];
      for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
        minDelayMs: 0,
        onComplete: () => {},
      })) {
        rows.push(row);
      }
      return rows;
    };

    await expect(consume()).rejects.toThrow(/malformed totalFound/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not prove a strict source when totalFound is smaller than unique rows', async () => {
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      totalFound: 0,
      content: [{ id: 'posting-a', name: 'Role A', location: { city: 'Lugano', country: { code: 'CH' } } }],
    }), { status: 200 })));

    const rows = [];
    for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
      minDelayMs: 0,
      onComplete: (info) => { outcome = info; },
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(0);
    expect(outcome).toMatchObject({
      terminationProven: false,
      recordsSeen: 1,
      rawRecordsSeen: 1,
      paginationIntegrityProven: false,
      totalFound: 0,
    });
  });

  it('fails when a later page corrupts an earlier valid total', async () => {
    const pages = [
      {
        totalFound: 2,
        content: [{ id: 'posting-a', name: 'Role A', location: { city: 'Lugano', country: { code: 'CH' } } }],
      },
      {
        totalFound: -1,
        content: [{ id: 'posting-b', name: 'Role B', location: { city: 'Zürich', country: { code: 'CH' } } }],
      },
    ];
    const requestedOffsets: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      const offset = url.searchParams.get('offset') || '';
      requestedOffsets.push(offset);
      return new Response(JSON.stringify(pages[Math.min(requestedOffsets.length - 1, pages.length - 1)]), { status: 200 });
    }));

    const consume = async () => {
      const rows = [];
      for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
        minDelayMs: 0,
        onComplete: () => {},
      })) {
        rows.push(row);
      }
      return rows;
    };

    await expect(consume()).rejects.toThrow(/malformed totalFound/);
    expect(requestedOffsets).toEqual(['0', '1']);
  });

  it('does not prove a strict short page when totalFound is undeclared', async () => {
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ id: 'posting-a', name: 'Role A', location: { city: 'Lugano', country: { code: 'CH' } } }],
    }), { status: 200 })));

    const rows = [];
    for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
      minDelayMs: 0,
      onComplete: (info) => { outcome = info; },
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(outcome).toMatchObject({
      terminationProven: false,
      recordsSeen: 1,
      rawRecordsSeen: 1,
      paginationIntegrityProven: true,
      totalFound: null,
    });
  });

  it('does not prove a later empty page after a full undeclared page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `posting-${index}`,
      name: `Role ${index}`,
      location: { city: 'Lugano', country: { code: 'CH' } },
    }));
    const requestedOffsets: string[] = [];
    let outcome: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      const offset = url.searchParams.get('offset') || '';
      requestedOffsets.push(offset);
      return new Response(JSON.stringify({
        content: offset === '0' ? firstPage : [],
      }), { status: 200 });
    }));

    const rows = [];
    for await (const row of fetchSmartRecruitersJobs('Avaloq1', {
      minDelayMs: 0,
      onComplete: (info) => { outcome = info; },
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(100);
    expect(requestedOffsets).toEqual(['0', '100']);
    expect(outcome).toMatchObject({
      terminationProven: false,
      recordsSeen: 100,
      rawRecordsSeen: 100,
      paginationIntegrityProven: true,
      totalFound: null,
    });
  });
});
