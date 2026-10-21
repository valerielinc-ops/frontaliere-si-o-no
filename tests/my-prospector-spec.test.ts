import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { loadSpec, runSpecInProduction, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

const SEED_URL = 'https://my.jobalino.ch/de/jobpreview/18678';
const CURRENT_DETAIL_URL = SEED_URL;

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
    clone: () => response(url, body),
  } as any;
}

const SOURCE_HTML = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  url: CURRENT_DETAIL_URL,
  title: 'Lernende Detailhandel EFZ Möbel (m/w) / 100%',
  description: 'Eine vollständige source-backed Beschreibung dieser Lehrstelle mit Aufgaben, Anforderungen, Arbeitsort und weiteren Informationen für den Detailhandel.',
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Gerechtigkeitsgasse 25',
      postalCode: '3011',
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
    },
  },
})}</script>`;

describe('Stiftung Helsenberg prospector URL-shape contract', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('accepts the current configured detail path and rejects the retired path', async () => {
    const spec = loadSpec('my');
    const template = templateToRegex(spec.detailTemplate);
    expect(template.test(new URL(CURRENT_DETAIL_URL).pathname)).toBe(true);
    expect(template.test('/job/6627a44879cd0/lernende-detailhandel-efz-moebel-m-w')).toBe(false);

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://my.jobalino.ch/robots.txt') {
        return response(url, 'User-agent: *\nAllow: /');
      }
      if (url === SEED_URL) return response(url, SOURCE_HTML);
      throw new Error(`unexpected URL ${url}`);
    });

    const rows = await runSpecInProduction(spec, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
    });

    expect(rows).toEqual([expect.objectContaining({
      url: CURRENT_DETAIL_URL,
      title: 'Lernende Detailhandel EFZ Möbel (m/w) / 100%',
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
      canton: 'BE',
    })]);
  });
});
