import { describe, expect, it } from 'vitest';

import { parsePaginatedJobLines } from '../scripts/ci/pr-autorebase.mjs';

describe('parsePaginatedJobLines', () => {
  it('flattens one JSON job emitted per line across paginated API pages', () => {
    const pageOne = { id: 101, name: 'vitest', status: 'completed' };
    const pageTwo = { id: 202, name: 'vitest', status: 'in_progress' };
    const raw = `${JSON.stringify(pageOne)}\n${JSON.stringify(pageTwo)}\n`;

    expect(parsePaginatedJobLines(raw)).toEqual([pageOne, pageTwo]);
  });

  it('returns no jobs for an empty response', () => {
    expect(parsePaginatedJobLines(' \n')).toEqual([]);
  });

  it('fails closed when a paginated response contains malformed JSON', () => {
    expect(() => parsePaginatedJobLines('{"id":101}\nnot-json\n')).toThrow(/line 2/i);
  });
});
