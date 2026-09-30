import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve(__dirname, '..', '.github/workflows/fast-publish-article.yml'),
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
