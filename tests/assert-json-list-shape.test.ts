import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — plain .mjs crawler lib, no type declarations
import { assertJsonListShape, describeJsonShape } from '../scripts/lib/assert-json-list-shape.mjs';

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
  });

  it('defaults to console.warn when no warn sink is injected (drop-in safe)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertJsonListShape({ nope: [] }, { key: 'jobs', source: 'x' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
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
});
