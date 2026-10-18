import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTED_TWIN_DISPOSITIONS,
  IDENTICAL_TWIN_DEPENDENCIES,
  reconcileNanakoLoopManifest,
} from '../scripts/ci/prepare-nanako-identical-twin-closure.mjs';
import {
  SITE_OWNED_MANIFEST_PATH,
  reconcileNanakoGeneratorTransport,
  validateStagedGeneratorDeletions,
} from '../scripts/ci/reconcile-nanako-generator-transport.mjs';

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
        path: 'scripts/ci/harvest-agent-lessons.mjs',
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
        adaptationIssue: disposition.adaptationIssue,
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
    duplicate.files.push(
      {
        path: 'generator/scripts/lib/first-name-recognition.mjs',
        sitePath: 'scripts/lib/first-name-recognition.mjs',
        mode: 'identical',
      },
      {
        path: 'generator/scripts/lib/first-name-recognition.mjs',
        sitePath: 'scripts/lib/first-name-recognition.mjs',
        mode: 'identical',
      },
    );
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

  it('overlays an existing nanako generator without deleting corpus-owned files', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../.github/workflows/transport-generator-to-nanako.yml'),
      'utf8',
    );
    const stageStart = workflow.indexOf('- name: Stage into a nanako clone');
    const reconcileStart = workflow.indexOf('- name: Reconcile identical-twin closure');
    const stage = workflow.slice(stageStart, reconcileStart);
    const guardStart = workflow.indexOf('- name: Guard - refuse any unowned deletion');
    const guard = workflow.slice(guardStart, workflow.indexOf('- name: Show staged diff', guardStart));

    expect(stage).toContain('reconcile-nanako-generator-transport.mjs');
    expect(stage).not.toMatch(/\brm\s+-rf\s+generator\b/);
    expect(stage).toContain('git add -A -- generator');
    expect(stage).toContain('git add -f -- "$transport_ledger"');
    expect(guard).toContain('--guard');
    expect(guard).toContain('git diff --cached --diff-filter=D --name-only -z --');
    expect(guard).toContain('reconcile-nanako-generator-transport.mjs');
  });

  it('removes stale site-owned files, preserves nanako-owned files, and passes the staged guard', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanako-generator-transport-'));
    const sourceRoot = path.join(root, 'site');
    const corpusRoot = path.join(root, 'nanako');
    const resolvedManifestPath = path.join(root, 'resolved-manifest.txt');
    const previousManifestPath = path.join(root, 'previous-manifest.txt');
    try {
      fs.mkdirSync(path.join(sourceRoot), { recursive: true });
      fs.mkdirSync(path.join(corpusRoot, 'generator'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'new.mjs'), 'new\n');
      fs.writeFileSync(path.join(corpusRoot, 'generator/old.mjs'), 'old\n');
      fs.writeFileSync(path.join(corpusRoot, 'generator/local.mjs'), 'nanako\n');
      fs.mkdirSync(path.join(corpusRoot, path.dirname(SITE_OWNED_MANIFEST_PATH)), { recursive: true });
      fs.writeFileSync(
        path.join(corpusRoot, SITE_OWNED_MANIFEST_PATH),
        'old.mjs\n',
      );
      fs.writeFileSync(resolvedManifestPath, 'new.mjs\n');

      reconcileNanakoGeneratorTransport({
        sourceRoot,
        corpusRoot,
        resolvedManifestPath,
        previousManifestOutputPath: previousManifestPath,
      });

      expect(fs.existsSync(path.join(corpusRoot, 'generator/old.mjs'))).toBe(false);
      expect(fs.readFileSync(path.join(corpusRoot, 'generator/local.mjs'), 'utf8')).toBe('nanako\n');
      expect(fs.readFileSync(path.join(corpusRoot, 'generator/new.mjs'), 'utf8')).toBe('new\n');
      expect(fs.readFileSync(previousManifestPath, 'utf8')).toBe('old.mjs\n');
      expect(fs.readFileSync(path.join(corpusRoot, SITE_OWNED_MANIFEST_PATH), 'utf8')).toBe('new.mjs\n');

      const guard = validateStagedGeneratorDeletions({
        corpusRoot,
        resolvedManifestPath,
        previousManifestPath,
        stagedPaths: ['generator/old.mjs'],
      });
      expect(guard.allowed).toEqual(['generator/old.mjs']);
      expect(guard.unexpected).toEqual([]);
      expect(validateStagedGeneratorDeletions({
        corpusRoot,
        resolvedManifestPath,
        previousManifestPath,
        stagedPaths: ['generator/local.mjs'],
      }).unexpected).toEqual(['generator/local.mjs']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
