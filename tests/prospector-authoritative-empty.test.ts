import { beforeEach, describe, expect, it } from 'vitest';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';

const SEED_URL = 'https://eqe.example/unternehmen-2/karriere';
const EMPTY_MARKER = 'Im Moment haben wir keine offenen Stellen.';
const EMPTY_HTML = `<html><body><h1>Current Vacancies</h1><p>${EMPTY_MARKER}</p></body></html>`;

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: () => {} },
    text: async () => body,
    clone: () => response(url, body),
  } as any;
}

function runtime(body = EMPTY_HTML) {
  return {
    fetchImpl: async (input: string | URL | Request) => response(String(input), body),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    sleepImpl: async () => {},
    hostDelayMs: 0,
    retries: 0,
    disableWafProxy: true,
  };
}

function spec(authoritativeEmptyText = EMPTY_MARKER) {
  return {
    companyKey: 'eqe-ch-fixture',
    companyName: 'eqe AG fixture',
    companyHost: 'eqe.example',
    mode: 'template',
    seedUrls: [SEED_URL],
    detailTemplate: '/unternehmen-2/offene-stellen/*',
    detailEnrichment: false,
    authoritativeEmptyText,
  } as any;
}

describe('prospector source-backed empty listing contract', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('stamps a zero only when the configured source marker is present', async () => {
    const rows = await runSpecInProduction(spec(), runtime());

    expect(rows).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(rows)).toBe(true);
    expect(rows).toHaveProperty('fetchOutcome', 'ok');
    expect(rows).toHaveProperty('discoveredCount', 0);
    expect(rows).toHaveProperty('authoritativeEmptyEvidence', expect.stringContaining(EMPTY_MARKER));
  });

  it('keeps an unmarked zero fail-closed', async () => {
    const rows = await runSpecInProduction(spec('A different reviewed source sentence.'), runtime());

    expect(rows).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(rows)).toBe(false);
    expect(rows).not.toHaveProperty('authoritativeEmptyState');
  });
});
