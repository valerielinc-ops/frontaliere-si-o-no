import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { declaredTwinPaths, identicalTwinEntries } from '@/scripts/ci/corpus-ahead-check.mjs';
import { splitIntroducedHazards, transportPathsAtBase } from '@/scripts/ci/identical-twin-import-gate.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');

// La forma della #9887: il gemello `identical` acquista l'import di un modulo
// nuovo che il manifest del corpus non elenca.
const IMPORTER = 'scripts/ci/claude-codex-fallback.mjs';
const MODULE = 'scripts/lib/codex-fallback-contract.mjs';
const HAZARD = { from: IMPORTER, mode: 'identical', spec: '../lib/codex-fallback-contract.mjs', target: MODULE };

describe('splitIntroducedHazards', () => {
  it('replay #9887: importatore e modulo nuovi nella PR → introdotto', () => {
    const base: Record<string, string> = { [IMPORTER]: "import { x } from './claude-rate-limit.mjs';\n" };
    const { introduced, preexisting } = splitIntroducedHazards({
      hazards: [HAZARD],
      changed: new Set([IMPORTER, MODULE]),
      readBase: (rel: string) => base[rel] ?? null,
    });
    expect(introduced).toEqual([HAZARD]);
    expect(preexisting).toEqual([]);
  });

  it('un gemello ritoccato che importava gia\' lo stesso file scoperto → gia\' presente', () => {
    const base: Record<string, string> = {
      [IMPORTER]: "import { CODEX_FALLBACK_MODEL } from '../lib/codex-fallback-contract.mjs';\n",
      [MODULE]: 'export const CODEX_FALLBACK_MODEL = 1;\n',
    };
    const { introduced, preexisting } = splitIntroducedHazards({
      hazards: [HAZARD],
      changed: new Set([IMPORTER]),
      readBase: (rel: string) => base[rel] ?? null,
    });
    expect(introduced).toEqual([]);
    expect(preexisting).toEqual([HAZARD]);
  });

  it('import gia\' presente ma modulo aggiunto dalla PR → introdotto (alla base non risolveva)', () => {
    const base: Record<string, string> = {
      [IMPORTER]: "import { CODEX_FALLBACK_MODEL } from '../lib/codex-fallback-contract.mjs';\n",
    };
    const { introduced } = splitIntroducedHazards({
      hazards: [HAZARD],
      changed: new Set([MODULE]),
      readBase: (rel: string) => base[rel] ?? null,
    });
    expect(introduced).toEqual([HAZARD]);
  });

  it('ne\' importatore ne\' modulo nella PR → gia\' presente, senza leggere la base', () => {
    const readBase = vi.fn(() => null);
    const { introduced, preexisting } = splitIntroducedHazards({
      hazards: [HAZARD],
      changed: new Set(['services/unrelated.ts']),
      readBase,
    });
    expect(introduced).toEqual([]);
    expect(preexisting).toEqual([HAZARD]);
    expect(readBase).not.toHaveBeenCalled();
  });

  it('importatore e modulo invariati ma dichiarazione tolta dalla PR → introdotto', () => {
    const base: Record<string, string> = {
      [IMPORTER]: "import { CODEX_FALLBACK_MODEL } from '../lib/codex-fallback-contract.mjs';\n",
      [MODULE]: 'export const CODEX_FALLBACK_MODEL = 1;\n',
    };
    const { introduced, preexisting } = splitIntroducedHazards({
      hazards: [HAZARD],
      changed: new Set(['.github/transport/nanako-generator-manifest.txt']),
      readBase: (rel: string) => base[rel] ?? null,
      isDeclaredAtBase: (rel: string) => rel === MODULE,
    });
    expect(introduced).toEqual([HAZARD]);
    expect(preexisting).toEqual([]);
  });
});

describe('transportPathsAtBase', () => {
  const noRead = () => {
    throw new Error('la base non va letta');
  };

  it('PR che non tocca il transport: la consegna della base e\' quella di HEAD, senza leggere niente', () => {
    const headPaths = ['scripts/lib/ai-models.mjs'];
    expect(
      transportPathsAtBase({ changed: new Set(['services/x.ts']), headPaths, readBase: noRead, listBase: noRead }),
    ).toBe(headPaths);
  });

  it('PR che cambia il transport manifest: righe e glob letti dalla base', () => {
    const base: Record<string, string> = {
      '.github/transport/nanako-generator-manifest.txt':
        '# commento\nscripts/lib/ai-models.mjs\nscripts/lib/codex-fallback-contract.mjs\nscripts/lib/discovery/**\n',
    };
    const paths = transportPathsAtBase({
      changed: new Set(['.github/transport/nanako-generator-manifest.txt']),
      headPaths: ['scripts/lib/ai-models.mjs'],
      readBase: (rel: string) => base[rel] ?? null,
      listBase: (dir: string) => (dir === 'scripts/lib/discovery' ? ['scripts/lib/discovery/a.mjs'] : []),
    });
    expect(paths.sort()).toEqual([
      'scripts/lib/ai-models.mjs',
      'scripts/lib/codex-fallback-contract.mjs',
      'scripts/lib/discovery/a.mjs',
    ]);
  });
});

