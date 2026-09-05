/**
 * sibling-check-gate.mjs — false-positive filter tests (issue #3325).
 *
 * The gate now reads the `## Non implementato` section from the `gh pr create`
 * command string and allows PR creation when ALL sibling candidates are
 * explicitly declared as false positives (AGENTS.md #6 escape hatch). Mere
 * deferral ("follow-up") does NOT bypass the gate. Mirrors the
 * pr-body-check-gate.test.ts pattern (shipped in #3332).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  isDeclaredFalsePositive,
  resolveGatedHeadRef,
  DECLARATION_HOWTO,
} from '../scripts/ci/sibling-check-gate.mjs';
import { describePrBodySource } from '../scripts/ci/pr-body-check-gate.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/sibling-check-gate.mjs');

describe('isDeclaredFalsePositive — only AGENTS.md #6 escape-hatch language qualifies', () => {
  const FP_NONIMPL = `
- scripts/foo-parser.mjs: falso positivo — solo lessicalmente simile ma semanticamente diverso
`;
  const FP_EN_NONIMPL = `
- scripts/bar-crawler.mjs: false positive — not the same bug class, different semantic context
`;
  const DEFERRED_NONIMPL = `
- scripts/baz-crawler.mjs: deferred — will fix in follow-up PR
`;
  const BARE_NONIMPL = `
- scripts/qux-parser.mjs: candidate detected by gate, listed here
`;
  const EXPLICIT_FP_MULTILINE = `
- scripts/alpha.mjs: semanticamente diverso dal costrutto fixato qui
- scripts/beta.mjs: not the same anti-pattern, different class
`;

  it('falso positivo + lessicalmente simile language → declared FP (bypasses gate)', () => {
    expect(isDeclaredFalsePositive('scripts/foo-parser.mjs', FP_NONIMPL)).toBe(true);
  });

  it('English "false positive — not the same bug class" → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/bar-crawler.mjs', FP_EN_NONIMPL)).toBe(true);
  });

  it('"semanticamente diverso" without "lessicalmente simile" prefix → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/alpha.mjs', EXPLICIT_FP_MULTILINE)).toBe(true);
  });

  it('"not the same anti-pattern" → declared FP', () => {
    expect(isDeclaredFalsePositive('scripts/beta.mjs', EXPLICIT_FP_MULTILINE)).toBe(true);
  });

  it('deferral note ("will fix in follow-up") → NOT a false positive (gate still blocks)', () => {
    expect(isDeclaredFalsePositive('scripts/baz-crawler.mjs', DEFERRED_NONIMPL)).toBe(false);
  });

  it('bare mention without FP language → NOT a false positive', () => {
    expect(isDeclaredFalsePositive('scripts/qux-parser.mjs', BARE_NONIMPL)).toBe(false);
  });

  it('file NOT mentioned at all → false', () => {
    expect(isDeclaredFalsePositive('scripts/missing.mjs', FP_NONIMPL)).toBe(false);
  });

  it('basename match (no path prefix) → finds FP declaration', () => {
    const nonImpl = '- foo-parser.mjs: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/update/foo-parser.mjs', nonImpl)).toBe(true);
  });

  it('very short basename (≤3 chars) is NOT matched by basename shortcut (anti-noise)', () => {
    const nonImpl = '- js: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/foo.js', nonImpl)).toBe(false);
  });

  it('empty nonImplText → false', () => {
    expect(isDeclaredFalsePositive('scripts/foo.mjs', '')).toBe(false);
  });

  it('empty candidatePath → false', () => {
    expect(isDeclaredFalsePositive('', FP_NONIMPL)).toBe(false);
  });

  it('null / undefined inputs → false (no throw)', () => {
    expect(isDeclaredFalsePositive(null as unknown as string, FP_NONIMPL)).toBe(false);
    expect(isDeclaredFalsePositive('scripts/foo.mjs', null as unknown as string)).toBe(false);
  });
});

describe('isDeclaredFalsePositive — negation-aware (issue #3367)', () => {
  it('"non è un falso positivo" (explicit REJECTION) → NOT a declared FP, gate still blocks', () => {
    const nonImpl =
      '- scripts/foo-parser.mjs: non è un falso positivo, va sistemato in follow-up';
    expect(isDeclaredFalsePositive('scripts/foo-parser.mjs', nonImpl)).toBe(false);
  });

  it('"not a false positive" (English rejection) → NOT a declared FP', () => {
    const nonImpl = '- scripts/bar-crawler.mjs: not a false positive, genuine sibling bug';
    expect(isDeclaredFalsePositive('scripts/bar-crawler.mjs', nonImpl)).toBe(false);
  });

  it('"non è semanticamente diverso" (explicit rejection) → NOT a declared FP', () => {
    const nonImpl = '- scripts/baz.mjs: non è semanticamente diverso, stesso bug del sibling';
    expect(isDeclaredFalsePositive('scripts/baz.mjs', nonImpl)).toBe(false);
  });
});

describe('isDeclaredFalsePositive — basename disambiguation across directories (issue #3367)', () => {
  it('basename-only FP declaration for a DIFFERENT full path does NOT cover the candidate', () => {
    const nonImpl =
      '- scripts/legacy/foo.js: falso positivo — solo lessicalmente simile ma semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/new/foo.js', nonImpl)).toBe(false);
  });

  it('basename-only FP declaration for the SAME full path still covers the candidate', () => {
    const nonImpl =
      '- scripts/legacy/foo.js: falso positivo — solo lessicalmente simile ma semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/legacy/foo.js', nonImpl)).toBe(true);
  });

  it('bare basename (no directory in body) still matches via basename shortcut', () => {
    const nonImpl = '- foo-parser.mjs: falso positivo — semanticamente diverso';
    expect(isDeclaredFalsePositive('scripts/update/foo-parser.mjs', nonImpl)).toBe(true);
  });
});

describe('sibling-check-gate hook — cwd forwarding (2026-08-25 incident)', () => {
  // Observed on a real run: a PR opened from a worktree got blocked citing a
  // file dirty only in the UNRELATED main checkout — proof the hook was
  // analysing the wrong directory. See lib/hook-target-cwd.mjs for the root
  // cause.
  //
  // These tests spawn the real check-sibling-patterns.mjs, which does a
  // full-tree `git grep`/pattern-class scan across CODE_DIRS — expensive
  // against THIS ~15GB monorepo (tests/check-sibling-patterns.test.ts avoids
  // it entirely, testing only the pure functions). So spawnSync's own
  // ambient cwd here is a tiny THROWAWAY git repo, not this one — fast, and
  // it still proves the fix: does the analysis follow payload.cwd, or fall
  // back to wherever the hook subprocess itself happens to run from?
  const createdDirs: string[] = [];
  let ambientRepo = '';

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sibling-gate-ambient-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    // resolveBase() tries `origin/main` first (see check-sibling-patterns.mjs)
    // — a bare local repo has no remote, so give it one.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    ambientRepo = dir;
    createdDirs.push(dir);
  });
  afterAll(() => {
    while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
  });

  function runGate(command: string, extraPayload: Record<string, unknown> = {}) {
    const payload = JSON.stringify({ tool_input: { command }, ...extraPayload });
    return spawnSync('node', [GATE], { input: payload, encoding: 'utf8', cwd: ambientRepo });
  }

  it('passes through (exit 0) for non "gh pr create" commands regardless of payload.cwd', () => {
    const res = runGate('git status', { cwd: ambientRepo });
    expect(res.status).toBe(0);
  });

  it('analyses payload.cwd, not this hook subprocess\'s own ambient directory: a directory outside any git repo blocks with "sweep NON ESEGUITO", never silently allowing an unverified PR', () => {
    const outsideAnyRepo = mkdtempSync(join(tmpdir(), 'sibling-gate-cwd-'));
    createdDirs.push(outsideAnyRepo);
    const res = runGate('gh pr create --title x --body "y"', { cwd: outsideAnyRepo });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/NON ESEGUITO/);
  });

  it('falls back to the ambient directory (today\'s pre-fix behaviour) when the payload carries no cwd at all', () => {
    // No `cwd` field in the payload → resolveHookTargetCwd returns undefined
    // → the check script inherits spawnSync's own cwd (ambientRepo, a
    // trivial but VALID repo with `origin/main` resolvable) → must NOT hit
    // the skipped/"NON ESEGUITO" branch, which only fires when the
    // merge-base can't be found.
    const res = runGate('gh pr create --title x --body "y"');
    expect(res.stderr ?? '').not.toMatch(/NON ESEGUITO/);
  });
});

/**
 * ─── 2026-09-05: quattro difetti misurati sul gate in un'ora, aprendo una PR
 * di UN file. Ognuno lascia qui la sua verifica.
 *
 * La fixture e' un repo git usa-e-getta che riproduce la flotta: un branch
 * (`feature-x`) che tocca un file, e un working tree SPORCO del lavoro non
 * committato di un'altra sessione. Il repo vero non serve — e scansionarlo
 * costerebbe minuti.
 */
