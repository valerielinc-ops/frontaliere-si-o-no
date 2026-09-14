import { describe, expect, it } from 'vitest';
import { isInvokedDirectly } from '../scripts/lib/is-invoked-directly.mjs';

describe('isInvokedDirectly', () => {
  it('matches a module file URL with an absolute argv path', () => {
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/update-example-jobs.mjs',
    )).toBe(true);
  });

  it('resolves relative argv paths using the process working directory', () => {
    expect(isInvokedDirectly(
      `file://${process.cwd()}/scripts/update-example-jobs.mjs`,
      'scripts/update-example-jobs.mjs',
    )).toBe(true);
  });

  it('does not identify an imported module as the entry point', () => {
    expect(isInvokedDirectly(
      'file:///workspace/scripts/update-example-jobs.mjs',
      '/workspace/scripts/other-jobs.mjs',
    )).toBe(false);
    expect(isInvokedDirectly('not-a-file-url', undefined)).toBe(false);
  });
});
