import { describe, expect, it, vi } from 'vitest';
import {
  assertAccumulatorFileWrite,
  materializedSize,
  trackedSizeAt,
} from '../scripts/ci/assert-accumulator-write.mjs';

describe('assert-accumulator-write', () => {
  it('blocks a catastrophic shrink before a commit', () => {
    const exec = vi.fn(() => '2000000\n');
    const stat = vi.fn(() => ({ size: 100000 }));

    expect(() => assertAccumulatorFileWrite('data/example.json', { exec, stat }))
      .toThrow(/catastrophic truncation avoided/);
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['cat-file', '-s', 'HEAD:data/example.json'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('allows an append and reports the measured sizes', () => {
    const exec = vi.fn(() => '1000000\n');
    const result = assertAccumulatorFileWrite('data/example.json', {
      exec,
      stat: () => ({ size: 1000100 }),
    });

    expect(result).toEqual({ previousBytes: 1000000, nextBytes: 1000100, checked: true });
  });

  it('does not invent a baseline for a new accumulator', () => {
    const missing = new Error("fatal: path 'data/new.json' does not exist in 'HEAD'");
    Object.assign(missing, { stderr: Buffer.from("fatal: path 'data/new.json' does not exist in 'HEAD'\n") });
    const exec = vi.fn(() => { throw missing; });

    expect(trackedSizeAt('HEAD', 'data/new.json', exec)).toBeNull();
    expect(assertAccumulatorFileWrite('data/new.json', {
      exec,
      stat: () => ({ size: 0 }),
    })).toEqual({ previousBytes: null, nextBytes: 0, checked: false });
    expect(materializedSize('data/missing.json', () => {
      const error = new Error('missing');
      Object.assign(error, { code: 'ENOENT' });
      throw error;
    })).toBe(0);
  });
});
