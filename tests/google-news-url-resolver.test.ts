// @vitest-environment node
// Tests for scripts/lib/discovery/googleNewsUrlResolver.mjs — decoding Google
// News RSS wrapper links to the real publisher URL. Motivated by run
// 29142084681 (2026-07-11): ~219 Google-News news candidates/run dropped as
// "non risolto a fonte diretta", forcing the generator into evergreen. All
// network is mocked — no live Google calls in CI.
import { afterEach, describe, expect, it, vi } from 'vitest';

const mod = await import('../scripts/lib/discovery/googleNewsUrlResolver.mjs');
const {
  decodeGoogleNewsUrl,
  decodeOfflineBase64,
  isGoogleNewsRssUrl,
  _resetDecodeCache,
} = mod;

// Build a legacy-format token: "CBMi" + base64url(protobuf-ish framing + url).
function legacyToken(realUrl: string): string {
  const urlBytes = Buffer.from(realUrl, 'utf8');
  const buf = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x12, urlBytes.length]),
    urlBytes,
    Buffer.from([0x18, 0x01]),
  ]);
  const b64 = buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'CBMi' + b64;
}

afterEach(() => {
  _resetDecodeCache();
  vi.restoreAllMocks();
});

describe('isGoogleNewsRssUrl', () => {
  it('recognises the RSS article wrapper and rejects everything else', () => {
    expect(isGoogleNewsRssUrl('https://news.google.com/rss/articles/CBMiABC?oc=5')).toBe(true);
    expect(isGoogleNewsRssUrl('https://www.rsi.ch/info/svizzera/x.html')).toBe(false);
    expect(isGoogleNewsRssUrl('https://news.google.com/search?q=x')).toBe(false);
    expect(isGoogleNewsRssUrl('not-a-url')).toBe(false);
  });
});

describe('decodeOfflineBase64 (legacy format, no network)', () => {
  it('recovers the real URL embedded in a legacy token', () => {
    const real = 'https://www.rsi.ch/info/svizzera/Frontalieri-disoccupati-123.html';
    expect(decodeOfflineBase64(legacyToken(real))).toBe(real);
  });

  it('returns null for an opaque new-format token (no embedded URL)', () => {
    // "AU_yqL…" opaque tokens contain no readable http URL.
    const opaque = Buffer.from('AU_yqLMxOpaqueTokenWithNoUrlInside').toString('base64');
    expect(decodeOfflineBase64(opaque)).toBeNull();
  });
});

