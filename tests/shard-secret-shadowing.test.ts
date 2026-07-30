// Regression coverage for the 2026-07-30 uri-it incident (deploy run
// 30522223432): a shard deploy key existed at BOTH the repository level and in
// the `shard-secrets-overflow` environment. GitHub resolves `secrets.*` with the
// environment winning, so the freshly generated repo-level key CI was supposed
// to use was inert — the shard served 3-day-stale HTML behind a green deploy.
import { describe, it, expect } from 'vitest';
import {
  findShadowedSecrets,
  SHARD_KEY_RE,
  REPO_SECRET_CAP,
} from '../scripts/ci/check-shard-secret-shadowing.mjs';
import { buildFailureIssue } from '../scripts/ci/report-shard-push-failure.mjs';

describe('findShadowedSecrets', () => {
  it('flags the exact incident shape: repo-level key shadowed by the overflow environment', () => {
    const shadowed = findShadowedSecrets({
      repoSecrets: ['SHARD_URI_IT_DEPLOY_KEY', 'SHARD_ZURIGO_IT_DEPLOY_KEY', 'CF_API_TOKEN'],
      envSecrets: {
        'shard-secrets-overflow': [
          'SHARD_URI_IT_DEPLOY_KEY',
          'SHARD_VAUD_IT_DEPLOY_KEY',
          'SHARD_VALLESE_IT_DEPLOY_KEY',
        ],
      },
    });
    expect(shadowed).toEqual([
      { name: 'SHARD_URI_IT_DEPLOY_KEY', environment: 'shard-secrets-overflow', isShardKey: true },
    ]);
  });

  it('stays silent when each secret lives at exactly one level', () => {
    expect(
      findShadowedSecrets({
        repoSecrets: ['SHARD_ZURIGO_IT_DEPLOY_KEY'],
        envSecrets: { 'shard-secrets-overflow': ['SHARD_URI_IT_DEPLOY_KEY'] },
      }),
    ).toEqual([]);
  });

  it('reports a non-shard collision too, but does not mark it as a shard key', () => {
    const shadowed = findShadowedSecrets({
      repoSecrets: ['CF_API_TOKEN'],
      envSecrets: { 'shard-secrets-overflow': ['CF_API_TOKEN'] },
    });
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].isShardKey).toBe(false);
  });

  it('tolerates a repo with no environments at all', () => {
    expect(findShadowedSecrets({ repoSecrets: ['A'], envSecrets: {} })).toEqual([]);
  });

  it('recognises every real shard key spelling and nothing else', () => {
    for (const name of [
      'SHARD_URI_IT_DEPLOY_KEY',
      'SHARD_VALLESE_FR_DEPLOY_KEY',
      'SHARD_ARTICOLIFRONTALIERE_DE_DEPLOY_KEY',
    ]) {
      expect(SHARD_KEY_RE.test(name)).toBe(true);
    }
    for (const name of ['SHARD_URI_IT', 'GITHUB_PAT', 'SHARD_URI_ES_DEPLOY_KEY']) {
      expect(SHARD_KEY_RE.test(name)).toBe(false);
    }
  });

  it('pins the documented per-repo secret cap that forced the overflow environment', () => {
    expect(REPO_SECRET_CAP).toBe(100);
  });
});

describe('buildFailureIssue', () => {
  it('keeps the dedup key stable across runs (no run id / date in the title)', () => {
    const a = buildFailureIssue({ locale: 'it', shards: ['uri'], runUrl: 'https://x/runs/1' });
    const b = buildFailureIssue({ locale: 'it', shards: ['vaud'], runUrl: 'https://x/runs/2' });
    // github-issue-creator.mjs dedups on the first 60 chars of the title.
    expect(a.title.slice(0, 60)).toBe(b.title.slice(0, 60));
    expect(a.title).not.toMatch(/\d{4}-\d{2}-\d{2}|runs?\/\d+/);
  });

  it('names every unpublished shard and the run in the body', () => {
    const { description } = buildFailureIssue({
      locale: 'en',
      shards: ['uri', 'vaud'],
      runUrl: 'https://github.com/o/r/actions/runs/42',
    });
    expect(description).toContain('`uri-en`');
    expect(description).toContain('`vaud-en`');
    expect(description).toContain('https://github.com/o/r/actions/runs/42');
    expect(description).toContain('check-shard-secret-shadowing.mjs');
  });

  it('omits the run line when the workflow context is absent', () => {
    const { description } = buildFailureIssue({ locale: 'de', shards: ['uri'] });
    expect(description).not.toContain('Run:');
  });
});
