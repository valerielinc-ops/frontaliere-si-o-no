import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  __resetCorpusFreshnessCache,
  checkCorpusFreshness,
  pushRenderedLocales,
} from '../scripts/rerender-article-hubs.mjs';

const workflow = readFileSync(
  resolve(__dirname, '..', '.github/workflows/fast-publish-article.yml'),
  'utf-8',
);
const hubWorkflow = readFileSync(
  resolve(__dirname, '..', '.github/workflows/rerender-article-hubs.yml'),
  'utf-8',
);
const hubDriver = readFileSync(
  resolve(__dirname, '..', 'scripts/rerender-article-hubs.mjs'),
  'utf-8',
);
const articleLockWorkflows = [
  '.github/workflows/fast-publish-article.yml',
  '.github/workflows/resync-cdn-article-chunks.yml',
  '.github/workflows/rerender-article-hubs.yml',
  '.github/workflows/sync-articles-sitemaps.yml',
];

/**
 * #5819 — the fast-publish HTML hub and the client registry must move in a
 * safe order. The standalone publisher now targets the named exports the
 * consumers actually import (`ARTICLES` / `SWISS_ARTICLES`), validates every
 * companion first, and fails closed before an HTML shard can be pushed.
 */
describe('fast-publish article workflow', () => {
  const invocations = [...workflow.matchAll(/run:\s+npx -y tsx@4.23.15 scripts\/publish-article-chunks\.mjs(?<args>[^\n]*)/g)];

  it('publishes the selected client registry before locale shards', () => {
    const publishIdx = workflow.indexOf('Publish client article chunks');
    const pushIdx = workflow.indexOf('Push locale shards');
    expect(publishIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeLessThan(pushIdx);
    const publishBlock = workflow.slice(publishIdx, pushIdx);
    expect(publishBlock).toContain('--section "$ARTICLE_SECTION"');
    expect(publishBlock).toContain('--strict');
    expect(publishBlock).toContain('--no-ticker');
    expect(workflow.slice(pushIdx, workflow.indexOf('Verify shard URLs are live'))).toContain(
      "steps.publish_chunks.outcome == 'success'",
    );
  });

  it('still refreshes the news-ticker payload after live verification', () => {
    expect(invocations).toHaveLength(2);
    const ticker = invocations.find((match) => (match.groups?.args ?? '').includes('--ticker-only'));
    expect(ticker).toBeDefined();
    expect(workflow.indexOf('Publish news-ticker payload')).toBeGreaterThan(workflow.indexOf('Verify shard URLs are live'));
  });
});

describe('rerender article hubs workflow', () => {
  it('preflights every rendered section before publishing client chunks, then pushes hubs', () => {
    const publishAt = hubDriver.indexOf('await publishClientChunks(sections, args.dryRun);');
    const renderAt = hubDriver.indexOf('await renderHubsAndOffload({');
    const freshnessAt = hubDriver.indexOf('const freshness = await checkCorpusFreshness(section, itemCount);');
    const pushAt = hubDriver.indexOf('// ── Push: ONE invocation per (section, locale)');
    const fatalExitAt = hubDriver.indexOf("console.error(`${LOG} validation failed — nothing pushed`);");

    expect(publishAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(-1);
    expect(freshnessAt).toBeGreaterThan(renderAt);
    expect(fatalExitAt).toBeGreaterThan(freshnessAt);
    expect(publishAt).toBeGreaterThan(fatalExitAt);
    expect(publishAt).toBeLessThan(pushAt);
    expect(hubDriver).toContain("path.join(ROOT_DIR, 'scripts', 'publish-article-chunks.mjs')");
    expect(hubDriver).toContain("args.push('--strict', '--no-ticker')");
    expect(hubDriver).toContain('assertArticleChunkLease({ required: leaseRequired });\n  await publishClientChunks');
    expect(hubDriver).toContain('PUBLISHED_SLUGS_URL');
    expect(hubDriver).toContain('refusing to move the client behind the hub');
  });

  it('rejects a published-ID gap even when the manifest count still matches', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve({ ok: true, json: async () => ({ counts: { swissArticles: 2 } }) });
      }
      if (url.endsWith('/slugs.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            swiss: {
              kept: { it: 'kept' },
              publishedAfterSync: { it: 'published-after-sync' },
            },
          }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const verdict = await checkCorpusFreshness('svizzera', 2, {
        localRegistry: { kept: { it: 'kept' } },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.note).toContain('publishedAfterSync');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      __resetCorpusFreshnessCache();
      vi.unstubAllGlobals();
    }
  });

  it('rejects local article IDs absent from the published registry', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve({ ok: true, json: async () => ({ counts: { articles: 1 } }) });
      }
      if (url.endsWith('/slugs.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ blog: { published: { it: 'published' } } }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const verdict = await checkCorpusFreshness('frontaliere', 1, {
        localRegistry: {
          published: { it: 'published' },
          staleLocalOnly: { it: 'stale-local-only' },
        },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.note).toContain('staleLocalOnly');
      expect(verdict.note).toContain('absent from the published registry');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      __resetCorpusFreshnessCache();
      vi.unstubAllGlobals();
    }
  });

  it('rejects a live hub card absent from the local registry', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/manifest.json')) {
        return Promise.resolve({ ok: true, json: async () => ({ counts: { articles: 1 } }) });
      }
      if (url.endsWith('/slugs.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ blog: { known: { it: 'known' } } }),
        });
      }
      if (url === 'https://frontaliereticino.ch/articoli-frontaliere/') {
        return Promise.resolve({
          ok: true,
          text: async () => '<main class="ssg-article-grid"><a class="ssg-art-card" href="/articoli-frontaliere/live-only/"></a></main>',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const verdict = await checkCorpusFreshness('frontaliere', 1, {
        localRegistry: { known: { it: 'known' } },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.note).toContain('live-only');
    } finally {
      __resetCorpusFreshnessCache();
      vi.unstubAllGlobals();
    }
  });

  it('fails closed for armed direct invocations without lease enforcement', () => {
    const guardAt = hubDriver.indexOf('assertArticleChunkLease({ required: leaseRequired });');
    const renderAt = hubDriver.indexOf('await renderHubsAndOffload({');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(renderAt);
    expect(hubDriver).toMatch(
      /function assertArticleChunkLease\(\{ required = false \} = \{\}\)[\s\S]*?if \(required\) \{[\s\S]*?enforcement is required for non-dry publication/,
    );
  });

  it('rechecks the lease immediately before each serial locale shard mutation', () => {
    const pushAt = hubDriver.indexOf('// ── Push: ONE invocation per (section, locale)');
    const pushBlock = hubDriver.slice(pushAt);
    const checkAt = pushBlock.indexOf('assertArticleChunkLease({ required: true });');
    const spawnAt = pushBlock.indexOf("spawnCommand(\n        'bash'");

    expect(pushAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(spawnAt);
    expect(pushBlock).toContain('for (const locale of targetLocales)');
    expect(pushBlock).not.toContain('Promise.all');
  });

  it('stops before the next locale when the watcher writes the failure file', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'rerender-hub-lease-'));
    const failureFile = resolve(tempDir, 'lock.failure');
    const pidFile = resolve(tempDir, 'lock.pid');
    const previous = {
      enforce: process.env.ARTICLE_CHUNK_LOCK_ENFORCE,
      failure: process.env.ARTICLE_CHUNK_LOCK_FAILURE_FILE,
      pid: process.env.ARTICLE_CHUNK_LOCK_PID_FILE,
    };
    process.env.ARTICLE_CHUNK_LOCK_ENFORCE = 'true';
    process.env.ARTICLE_CHUNK_LOCK_FAILURE_FILE = failureFile;
    process.env.ARTICLE_CHUNK_LOCK_PID_FILE = pidFile;
    writeFileSync(pidFile, `${process.pid}\n`);

    const calls: string[] = [];
    const summary = {
      sections: {
        frontaliere: {
          shardToken: 'articolifrontaliere',
          distDir: tempDir,
          pathsByLocale: { it: ['it/index.html'], en: ['en/index.html'] },
        },
      },
    };

    try {
      await expect(
        pushRenderedLocales({
          sections: ['frontaliere'],
          targetLocales: ['it', 'en'],
          summary,
          pushScript: '/unused/push-article-shard-incremental.sh',
          spawn: async (_cmd: string, args: string[]) => {
            calls.push(args[2] ?? '');
            writeFileSync(failureFile, 'renewal lost\n');
            return { status: 0 };
          },
        }),
      ).rejects.toThrow(/article chunk lock was lost/);
      expect(calls).toEqual(['it']);
    } finally {
      if (previous.enforce === undefined) delete process.env.ARTICLE_CHUNK_LOCK_ENFORCE;
      else process.env.ARTICLE_CHUNK_LOCK_ENFORCE = previous.enforce;
      if (previous.failure === undefined) delete process.env.ARTICLE_CHUNK_LOCK_FAILURE_FILE;
      else process.env.ARTICLE_CHUNK_LOCK_FAILURE_FILE = previous.failure;
      if (previous.pid === undefined) delete process.env.ARTICLE_CHUNK_LOCK_PID_FILE;
      else process.env.ARTICLE_CHUNK_LOCK_PID_FILE = previous.pid;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('holds the shared section lease for the composite publication', () => {
    const acquireAt = hubWorkflow.indexOf('Acquire article chunk section lock');
    const renderAt = hubWorkflow.indexOf('Rerender ${{ matrix.section }} hubs');
    const verifyAt = hubWorkflow.indexOf('Verify article chunk section lock after rerender');
    const releaseAt = hubWorkflow.indexOf('Release article chunk section lock after rerender');

    expect(acquireAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeLessThan(renderAt);
    expect(renderAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(releaseAt);
    expect(hubWorkflow).toContain('r2-section-lock.mjs acquire --section "$ARTICLE_SECTION"');
    expect(hubWorkflow).toContain('r2-section-lock.mjs renew');
    expect(hubWorkflow).toContain('ARTICLE_CHUNK_LOCK_ENFORCE=true');
    expect(hubWorkflow).toContain('ARTICLE_CHUNK_LOCK_FAILURE_FILE');
    expect(hubWorkflow).toContain("if: always() && steps.acquire_chunk_lock.outcome == 'success'");
  });

  it('keeps the renewer pid attached to the live process in every article publisher', () => {
    for (const workflowPath of articleLockWorkflows) {
      const source = readFileSync(resolve(__dirname, '..', workflowPath), 'utf-8');
      expect(source, workflowPath).toContain(
        'env -u RUNNER_TRACKING_ID nohup node scripts/lib/r2-section-lock.mjs renew',
      );
      expect(source, workflowPath).not.toContain(
        'env -u RUNNER_TRACKING_ID nohup setsid node scripts/lib/r2-section-lock.mjs renew',
      );
    }
  });
});
