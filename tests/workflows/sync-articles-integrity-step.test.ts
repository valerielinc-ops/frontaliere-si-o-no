import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/sync-articles-sitemaps.yml'),
  'utf8',
);

describe('sync-articles-sitemaps routing integrity gate', () => {
  it('validates the pinned corpus and HTTP pair before deciding to commit it', () => {
    const pullSurface = workflow.indexOf('- name: Pull the article corpus and published HTTP surface');
    const integrity = workflow.indexOf('- name: Validate article routing integrity');
    const commitDecision = workflow.indexOf('- name: Decide whether this run may commit');

    expect(pullSurface).toBeGreaterThanOrEqual(0);
    expect(integrity).toBeGreaterThan(pullSurface);
    expect(commitDecision).toBeGreaterThan(integrity);

    const integrityStep = workflow.slice(integrity, commitDecision);
    expect(integrityStep).toContain("if: steps.pull-article-surface.outputs.skipped != 'true'");
    expect(integrityStep).toContain(
      'run: node scripts/ci/validate-article-append-integrity.mjs --swiss-only',
    );
  });
});
