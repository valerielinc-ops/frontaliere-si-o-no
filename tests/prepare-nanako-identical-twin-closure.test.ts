import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADAPTED_TWIN_DISPOSITIONS,
  IDENTICAL_TWIN_DEPENDENCIES,
  reconcileNanakoLoopManifest,
} from '../scripts/ci/prepare-nanako-identical-twin-closure.mjs';

const hashes = {
  'scripts/lib/first-name-recognition.mjs': {
    site: '1111111111111111',
    corpus: '1111111111111111',
  },
  'scripts/lib/first-names.json': {
    site: '2222222222222222',
    corpus: '2222222222222222',
  },
};

function manifestWithTransportedTwins() {
  return {
    version: 1,
    files: [
      {
        path: 'generator/scripts/lib/evergreen-topic-generator.mjs',
        sitePath: 'scripts/lib/evergreen-topic-generator.mjs',
        mode: 'identical',
        baseline: { site: 'aaaa', corpus: 'bbbb', alignedAt: '2026-10-16' },
      },
      {
        path: 'generator/scripts/ci/harvest-agent-lessons.mjs',
        sitePath: 'scripts/ci/harvest-agent-lessons.mjs',
        mode: 'identical',
        baseline: { site: 'cccc', corpus: 'dddd', alignedAt: '2026-10-16' },
      },
      {
        path: 'generator/scripts/lib/article-factuality-gates.mjs',
        sitePath: 'scripts/lib/article-factuality-gates.mjs',
        mode: 'identical',
      },
    ],
  };
}

describe('prepare-nanako-identical-twin-closure', () => {
  it('registers the missing identical dependency closure and preserves adapted boundaries', () => {
    const result = reconcileNanakoLoopManifest(manifestWithTransportedTwins(), {
      hashes,
      alignedAt: '2026-10-17',
    });

    const bySitePath = new Map(result.manifest.files.map((entry) => [entry.sitePath, entry]));
    for (const dependency of IDENTICAL_TWIN_DEPENDENCIES) {
      expect(bySitePath.get(dependency.sitePath)).toMatchObject({
        path: dependency.corpusPath,
        sitePath: dependency.sitePath,
        mode: 'identical',
        baseline: { ...hashes[dependency.sitePath], alignedAt: '2026-10-17' },
      });
    }
    for (const disposition of ADAPTED_TWIN_DISPOSITIONS) {
      expect(bySitePath.get(disposition.sitePath)).toMatchObject({
        path: disposition.corpusPath,
        sitePath: disposition.sitePath,
        mode: 'adapted',
        reason: disposition.reason,
      });
    }
    expect(bySitePath.get('scripts/lib/article-factuality-gates.mjs')).toMatchObject({
      mode: 'identical',
    });
    expect(result.added).toEqual(IDENTICAL_TWIN_DEPENDENCIES.map(({ sitePath }) => sitePath));
    expect(result.updated).toEqual(ADAPTED_TWIN_DISPOSITIONS.map(({ sitePath }) => sitePath));
  });

  it('is idempotent once the closure has been reconciled', () => {
    const first = reconcileNanakoLoopManifest(manifestWithTransportedTwins(), {
      hashes,
      alignedAt: '2026-10-17',
    });
    const second = reconcileNanakoLoopManifest(first.manifest, {
      hashes,
      alignedAt: '2026-10-17',
    });

    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual([
      ...IDENTICAL_TWIN_DEPENDENCIES.map(({ sitePath }) => sitePath),
      ...ADAPTED_TWIN_DISPOSITIONS.map(({ sitePath }) => sitePath),
    ]);
    expect(second.manifest).toEqual(first.manifest);
  });

  it('fails closed when an adapted boundary is missing or an identical entry is duplicated', () => {
    const missing = manifestWithTransportedTwins();
    missing.files = missing.files.filter(
      (entry) => entry.sitePath !== 'scripts/ci/harvest-agent-lessons.mjs',
    );
    expect(() => reconcileNanakoLoopManifest(missing, { hashes, alignedAt: '2026-10-17' }))
      .toThrow('loop-sync entry missing for scripts/ci/harvest-agent-lessons.mjs');

    const duplicate = manifestWithTransportedTwins();
    duplicate.files.push({
      path: 'generator/scripts/lib/first-name-recognition.mjs',
      sitePath: 'scripts/lib/first-name-recognition.mjs',
      mode: 'identical',
    });
    expect(() => reconcileNanakoLoopManifest(duplicate, { hashes, alignedAt: '2026-10-17' }))
      .toThrow('duplicate loop-sync entries for scripts/lib/first-name-recognition.mjs');
  });

  it('is wired into the structural transport before the staged-change check', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../.github/workflows/transport-generator-to-nanako.yml'),
      'utf8',
    );
    const reconcileCall = workflow.indexOf('prepare-nanako-identical-twin-closure.mjs');
    const stageManifest = workflow.indexOf('git add -- scripts/ci/loop-sync-manifest.json');
    const changeCheck = workflow.indexOf('if git diff --cached --quiet;', reconcileCall);
    const commitFlag = workflow.indexOf('steps.reconcile.outputs.has_changes');

    expect(reconcileCall).toBeGreaterThan(-1);
    expect(stageManifest).toBeGreaterThan(reconcileCall);
    expect(changeCheck).toBeGreaterThan(stageManifest);
    expect(commitFlag).toBeGreaterThan(changeCheck);
  });
});
