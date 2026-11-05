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

  it('requires the private R2 key pair before publishing a changed ticker', () => {
    const loader = workflow.indexOf('- name: Load private R2 publishing credentials');
    const publish = workflow.indexOf('- name: Publish the news-ticker payload to the edge');
    const nextStep = workflow.indexOf('\n      - name:', publish + 1);
    const loadStep = workflow.slice(loader, publish);
    const publishStep = workflow.slice(publish, nextStep < 0 ? undefined : nextStep);

    expect(loader).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(loader);
    expect(loadStep).toContain("if: steps.commit.outputs.ticker-changed == 'true'");
    expect(loadStep).toContain('--only-social-env=R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY');
    expect(loadStep).toContain('test -n "${R2_ACCESS_KEY_ID:-}"');
    expect(loadStep).toContain('test -n "${R2_SECRET_ACCESS_KEY:-}"');
    expect(publishStep).not.toContain('continue-on-error: true');
    expect(publishStep).toContain('private R2 credentials absent');
  });
});
