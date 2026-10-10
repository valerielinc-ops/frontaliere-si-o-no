import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/sync-articles-sitemaps.yml'),
  'utf8',
);

describe('sync-articles-sitemaps routing integrity gate', () => {
  it('validates the pinned corpus and sitemap pair before deciding to commit it', () => {
    const pullCorpus = workflow.indexOf('- name: Pull the article corpus');
    const pullApi = workflow.indexOf('- name: Pull published sitemaps');
    const integrity = workflow.indexOf('- name: Validate article routing integrity');
    const commitDecision = workflow.indexOf('- name: Decide whether this run may commit');

    expect(pullCorpus).toBeGreaterThanOrEqual(0);
    expect(pullApi).toBeGreaterThan(pullCorpus);
    expect(integrity).toBeGreaterThan(pullApi);
    expect(commitDecision).toBeGreaterThan(integrity);

    const integrityStep = workflow.slice(integrity, commitDecision);
    expect(integrityStep).toContain(
      "if: steps.pull-corpus.outputs.skipped != 'true' && steps.pull-api.outputs.skipped != 'true'",
    );
    expect(integrityStep).toContain(
      'run: node scripts/ci/validate-article-append-integrity.mjs --swiss-only',
    );
  });
});
