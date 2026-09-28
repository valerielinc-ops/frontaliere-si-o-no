import { describe, expect, it } from 'vitest';
import {
  FIREBASE_DEPLOY_ARGS,
  deployFunctions,
  isTransientFirebaseApiHtmlFailure,
} from '../scripts/ci/deploy-cloud-functions-with-retry.mjs';

const TRANSIENT_FAILURE = [
  'Unable to parse JSON: SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
  'Failed to update function projects/frontaliere-ticino/locations/europe-west6/functions/createReaderCheckout',
].join('\n');

describe('deploy-cloud-functions-with-retry', () => {
  it('recognizes only the observed HTML response parse failure', () => {
    expect(isTransientFirebaseApiHtmlFailure(TRANSIENT_FAILURE)).toBe(true);
    expect(isTransientFirebaseApiHtmlFailure('Error: permission denied')).toBe(false);
    expect(isTransientFirebaseApiHtmlFailure('Unable to parse JSON: unexpected token')).toBe(false);
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
      retryDelayMs: 17,
    });

    expect(result).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(calls).toEqual([
      { args: FIREBASE_DEPLOY_ARGS, attempt: 1 },
      { args: FIREBASE_DEPLOY_ARGS, attempt: 2 },
    ]);
    expect(waits).toEqual([17]);
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
      retryDelayMs: 0,
    });

    expect(result).toMatchObject({ exitCode: 1, attempts: 2 });
    expect(calls).toEqual([1, 2]);
  });
});
