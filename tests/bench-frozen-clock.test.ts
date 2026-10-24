import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PRELOAD = path.resolve(__dirname, '../scripts/ci/bench-frozen-clock.mjs');
const PROBE = `
import fs from 'node:fs';
class Sub extends Date {}
console.log(JSON.stringify({
  now: Date.now(),
  bare: new Date().getTime(),
  fn: typeof Date(),
  explicit: new Date(0).getTime(),
  inst: new Date() instanceof Date,
  statInst: fs.statSync('.').mtime instanceof Date,
  sub: new Sub().getTime(),
  utc: Date.UTC(2020, 0, 1),
}));
`;

function probe(env: Record<string, string | undefined>) {
  const out = execFileSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', PROBE], {
    env: { ...process.env, BENCH_FROZEN_CLOCK_MS: undefined, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('bench-frozen-clock preload', () => {
  it('freezes Date.now and argument-less construction without breaking Date semantics', () => {
    const r = probe({ BENCH_FROZEN_CLOCK_MS: '1792800000000' });
    expect(r).toEqual({
      now: 1792800000000,
      bare: 1792800000000,
      fn: 'string',
      explicit: 0,
      inst: true,
      statInst: true,
      sub: 1792800000000,
      utc: Date.UTC(2020, 0, 1),
    });
  });

  it('is inert without a valid value', () => {
    for (const value of [undefined, '', 'abc', '12']) {
      const r = probe({ BENCH_FROZEN_CLOCK_MS: value });
      expect(Math.abs(r.now - Date.now())).toBeLessThan(60_000);
    }
  });
});