describe('ambito condiviso con corpus-ahead-check', () => {
  const manifest = {
    files: [
      { path: 'scripts/ci/a.mjs', mode: 'identical' },
      { path: 'generator/scripts/lib/b.mjs', sitePath: 'scripts/lib/b.mjs', mode: 'identical' },
      { path: 'scripts/ci/c.mjs', mode: 'adapted' },
      { path: 'scripts/ci/only-here.mjs', mode: 'corpus-only' },
      { path: 'scripts/ci/pending.mjs', mode: 'corpus-only-pending' },
    ],
  };

  it('i gemelli sono i soli identical, con il path del sito', () => {
    expect(identicalTwinEntries(manifest)).toEqual([
      { path: 'scripts/ci/a.mjs', mode: 'identical' },
      { path: 'scripts/lib/b.mjs', mode: 'identical' },
    ]);
  });

  it('dichiarato = manifest senza corpus-only* piu\' la consegna del transport', () => {
    expect([...declaredTwinPaths(manifest, ['data/borderCrossings.ts'])].sort()).toEqual([
      'data/borderCrossings.ts',
      'scripts/ci/a.mjs',
      'scripts/ci/c.mjs',
      'scripts/lib/b.mjs',
    ]);
  });
});

// Il cancello vero, su un repo git temporaneo con la forma del checkout di
// `tests.yml`: HEAD e' il merge commit della PR su main, HEAD^1 la punta di main.
describe('identical-twin-import-gate.mjs end-to-end', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]) {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  function write(root: string, rel: string, text: string) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }

  /**
   * `main` con i file di base, poi i commit della PR. Con `merge` (default) HEAD
   * e' il merge commit `--no-ff`, la forma di `refs/pull/N/merge`; senza, i
   * commit della PR stanno direttamente su main e HEAD ha un solo genitore.
   */
  function repo(baseFiles: Record<string, string | null>, prCommits: Array<Record<string, string | null>>, { merge = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-import-gate-'));
    dirs.push(root);
    for (const script of ['corpus-ahead-check.mjs', 'identical-twin-import-gate.mjs']) {
      write(root, `scripts/ci/${script}`, fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci', script), 'utf8'));
    }
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'test');
    const apply = (files: Record<string, string | null>, message: string) => {
      for (const [rel, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(root, rel), { force: true });
        else write(root, rel, text);
      }
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', message);
    };
    apply(baseFiles, 'base');
    if (merge) git(root, 'checkout', '-q', '-b', 'pr');
    prCommits.forEach((files, i) => apply(files, `pr ${i + 1}`));
    if (merge) {
      git(root, 'checkout', '-q', 'main');
      git(root, 'merge', '-q', '--no-ff', '-m', 'merge pr', 'pr');
    }
    return root;
  }

  function run(root: string, manifest: object | null, extraArgs: string[] = []) {
    const manifestFile = path.join(root, 'manifest.json');
    if (manifest) fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const res = spawnSync(
      process.execPath,
      ['scripts/ci/identical-twin-import-gate.mjs', '--manifest', manifestFile, ...extraArgs],
      { cwd: root, encoding: 'utf8' },
    );
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  }

  function sha(root: string, rev: string) {
    return execFileSync('git', ['rev-parse', rev], { cwd: root, encoding: 'utf8' }).trim();
  }

  const manifest = {
    files: [
      { path: IMPORTER, mode: 'identical' },
      { path: 'scripts/ci/claude-rate-limit.mjs', mode: 'adapted' },
    ],
  };
  const before = "import { detectClaudeRateLimit } from './claude-rate-limit.mjs';\n";
  const after = `${before}import { CODEX_FALLBACK_MODEL } from '../lib/codex-fallback-contract.mjs';\n`;
  const moduleText = "export const CODEX_FALLBACK_MODEL = 'm';\n";
  const baseFiles = { [IMPORTER]: before, 'scripts/ci/claude-rate-limit.mjs': 'export const detectClaudeRateLimit = 1;\n' };
  const prFiles = { [IMPORTER]: after, [MODULE]: moduleText };

  it('rosso sulla forma della #9887, con il rimedio', () => {
    const root = repo(baseFiles, [prFiles]);
    const { status, out } = run(root, manifest);
    expect(status).toBe(1);
    expect(out).toContain(`::error file=${IMPORTER}::`);
    expect(out).toContain(MODULE);
    expect(out).toContain('1 introdotti da questa PR');
    expect(out).toContain('loop-sync-manifest.json');
  });

  it('rosso anche se l\'import sta nel PRIMO di due commit della PR: il merge commit copre tutta la PR', () => {
    const root = repo(baseFiles, [prFiles, { 'docs/note.md': 'commit non correlato\n' }]);
    const { status, out } = run(root, manifest);
    expect(status).toBe(1);
    expect(out).toContain('1 introdotti da questa PR');
    // La forma dell'invocazione di tests.yml: base passata esplicitamente.
    const explicit = run(root, manifest, ['--base', sha(root, 'HEAD^1')]);
    expect(explicit.status).toBe(1);
    expect(explicit.out).toContain('1 introdotti da questa PR');
  });

  it('senza --base un HEAD con un solo genitore e\' un rosso esplicito; con --base il confronto e\' esatto', () => {
    const root = repo(baseFiles, [prFiles, { 'docs/note.md': 'commit non correlato\n' }], { merge: false });
    const implicit = run(root, manifest);
    expect(implicit.status).toBe(1);
    expect(implicit.out).toContain("HEAD non e' un merge commit");
    const explicit = run(root, manifest, ['--base', sha(root, 'HEAD~2')]);
    expect(explicit.status).toBe(1);
    expect(explicit.out).toContain('1 introdotti da questa PR');
  });

  it('verde quando il modulo e\' gia\' dichiarato nel manifest del corpus', () => {
    const root = repo(baseFiles, [prFiles]);
    const { status, out } = run(root, { files: [...manifest.files, { path: MODULE, mode: 'identical' }] });
    expect(status).toBe(0);
    expect(out).toContain('0 import non dichiarati');
  });

  it('un pericolo gia\' su main resta un avviso anche se la PR ritocca il gemello', () => {
    const root = repo({ ...baseFiles, [IMPORTER]: after, [MODULE]: moduleText }, [{ [IMPORTER]: `${after}// ritocco\n` }]);
    const { status, out } = run(root, manifest);
    expect(status).toBe(0);
    expect(out).toContain(`::warning file=${IMPORTER}::`);
    expect(out).toContain("1 gia' presenti");
  });

  it('rosso se la PR toglie la riga del transport manifest che copriva l\'import', () => {
    const transport = '.github/transport/nanako-generator-manifest.txt';
    const root = repo(
      { ...baseFiles, [IMPORTER]: after, [MODULE]: moduleText, [transport]: `${MODULE}\n` },
      [{ [transport]: '# niente\n' }],
    );
    const { status, out } = run(root, manifest);
    expect(status).toBe(1);
    expect(out).toContain('1 introdotti da questa PR');
  });

  it('manifest illeggibile: rosso, un cancello che non ha guardato non e\' verde', () => {
    const root = repo(baseFiles, [prFiles]);
    const { status, out } = run(root, null);
    expect(status).toBe(1);
    expect(out).toContain('::error::identical-twin-import-gate: manifest del corpus illeggibile');
  });

  it('base non risolvibile: rosso', () => {
    const root = repo(baseFiles, [prFiles]);
    const { status, out } = run(root, manifest, ['--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    expect(status).toBe(1);
    expect(out).toContain('::error::identical-twin-import-gate: base del confronto non risolvibile');
  });
});

describe('tests.yml', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/tests.yml'), 'utf8');

  it('il cancello e\' nel roster dei gate indipendenti, solo su PR e merge queue', () => {
    expect(workflow).toContain('expected_labels+=(twin-imports)');
    expect(workflow).toContain(
      `start_gate twin-imports 'node scripts/ci/identical-twin-import-gate.mjs \${TWIN_GATE_BASE:+--base "$TWIN_GATE_BASE"}'`,
    );
    expect(workflow).toContain(
      'TWIN_GATE_BASE: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
    );
    expect(workflow).toMatch(
      /RUN_TWIN_IMPORTS: \$\{\{ steps\.body_contract\.outcome != 'failure' && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\) \}\}/,
    );
  });
});
