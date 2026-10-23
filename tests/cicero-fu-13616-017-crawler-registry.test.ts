import { describe, expect, it } from 'vitest';
import {
  assertEmittedFamiliesRegistered,
  diffEmittedFamiliesAgainstRegistry,
  expectedCorpusPaths,
} from '../scripts/ci/prepare-crawler-workflow-corpus-sync.mjs';

describe('crawler transport registry contract (#13616 FU-017)', () => {
  it('reports both an emitted family without a registry row and a stale row', () => {
    const diff = diffEmittedFamiliesAgainstRegistry({
      emittedSitePaths: ['.github/corpus-workflows/crawler-group-02.yml', '.github/corpus-workflows/new.yml'],
      registeredSitePaths: ['.github/corpus-workflows/crawler-group-02.yml', '.github/corpus-workflows/old.yml'],
    });

    expect(diff.unregistered).toEqual(['.github/corpus-workflows/new.yml']);
    expect(diff.unemitted).toEqual(['.github/corpus-workflows/old.yml']);
    expect(() => assertEmittedFamiliesRegistered({
      emittedSitePaths: ['.github/corpus-workflows/new.yml'],
      registeredSitePaths: [],
    })).toThrow(/registry missing or empty/);
  });

  it('keeps the generated crawler family set in the expected transport paths', () => {
    const paths = expectedCorpusPaths(['crawler-group-01.yml', 'translate-pending.yml']);

    expect(paths).toContain('.github/workflows/crawler-group-01.yml');
    expect(paths).toContain('.github/workflows/translate-pending.yml');
    expect(paths).toContain('generator/data/crawler-cross-repo-contract.json');
    expect(paths).toContain('scripts/ci/loop-sync-manifest.json');
  });
});
