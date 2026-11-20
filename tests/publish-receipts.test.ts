import { describe, expect, it } from 'vitest';
import {
  localeReceiptContext,
  pagesReceiptContext,
  resolvePublishReceipts,
  isRetryableGithubReadError,
  withGithubReadRetry,
} from '../scripts/ci/publish-receipts.mjs';

const sourceRunId = '39606182063';
const priorRunId = '39606182064';
const currentRunId = '39606182065';

function localeReceipt(runId: string, locale: string, publisherRunId = priorRunId) {
  return {
    context: localeReceiptContext(runId, locale),
    state: 'success',
    target_url: `https://github.com/example/site/actions/runs/${publisherRunId}`,
  };
}

describe('durable build -> publish receipts', () => {
  it('uses an immutable, source-run-scoped context for Pages and each locale', () => {
    expect(pagesReceiptContext(sourceRunId)).toBe(`frontaliere/pages-deployed/${sourceRunId}`);
    expect(localeReceiptContext(sourceRunId, 'en')).toBe(`frontaliere/shard-published/${sourceRunId}/en`);
    expect(localeReceiptContext(sourceRunId, 'EN')).toBe(`frontaliere/shard-published/${sourceRunId}/en`);
    expect(localeReceiptContext(sourceRunId, 'xx')).toBe('');
  });

  it('admits only successful exact contexts and ignores stale/failed statuses', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      statuses: [
        { context: pagesReceiptContext(sourceRunId), state: 'failure' },
        { context: pagesReceiptContext(sourceRunId), state: 'success' },
        localeReceipt(sourceRunId, 'en'),
        localeReceipt('39606182062', 'de'),
        { context: 'frontaliere/shard-published/39606182063/fr', state: 'pending' },
      ],
    });
    expect(state.pagesDeployed).toBe(true);
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pendingLocales).toEqual(['it', 'de', 'fr']);
    expect(state.pendingNonItLocales).toEqual(['de', 'fr']);
  });

  it('fails closed on malformed source identity', () => {
    expect(pagesReceiptContext('')).toBe('');
    expect(localeReceiptContext('not-a-run', 'it')).toBe('');
    expect(resolvePublishReceipts({ sourceRunId: '', statuses: [] })).toMatchObject({
      pagesDeployed: false,
      publishedLocales: [],
      pendingLocales: ['it', 'en', 'de', 'fr'],
      pendingNonItLocales: ['en', 'de', 'fr'],
    });
  });

  it('produces the matrix input that skips locales already pushed', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      locales: ['it', 'en', 'de', 'fr'],
      publisherRunId: currentRunId,
      statuses: [
        localeReceipt(sourceRunId, 'it'),
        localeReceipt(sourceRunId, 'en'),
        localeReceipt(sourceRunId, 'de', sourceRunId),
        localeReceipt('39606182062', 'fr'),
      ],
    });
    expect(state.localeArtifactRunIds).toEqual({ it: currentRunId, en: priorRunId, de: null, fr: currentRunId });
    expect(state.pendingLocales).toEqual(['fr']);
    expect(state.pendingNonItLocales).toEqual(['fr']);
  });

  it('deduplicates the requested matrix and ignores unsupported locale contexts', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      locales: ['fr', 'en', 'fr', 'xx'],
      statuses: [
        localeReceipt(sourceRunId, 'en'),
        { context: 'frontaliere/shard-published/39606182063/xx', state: 'success' },
      ],
    });
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pendingLocales).toEqual(['fr']);
    expect(state.pendingNonItLocales).toEqual(['fr']);
    expect(Object.keys(state.localeContexts)).toEqual(['fr', 'en']);
  });

  it('requires exact receipt contexts while accepting normalized success state', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      statuses: [
        { context: `${localeReceiptContext(sourceRunId, 'en')}/extra`, state: 'success' },
        { ...localeReceipt(sourceRunId, 'en'), state: ' SUCCESS ' },
        { context: `${pagesReceiptContext(sourceRunId)}-retry`, state: 'success' },
      ],
    });
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pagesDeployed).toBe(false);
  });

  it('retries transient GitHub gateway failures with bounded backoff', () => {
    let calls = 0;
    const sleeps = [];
    const warnings = [];
    const result = withGithubReadRetry(() => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('gh: Server Error (HTTP 502)'), {
        stderr: 'gh: Server Error (HTTP 502)',
      });
      return 'ok';
    }, {
      backoffMs: [11, 22],
      sleep: (delayMs) => sleeps.push(delayMs),
      onRetry: (...args) => warnings.push(args),
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([11, 22]);
    expect(warnings).toHaveLength(2);
  });

  it('does not retry permanent or malformed GitHub failures', () => {
    expect(isRetryableGithubReadError(new Error('gh: HTTP 400'))).toBe(false);
    expect(isRetryableGithubReadError(new Error('invalid JSON response'))).toBe(false);
    let calls = 0;
    expect(() => withGithubReadRetry(() => {
      calls += 1;
      throw new Error('gh: HTTP 400');
    }, { sleep: () => { throw new Error('unexpected retry'); } })).toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('fails after the bounded number of transient attempts', () => {
    let calls = 0;
    expect(() => withGithubReadRetry(() => {
      calls += 1;
      throw new Error('gh: HTTP 503');
    }, { maxAttempts: 3, backoffMs: [1, 1], sleep: () => {} })).toThrow('HTTP 503');
    expect(calls).toBe(3);
  });
});
