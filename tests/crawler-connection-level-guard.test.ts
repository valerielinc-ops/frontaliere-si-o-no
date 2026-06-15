import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error — JS module without types
import {
  runStandardCrawlerPipeline,
  exitCrawlerOnError,
} from '../scripts/lib/crawler-template.mjs';

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

  it('exits 1 (surface) on an HTTP-status error', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const httpErr = new Error('HTTP 403') as Error & { status?: number };
    httpErr.status = 403;
    expect(() => exitCrawlerOnError(httpErr, 'Test Co')).toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
