import { describe, expect, it } from 'vitest';
import {
  localeReceiptContext,
  pagesReceiptContext,
  resolvePublishReceipts,
} from '../scripts/ci/publish-receipts.mjs';

const sourceRunId = '39606182063';

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
        { context: localeReceiptContext(sourceRunId, 'en'), state: 'success' },
        { context: localeReceiptContext('old-run', 'de'), state: 'success' },
        { context: 'frontaliere/shard-published/39606182063/fr', state: 'pending' },
      ],
    });
    expect(state.pagesDeployed).toBe(true);
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pendingLocales).toEqual(['it', 'de', 'fr']);
  });

  it('fails closed on malformed source identity', () => {
    expect(pagesReceiptContext('')).toBe('');
    expect(localeReceiptContext('not-a-run', 'it')).toBe('');
    expect(resolvePublishReceipts({ sourceRunId: '', statuses: [] })).toMatchObject({
      pagesDeployed: false,
      publishedLocales: [],
      pendingLocales: ['it', 'en', 'de', 'fr'],
    });
  });

  it('produces the matrix input that skips locales already pushed', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      locales: ['en', 'de', 'fr'],
      statuses: [
        { context: localeReceiptContext(sourceRunId, 'en'), state: 'success' },
      ],
    });
    expect(state.pendingLocales).toEqual(['de', 'fr']);
  });

  it('deduplicates the requested matrix and ignores unsupported locale contexts', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      locales: ['fr', 'en', 'fr', 'xx'],
      statuses: [
        { context: localeReceiptContext(sourceRunId, 'en'), state: 'success' },
        { context: 'frontaliere/shard-published/39606182063/xx', state: 'success' },
      ],
    });
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pendingLocales).toEqual(['fr']);
    expect(Object.keys(state.localeContexts)).toEqual(['fr', 'en']);
  });

  it('requires exact receipt contexts while accepting normalized success state', () => {
    const state = resolvePublishReceipts({
      sourceRunId,
      statuses: [
        { context: `${localeReceiptContext(sourceRunId, 'en')}/extra`, state: 'success' },
        { context: localeReceiptContext(sourceRunId, 'en'), state: ' SUCCESS ' },
        { context: `${pagesReceiptContext(sourceRunId)}-retry`, state: 'success' },
      ],
    });
    expect(state.publishedLocales).toEqual(['en']);
    expect(state.pagesDeployed).toBe(false);
  });
});
