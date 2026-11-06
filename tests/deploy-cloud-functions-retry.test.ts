import { describe, expect, it } from 'vitest';
import {
  buildFirebaseDeployArgs,
  chunkFunctionNames,
  FIREBASE_DEPLOY_ARGS,
  FUNCTION_NAMES,
  parseFunctionNames,
  deployFunctions,
  isTransientFirebaseApiHtmlFailure,
  isTransientFirebaseQuotaFailure,
} from '../scripts/ci/deploy-cloud-functions-with-retry.mjs';

const TRANSIENT_FAILURE = [
  'Unable to parse JSON: SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
  'Failed to update function projects/frontaliere-ticino/locations/europe-west6/functions/createReaderCheckout',
].join('\n');

describe('deploy-cloud-functions-with-retry', () => {
  it('discovers every top-level trigger export and refuses unsupported exports', () => {
    expect(FUNCTION_NAMES).toContain('jobsSourceRelay');
    expect(FUNCTION_NAMES).toContain('purgeExpiredApplicationConciergeMetaAttribution');
    expect(new Set(FUNCTION_NAMES).size).toBe(FUNCTION_NAMES.length);
    expect(() => parseFunctionNames('export const helper = onHelper();')).toThrow(/partial deploy/u);
  });

  it('builds scoped Firebase targets without changing the deploy project or force mode', () => {
    expect(buildFirebaseDeployArgs(['firstFunction', 'secondFunction'])).toEqual([
      ...FIREBASE_DEPLOY_ARGS,
      '--only',
      'functions:firstFunction,functions:secondFunction',
    ]);
  });

  it('keeps function batches bounded and covers every name exactly once', () => {
    const batches = chunkFunctionNames(['one', 'two', 'three', 'four', 'five'], 2);
    expect(batches).toEqual([
      ['one', 'two'],
      ['three', 'four'],
      ['five'],
    ]);
    expect(batches.flat()).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('recognizes only the observed HTML response parse failure', () => {
    expect(isTransientFirebaseApiHtmlFailure(TRANSIENT_FAILURE)).toBe(true);
    expect(isTransientFirebaseApiHtmlFailure('Error: permission denied')).toBe(false);
    expect(isTransientFirebaseApiHtmlFailure('Unable to parse JSON: unexpected token')).toBe(false);
  });

  it('recognizes quota exhaustion but not a generic IAM failure', () => {
    expect(isTransientFirebaseQuotaFailure([
      'HTTP Error: 429, Could not get Cloud Run service',
      "Quota exceeded for quota metric 'Read requests'",
    ].join('\n'))).toBe(true);
    expect(isTransientFirebaseQuotaFailure('Failed to set invoker: permission denied')).toBe(false);
    expect(isTransientFirebaseQuotaFailure('HTTP Error: 429 but no quota detail')).toBe(false);
  });

  it('retries the idempotent deploy once and returns success', async () => {
    const calls: Array<{ args: string[]; attempt: number }> = [];
    const waits: number[] = [];
    const result = await deployFunctions({
      run: async (args, attempt) => {
        calls.push({ args, attempt });
        return calls.length === 1
          ? { exitCode: 1, output: TRANSIENT_FAILURE }
          : { exitCode: 0, output: 'deploy succeeded' };
      },
      sleep: async (ms) => waits.push(ms),
      functionNames: ['createReaderCheckout'],
      batchDelayMs: 0,
      retryDelayMs: 17,
    });

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(calls).toEqual([
      { args: buildFirebaseDeployArgs(['createReaderCheckout']), attempt: 1 },
      { args: buildFirebaseDeployArgs(['createReaderCheckout']), attempt: 2 },
    ]);
    expect(waits).toEqual([17]);
  });

  it('deploys each bounded batch in order and pauses only between batches', async () => {
    const calls: string[][] = [];
    const waits: number[] = [];
    const result = await deployFunctions({
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0, output: 'deploy succeeded' };
      },
      sleep: async (ms) => waits.push(ms),
      functionNames: ['one', 'two', 'three'],
      batchSize: 2,
      batchDelayMs: 23,
      retryDelayMs: 17,
    });

    expect(result).toMatchObject({ exitCode: 0, attempts: 2, batches: 2 });
    expect(calls).toEqual([
      buildFirebaseDeployArgs(['one', 'two']),
      buildFirebaseDeployArgs(['three']),
    ]);
    expect(waits).toEqual([23]);
  });

  it('does not retry a non-transient Firebase failure', async () => {
    const calls: number[] = [];
    const waits: number[] = [];
    const result = await deployFunctions({
      run: async (_args, attempt) => {
        calls.push(attempt);
        return { exitCode: 1, output: 'Error: permission denied' };
      },
      sleep: async (ms) => waits.push(ms),
      functionNames: ['createReaderCheckout'],
      batchDelayMs: 0,
      retryDelayMs: 17,
    });

    expect(result).toMatchObject({ exitCode: 1, attempts: 1 });
    expect(calls).toEqual([1]);
    expect(waits).toEqual([]);
  });

  it('fails after the bounded retry when the transient error persists', async () => {
    const calls: number[] = [];
    const result = await deployFunctions({
      run: async (_args, attempt) => {
        calls.push(attempt);
        return { exitCode: 1, output: TRANSIENT_FAILURE };
      },
      sleep: async () => {},
      functionNames: ['createReaderCheckout'],
      batchDelayMs: 0,
      retryDelayMs: 0,
    });

    expect(result).toMatchObject({ exitCode: 1, attempts: 2 });
    expect(calls).toEqual([1, 2]);
  });
});
