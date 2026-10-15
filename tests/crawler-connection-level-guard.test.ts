import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runStandardCrawlerPipeline,
  exitCrawlerOnError,
} from '../scripts/lib/crawler-template.mjs';
import {
  FeedEndpointUnavailableError,
  assertFeedBodyLooksLikeXml,
  assertFeedEndpointHost,
} from '../scripts/lib/feed-endpoint-guard.mjs';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-guard-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), '[]\n');
  return root;
}

describe('runStandardCrawlerPipeline — connection-level fetch guard', () => {
  it('preserves existing jobs (resolves, no throw) when fetchJobs throws a connection-level error', async () => {
    // A datacenter-egress block surfaces as a TypeError "fetch failed" with NO
    // err.status — the crawler must NOT fail the run (would spam an issue +
    // de-index a live employer). It returns early, keeping the existing slice.
    const root = makeRoot();
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw new TypeError('fetch failed');
        },
        root,
      }),
    ).resolves.toBeUndefined();
  });

  it('re-throws when fetchJobs throws an HTTP-status error (a real break must surface)', async () => {
    // A 404/403/5xx means the server DID respond — egress works, source changed.
    // That is a genuine break and must propagate so the "Crawler Failure" issue
    // opens rather than silently keeping stale data.
    const root = makeRoot();
    const httpErr = new Error('HTTP 404 from https://example.test/jobs') as Error & {
      status?: number;
    };
    httpErr.status = 404;
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw httpErr;
        },
        root,
      }),
    ).rejects.toThrow(/404/);
  });

  it('preserves existing jobs when fetchJobs throws an anti-bot-exhausted error (#2029)', async () => {
    // The jobup feed client marks err.antiBotExhausted=true after the full
    // cascade (realistic UA → Jina clean IP → Playwright) all hit the WAF fence.
    // The clean Jina IP being blocked too makes it an IP-reputation transient,
    // not a source change → soft-exit (keep slice), same as connection-level.
    const root = makeRoot();
    const err = new Error('HTTP 403 from https://www.jobup.ch/masks/ehnv/list_ehnv.asp') as Error & {
      status?: number;
      antiBotExhausted?: boolean;
    };
    err.status = 403;
    err.antiBotExhausted = true;
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw err;
        },
        root,
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves existing jobs when a feed endpoint is unavailable', async () => {
    const root = makeRoot();
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw new FeedEndpointUnavailableError('feed redirected off its own host');
        },
        root,
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves existing jobs when a retryable HTTP response exhausted its retry budget', async () => {
    // httpFetchWithRetry returns the final 429/5xx Response so parsers can keep
    // their status handling. A parser that turns that marked Response into a
    // domain error must still get the same soft-exit as the other transient
    // guards; a persistent 4xx has no marker and remains loud below.
    const root = makeRoot();
    const err = Object.assign(new Error('HTTP 429'), {
      status: 429,
      retryBudgetExhausted: true,
    });
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw err;
        },
        root,
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves existing jobs when the shared fetch retry marker is propagated directly', async () => {
    // fetchWithRetry() uses retryExhausted on its final Error. PastaHR's
    // cross-origin 403 path reaches this boundary in exactly that form; it is
    // a transient WAF fence, not a source/parser failure.
    const root = makeRoot();
    const err = Object.assign(new Error('HTTP 403 from https://www.publicjobs.ch/widget'), {
      status: 403,
      retryExhausted: true,
    });
    await expect(
      runStandardCrawlerPipeline({
        companyKey: 'test-co',
        companyLabel: 'Test Co',
        isCompanyJob: () => false,
        fetchJobs: async () => {
          throw err;
        },
        root,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('feed-endpoint-guard', () => {
  it('flags a response redirected away from the expected host', () => {
    expect(() => assertFeedEndpointHost(
      'nord-anglia',
      'careers.nordangliaeducation.com',
      'https://www.nordangliaeducation.com/careers',
    )).toThrow(/redirected off careers\.nordangliaeducation\.com to www\.nordangliaeducation\.com/);
  });

  it('flags an HTML maintenance page but leaves malformed XML to the XML parser', () => {
    expect(() => assertFeedBodyLooksLikeXml(
      'nord-anglia',
      'careers.nordangliaeducation.com',
      '<!DOCTYPE html><html><body>careers unavailable</body></html>',
    )).toThrow(/answered with an HTML document/);
    expect(() => assertFeedBodyLooksLikeXml(
      'nord-anglia',
      'careers.nordangliaeducation.com',
      '<?xml version="1.0"?><rss><channel>',
    )).not.toThrow();
  });

  it('marks endpoint errors as soft-exitable', () => {
    expect(new FeedEndpointUnavailableError('unavailable').feedEndpointUnavailable).toBe(true);
  });
});

describe('exitCrawlerOnError — custom-main terminal catch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 (soft, preserve) on a connection-level fetch failure', () => {
    // Mock process.exit to throw so it halts execution like the real call —
    // otherwise the function would fall through past exit(0).
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() => exitCrawlerOnError(new TypeError('fetch failed'), 'Test Co')).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 (soft, preserve) when the feed endpoint is unavailable', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() => exitCrawlerOnError(
      new FeedEndpointUnavailableError('feed unavailable'),
      'Test Co',
    )).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 (surface) on an HTTP-status error', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const httpErr = new Error('HTTP 403') as Error & { status?: number };
    httpErr.status = 403;
    expect(() => exitCrawlerOnError(httpErr, 'Test Co')).toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 0 (soft, preserve) on a retry-budget-exhausted HTTP error', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const httpErr = Object.assign(new Error('HTTP 429'), {
      status: 429,
      retryBudgetExhausted: true,
    });
    expect(() => exitCrawlerOnError(httpErr, 'Test Co')).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 (soft, preserve) on the shared fetch retry-exhausted marker', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const httpErr = Object.assign(new Error('HTTP 403'), {
      status: 403,
      retryExhausted: true,
    });
    expect(() => exitCrawlerOnError(httpErr, 'Test Co')).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