describe('sibling-check-gate — difetti misurati il 2026-09-05', () => {
  const dirs: string[] = [];
  let repo = '';

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'sibling-gate-fleet-'));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const write = (rel: string, body: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body, 'utf8');
    };

    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    // alpha: il file che il branch tocca. beta ne condivide DUE costrutti
    // (helper + campo) → aggancio forte. gamma ne condivide UNO solo, il nome
    // di campo → aggancio debole, la classe che il 2026-09-05 era 20 su 22.
    write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 1; }\nconst rawDescription = "a";\nexport { rawDescription };\n');
    write('scripts/beta.mjs', 'import { sharedComputeHelper } from "./alpha.mjs";\nconst rawDescription = sharedComputeHelper();\n');
    write('scripts/gamma.mjs', 'const rawDescription = "gamma only";\nexport default rawDescription;\n');
    // La coppia "altra sessione": foreign-session e' quello che verra' sporcato
    // senza commit, foreign-twin il gemello che quel lavoro tirerebbe dentro.
    write('scripts/foreign-session.mjs', 'export const x = 1;\n');
    write('scripts/foreign-twin.mjs', 'export function foreignSharedRoutine() { return 2; }\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    git('checkout', '-q', '-b', 'feature-x');
    write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 42; }\nconst rawDescription = "changed";\nexport { rawDescription };\n');
    git('add', 'scripts/alpha.mjs');
    git('commit', '-q', '-m', 'feature');

    // Torna su main e sporca il working tree, come il checkout principale
    // condiviso da una flotta di agenti.
    git('checkout', '-q', 'main');
    write('scripts/foreign-session.mjs', 'import { foreignSharedRoutine } from "./foreign-twin.mjs";\nexport const x = foreignSharedRoutine();\n');
  });
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const runCheck = (...extra: string[]) =>
    JSON.parse(
      execFileSync('node', [resolve(ROOT, 'scripts/ci/check-sibling-patterns.mjs'), '--json', ...extra], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );

  const runGate = (command: string, payloadCwd: string = repo) =>
    spawnSync('node', [GATE], {
      input: JSON.stringify({ tool_input: { command }, cwd: payloadCwd }),
      encoding: 'utf8',
      cwd: repo,
    });

  describe('difetto 1 — il gate deve giudicare il branch, non il working tree di chi ha sporcato il checkout', () => {
    it('senza --head l\'analisi vede il lavoro NON COMMITTATO di un\'altra sessione (il difetto)', () => {
      const r = runCheck();
      expect(r.changedCode).toContain('scripts/foreign-session.mjs');
      expect(r.changedCode).not.toContain('scripts/alpha.mjs');
    });

    it('con --head <branch> l\'analisi segue il branch e ignora lo sporco altrui', () => {
      const r = runCheck('--head', 'feature-x');
      expect(r.changedCode).toEqual(['scripts/alpha.mjs']);
      expect(r.changedCode).not.toContain('scripts/foreign-session.mjs');
    });

    it('il diagnostico del brief: «File di codice cambiati» diverge fra due directory senza --head, coincide con --head', () => {
      // Il diagnostico del brief, riprodotto: stesso branch, due directory del
      // MEDESIMO repo (checkout sporco + worktree pulito sul branch). Se i due
      // numeri differiscono, il gate sta guardando il diff di qualcun altro.
      const wt = mkdtempSync(join(tmpdir(), 'sibling-gate-wt-'));
      rmSync(wt, { recursive: true, force: true });
      dirs.push(wt);
      execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'feature-x'], { cwd: repo, stdio: 'ignore' });
      const read = (cwd: string, extra: string[]) =>
        JSON.parse(
          execFileSync('node', [resolve(ROOT, 'scripts/ci/check-sibling-patterns.mjs'), '--json', ...extra], {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }),
        );

      const dirtyHere = read(repo, []).changedCode;
      const cleanThere = read(wt, []).changedCode;
      expect(dirtyHere).not.toEqual(cleanThere); // il difetto, riprodotto

      const scopedHere = read(repo, ['--head', 'feature-x']).changedCode;
      const scopedThere = read(wt, ['--head', 'feature-x']).changedCode;
      expect(scopedHere).toEqual(scopedThere); // la fix
      expect(scopedHere).toEqual(['scripts/alpha.mjs']);
    });

    it('il gate non accusa piu\' i gemelli del lavoro altrui', () => {
      const res = runGate('gh pr create --head feature-x --title x --body "y"');
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stdout).toContain('scripts/beta.mjs');
      expect(res.stdout).not.toContain('scripts/foreign-twin.mjs');
    });

    it('resolveGatedHeadRef: nome letterale risolvibile → si usa quello', () => {
      expect(resolveGatedHeadRef('gh pr create --head feature-x', repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag',
      });
    });

    it('resolveGatedHeadRef: sostituzione di shell non espansa → fallback su HEAD', () => {
      const r = resolveGatedHeadRef('gh pr create --head "$(git rev-parse --abbrev-ref HEAD)"', repo);
      expect(r).toEqual({ ref: 'HEAD', source: 'cwd-head' });
    });

    it('resolveGatedHeadRef: branch inesistente → fallback su HEAD invece di un ref rotto', () => {
      expect(resolveGatedHeadRef('gh pr create --head mai-esistito', repo).ref).toBe('HEAD');
    });

    it('resolveGatedHeadRef: forma cross-fork owner:branch → tiene il branch', () => {
      expect(resolveGatedHeadRef('gh pr create --head someone:feature-x', repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag',
      });
    });

    it('branch non identificabile (ref fermo su origin/main) → BLOCCA dicendolo, non passa in silenzio', () => {
      const clean = mkdtempSync(join(tmpdir(), 'sibling-gate-clean-'));
      dirs.push(clean);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: clean, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      git('commit', '-q', '--allow-empty', '-m', 'init');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const res = spawnSync('node', [GATE], {
        input: JSON.stringify({ tool_input: { command: 'gh pr create --title x --body "y"' }, cwd: clean }),
        encoding: 'utf8',
        cwd: clean,
      });
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stderr).toMatch(/BRANCH NON IDENTIFICATO/);
      expect(res.stderr).toMatch(/chiamata Bash PRECEDENTE/);
    });
  });

  describe('difetto 2 — body illeggibile: dirlo per primo, col path e la directory', () => {
    it('--body-file inesistente → il gate dice che NON ha letto il body, con path e cwd', () => {
      const res = runGate('gh pr create --head feature-x --title x --body-file non-esiste.md');
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stderr).toMatch(/IL BODY DELLA PR NON È STATO LETTO/);
      expect(res.stderr).toContain('non-esiste.md');
      expect(res.stderr).toContain(repo);
      // e lo dice PRIMA di parlare dei gemelli
      expect(res.stderr.indexOf('NON È STATO LETTO')).toBeLessThan(res.stderr.indexOf('PR bloccata'));
    });

    it('body leggibile → nessun avviso di body illeggibile', () => {
      const bodyPath = join(repo, 'body-ok.md');
      writeFileSync(bodyPath, '## Implementato\n- x\n\n## Non implementato (ancora)\n- Nessuno\n', 'utf8');
      const res = runGate(`gh pr create --head feature-x --title x --body-file ${bodyPath}`);
      expect(res.stderr).not.toMatch(/NON È STATO LETTO/);
    });

    it('describePrBodySource distingue le tre cause che extractPrBody collassa in undefined', () => {
      expect(describePrBodySource('gh pr create --title x', repo)).toMatchObject({ kind: 'assente', ok: false });
      expect(describePrBodySource('gh pr create --body-file nope.md', repo)).toMatchObject({
        kind: 'body-file',
        ok: false,
        path: 'nope.md',
      });
      expect(describePrBodySource('gh pr create --body-file body-ok.md', repo)).toMatchObject({
        kind: 'body-file',
        ok: true,
      });
      // forma di --body che le regex non matchano (nessuna quotatura)
      expect(describePrBodySource('gh pr create --body ciao-senza-apici', repo)).toMatchObject({
        kind: 'body-inline',
        ok: false,
      });
    });
  });

  describe('difetto 3 — il messaggio insegna la forma che il filtro accetta', () => {
    it('il blocco stampa la forma accettata con un esempio di UNA riga', () => {
      const res = runGate('gh pr create --head feature-x --title x --body "y"');
      expect(res.stderr).toMatch(/UNA RIGA PER FILE/);
      expect(res.stderr).toContain('- scripts/foo.mjs — falso positivo');
      expect(res.stderr).toMatch(/paragrafo unico .* NON viene riconosciuto/);
    });

    it('l\'esempio stampato è davvero accettato da isDeclaredFalsePositive (non solo plausibile)', () => {
      const exampleLine = DECLARATION_HOWTO.split('\n').find((l) => l.includes('- scripts/foo.mjs'))!;
      expect(isDeclaredFalsePositive('scripts/foo.mjs', exampleLine)).toBe(true);
    });
  });

  describe('difetto 4 — la forza dell\'aggancio è visibile', () => {
    it('due costrutti condivisi → forte, un identificatore nudo → debole', () => {
      const r = runCheck('--head', 'feature-x');
      const beta = r.candidates.find((c: { file: string }) => c.file === 'scripts/beta.mjs');
      const gamma = r.candidates.find((c: { file: string }) => c.file === 'scripts/gamma.mjs');
      expect(beta.strength).toBe('forte');
      expect(gamma.strength).toBe('debole');
      // i forti vengono elencati per primi
      expect(r.candidates[0].file).toBe('scripts/beta.mjs');
    });

    it('il gate etichetta i candidati e spiega cosa significa [debole]', () => {
      const res = runGate('gh pr create --head feature-x --title x --body "y"');
      expect(res.stdout).toMatch(/\[forte\] scripts\/beta\.mjs/);
      expect(res.stdout).toMatch(/\[debole\] scripts\/gamma\.mjs/);
      expect(res.stdout).toMatch(/UN SOLO identificatore nudo/);
    });

    it('un candidato debole BLOCCA ancora: è un ordinamento, non un filtro', () => {
      // Solo il forte dichiarato → il debole tiene il gate chiuso.
      const bodyPath = join(repo, 'body-partial.md');
      writeFileSync(
        bodyPath,
        '## Implementato\n- x\n\n## Non implementato (ancora)\n- scripts/beta.mjs — falso positivo, per scelta: semanticamente diverso\n',
        'utf8',
      );
      const res = runGate(`gh pr create --head feature-x --title x --body-file ${bodyPath}`);
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stdout).toContain('scripts/gamma.mjs');
      expect(res.stdout).not.toContain('scripts/beta.mjs');
    });

    it('tutti dichiarati uno per riga → il gate passa', () => {
      const bodyPath = join(repo, 'body-full.md');
      writeFileSync(
        bodyPath,
        '## Implementato\n- x\n\n## Non implementato (ancora)\n' +
          '- scripts/beta.mjs — falso positivo, per scelta: semanticamente diverso\n' +
          '- scripts/gamma.mjs — falso positivo, per scelta: solo lessicalmente simile\n',
        'utf8',
      );
      const res = runGate(`gh pr create --head feature-x --title x --body-file ${bodyPath}`);
      expect(res.status).toBe(0);
    });
  });
});
