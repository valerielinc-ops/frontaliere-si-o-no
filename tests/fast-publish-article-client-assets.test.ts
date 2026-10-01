import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pushRenderedLocales } from '../scripts/rerender-article-hubs.mjs';

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
  it('publishes the matching client chunks before render/offload and shard fan-out', () => {
    const publishAt = hubDriver.indexOf('await publishClientChunks(sections, args.dryRun);');
    const renderAt = hubDriver.indexOf('await renderHubsAndOffload({');
    const pushAt = hubDriver.indexOf('// ── Push: ONE invocation per (section, locale)');

    expect(publishAt).toBeGreaterThan(-1);
    expect(publishAt).toBeLessThan(renderAt);
    expect(publishAt).toBeLessThan(pushAt);
    expect(hubDriver).toContain("path.join(ROOT_DIR, 'scripts', 'publish-article-chunks.mjs')");
    expect(hubDriver).toContain("args.push('--strict', '--no-ticker')");
    expect(hubDriver).toContain('assertArticleChunkLease({ required: leaseRequired });\n  await publishClientChunks');
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
});
