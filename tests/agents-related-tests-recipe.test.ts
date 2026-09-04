import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// La ricetta pre-PR di AGENTS.md non e' prosa: gli agent la eseguono verbatim,
// e il suo output (`changed-paths.txt` + `changed-paths-status.txt`) e' l'input
// di `run-related-tests.mjs`. La versione precedente scriveva `complete`
// incondizionatamente dopo un `git diff --name-only "$(git merge-base ...)"`:
// quando il merge-base non risolve (storia non imparentata, clone shallow che
// non arriva all'antenato comune) la sostituzione e' vuota, il diff esce
// non-zero e l'elenco resta parziale — ma lo stato diceva `complete`, cioe'
// zero test selezionati e dichiarati verdi. Questo test esegue la ricetta
// ESTRATTA DAL DOCUMENTO, cosi' non puo' divergere da cio' che l'agent legge.

const AGENTS_MD = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');

function extractRecipe(): string {
  const blocks = AGENTS_MD.match(/```bash\n([\s\S]*?)```/g) ?? [];
  const block = blocks.find((b) => b.includes('changed-paths-status.txt'));
  expect(block, 'ricetta con changed-paths-status.txt non trovata in AGENTS.md').toBeTruthy();
  return (block as string)
    .replace(/^```bash\n/, '')
    .replace(/```$/, '')
    .split('\n')
    // L'ultima riga lancia davvero Vitest: qui interessa solo il collector.
    .filter((line) => !line.includes('run-related-tests.mjs'))
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

/**
 * Clone locale con un remoto `origin` reale, cosi' il `git fetch origin main`
 * della ricetta e' quello vero e non uno stub.
 *
 * `related=false` fa nascere HEAD da una storia orfana: `git merge-base
 * origin/main HEAD` esce non-zero senza output, esattamente il caso segnalato.
 */
function makeRepo(related: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recipe-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(root, ['init', '--bare', '-b', 'main', remote]);
  git(work, ['init', '-b', 'main']);
  git(work, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(work, 'base.txt'), 'base\n');
  // Nel repo vero i due file di lavoro sono gitignorati: senza, `git ls-files
  // --others` li rimetterebbe dentro l'elenco che sta scrivendo.
  fs.writeFileSync(path.join(work, '.gitignore'), 'changed-paths.txt\nchanged-paths-status.txt\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['push', '-q', 'origin', 'main']);

  if (!related) {
    git(work, ['checkout', '-q', '--orphan', 'feature']);
    git(work, ['rm', '-q', '-rf', '.']);
    fs.writeFileSync(path.join(work, 'orphan.txt'), 'orphan\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-m', 'orphan']);
  } else {
    git(work, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(work, 'base.txt'), 'changed\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-m', 'change']);
    // File non tracciato: la ricetta deve includerlo (una PR che AGGIUNGE
    // moduli non deve selezionare zero test).
    fs.writeFileSync(path.join(work, 'brand-new.ts'), 'export {};\n');
  }
  return work;
}

function runRecipe(cwd: string): { paths: string[]; state: string } {
  // Fuori dal working tree: uno script dentro il repo sarebbe un file non
  // tracciato e finirebbe nel proprio elenco.
  const script = path.join(cwd, '..', 'recipe.sh');
  fs.writeFileSync(script, extractRecipe());
  execFileSync('bash', [script], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (f: string) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), 'utf8') : '');
  return {
    paths: read('changed-paths.txt').split('\n').map((l) => l.trim()).filter(Boolean),
    state: read('changed-paths-status.txt').trim(),
  };
}

describe('ricetta pre-PR di AGENTS.md (collector changed-paths)', () => {
  beforeAll(() => {
    // Se il blocco sparisce o viene rinominato, i casi sotto girerebbero su una
    // stringa vuota e passerebbero per finta.
    expect(extractRecipe()).toContain('changed-paths-status.txt');
  });

  it('non scrive mai `complete` incondizionatamente', () => {
    const recipe = extractRecipe();
    expect(recipe).toContain('merge-base');
    expect(recipe).toMatch(/partial/);
    // `complete` deve stare dentro un ramo condizionale, mai come riga finale
    // che segue il diff qualunque cosa sia successa.
    expect(recipe).toMatch(/if \[ -n "\$base" \]/);
  });

  it('con merge-base risolvibile: elenca diff + non tracciati e dichiara complete', () => {
    const cwd = makeRepo(true);
    const { paths, state } = runRecipe(cwd);
    expect(state).toBe('complete');
    expect(paths).toContain('base.txt');
    expect(paths).toContain('brand-new.ts');
    expect(paths).not.toContain('changed-paths.txt');
  });

  it('senza merge-base: stato partial e elenco vuoto, mai un complete bugiardo', () => {
    const cwd = makeRepo(false);
    const { paths, state } = runRecipe(cwd);
    expect(state).toBe('partial');
    expect(state).not.toBe('complete');
    expect(paths).toEqual([]);
  });

  it('lo stato non-complete forza la suite intera nel runner', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'scripts/ci/run-related-tests.mjs'), 'utf8');
    expect(runner).toContain("changedStatus !== 'complete'");
  });
});
