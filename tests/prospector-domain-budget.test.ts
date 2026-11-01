import { beforeEach, describe, expect, it } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { resolveDomain } from '../scripts/lib/prospector/domain-resolve.mjs';

const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const sleepImpl = async () => {};

function response(url: string, status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    text: async () => body,
  } as any;
}

describe('Prospector domain HTTP budget', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('counts every call across hinted and guessed domains, robots.txt included', async () => {
    let calls = 0;
    const fetchImpl = async (url: unknown) => {
      calls++;
      return String(url).startsWith('https://www.') && !String(url).endsWith('robots.txt')
        ? response(String(url), 200, 'short')
        : response(String(url), 404);
    };
    const result = await resolveDomain(
      { name: 'Rossi Costruzioni SA', domainHints: ['a.ch', 'b.ch', 'c.ch', 'd.ch', 'e.ch', 'f.ch'] },
      { fetchImpl, lookupImpl, sleepImpl, hostDelayMs: 0 } as never,
    );
    expect(calls).toBeLessThanOrEqual(10);
    expect(result).toMatchObject({ domain: null, retryable: false });
  });

  it('does not retry a probe inside the same run', async () => {
    let pages = 0;
    const fetchImpl = async (url: unknown) => {
      if (String(url).endsWith('robots.txt')) return response(String(url), 404);
      pages++;
      return response(String(url), 503);
    };
    const result = await resolveDomain(
      { name: 'Rossi SA' },
      { fetchImpl, lookupImpl, sleepImpl, hostDelayMs: 0 } as never,
    );
    expect(pages).toBeLessThanOrEqual(5);
    expect(result).toMatchObject({ domain: null, retryable: true });
  });
});
