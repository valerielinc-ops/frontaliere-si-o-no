import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  CRAWLER_WORKFLOW_FILES,
  CORPUS_OBSERVER_FILES,
  assertCrawlerManifestDelta,
  prepareCrawlerWorkflowCorpusSync,
} from '../../scripts/ci/prepare-crawler-workflow-corpus-sync.mjs';
import {
  UNREFRESHABLE_TITLE,
  unrefreshableAnnotation,
  WATCHDOG_RUNTIME_PATH,
  assertTranslatePendingArtifact,
  assertWatchdogRuntimeDelta,
  evaluateWatchdogTargetAssumptions,
  gitBlobSha,
  manifestDigest,
} from '../../scripts/ci/translate-watchdog-pin.mjs';

import {
  CRAWLER_GENERATION_PORTABLE_TOKEN_EXPR as PORTABLE_GENERATION_TOKEN_EXPR,
} from '../../scripts/generate-crawler-group-workflows.mjs';

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
    const checkout = workflow.jobs.sync.steps.find((step: any) => step.uses === 'actions/checkout@v7');
    expect(checkout.with['sparse-checkout']).toContain('/.github/corpus-workflows/');
    expect(workflowSource).toContain('ARTICLES_REPO_PAT: ${{ secrets.ARTICLES_REPO_PAT }}');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflowSource).not.toMatch(/GITHUB_PAT|APP_TOKEN/);
  });

  it('materializza la closure degli import del gate body prima di aprire la PR corpus', () => {
    const checkout = workflow.jobs.sync.steps.find((step: any) => step.uses === 'actions/checkout@v7');
    const sparsePaths = new Set(String(checkout.with['sparse-checkout'])
      .split(/\r?\n/)
      .map((entry) => entry.trim().replace(/^\//, ''))
      .filter(Boolean));
    const pending = [path.join(ROOT, 'scripts/ci/pr-body-check-gate.mjs')];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const source = fs.readFileSync(current, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
        pending.push(path.resolve(path.dirname(current), match[1]));
      }
    }

    const missing = [...visited]
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter((file) => !sparsePaths.has(file))
      .sort();
    expect(missing).toEqual([]);
  });

  it('ritenta con backoff e fallisce loud dopo tre tentativi', () => {
    expect(workflowSource).toMatch(/for attempt in 1 2 3/);
    expect(workflowSource).toMatch(/delay=\$\(\(attempt \* 30\)\)/);
    expect(workflowSource).toMatch(/transport exhausted 3 attempts/);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('non dichiara successo se il gate body non e eseguibile', () => {
    expect(script).toContain('::error::crawler transport body PR non verificabile');
    expect(script).toContain('exit "$gate_status"');
    expect(script).not.toContain('::warning::crawler transport body PR non verificabile');
  });

  it('pusha normalmente solo una branch PR e deduplica aggiornando quella aperta', () => {
    expect(script).toContain('gh pr list --repo "$target_repo" --state open');
    expect(script).toContain('--state open --limit 1000');
    expect(script).toContain('gh pr create --repo "$target_repo" --base main --head "$head_ref"');
    expect(script).toContain('git push -u origin "HEAD:$target_branch"');
    expect(script).not.toMatch(/git push[^\n]*(--force|HEAD:main|origin main)/);
    expect(script).not.toMatch(/gh pr edit/);
    expect(script).toContain('branch updated without replacing its body');
    expect(script.indexOf('assert_transport_paths origin/main...HEAD'))
      .toBeLessThan(script.indexOf('git push -u origin "HEAD:$target_branch"'));
  });

  it('deriva dal contratto l allowlist dei workflow esecutivi e rifiuta delete', () => {
    expect(script).toContain('expected_transport_paths=');
    expect(script).toContain('contract.artifacts.map');
    expect(script).toContain('contract.observers.map');
    expect(script).toContain('assert_transport_paths --cached');
    expect(script).toContain('assert_transport_paths origin/main...HEAD');
    expect(script).toContain('scripts/ci/lib/crawler-generation-group-ids.mjs');
    expect(script).toContain('--assert-manifest-delta');
    expect(script).toContain('git diff --cached --diff-filter=D --name-only');
    expect(script).toMatch(/refuses artifact deletion/);
    expect(script).not.toMatch(/content\/|engine\/|host\//);
  });

  it('descrive nel body generato il delta reale, senza conteggi fissi del catalogo', () => {
    expect(script).toContain('i file di trasporto effettivamente presenti nel diff della branch');
    expect(script).toContain('il trasporto resta limitato ai file elencati dal diff');
    expect(script).not.toMatch(/24 workflow crawler eseguibili|sette observer dedicati|32 baseline/);
  });

  it('emette stati espliciti nel body per evitare un finding Important del review-gate', () => {
    const bodyStart = script.indexOf('## Non implementato (ancora)');
    const bodyEnd = script.indexOf('\nBODY', bodyStart);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = script.slice(bodyStart, bodyEnd);
    expect(body).toContain('- in questa PR, per scelta:');
    expect(body).toContain('**Motivo:**');
    expect(body).toContain('**Prossimo passo:**');
    expect(body).toContain('- blocked:');
    expect(body).not.toContain('\n- by construction:');
    expect(body).not.toContain('\n- per scelta:');
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
      expect(transportedGroup).toContain(`crawler-generation-${PORTABLE_GENERATION_TOKEN_EXPR}-group-01`);
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
  it('REGRESSIONE corpus #2008: una branch di trasporto in conflitto con main viene rigenerata, non lascia il trasporto fermo', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-conflict-'));
    try {
      const seed = path.join(tmp, 'seed');
      const remote = path.join(tmp, 'corpus.git');
      const bin = path.join(tmp, 'bin');
      const calls = path.join(tmp, 'gh-calls');
      const manifestPath = path.join(seed, 'scripts/ci/loop-sync-manifest.json');
      const manifest = (reason: string) => JSON.stringify({
        files: [{ path: 'generator/data/corpus-owned.json', mode: 'corpus-only', reason }],
      });
      fs.mkdirSync(path.join(seed, 'scripts/ci'), { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(manifestPath, manifest('fixture owned only by corpus'));
      const git = (args: string[], cwd = seed) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'test']);
      git(['config', 'user.email', 'test@example.com']);
      git(['add', '.']);
      git(['commit', '-m', 'seed']);
      execFileSync('git', ['clone', '--bare', seed, remote], { stdio: 'pipe' });

      const ghStub = path.join(bin, 'gh');
      fs.writeFileSync(ghStub, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_STUB_CALLS"
if [ "$1 $2" = "api user" ]; then
  printf '%s\\n' 'valerielinc-ops'
elif [ "$1 $2" = "pr list" ]; then
  printf '%s\\n' "$GH_STUB_LIST_JSON"
elif [ "$1 $2" = "pr create" ]; then
  printf '%s\\n' 'https://example.test/pull/1'
elif [ "$1 $2" = "pr close" ]; then
  exit 0
else
  exit 2
fi
`);
      fs.chmodSync(ghStub, 0o700);
      const branch = 'crawler-workflows-lockstep-0123456789ab';
      const rebuiltBranch = `${branch}-rebuilt`;
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ARTICLES_REPO_PAT: 'test-token-not-a-secret',
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_WORKSPACE: ROOT,
        CRAWLER_SYNC_TARGET_URL: remote,
        GH_STUB_CALLS: calls,
        GH_STUB_LIST_JSON: '[]',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      // Prima consegna: branch + PR aperta.
      execFileSync('bash', [scriptPath], { cwd: ROOT, env, stdio: 'pipe' });
      const delivered = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();

      // main del corpus cambia la stessa riga del manifest: il merge della
      // branch di trasporto con main va in conflitto.
      fs.writeFileSync(manifestPath, manifest('reason updated on corpus main'));
      git(['add', '.']);
      git(['commit', '-m', 'corpus main moves the manifest']);
      git(['push', remote, 'main']);
      const mainTip = git(['rev-parse', 'HEAD']).trim();

      const openPr = JSON.stringify([{
        number: 2008,
        headRefName: branch,
        baseRefName: 'main',
        headRepositoryOwner: { login: 'nanakokyobashi-rgb' },
        headRepository: { name: 'frontaliere-articles' },
        author: { login: 'valerielinc-ops' },
        isCrossRepository: false,
      }]);
      expect(() => execFileSync('bash', [scriptPath], {
        cwd: ROOT,
        env: { ...env, GH_STUB_LIST_JSON: openPr },
        stdio: 'pipe',
      })).not.toThrow();

      // La vecchia branch non viene riscritta (niente force-push)…
      expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim()).toBe(delivered);
      // …la consegna rinasce su una branch nuova figlia di main, senza merge…
      expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${rebuiltBranch}^`], { encoding: 'utf8' }).trim()).toBe(mainTip);
      expect(Number(execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', '--merges', `${mainTip}..${rebuiltBranch}`], { encoding: 'utf8' }).trim())).toBe(0);
      // …conserva la riga di main e riporta il trasporto.
      const transported = JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', `${rebuiltBranch}:scripts/ci/loop-sync-manifest.json`], { encoding: 'utf8' }));
      expect(transported.files.find((entry: { path: string }) => entry.path === 'generator/data/corpus-owned.json').reason)
        .toBe('reason updated on corpus main');
      expect(transported.files.some((entry: { sitePath?: string }) => entry.sitePath?.startsWith('.github/corpus-workflows/'))).toBe(true);
      // La PR in conflitto viene chiusa PRIMA di aprire la nuova: resta una sola PR di trasporto.
      const ghCalls = fs.readFileSync(calls, 'utf8').split('\n');
      const close = ghCalls.findIndex((line) => line.startsWith('pr close 2008') && line.includes('--delete-branch'));
      const creates = ghCalls.map((line, i) => (line.startsWith('pr create') ? i : -1)).filter((i) => i >= 0);
      expect(close).toBeGreaterThan(-1);
      expect(creates).toHaveLength(2);
      expect(creates[1]).toBeGreaterThan(close);
      expect(ghCalls[creates[1]]).toContain(`--head ${rebuiltBranch}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('lo sparse checkout del job contiene ogni script Node che la consegna esegue, con i suoi import', () => {
    const checkout = workflow.jobs.sync.steps.find((step: any) => step.uses === 'actions/checkout@v7');
    const sparsePaths = new Set(String(checkout.with['sparse-checkout'])
      .split(/\r?\n/)
      .map((entry) => entry.trim().replace(/^\//, ''))
      .filter(Boolean));
    const pending = [...script.matchAll(/\$site_root\/(scripts\/[A-Za-z0-9_./-]+\.mjs)/g)]
      .map((match) => path.join(ROOT, match[1]));
    expect(pending.length).toBeGreaterThan(0);
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const source = fs.readFileSync(current, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
        pending.push(path.resolve(path.dirname(current), match[1]));
      }
    }
    const missing = [...visited]
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter((file) => !sparsePaths.has(file))
      .sort();
    expect(missing).toEqual([]);
    expect(on.push.paths).toContain('scripts/ci/translate-watchdog-pin.mjs');
  });
});

// Il corpus tiene un pin sul blob di `translate-pending.yml` nel runtime del
// suo watchdog. Corpus #1998 e #2052: il trasporto consegnava il workflow nuovo
// senza il pin e la PR di lockstep restava rossa finche' qualcuno non lo
// rinfrescava a mano (20 ore su #2052).
describe('crawler workflow corpus transport — pin del watchdog translate', () => {
  const TRANSLATE_WORKFLOW = '.github/workflows/translate-pending.yml';
  const MANIFEST = 'scripts/ci/loop-sync-manifest.json';
  const WATCHDOG_REASON = 'fixture: runtime corpus-only del watchdog translate';
  const siteArtifact = fs.readFileSync(path.join(ROOT, '.github/corpus-workflows/translate-pending.yml'));
  const runtimeSource = (pin: string) => [
    "export const TARGET_WORKFLOW_PATH = '.github/workflows/translate-pending.yml';",
    `export const TARGET_WORKFLOW_BLOB_SHA = '${pin}';`,
    "const ALLOWED_EVENTS = new Set(['schedule', 'workflow_dispatch']);",
    "export const holds = (job) => job?.name === 'translate' && job?.status === 'in_progress';",
    '',
  ].join('\n');

  /** Corpus finto con workflow, runtime del watchdog e manifest coerenti fra loro. */
  function setupCorpus(tmp: string, { workflow, siteRoot = ROOT }: { workflow: Buffer | string; siteRoot?: string }) {
    const seed = path.join(tmp, 'seed');
    const remote = path.join(tmp, 'corpus.git');
    const bin = path.join(tmp, 'bin');
    const bodyCopy = path.join(tmp, 'pr-body.md');
    const pin = gitBlobSha(Buffer.from(workflow));
    const runtime = runtimeSource(pin);
    fs.mkdirSync(path.join(seed, 'scripts/ci'), { recursive: true });
    fs.mkdirSync(path.join(seed, '.github/workflows'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(seed, TRANSLATE_WORKFLOW), workflow);
    fs.writeFileSync(path.join(seed, WATCHDOG_RUNTIME_PATH), runtime);
    fs.writeFileSync(path.join(seed, MANIFEST), `${JSON.stringify({
      files: [
        { path: 'generator/data/corpus-owned.json', mode: 'corpus-only', reason: 'fixture owned only by corpus' },
        {
          path: WATCHDOG_RUNTIME_PATH,
          mode: 'corpus-only',
          reason: WATCHDOG_REASON,
          baseline: { site: null, corpus: manifestDigest(Buffer.from(runtime)), alignedAt: '2026-01-01' },
        },
      ],
    }, null, 2)}\n`);
    const git = (args: string[], cwd = seed) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['add', '.']);
    git(['commit', '-m', 'seed']);
    execFileSync('git', ['clone', '--bare', seed, remote], { stdio: 'pipe' });

    const ghStub = path.join(bin, 'gh');
    fs.writeFileSync(ghStub, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "api user" ]; then
  printf '%s\\n' 'valerielinc-ops'
elif [ "$1 $2" = "pr list" ]; then
  printf '%s\\n' '[]'
elif [ "$1 $2" = "pr create" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cp "$2" "$GH_STUB_BODY"; fi
    shift
  done
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
      GITHUB_WORKSPACE: siteRoot,
      CRAWLER_SYNC_TARGET_URL: remote,
      GH_STUB_BODY: bodyCopy,
      // Con FORCE_COLOR i `console.log` numerici dello script escono colorati
      // e i suoi confronti interi falliscono: l'esito non deve dipendere dal terminale.
      FORCE_COLOR: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const branch = 'crawler-workflows-lockstep-0123456789ab';
    const show = (ref: string) => execFileSync('git', ['--git-dir', remote, 'show', ref], { encoding: 'utf8' });
    const run = () => execFileSync('bash', [path.join(siteRoot, 'scripts/ci/sync-crawler-workflows-to-corpus.sh')], {
      cwd: siteRoot,
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const changedPaths = () => execFileSync('git', ['--git-dir', remote, 'diff', '--name-only', 'main', branch], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const watchdogEntry = () => JSON.parse(show(`${branch}:${MANIFEST}`)).files
      .find((entry: { path: string }) => entry.path === WATCHDOG_RUNTIME_PATH);
    return { remote, branch, pin, runtime, bodyCopy, show, run, changedPaths, watchdogEntry };
  }

  it('cambio di translate-pending.yml: pin e baseline del manifest rinfrescati nello stesso commit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-pin-'));
    try {
      const corpus = setupCorpus(tmp, { workflow: 'name: workflow rivisto in passato\n' });
      corpus.run();

      // L'albero consegnato e' quello in cui il test del corpus passa: pin = blob
      // sha del workflow nuovo, digest del manifest = sha256[0..16] del runtime.
      const deliveredBlob = execFileSync('git', ['--git-dir', corpus.remote, 'rev-parse', `${corpus.branch}:${TRANSLATE_WORKFLOW}`], { encoding: 'utf8' }).trim();
      expect(deliveredBlob).toBe(gitBlobSha(siteArtifact));
      const deliveredRuntime = corpus.show(`${corpus.branch}:${WATCHDOG_RUNTIME_PATH}`);
      expect(deliveredRuntime).toBe(runtimeSource(deliveredBlob));
      expect(corpus.watchdogEntry()).toEqual({
        path: WATCHDOG_RUNTIME_PATH,
        mode: 'corpus-only',
        reason: WATCHDOG_REASON,
        baseline: { site: null, corpus: manifestDigest(Buffer.from(deliveredRuntime)), alignedAt: '2026-01-01' },
      });
      expect(corpus.changedPaths()).toEqual(expect.arrayContaining([TRANSLATE_WORKFLOW, WATCHDOG_RUNTIME_PATH, MANIFEST]));
      // Un solo commit: workflow e pin non possono arrivare separati.
      expect(execFileSync('git', ['--git-dir', corpus.remote, 'rev-list', '--count', `main..${corpus.branch}`], { encoding: 'utf8' }).trim()).toBe('1');
      expect(execFileSync('git', ['--git-dir', corpus.remote, 'log', '-1', '--format=%B', corpus.branch], { encoding: 'utf8' }))
        .toContain('Refresh translate watchdog pin');
      const body = fs.readFileSync(corpus.bodyCopy, 'utf8');
      expect(body).toContain(`pin del watchdog rinfrescato: \`${corpus.pin}\` → \`${deliveredBlob}\``);
      expect(body.indexOf('pin del watchdog rinfrescato')).toBeLessThan(body.indexOf('## Non implementato (ancora)'));
      expect(body).not.toContain(UNREFRESHABLE_TITLE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('translate-pending.yml invariato: il runtime del watchdog non viene toccato', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-pin-'));
    try {
      const corpus = setupCorpus(tmp, { workflow: siteArtifact });
      corpus.run();
      const changed = corpus.changedPaths();
      expect(changed).toContain(MANIFEST);
      expect(changed).not.toContain(WATCHDOG_RUNTIME_PATH);
      expect(changed).not.toContain(TRANSLATE_WORKFLOW);
      expect(corpus.show(`${corpus.branch}:${WATCHDOG_RUNTIME_PATH}`)).toBe(corpus.runtime);
      expect(corpus.watchdogEntry().baseline.corpus).toBe(manifestDigest(Buffer.from(corpus.runtime)));
      expect(fs.readFileSync(corpus.bodyCopy, 'utf8')).not.toContain('pin del watchdog');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('workflow nuovo senza job translate: pin NON rinfrescato, avviso nel body e job rosso col titolo stabile', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-pin-'));
    try {
      // Sito finto: stessi script, ma un artifact translate-pending senza il job
      // `translate` (rinominato), dichiarato coerentemente dal contratto.
      // Contiene SOLO i path dello sparse checkout del job: la consegna deve
      // riuscire con quelli. `realpath`: gli script riconoscono il proprio
      // avvio confrontando argv con il path reale del modulo.
      const siteRoot = path.join(fs.realpathSync(tmp), 'site');
      const source = path.join(siteRoot, '.github/corpus-workflows');
      const checkout = workflow.jobs.sync.steps.find((step: any) => step.uses === 'actions/checkout@v7');
      for (const entry of String(checkout.with['sparse-checkout']).split(/\r?\n/)) {
        const relative = entry.trim().replace(/^\//, '').replace(/\/$/, '');
        if (!relative) continue;
        fs.mkdirSync(path.dirname(path.join(siteRoot, relative)), { recursive: true });
        fs.cpSync(path.join(ROOT, relative), path.join(siteRoot, relative), { recursive: true });
      }
      const renamed = siteArtifact.toString('utf8').replace(/^ {2}translate:$/m, '  translate_all:');
      expect(renamed).not.toBe(siteArtifact.toString('utf8'));
      fs.writeFileSync(path.join(source, 'translate-pending.yml'), renamed);
      const sha256 = (content: Buffer | string) => execFileSync('shasum', ['-a', '256'], { input: content, encoding: 'utf8' }).slice(0, 64);
      const contractPath = path.join(source, 'contract.json');
      const contract = fs.readFileSync(contractPath, 'utf8');
      expect(contract.split(sha256(siteArtifact))).toHaveLength(2);
      fs.writeFileSync(contractPath, contract.replace(sha256(siteArtifact), sha256(renamed)));

      const corpus = setupCorpus(tmp, { workflow: 'name: workflow rivisto in passato\n', siteRoot });
      let failure: { status?: number; stdout?: string } = {};
      try {
        corpus.run();
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain(unrefreshableAnnotation('error', '').slice(0, -2));
      expect(failure.stdout).toMatch(/^::error title=Lockstep crawler%3A pin del watchdog translate non rinfrescabile[^\n]*job `translate` assente dal workflow$/m);

      // La consegna e' avvenuta comunque: il rosso del corpus e' il segnale.
      expect(corpus.show(`${corpus.branch}:${TRANSLATE_WORKFLOW}`)).toBe(renamed);
      expect(corpus.changedPaths()).not.toContain(WATCHDOG_RUNTIME_PATH);
      expect(corpus.show(`${corpus.branch}:${WATCHDOG_RUNTIME_PATH}`)).toBe(corpus.runtime);
      expect(corpus.watchdogEntry().baseline.corpus).toBe(manifestDigest(Buffer.from(corpus.runtime)));
      const body = fs.readFileSync(corpus.bodyCopy, 'utf8');
      const pending = body.slice(body.indexOf('## Non implementato (ancora)'));
      expect(pending).toContain(`- blocked: decisione del proprietario. ${UNREFRESHABLE_TITLE}`);
      expect(pending).toContain('**Motivo:** job `translate` assente dal workflow. **Prossimo passo:**');
      expect(body).not.toContain('pin del watchdog rinfrescato');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('assert_translate_pending_artifact fallisce su un artifact diverso dal contratto o senza il gate richiesto', () => {
    // La guardia gira dopo la copia e prima che qualunque file venga messo in stage.
    expect(script).toMatch(/^assert_translate_pending_artifact\(\) \{$/m);
    const prepared = script.indexOf('"$site_root/.github/corpus-workflows" "$PWD"\nassert_translate_pending_artifact\n');
    expect(prepared).toBeGreaterThan(-1);
    expect(prepared).toBeLessThan(script.indexOf('git add -- '));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-artifact-'));
    try {
      const sourceDir = path.join(ROOT, '.github/corpus-workflows');
      const delivered = path.join(tmp, TRANSLATE_WORKFLOW);
      fs.mkdirSync(path.dirname(delivered), { recursive: true });
      fs.writeFileSync(delivered, siteArtifact);
      expect(() => assertTranslatePendingArtifact({ sourceDir, corpusRoot: tmp })).not.toThrow();

      fs.writeFileSync(delivered, `${siteArtifact.toString('utf8')}# mirror stantio\n`);
      expect(() => assertTranslatePendingArtifact({ sourceDir, corpusRoot: tmp })).toThrow(/does not match the contract/);
      fs.rmSync(delivered);
      expect(() => assertTranslatePendingArtifact({ sourceDir, corpusRoot: tmp })).toThrow(/missing from the corpus checkout/);

      // Contratto e artifact coerenti fra loro, ma senza il gate `repair_lane_budget`.
      const gateless = siteArtifact.toString('utf8').replace(/^(\s+)id: repair_lane_budget$/m, '$1id: other_gate');
      const staleSource = path.join(tmp, 'source');
      fs.mkdirSync(staleSource);
      fs.writeFileSync(path.join(staleSource, 'contract.json'), JSON.stringify({
        artifacts: [{
          file: 'translate-pending.yml',
          artifactSha256: execFileSync('shasum', ['-a', '256'], { input: gateless, encoding: 'utf8' }).slice(0, 64),
        }],
      }));
      fs.writeFileSync(delivered, gateless);
      expect(() => assertTranslatePendingArtifact({ sourceDir: staleSource, corpusRoot: tmp }))
        .toThrow(/lacks the required gate step `repair_lane_budget`/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rinfresca solo se il workflow rispetta le presunzioni statiche del runtime del watchdog', () => {
    const runtime = runtimeSource('0'.repeat(40));
    const workflowText = siteArtifact.toString('utf8');
    const violations = (text: string) => evaluateWatchdogTargetAssumptions({ workflow: text, runtime });
    expect(violations(workflowText)).toEqual([]);
    expect(violations(workflowText.replace(/^ {2}translate:$/m, '  translate_all:')))
      .toEqual(['job `translate` assente dal workflow']);
    expect(violations(workflowText.replace(/^ {6}group: jobs-data-pipeline$/m, '      group: another-mutex')).join('\n'))
      .toContain('non tiene il mutex `jobs-data-pipeline`');
    expect(violations(workflowText.replace(/^ {6}cancel-in-progress: false$/m, '      cancel-in-progress: true')).join('\n'))
      .toContain('cancel-in-progress: false');
    expect(violations(workflowText.replace(/^ {4}timeout-minutes: 350$/m, '    timeout-minutes: 720')).join('\n'))
      .toContain('non e\' un intero entro 350');
    expect(violations(workflowText.replace(/^ {2}workflow_dispatch:$/m, '  push:')).join('\n'))
      .toContain('trigger fuori dagli eventi ammessi dal watchdog');
    expect(violations(workflowText.replace(/^jobs:$/m, 'concurrency: jobs-data-pipeline\njobs:')).join('\n'))
      .toContain('`concurrency` a livello di workflow');
    // Il mutex deve stare sul SOLO job bersaglio: un guard dentro il mutex
    // (in blocco o inline) cambia chi e' il detentore.
    const otherJobs = [...workflowText.slice(workflowText.indexOf('\njobs:\n')).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)]
      .map((match) => match[1])
      .filter((name) => name !== 'translate');
    expect(otherJobs.length).toBeGreaterThan(0);
    const guard = otherJobs[0];
    expect(violations(workflowText.replace(
      `\n  ${guard}:\n`,
      `\n  ${guard}:\n    concurrency:\n      group: jobs-data-pipeline\n      cancel-in-progress: false\n`,
    ))).toEqual([`il job \`${guard}\` dichiara \`concurrency\`: il mutex \`jobs-data-pipeline\` deve stare sul solo job \`translate\``]);
    expect(violations(workflowText.replace(`\n  ${guard}:\n`, `\n  ${guard}:\n    concurrency: another-group\n`)).join('\n'))
      .toContain(`il job \`${guard}\` dichiara \`concurrency\``);
    expect(violations(workflowText.replace(`\n  ${guard}:\n`, `\n  "${guard}":\n`)).join('\n'))
      .toContain('job in forma non generata');
    // Runtime che non dichiara piu' il job bersaglio: nessun rinfresco alla cieca.
    expect(evaluateWatchdogTargetAssumptions({ workflow: workflowText, runtime: 'export const X = 1;\n' }))
      .toHaveLength(1);
  });

  it('il path del runtime nell allowlist ammette solo la riga del pin e la sua baseline', () => {
    const base = runtimeSource('a'.repeat(40));
    const workflowBytes = Buffer.from('name: consegnato\n');
    const pinned = runtimeSource(gitBlobSha(workflowBytes));
    expect(assertWatchdogRuntimeDelta({ baseRuntime: base, currentRuntime: base, workflowBytes })).toBeNull();
    expect(assertWatchdogRuntimeDelta({ baseRuntime: base, currentRuntime: pinned, workflowBytes }))
      .toEqual({ previousPin: 'a'.repeat(40), nextPin: gitBlobSha(workflowBytes) });
    expect(() => assertWatchdogRuntimeDelta({ baseRuntime: base, currentRuntime: `${pinned}export const smuggled = 1;\n`, workflowBytes }))
      .toThrow(/beyond its target workflow pin/);
    expect(() => assertWatchdogRuntimeDelta({ baseRuntime: base, currentRuntime: runtimeSource('b'.repeat(40)), workflowBytes }))
      .toThrow(/does not match the delivered workflow/);
    expect(() => assertWatchdogRuntimeDelta({ baseRuntime: undefined, currentRuntime: pinned, workflowBytes }))
      .toThrow(/may not add or remove/);
    expect(script.indexOf('--describe "$PWD" "$pin_state"'))
      .toBeLessThan(script.indexOf('git push -u origin "HEAD:$target_branch"'));

    const entry = (corpus: string, reason = WATCHDOG_REASON) => ({
      path: WATCHDOG_RUNTIME_PATH,
      mode: 'corpus-only',
      reason,
      baseline: { site: null, corpus, alignedAt: '2026-01-01' },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-sync-manifest-'));
    try {
      // Manifest reale del trasporto: il preparatore aggiunge le voci owned.
      fs.mkdirSync(path.join(tmp, 'scripts/ci'), { recursive: true });
      fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify({ files: [entry('1111111111111111')] }));
      prepareCrawlerWorkflowCorpusSync({
        sourceDir: path.join(ROOT, '.github/corpus-workflows'),
        corpusRoot: tmp,
        alignedAt: '2026-01-01',
      });
      const prepared = fs.readFileSync(path.join(tmp, MANIFEST), 'utf8');
      const delta = (current: ReturnType<typeof entry>, watchdogRuntimeDigest?: string) => () => {
        const currentManifest = JSON.parse(prepared);
        currentManifest.files[0] = current;
        assertCrawlerManifestDelta({
          baseManifest: { files: [entry('1111111111111111')] },
          currentManifest,
          watchdogRuntimeDigest,
        });
      };
      const outsideOwned = /outside its owned baselines/;
      expect(delta(entry('1111111111111111'))).not.toThrow();
      // La deroga vale solo per il digest del file realmente nel checkout…
      expect(delta(entry('2222222222222222'), '2222222222222222')).not.toThrow();
      expect(delta(entry('2222222222222222'))).toThrow(outsideOwned);
      expect(delta(entry('2222222222222222'), '3333333333333333')).toThrow(outsideOwned);
      // …e solo per `baseline.corpus`: nessun altro campo della voce puo' cambiare.
      expect(delta(entry('2222222222222222', 'reason riscritta'), '2222222222222222')).toThrow(outsideOwned);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
