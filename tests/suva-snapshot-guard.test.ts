import { describe, expect, it } from 'vitest';
import {
  assertSuvaDetailSnapshotComplete,
  suvaDetailSnapshotFailure,
} from '../scripts/lib/suva-snapshot-guard.mjs';

describe('Suva sitemap/detail snapshot guard', () => {
  it('accepts a complete detail snapshot', () => {
    expect(assertSuvaDetailSnapshotComplete(['a', 'b'], [{ id: 'a' }, { id: 'b' }])).toBe(true);
    expect(suvaDetailSnapshotFailure(['a', 'b'], [{ id: 'a' }, { id: 'b' }])).toBeNull();
  });

  it('fails closed instead of publishing a partial detail subset', () => {
    const failure = suvaDetailSnapshotFailure(
      ['a', 'b', 'c'],
      [{ id: 'a' }, { id: 'b' }],
    );

    expect(failure).toMatchObject({
      message: 'Suva detail snapshot incomplete: parsed 2/3; refusing partial publication.',
      specDiscoveredCount: 3,
      specDetailDrop: { candidates: 3, gone: 0, rejected: 1 },
    });
    expect(() => assertSuvaDetailSnapshotComplete(['a', 'b', 'c'], [{ id: 'a' }, { id: 'b' }]))
      .toThrow(/refusing partial publication/);
  });

  it('does not invent a drop for an empty candidate list', () => {
    expect(suvaDetailSnapshotFailure([], [])).toBeNull();
    expect(assertSuvaDetailSnapshotComplete([], [])).toBe(true);
  });
});