describe('decodeGoogleNewsUrl', () => {
  it('short-circuits offline for a legacy token without hitting the network', async () => {
    const real = 'https://www.corriere.ch/economia/frontalieri-berna.html';
    const fetchImpl = vi.fn();
    const out = await decodeGoogleNewsUrl(
      `https://news.google.com/rss/articles/${legacyToken(real)}?oc=5`,
      { fetchImpl },
    );
    expect(out).toBe(real);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves the opaque format via the batchexecute RPC (mocked)', async () => {
    const real = 'https://www.rsi.ch/info/svizzera/riforma-disoccupazione-frontalieri.html';
    const opaqueUrl =
      'https://news.google.com/rss/articles/CBMiwAFAU_yqLMxKEXg6MIkNtxhJ1fBazfGIBuflaA?oc=5';
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        // batchexecute reply shape: leading )]}' then a JSON array whose
        // inner string embeds the real URL. Google returns plain slashes
        // (verified live 2026-07-11); the module also tolerates \/-escaped.
        return { ok: true, text: async () => `)]}'\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"${real}\\"]"]]` };
      }
      // wrapper HTML with signature + timestamp
      return {
        ok: true,
        text: async () => '<c-wiz data-n-a-sg="SIG123" data-n-a-ts="1700000000">x</c-wiz>',
      };
    });
    const out = await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl });
    expect(out).toBe(real);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null (defensive) when the wrapper HTML lacks signature/timestamp', async () => {
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMopaque?oc=5';
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '<html>no sig here</html>' }));
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
  });

  it('returns null (defensive) on network throw, never propagates', async () => {
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMopaque2?oc=5';
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
  });

  it('does NOT hang when the response body stalls — aborts at timeout → null (hotfix 2026-07-12)', async () => {
    // Regression for run 29202963318 (hung 2h42m): headers arrive OK but the
    // body never completes. fetchText reads the body under the same abort
    // scope, so it aborts at timeoutMs instead of hanging forever.
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMstall?oc=5';
    const fetchImpl = vi.fn(async (_url: string, init: any) => ({
      ok: true,
      // body that never resolves on its own — only the abort signal ends it
      text: () => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('aborted')));
      }),
    }));
    const started = Date.now();
    const out = await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl, timeoutMs: 50 });
    expect(out).toBeNull();
    // Completed promptly (abort fired) — nowhere near a hang.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects a malformed batchexecute URL via validateRealUrl (host with no dot)', async () => {
    // The regex DOES match `https://localhost/foo` (valid chars), so this
    // reaches validateRealUrl — which rejects it because the host has no dot
    // (not a real publisher domain). Guards against a payload-format drift
    // that yields a plausible-looking but bogus host instead of a clean fail.
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMtrunc?oc=5';
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        return { ok: true, text: async () => `)]}'\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://localhost/foo\\"]"]]` };
      }
      return { ok: true, text: async () => '<c-wiz data-n-a-sg="S" data-n-a-ts="1700000000">x</c-wiz>' };
    });
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
  });

  it('rejects a batchexecute URL on a google host via validateRealUrl', async () => {
    // `mail.google.com` matches the regex (the (?!news\.google\.com) lookahead
    // only excludes that exact host) and must be rejected by validateRealUrl's
    // .google.com guard — exercising the validator on the batchexecute path.
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMgoog?oc=5';
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        return { ok: true, text: async () => `)]}'\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://mail.google.com/x\\"]"]]` };
      }
      return { ok: true, text: async () => '<c-wiz data-n-a-sg="S" data-n-a-ts="1700000000">x</c-wiz>' };
    });
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
  });

  it('accepts a well-formed publisher URL from batchexecute (validateRealUrl passes)', async () => {
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMok?oc=5';
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        return { ok: true, text: async () => `)]}'\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.rsi.ch/info/x-123.html\\"]"]]` };
      }
      return { ok: true, text: async () => '<c-wiz data-n-a-sg="S" data-n-a-ts="1700000000">x</c-wiz>' };
    });
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBe('https://www.rsi.ch/info/x-123.html');
  });

  it('rejects a decoded google-internal URL (validation)', async () => {
    // Legacy token that base64-decodes to a news.google.com URL must be rejected.
    const gInternal = 'https://news.google.com/articles/internal';
    const urlBytes = Buffer.from(gInternal, 'utf8');
    const buf = Buffer.concat([Buffer.from([0x08, 0x13, 0x12, urlBytes.length]), urlBytes]);
    const tok = 'CBMi' + buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Offline decode finds the URL but validateRealUrl rejects google hosts →
    // falls through to batchexecute; with no fetch it stays null.
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '<html>no sig</html>' }));
    expect(await decodeGoogleNewsUrl(`https://news.google.com/rss/articles/${tok}?oc=5`, { fetchImpl })).toBeNull();
  });

  it('returns null for a non-Google-News URL', async () => {
    expect(await decodeGoogleNewsUrl('https://www.rsi.ch/x.html')).toBeNull();
  });

  it('negative-caches so a failing token is not re-fetched', async () => {
    const opaqueUrl = 'https://news.google.com/rss/articles/CBMiwAFAU_yqLMcached?oc=5';
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
    expect(await decodeGoogleNewsUrl(opaqueUrl, { fetchImpl })).toBeNull();
    // Only the first call touched the network; the second was served from cache.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
