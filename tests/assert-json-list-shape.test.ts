import { describe, it, expect, vi } from 'vitest';
import {
  assertJsonListShape,
  assertJsonListShapeMultiKey,
  assertRssChannelItems,
  describeJsonShape,
  // @ts-expect-error — plain .mjs crawler lib, no type declarations
} from '../scripts/lib/assert-json-list-shape.mjs';

/**
 * Locks the shared non-silent guard extracted per #1666 (swept across ~12
 * JSON-envelope crawler parsers that used `Array.isArray(data?.key) ? … : []`).
 *
 * The crucial invariant: a *valid empty board* (`data[key]` IS an array, just
 * empty) must pass SILENTLY, while a *malformed/error envelope* (`data[key]`
 * not an array) must warn LOUDLY — otherwise the two are indistinguishable and
 * a shape drift silently empties a previously-populated source.
 */
describe('assertJsonListShape — shared non-silent JSON-envelope guard (#1666)', () => {
  const captureWarn = () => {
    const calls: string[] = [];
    return { warn: (m: string) => calls.push(m), calls };
  };

  it('returns the array unchanged for a valid populated envelope (no warn)', () => {
    const { warn, calls } = captureWarn();
    const jobs = [{ id: 1 }, { id: 2 }];
    const out = assertJsonListShape({ jobs }, { key: 'jobs', source: 'usz', warn });
    expect(out).toBe(jobs);
    expect(calls).toHaveLength(0);
  });

  it('valid EMPTY board (`{jobs: []}`) returns [] SILENTLY — not a malformed envelope', () => {
    const { warn, calls } = captureWarn();
    const out = assertJsonListShape({ jobs: [], total: 0 }, { key: 'jobs', source: 'usz', warn });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0); // the whole point: genuine empty ≠ drift
  });

  it('warns LOUDLY when the envelope key is missing entirely (renamed/paginated)', () => {
    const { warn, calls } = captureWarn();
    const out = assertJsonListShape({ data: [{ id: 1 }], page: 1 }, { key: 'jobs', source: 'usz', warn });
    expect(out).toEqual([]); // contract-invariant: still returns []
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('JSON list shape mismatch for usz');
    expect(calls[0]).toContain('data.jobs');
    expect(calls[0]).toContain('envelope keys: data, page');
    // must explicitly distinguish from a genuinely-empty board
    expect(calls[0]).toContain('NOT a genuinely-empty board');
  });

  it('warns and describes the actual type for a bare-array error body (no misleading index keys)', () => {
    const { warn, calls } = captureWarn();
    const out = assertJsonListShape(['a', 'b'], { key: 'jobs', source: 'usz', warn });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('got array[2]');
    expect(calls[0]).not.toContain('envelope keys: 0, 1'); // never print array indices
  });

  it('warns and describes the typeof for a primitive/HTML-string error body', () => {
    const { warn, calls } = captureWarn();
    const out = assertJsonListShape('<html>403 Forbidden</html>', { key: 'jobs', source: 'usz', warn });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('got string');
  });

  it('warns for null / undefined `data` (parse failure / no body)', () => {
    const { warn, calls } = captureWarn();
    expect(assertJsonListShape(null, { key: 'jobs', source: 'usz', warn })).toEqual([]);
    expect(assertJsonListShape(undefined, { key: 'jobs', source: 'usz', warn })).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('got null');
    expect(calls[1]).toContain('got undefined');
  });

  it('supports key-variants (`data`, `content`, `items`, `jobPostings`) and lang suffix', () => {
    const { warn, calls } = captureWarn();
    assertJsonListShape({ wrong: [] }, { key: 'data', source: 'igs-bern', warn });
    assertJsonListShape({ wrong: [] }, { key: 'content', source: 'villa-im-park', warn });
    assertJsonListShape({ wrong: [] }, { key: 'jobPostings', source: 'workday:acme', lang: 'de', warn });
    expect(calls[0]).toContain('data.data');
    expect(calls[1]).toContain('data.content');
    expect(calls[2]).toContain('data.jobPostings');
    expect(calls[2]).toContain('(de)'); // lang surfaced
  });

  it('NEVER throws — the orchestrator must keep running / not wipe partial pagination', () => {
    expect(() => assertJsonListShape(42, { key: 'jobs', source: 'x', warn: () => {} })).not.toThrow();
    expect(() => assertJsonListShape({}, { key: 'jobs', source: 'x', warn: () => {} })).not.toThrow();
  });

  describe('optional per-row shape predicate (catches per-field rename drift)', () => {
    const rowOk = (r: any) => r != null && typeof r === 'object' && 'title' in r;

    it('does NOT warn when all rows satisfy the predicate', () => {
      const { warn, calls } = captureWarn();
      assertJsonListShape({ jobs: [{ title: 'a' }, { title: 'b' }] }, { key: 'jobs', source: 'x', rowShapeOk: rowOk, warn });
      expect(calls).toHaveLength(0);
    });

    it('warns when a row loses the expected per-row shape (renamed fields)', () => {
      const { warn, calls } = captureWarn();
      assertJsonListShape({ jobs: [{ name: 'a', href: '/y' }] }, { key: 'jobs', source: 'x', rowShapeOk: rowOk, warn });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('row shape mismatch');
      expect(calls[0]).toContain('row keys: name, href');
    });

    it('scans ALL rows — valid head + drifted tail still warns', () => {
      const { warn, calls } = captureWarn();
      assertJsonListShape({ jobs: [{ title: 'ok' }, { broken: 1 }] }, { key: 'jobs', source: 'x', rowShapeOk: rowOk, warn });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('row shape mismatch');
    });

    it('does NOT run the row predicate on a valid empty board (no false row warn)', () => {
      const { warn, calls } = captureWarn();
      assertJsonListShape({ jobs: [] }, { key: 'jobs', source: 'x', rowShapeOk: rowOk, warn });
      expect(calls).toHaveLength(0);
    });

    it('a THROWING rowShapeOk does NOT propagate — caught, treated as a malformed row + warns', () => {
      const { warn, calls } = captureWarn();
      // A predicate that reads a nested field off whatever it gets will throw on
      // a primitive/null row. The helper must catch it (never-throws contract)
      // and treat the throwing row as malformed.
      const throwing = (row: unknown) => (row as { meta: { ok: boolean } }).meta.ok;
      expect(() =>
        assertJsonListShape(
          { jobs: [{ meta: { ok: true } }, null] },
          { key: 'jobs', source: 'x', rowShapeOk: throwing, warn },
        ),
      ).not.toThrow();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('row shape mismatch');
    });
  });

  it('defaults to console.warn when no warn sink is injected (drop-in safe)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertJsonListShape({ nope: [] }, { key: 'jobs', source: 'x' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  describe('assertJsonListShapeMultiKey — OR-chain / multi-key variant (#1700)', () => {
    const captureWarnMK = () => {
      const calls: string[] = [];
      return { warn: (m: string) => calls.push(m), calls };
    };

    it('resolves the FIRST candidate key that is an array (no warn)', () => {
      const { warn, calls } = captureWarnMK();
      const list = [{ id: 1 }];
      const out = assertJsonListShapeMultiKey(
        { result: list, jobs: [], data: [] },
        { keys: ['result', 'jobs', 'data'], source: 'canton-valais', warn },
      );
      expect(out).toBe(list);
      expect(calls).toHaveLength(0);
    });

    it('skips a non-array candidate and resolves the next array key (the `||` truthy-non-array bug)', () => {
      const { warn, calls } = captureWarnMK();
      // `result` is a truthy NON-array (error object) — the raw `||` chain would
      // have returned it as the "list"; the helper skips it and uses `jobs`.
      const list = [{ id: 2 }];
      const out = assertJsonListShapeMultiKey(
        { result: { error: 'rate limited' }, jobs: list },
        { keys: ['result', 'jobs'], source: 'x', warn },
      );
      expect(out).toBe(list);
      expect(calls).toHaveLength(0);
    });

    it('accepts a bare top-level array when allowBareArray (Lever-style API)', () => {
      const { warn, calls } = captureWarnMK();
      const list = [{ id: 1 }, { id: 2 }];
      const out = assertJsonListShapeMultiKey(list, { keys: [], allowBareArray: true, source: 'lever:acme', warn });
      expect(out).toBe(list);
      expect(calls).toHaveLength(0);
    });

    it('resolves a dotted candidate path (OData `d.results`)', () => {
      const { warn, calls } = captureWarnMK();
      const list = [{ id: 1 }];
      const out = assertJsonListShapeMultiKey(
        { d: { results: list }, value: [] },
        { keys: ['d.results', 'value'], source: 'successfactors:acme', warn },
      );
      expect(out).toBe(list);
      expect(calls).toHaveLength(0);
    });

    it('valid EMPTY board (a candidate key IS an empty array) returns [] SILENTLY', () => {
      const { warn, calls } = captureWarnMK();
      const out = assertJsonListShapeMultiKey(
        { jobs: [], total: 0 },
        { keys: ['result', 'jobs', 'data'], allowBareArray: true, source: 'x', warn },
      );
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0); // matched key wins before the none-match branch
    });

    it('warns LOUDLY + returns [] when NO candidate key matches and not a bare array (total drift)', () => {
      const { warn, calls } = captureWarnMK();
      const out = assertJsonListShapeMultiKey(
        { page: 1, payload: { renamed: [] } },
        { keys: ['result', 'jobs', 'data'], allowBareArray: true, source: 'canton-valais', warn },
      );
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('JSON list shape mismatch for canton-valais');
      expect(calls[0]).toContain('data.result'); // lists the candidate keys
      expect(calls[0]).toContain('data.jobs');
      expect(calls[0]).toContain('or a bare top-level array');
      expect(calls[0]).toContain('envelope keys: page, payload'); // actual shape
      expect(calls[0]).toContain('NOT a genuinely-empty board');
    });

    it('warns for an error-string / primitive body', () => {
      const { warn, calls } = captureWarnMK();
      const out = assertJsonListShapeMultiKey('<html>403</html>', { keys: ['jobs'], source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('got string');
    });

    it('does NOT accept a bare array when allowBareArray is false (drift → warn)', () => {
      const { warn, calls } = captureWarnMK();
      const out = assertJsonListShapeMultiKey([1, 2], { keys: ['jobs'], allowBareArray: false, source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain('or a bare top-level array');
    });

    it('NEVER throws — invariant return contract preserved', () => {
      expect(() => assertJsonListShapeMultiKey(42, { keys: ['jobs'], source: 'x', warn: () => {} })).not.toThrow();
      expect(() => assertJsonListShapeMultiKey(null, { keys: ['jobs'], source: 'x', warn: () => {} })).not.toThrow();
      expect(() => assertJsonListShapeMultiKey(undefined, { keys: [], allowBareArray: true, source: 'x', warn: () => {} })).not.toThrow();
    });

    it('defaults to console.warn when no warn sink injected (drop-in safe)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      assertJsonListShapeMultiKey({ nope: [] }, { keys: ['jobs'], source: 'x' });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('describeJsonShape', () => {
    it('describes each shape category without leaking indices', () => {
      expect(describeJsonShape(null)).toBe('null');
      expect(describeJsonShape(undefined)).toBe('undefined');
      expect(describeJsonShape([1, 2, 3])).toBe('array[3]');
      expect(describeJsonShape('x')).toBe('string');
      expect(describeJsonShape(7)).toBe('number');
      expect(describeJsonShape({ a: 1, b: 2 })).toContain('envelope keys: a, b');
      expect(describeJsonShape({})).toContain('envelope keys: none');
    });
  });

  describe('assertRssChannelItems (RSS/XML parsed-object feeds)', () => {
    const captureWarn = () => {
      const calls: string[] = [];
      return { warn: (m: string) => calls.push(m), calls };
    };

    it('returns the item array when channel.item is an array (multi-listing feed)', () => {
      const { warn, calls } = captureWarn();
      const parsed = { rss: { channel: { item: [{ title: 'a' }, { title: 'b' }] } } };
      const out = assertRssChannelItems(parsed, { source: 'x', warn });
      expect(out).toHaveLength(2);
      expect(calls).toHaveLength(0);
    });

    it('wraps a single bare item object into [item] WITHOUT warning (one-listing feed)', () => {
      const { warn, calls } = captureWarn();
      const parsed = { rss: { channel: { item: { title: 'solo' } } } };
      const out = assertRssChannelItems(parsed, { source: 'x', warn });
      expect(out).toEqual([{ title: 'solo' }]);
      expect(calls).toHaveLength(0); // single-item is NOT drift — must not false-warn
    });

    it('returns [] WITHOUT warning when the channel is present but has no items (empty board)', () => {
      const { warn, calls } = captureWarn();
      const parsed = { rss: { channel: { title: 'Jobs', item: undefined } } };
      const out = assertRssChannelItems(parsed, { source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0); // a genuinely-empty feed is silent
    });

    it('returns [] WITHOUT warning for a bare `<channel></channel>` (parsed to channel:"")', () => {
      const { warn, calls } = captureWarn();
      // fast-xml-parser renders an empty channel element as an empty string;
      // the rss root is still present → legit closed board, must not warn.
      const out = assertRssChannelItems({ rss: { channel: '' } }, { source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('WARNS when the rss>channel envelope itself is missing/malformed (real drift)', () => {
      const { warn, calls } = captureWarn();
      const out = assertRssChannelItems({ feed: { entry: [] } }, { source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('rss.channel.item');
    });

    it('WARNS on an error/HTML body (no rss envelope at all)', () => {
      const { warn, calls } = captureWarn();
      const out = assertRssChannelItems('<html>503</html>', { source: 'x', warn });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it('NEVER throws on null/undefined/primitive input', () => {
      expect(() => assertRssChannelItems(null, { source: 'x', warn: () => {} })).not.toThrow();
      expect(() => assertRssChannelItems(undefined, { source: 'x', warn: () => {} })).not.toThrow();
      expect(() => assertRssChannelItems(42, { source: 'x', warn: () => {} })).not.toThrow();
    });
  });
});
