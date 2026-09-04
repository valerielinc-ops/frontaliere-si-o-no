import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  CRAWLER_WORKFLOW_FILES,
  CORPUS_OBSERVER_FILES,
} from '../../scripts/ci/prepare-crawler-workflow-corpus-sync.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(ROOT, '.github/workflows/sync-crawler-workflows-to-corpus.yml');
const scriptPath = path.join(ROOT, 'scripts/ci/sync-crawler-workflows-to-corpus.sh');
const workflowSource = fs.readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(workflowSource);
const on = workflow.on ?? workflow.true;
const script = fs.readFileSync(scriptPath, 'utf8');

describe('crawler workflow corpus transport', () => {
  it('ha trigger main sui portable artifact e schedule di recupero', () => {
    expect(on.push.branches).toEqual(['main']);
    expect(on.push.paths).toContain('.github/corpus-workflows/**');
    expect(on.schedule?.length).toBeGreaterThan(0);
    expect(on.workflow_dispatch).toBeDefined();
  });

  it('usa sparse checkout e l unica credenziale cross-repo gia esistente', () => {
    const checkout = workflow.jobs.sync.steps.find((step: any) => step.uses === 'actions/checkout@v5');
    expect(checkout.with['sparse-checkout']).toContain('/.github/corpus-workflows/');
    expect(workflowSource).toContain('ARTICLES_REPO_PAT: ${{ secrets.ARTICLES_REPO_PAT }}');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflowSource).not.toMatch(/GITHUB_PAT|APP_TOKEN/);
  });

  it('ritenta con backoff e fallisce loud dopo tre tentativi', () => {
    expect(workflowSource).toMatch(/for attempt in 1 2 3/);
    expect(workflowSource).toMatch(/delay=\$\(\(attempt \* 30\)\)/);
    expect(workflowSource).toMatch(/transport exhausted 3 attempts/);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('pusha normalmente solo una branch PR e deduplica aggiornando quella aperta', () => {
    expect(script).toContain('gh pr list --repo "$target_repo" --state open');
    expect(script).toContain('--state open --limit 1000');
    expect(script).toContain('gh pr create --repo "$target_repo" --base main --head "$head_ref"');
    expect(script).toContain('git push -u origin "HEAD:$target_branch"');
    expect(script).not.toMatch(/git push[^\n]*(--force|HEAD:main|origin main)/);
    expect(script).not.toMatch(/gh pr edit/);
    expect(script).toContain('branch updated without replacing its body');
    expect(script.indexOf('git diff --name-only origin/main...HEAD'))
      .toBeLessThan(script.indexOf('git push -u origin "HEAD:$target_branch"'));
  });

  it('allowlista esattamente 24 workflow esecutivi, observer shadow, contratto e manifest e rifiuta delete', () => {
    expect(script).toContain('crawler-group-(0[1-9]|1[0-9]|2[0-3])');
    expect(script).toContain('crawler-generation-observer-shadow\\.yml');
    expect(script).toContain('generator/data/crawler-cross-repo-contract\\.json');
    expect(script).toContain('generator/tests/crawler-cross-repo-artifacts\\.test\\.mjs');
    expect(script).toContain('scripts/ci/lib/crawler-generation-token');
    expect(script).toContain('scripts/ci/loop-sync-manifest\\.json');
    expect(script).toContain('--assert-manifest-delta');
    expect(script).toContain('git diff --cached --diff-filter=D --name-only');
    expect(script).toMatch(/refuses artifact deletion/);
    expect(script).not.toMatch(/content\/|engine\/|host\//);
  });

  it('lo script di consegna e sintatticamente valido', () => {
    expect(() => execFileSync('bash', ['-n', scriptPath], { stdio: 'pipe' })).not.toThrow();
  });

  it('recupera branch remoto orfano quando il primo pr create fallisce', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-remote-'));
    try {
      const seed = path.join(tmp, 'seed');
      const remote = path.join(tmp, 'corpus.git');
      const bin = path.join(tmp, 'bin');
      const state = path.join(tmp, 'create-failed-once');
      const calls = path.join(tmp, 'gh-calls');
      fs.mkdirSync(path.join(seed, 'scripts/ci'), { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(seed, 'scripts/ci/loop-sync-manifest.json'), JSON.stringify({
        files: [
          {
            path: 'generator/data/corpus-owned.json',
            mode: 'corpus-only',
            reason: 'fixture owned only by corpus',
          },
        ],
      }));
      execFileSync('git', ['init', '-b', 'main'], { cwd: seed, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: seed });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seed });
      execFileSync('git', ['add', '.'], { cwd: seed });
      execFileSync('git', ['commit', '-m', 'seed'], { cwd: seed, stdio: 'pipe' });
      execFileSync('git', ['clone', '--bare', seed, remote], { stdio: 'pipe' });

      const ghStub = path.join(bin, 'gh');
      fs.writeFileSync(ghStub, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "api user" ]; then
  printf '%s\\n' 'valerielinc-ops'
elif [ "$1 $2" = "pr list" ]; then
  printf '%s\\n' "$GH_STUB_LIST_JSON"
elif [ "$1 $2" = "pr create" ]; then
  printf '%s\\n' create >> "$GH_STUB_CALLS"
  if [ ! -f "$GH_STUB_STATE" ]; then
    touch "$GH_STUB_STATE"
    exit 1
  fi
  printf '%s\\n' 'https://example.test/pull/1'
else
  exit 2
fi
`);
      fs.chmodSync(ghStub, 0o700);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ARTICLES_REPO_PAT: 'test-token-not-a-secret',
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_WORKSPACE: ROOT,
        CRAWLER_SYNC_TARGET_URL: remote,
        GH_STUB_STATE: state,
        GH_STUB_CALLS: calls,
        GH_STUB_LIST_JSON: '[]',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      expect(() => execFileSync('bash', [scriptPath], { cwd: ROOT, env, stdio: 'pipe' })).toThrow();
      expect(execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'crawler-workflows-lockstep-*'], { encoding: 'utf8' }))
        .toContain('crawler-workflows-lockstep-0123456789ab');

      // Simula main avanzato dopo il push orfano: il retry deve creare un vero
      // merge commit, quindi l'identità Git deve essere configurata PRIMA del merge.
      fs.writeFileSync(path.join(seed, 'main-advanced.txt'), 'advanced\n');
      execFileSync('git', ['add', 'main-advanced.txt'], { cwd: seed });
      execFileSync('git', ['commit', '-m', 'advance main'], { cwd: seed, stdio: 'pipe' });
      execFileSync('git', ['push', remote, 'main'], { cwd: seed, stdio: 'pipe' });

      expect(() => execFileSync('bash', [scriptPath], { cwd: ROOT, env, stdio: 'pipe' })).not.toThrow();
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
      const transportedGroup = execFileSync('git', [
        '--git-dir', remote,
        'show',
        'crawler-workflows-lockstep-0123456789ab:.github/workflows/crawler-group-01.yml',
      ], { encoding: 'utf8' });
      expect(transportedGroup).toContain('sparse cross-repo execution');
      expect(transportedGroup).toContain('crawler-generation-${{ inputs.generation_token }}-group-01');
      expect(transportedGroup).toContain('node scripts/crawler-group-generation-finalizer.mjs');
      expect(transportedGroup).toContain('uses: actions/upload-artifact@v7');
      expect(transportedGroup).toContain('retention-days: 14');
      const transportedContract = JSON.parse(execFileSync('git', [
        '--git-dir', remote,
        'show',
        'crawler-workflows-lockstep-0123456789ab:generator/data/crawler-cross-repo-contract.json',
      ], { encoding: 'utf8' }));
      expect(transportedContract.crawlerGeneration).toMatchObject({
        mode: 'shadow',
        artifactRetentionDays: 14,
        dispatchesTranslation: false,
      });
      expect(transportedContract.siteRuntimePaths).toContain('scripts/lib/crawler-generation-receipt.mjs');
      expect(transportedContract.siteRuntimePaths).toContain('scripts/crawler-generation-observer.mjs');
      expect(execFileSync('git', [
        '--git-dir', remote,
        'show',
        'crawler-workflows-lockstep-0123456789ab:.github/workflows/crawler-generation-observer-shadow.yml',
      ], { encoding: 'utf8' })).toContain('crawler-generation-sentinel-${{ inputs.generation_token }}');
      expect(execFileSync('git', [
        '--git-dir', remote,
        'show',
        'crawler-workflows-lockstep-0123456789ab:generator/tests/crawler-cross-repo-artifacts.test.mjs',
      ], { encoding: 'utf8' })).toContain('crawler unici');
      const transportedLoopManifest = JSON.parse(execFileSync('git', [
        '--git-dir', remote,
        'show',
        'crawler-workflows-lockstep-0123456789ab:scripts/ci/loop-sync-manifest.json',
      ], { encoding: 'utf8' }));
      const ownedMappings = transportedLoopManifest.files.filter((entry: any) =>
        entry.sitePath?.startsWith('.github/corpus-workflows/'));
      expect(ownedMappings).toHaveLength(CRAWLER_WORKFLOW_FILES.length + CORPUS_OBSERVER_FILES.length + 1);
      expect(ownedMappings).toEqual(expect.arrayContaining(CORPUS_OBSERVER_FILES.map(({ source, target }) => ({
        path: target,
        sitePath: `.github/corpus-workflows/${source}`,
        mode: 'identical',
        baseline: expect.objectContaining({ site: expect.any(String), corpus: expect.any(String) }),
      }))));
      expect(transportedLoopManifest.files.find((entry: any) =>
        entry.path === 'generator/data/corpus-owned.json').reason).toBe('fixture owned only by corpus');
      expect(Number(execFileSync('git', [
        '--git-dir', remote,
        'rev-list', '--count', '--merges', 'crawler-workflows-lockstep-0123456789ab',
      ], { encoding: 'utf8' }).trim())).toBeGreaterThan(0);

      const callsAfterRecovery = fs.readFileSync(calls, 'utf8');
      const forkLike = {
        ...env,
        GH_STUB_LIST_JSON: JSON.stringify([{
          number: 99,
          headRefName: 'crawler-workflows-lockstep-foreign',
          baseRefName: 'main',
          headRepositoryOwner: { login: 'foreign-owner' },
          headRepository: { name: 'frontaliere-articles' },
          author: { login: 'valerielinc-ops' },
          isCrossRepository: true,
        }]),
      };
      expect(() => execFileSync('bash', [scriptPath], { cwd: ROOT, env: forkLike, stdio: 'pipe' }))
        .toThrow();
      expect(fs.readFileSync(calls, 'utf8')).toBe(callsAfterRecovery);

      // Una branch remota orfana contaminata deve fallire sul delta completo
      // prima del push, lasciando il ref remoto byte-per-byte invariato.
      const contaminatedSha = 'fedcba9876543210fedcba9876543210fedcba98';
      const contaminatedBranch = `crawler-workflows-lockstep-${contaminatedSha.slice(0, 12)}`;
      execFileSync('git', ['fetch', remote, 'crawler-workflows-lockstep-0123456789ab'], {
        cwd: seed,
        stdio: 'pipe',
      });
      execFileSync('git', ['checkout', '-b', contaminatedBranch, 'FETCH_HEAD'], {
        cwd: seed,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(seed, 'unexpected.txt'), 'must never be transported\n');
      execFileSync('git', ['add', 'unexpected.txt'], { cwd: seed });
      execFileSync('git', ['commit', '-m', 'contaminate orphan'], { cwd: seed, stdio: 'pipe' });
      execFileSync('git', ['push', remote, contaminatedBranch], { cwd: seed, stdio: 'pipe' });
      const before = execFileSync('git', ['--git-dir', remote, 'rev-parse', contaminatedBranch], {
        encoding: 'utf8',
      }).trim();
      expect(() => execFileSync('bash', [scriptPath], {
        cwd: ROOT,
        env: { ...env, GITHUB_SHA: contaminatedSha },
        stdio: 'pipe',
      })).toThrow();
      const after = execFileSync('git', ['--git-dir', remote, 'rev-parse', contaminatedBranch], {
        encoding: 'utf8',
      }).trim();
      expect(after).toBe(before);

      const manifestSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const manifestBranch = `crawler-workflows-lockstep-${manifestSha.slice(0, 12)}`;
      execFileSync('git', ['fetch', remote, 'crawler-workflows-lockstep-0123456789ab'], {
        cwd: seed,
        stdio: 'pipe',
      });
      execFileSync('git', ['checkout', '-B', manifestBranch, 'FETCH_HEAD'], {
        cwd: seed,
        stdio: 'pipe',
      });
      const loopManifestPath = path.join(seed, 'scripts/ci/loop-sync-manifest.json');
      const loopManifest = JSON.parse(fs.readFileSync(loopManifestPath, 'utf8'));
      loopManifest.files.find((entry: any) => entry.path === 'generator/data/corpus-owned.json').reason =
        'contaminated non-owned entry';
      fs.writeFileSync(loopManifestPath, `${JSON.stringify(loopManifest, null, 2)}\n`);
      execFileSync('git', ['add', 'scripts/ci/loop-sync-manifest.json'], { cwd: seed });
      execFileSync('git', ['commit', '-m', 'contaminate non-owned manifest entry'], {
        cwd: seed,
        stdio: 'pipe',
      });
      execFileSync('git', ['push', remote, manifestBranch], { cwd: seed, stdio: 'pipe' });
      const manifestBefore = execFileSync('git', ['--git-dir', remote, 'rev-parse', manifestBranch], {
        encoding: 'utf8',
      }).trim();
      expect(() => execFileSync('bash', [scriptPath], {
        cwd: ROOT,
        env: { ...env, GITHUB_SHA: manifestSha },
        stdio: 'pipe',
      })).toThrow();
      const manifestAfter = execFileSync('git', ['--git-dir', remote, 'rev-parse', manifestBranch], {
        encoding: 'utf8',
      }).trim();
      expect(manifestAfter).toBe(manifestBefore);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
