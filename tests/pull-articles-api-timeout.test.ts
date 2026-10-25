import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../scripts/pull-articles-api.mjs'), 'utf8');

describe('pull-articles-api artifact downloads', () => {
  it('bounds every request and its response body with one AbortSignal timeout', () => {
    expect(source).toMatch(
      /const DEFAULT_ARTICLES_API_FETCH_TIMEOUT_MS = 30_000;/,
    );
    expect(source).toMatch(
      /Number\.isSafeInteger\(configuredArticlesApiFetchTimeoutMs\)/,
    );
    expect(source).toMatch(
      /configuredArticlesApiFetchTimeoutMs > 0/,
    );
    expect(source).toMatch(
      /configuredArticlesApiFetchTimeoutMs <= MAX_ARTICLES_API_FETCH_TIMEOUT_MS/,
    );
    expect(source).toMatch(
      /fetch\(url, \{\s*redirect: 'follow',\s*signal: AbortSignal\.timeout\(ARTICLES_API_FETCH_TIMEOUT_MS\),\s*\}\)/,
    );
  });
});
