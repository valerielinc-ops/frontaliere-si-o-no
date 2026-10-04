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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  isDeclaredFalsePositive,
  DECLARATION_HOWTO,
  isPrCreateCommand,
  resolveSiblingGateTarget,
  SIBLING_GATE_PAYLOAD_ENV,
} from '../scripts/ci/sibling-check-gate.mjs';
import { resolveGatedHeadRef } from '../scripts/ci/lib/hook-target-cwd.mjs';
import {
  checkerCandidates,
  materializeChecker,
  readRevisionChecker,
  relativeImports,
} from '../scripts/ci/lib/sibling-checker-revision.mjs';
import { describePrBodySource, localDiffPaths } from '../scripts/ci/pr-body-check-gate.mjs';
import { EXIT_BLOCK } from '../scripts/ci/lib/hook-exit-codes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GATE = resolve(ROOT, 'scripts/ci/sibling-check-gate.mjs');

describe('sibling-check-gate — repository routing', () => {
  it('uses the site checker for an explicit site repository', () => {
    const target = resolveSiblingGateTarget(
      'gh pr create --repo valerielinc-ops/frontaliere-si-o-no --head feature-x --title x',
    );
    expect(target?.repo).toBe(ROOT);
    expect(target?.checkScript).toMatch(/scripts\/ci\/check-sibling-patterns\.mjs$/);
  });

  it('does not run the site checker for corpus PRs without a corpus checker', () => {
    expect(
      resolveSiblingGateTarget(
        'gh pr create --repo nanakokyobashi-rgb/frontaliere-articles --head feature-x --title x',
      ),
    ).toBeNull();
  });

  it('ignores an explicit repository outside this workspace', () => {
    expect(resolveSiblingGateTarget('gh pr create --repo example/other --head feature-x')).toBeNull();
  });
});

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

  it('accetta il payload via env senza richiedere una stdin pipe', () => {
    const payload = JSON.stringify({ tool_input: { command: 'git status' }, cwd: ambientRepo });
    const res = spawnSync(process.execPath, [GATE], {
      encoding: 'utf8',
      cwd: ambientRepo,
      env: { ...process.env, [SIBLING_GATE_PAYLOAD_ENV]: payload },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(res.error).toBeUndefined();
    expect(res.status, res.stderr).toBe(0);
  });

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

  it('blocks a literal cd to an existing non-repository before --head can fall back to the gate repo', () => {
    const outsideAnyRepo = mkdtempSync(join(tmpdir(), 'sibling-gate-literal-cd-'));
    createdDirs.push(outsideAnyRepo);
    const res = runGate(
      `cd "${outsideAnyRepo}" && gh pr create --head main --title x --body "y"`,
      { cwd: ambientRepo },
    );
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/cwd non risolvibile|non appartiene a una repository Git/i);
    expect(res.stderr).toMatch(/NON ESEGUITO/);
  });

  it('blocks a relative cd that points at a different nested worktree', () => {
    const foreign = join(ambientRepo, 'foreign-worktree');
    mkdirSync(foreign);
    execFileSync('git', ['init', '-q', foreign], { stdio: 'ignore' });
    const res = runGate(
      'cd foreign-worktree && gh pr create --title x --body "y"',
      { cwd: ambientRepo },
    );
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/worktree diverso/i);
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

    // beta usa il helper esportato: binding forte. gamma condivide soltanto
    // un literal di dominio: debole, ma ancora da verificare.
    write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 1; }\nconst rawDescription = "a";\nexport { rawDescription };\n');
    write('scripts/beta.mjs', 'import { sharedComputeHelper } from "./alpha.mjs";\nconst rawDescription = sharedComputeHelper();\n');
    write('scripts/gamma.mjs', 'const rawDescription = "shared-policy-value";\nexport default rawDescription;\n');
    // La coppia "altra sessione": foreign-session e' quello che verra' sporcato
    // senza commit, foreign-twin il gemello che quel lavoro tirerebbe dentro.
    write('scripts/foreign-session.mjs', 'export const x = 1;\n');
    write('scripts/foreign-twin.mjs', 'export function foreignSharedRoutine() { return 2; }\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    git('checkout', '-q', '-b', 'feature-x');
    write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 42; }\nconst rawDescription = "shared-policy-value";\nexport { rawDescription };\n');
    git('add', 'scripts/alpha.mjs');
    git('commit', '-q', '-m', 'feature');

    // Il branch che ritira uno script morto e NON tocca nient'altro: revert,
    // workflow ritirato, cleanup. E' un branch legittimo e frequente, e fino
    // al 2026-09-05 era l'unico che il gate non sapeva far passare.
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'delete-only');
    git('rm', '-q', 'scripts/gamma.mjs');
    git('commit', '-q', '-m', 'ritira lo script morto');

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

  describe('regressione del 2026-09-05 — un branch di sole cancellazioni deve passare il gate', () => {
    // `changedFiles` alimenta il blocco «BRANCH NON IDENTIFICATO», che esiste
    // per un motivo giusto: un ref che non differisce dalla base non e' il
    // branch dell'autore. Ma veniva calcolato da un diff `--diff-filter=ACMR`,
    // che per costruzione non conta le `D`. Un branch di sole rimozioni
    // produceva quindi `changedFiles: 0` con un ref perfettamente corretto, e
    // il gate stampava tre rimedi TUTTI falsi — l'autore aveva gia' fatto
    // tutto e non aveva nessuna leva. E' la stessa classe di blocco
    // insoddisfacibile che questa PR chiude altrove, reintrodotta dal suo
    // stesso fix: prima della PR quel branch usciva 0.
    it('changedFiles conta le cancellazioni: il ref differisce dalla base, e il gate lo vede', () => {
      const r = runCheck('--head', 'delete-only');
      expect(r.changedFiles).toBeGreaterThan(0);
    });

    it('changedCode resta su ACMR: un file cancellato non e\' un file da leggere', () => {
      // La restrizione di filtro serve ancora — l'analisi dei gemelli legge il
      // CONTENUTO dei file cambiati, e un file cancellato non ha contenuto da
      // leggere. Le due misure rispondono a due domande diverse e devono
      // restare separate: questo caso lo fissa, cosi' nessuno "semplifica"
      // riunificandole e riporta il difetto dall'altro lato.
      const r = runCheck('--head', 'delete-only');
      expect(r.changedCode).toEqual([]);
    });

    it('il gate NON blocca un branch di sole cancellazioni', () => {
      const res = runGate('gh pr create --head delete-only --title x --body-file body.md');
      expect(res.status, res.stderr).not.toBe(EXIT_BLOCK);
      expect(res.stderr).not.toMatch(/BRANCH NON IDENTIFICATO/i);
    });
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
      expect(res.stderr).toContain('scripts/beta.mjs');
      expect(res.stderr).not.toContain('scripts/foreign-twin.mjs');
    });

    it('da Codex il cd nella stessa chiamata porta il gate nel worktree e segue il suo HEAD', () => {
      const wt = mkdtempSync(join(tmpdir(), 'sibling-gate-command-wt-'));
      rmSync(wt, { recursive: true, force: true });
      dirs.push(wt);
      execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'feature-x'], { cwd: repo, stdio: 'ignore' });
      writeFileSync(
        join(wt, 'body.md'),
        '## Implementato\n- x\n\n## Non implementato (ancora)\n' +
          '- scripts/beta.mjs — falso positivo, per scelta: semanticamente diverso\n' +
          '- scripts/gamma.mjs — falso positivo, per scelta: solo lessicalmente simile\n',
        'utf8',
      );
      const command = `cd "${wt}" && gh pr create --title x --body-file body.md`;
      const res = runGate(command, repo);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toMatch(/BRANCH NON IDENTIFICATO/);
      expect(res.stderr).not.toMatch(/BODY DELLA PR NON È STATO LETTO/);
    });

    it('resolveGatedHeadRef: nome letterale risolvibile → si usa quello', () => {
      expect(resolveGatedHeadRef('gh pr create --head feature-x', repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag',
        cwd: repo,
      });
    });

    it('resolveGatedHeadRef: sostituzione di shell non espansa → fallback su HEAD', () => {
      const r = resolveGatedHeadRef('gh pr create --head "$(git rev-parse --abbrev-ref HEAD)"', repo);
      expect(r).toEqual({ ref: 'HEAD', source: 'cwd-head', cwd: repo });
    });

    it('resolveGatedHeadRef: branch inesistente → fallback su HEAD invece di un ref rotto', () => {
      expect(resolveGatedHeadRef('gh pr create --head mai-esistito', repo).ref).toBe('HEAD');
    });

    it('resolveGatedHeadRef: l\'alias corto -H vale quanto la forma lunga', () => {
      // `gh pr create` accetta `-H`. Prima cadeva sul fallback `HEAD`, e dal
      // checkout principale fermo su main quel diff e' vuoto: il gate bloccava
      // un comando che il branch lo dichiarava eccome.
      for (const cmd of [
        'gh pr create -H feature-x --title x',
        'gh pr create -H=feature-x --title x',
        'gh pr create -Hfeature-x --title x',
      ]) {
        expect(resolveGatedHeadRef(cmd, repo), cmd).toEqual({
          ref: 'feature-x',
          source: 'head-flag',
          cwd: repo,
        });
      }
    });

    it('resolveGatedHeadRef: un --head citato NEL BODY non batte il flag vero', () => {
      // Domanda avversariale 2 della review, e non e' teorica: i messaggi di
      // questi gate consigliano testualmente di passare il nome letterale del
      // branch, quindi quella frase finira' nei body delle PR future. Qui la
      // citazione PRECEDE il flag vero, che e' il caso in cui il vecchio
      // "primo match vince" sbagliava.
      const cmd =
        'gh pr create --body "il gate chiede di passare --head mai-esistito come nome letterale" '
        + '--head feature-x --title x';
      expect(resolveGatedHeadRef(cmd, repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag',
        cwd: repo,
      });
    });

    it('resolveGatedHeadRef: nessun candidato risolvibile → resta il fallback, non un ref inventato', () => {
      // L'altra meta' della regola sopra: se NIENTE risolve, il risultato deve
      // restare `cwd-head`. Il rev-parse e' un oracolo, non un modo per
      // pescare la prima parola che somiglia a un branch.
      const cmd = 'gh pr create --body "vedi --head qualcosa-che-non-esiste" --title x';
      expect(resolveGatedHeadRef(cmd, repo)).toEqual({ ref: 'HEAD', source: 'cwd-head', cwd: repo });
    });

    it('il gemello pr-body-check-gate aveva la STESSA forma e la stessa fix (AGENTS.md #6)', () => {
      // localDiffPaths leggeva `origin/main...HEAD`: dal checkout sporco quello
      // e' l'HEAD di un'altra sessione, non il branch in apertura. Col ref
      // esplicito i due path divergono esattamente come nel gate sibling.
      expect(localDiffPaths(repo, 'feature-x')).toEqual(['scripts/alpha.mjs']);
      expect(localDiffPaths(repo, 'HEAD')).not.toContain('scripts/alpha.mjs');
    });

    it('resolveGatedHeadRef: forma cross-fork owner:branch → tiene il branch', () => {
      expect(resolveGatedHeadRef('gh pr create --head someone:feature-x', repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag',
        cwd: repo,
      });

      // Anche quando il payload non porta la cwd del worktree, un `--head`
      // LETTERALE deve risolvere cercandolo nel repo a cui il gate appartiene —
      // i worktree condividono `.git`, quindi il nome del branch e' un segnale
      // indipendente dalla directory.
      const elsewhere = mkdtempSync(join(tmpdir(), 'sibling-gate-launchdir-'));
      dirs.push(elsewhere);
      expect(resolveGatedHeadRef('gh pr create --head feature-x', elsewhere, repo)).toEqual({
        ref: 'feature-x',
        source: 'head-flag-fallback',
        cwd: repo,
      });
      // Senza un branch leggibile NON ricadiamo sul repo del gate: l'HEAD di un
      // altro checkout non e' un'ipotesi migliore, e' un albero altrettanto
      // arbitrario. Resta la directory tracciata, e il diff vuoto lo dira'.
      expect(resolveGatedHeadRef('gh pr create --title x', elsewhere, repo)).toEqual({
        ref: 'HEAD',
        source: 'cwd-head',
        cwd: elsewhere,
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
      expect(res.stderr).toMatch(/né un `cd <worktree> &&` letterale/);
    });
  });

  describe('difetto 2 — body illeggibile: dirlo per primo, col path e la directory', () => {
    it('--body-file inesistente → il gate dice che NON ha letto il body, con path e cwd', () => {
      const res = runGate('gh pr create --head feature-x --title x --body-file non-esiste.md');
      expect(res.status).toBe(EXIT_BLOCK);
      expect(res.stderr).toMatch(/IL BODY DELLA PR NON È STATO LETTO/);
      expect(res.stderr).toMatch(/path non leggibile \(ENOENT\)/);
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
    it('binding condiviso → forte, literal di dominio → debole', () => {
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
      expect(res.stderr).toMatch(/\[forte\] scripts\/beta\.mjs/);
      expect(res.stderr).toMatch(/\[debole\] scripts\/gamma\.mjs/);
      expect(res.stderr).toMatch(/evidenza limitata/);
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
      expect(res.stderr).toContain('scripts/gamma.mjs');
      expect(res.stderr).not.toContain('scripts/beta.mjs');
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

describe('sibling-check-gate — il verdetto viene dal checker della revisione giudicata (2026-10-04)', () => {
  // Incidente: l'hook girava dal checkout principale, fermo sul branch di
  // un'altra sessione con un checker di settimane prima. Quel checker vedeva
  // candidati che il checker del branch proposto non vedeva, e il gate
  // bloccava senza nemmeno elencarli. Qui il gate gira da questo repo: il suo
  // checker LOCALE (quello vero) troverebbe beta/gamma per un branch che
  // tocca alpha, e fa la parte del checker "vecchio" del checkout principale.
  // La revisione giudicata porta invece un checker finto, "nuovo", il cui
  // verdetto e' scritto in un modulo importato: il risultato deve dipendere
  // solo da quello.
  const dirs: string[] = [];
  let repo = '';
  const CHECKER = 'scripts/ci/check-sibling-patterns.mjs';
  const VERDICT = 'scripts/ci/lib/fake-verdict.mjs';

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body, 'utf8');
  };
  const verdict = (candidates: unknown[]) => `export const candidates = ${JSON.stringify(candidates)};\n`;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'sibling-gate-judged-'));
    dirs.push(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 1; }\nconst rawDescription = "a";\nexport { rawDescription };\n');
    write('scripts/beta.mjs', 'import { sharedComputeHelper } from "./alpha.mjs";\nconst rawDescription = sharedComputeHelper();\n');
    write('scripts/gamma.mjs', 'const rawDescription = "shared-policy-value";\nexport default rawDescription;\n');
    write(
      CHECKER,
      "import { candidates } from './lib/fake-verdict.mjs';\n" +
        "const head = process.argv[process.argv.indexOf('--head') + 1];\n" +
        "console.log(JSON.stringify({ base: 'origin/main', head, changedFiles: 1, changedCode: ['scripts/alpha.mjs'], candidates }));\n",
    );
    write(VERDICT, verdict([]));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const touchAlpha = () =>
      write('scripts/alpha.mjs', 'export function sharedComputeHelper() { return 42; }\nconst rawDescription = "shared-policy-value";\nexport { rawDescription };\n');

    git('checkout', '-q', '-b', 'clean-verdict');
    touchAlpha();
    git('add', '-A');
    git('commit', '-q', '-m', 'feature con zero candidati per il checker nuovo');

    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'real-candidate');
    touchAlpha();
    write(VERDICT, verdict([{ file: 'scripts/beta.mjs', tokens: ['sharedComputeHelper'], strength: 'forte' }]));
    git('add', '-A');
    git('commit', '-q', '-m', 'feature con un candidato vero');

    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'broken-checker');
    touchAlpha();
    write(CHECKER, "process.stderr.write('checker rotto\\n');\nprocess.exit(3);\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'feature che rompe il checker');
    git('checkout', '-q', 'main');
  });
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const runGate = (command: string) =>
    spawnSync('node', [GATE], {
      input: JSON.stringify({ tool_input: { command }, cwd: repo }),
      encoding: 'utf8',
      cwd: repo,
    });

  it('relativeImports trova import statici, dinamici e side-effect, non i pacchetti', () => {
    const source = [
      "import { a } from './lib/a.mjs';",
      "import './side.mjs';",
      "const b = await import('../b.mjs');",
      "export { c } from \"./c.mjs\";",
      "import ts from 'typescript';",
    ].join('\n');
    expect(relativeImports(source).sort()).toEqual(['../b.mjs', './c.mjs', './lib/a.mjs', './side.mjs']);
  });

  it('readRevisionChecker legge dal ref la chiusura degli import, non il disco', () => {
    write(VERDICT, verdict([{ file: 'sporco-locale.mjs', tokens: [], strength: 'debole' }]));
    try {
      const snapshot = readRevisionChecker(repo, 'real-candidate', CHECKER)!;
      expect(snapshot.files.map((f) => f.path).sort()).toEqual([VERDICT, CHECKER].sort());
      const verdictFile = snapshot.files.find((f) => f.path === VERDICT)!;
      expect(verdictFile.content).toContain('scripts/beta.mjs');
      expect(verdictFile.content).not.toContain('sporco-locale.mjs');
    } finally {
      git('checkout', '-q', '--', VERDICT);
    }
    expect(readRevisionChecker(repo, 'ref-che-non-esiste', CHECKER)).toBeUndefined();
  });

  it('cache del checker svuotata a meta\' da un pulitore di tmp → si ripara, non ripiega per sempre', () => {
    // Revisione: un pulitore di $TMPDIR cancella file singoli per eta'; il
    // marker `.complete`, solo letto con uno stat, sparisce per primo. Prima
    // della correzione: (a) senza marker il rename finiva in ENOTEMPTY, (b) col
    // marker ma senza il file d'ingresso veniva servito un path inesistente.
    const cacheRoot = mkdtempSync(join(tmpdir(), 'sibling-gate-checker-cache-'));
    dirs.push(cacheRoot);
    const snapshot = readRevisionChecker(repo, 'real-candidate', CHECKER)!;
    const runChecker = (script: string) =>
      JSON.parse(execFileSync('node', [script, '--json', '--head', 'real-candidate'], { encoding: 'utf8', cwd: repo }));
    const first = materializeChecker(snapshot, { cacheRoot });
    const keyDir = first.slice(0, -(CHECKER.length + 1));
    expect(runChecker(first).candidates[0].file).toBe('scripts/beta.mjs');

    // (a) marker cancellato, directory non vuota.
    rmSync(join(keyDir, '.complete'));
    const afterMarkerLoss = materializeChecker(snapshot, { cacheRoot });
    expect(afterMarkerLoss).toBe(first);
    expect(existsSync(join(keyDir, '.complete'))).toBe(true);
    expect(runChecker(afterMarkerLoss).candidates[0].file).toBe('scripts/beta.mjs');

    // (b) marker presente, file della chiusura cancellati.
    rmSync(join(keyDir, CHECKER));
    rmSync(join(keyDir, VERDICT));
    const afterFileLoss = materializeChecker(snapshot, { cacheRoot });
    expect(existsSync(afterFileLoss)).toBe(true);
    expect(runChecker(afterFileLoss).candidates[0].file).toBe('scripts/beta.mjs');
  });

  it('checker presente nella revisione ma blob illeggibile → errore dichiarato, non un ripiego muto', () => {
    const broken = mkdtempSync(join(tmpdir(), 'sibling-gate-judged-missing-blob-'));
    dirs.push(broken);
    const g = (...args: string[]) =>
      execFileSync('git', args, { cwd: broken, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    mkdirSync(join(broken, 'scripts/ci'), { recursive: true });
    writeFileSync(join(broken, CHECKER), "console.log('{}');\n", 'utf8');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    // Il blob sparisce dal database degli oggetti (come in un clone parziale
    // senza rete): l'albero lo nomina ancora, `cat-file` fallisce.
    const blob = g('rev-parse', `HEAD:${CHECKER}`);
    rmSync(join(broken, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    expect(() => readRevisionChecker(broken, 'main', CHECKER)).toThrow(/non leggibile in main/);
    const { sources, errors } = checkerCandidates({
      cwd: broken,
      headRef: 'main',
      entry: CHECKER,
      localCheckScript: join(broken, CHECKER),
      localRepo: broken,
      baseRef: 'main',
    });
    expect(sources.map((s) => s.kind)).toEqual(['local']);
    expect(errors.join('\n')).toMatch(/revisione giudicata main: lettura fallita/);
  });

  it('0 candidati per il checker della revisione giudicata → passa, anche se il checker locale ne vedrebbe', () => {
    const res = runGate('gh pr create --head clean-verdict --title x --body "y"');
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('scripts/gamma.mjs');
  });

  it('un candidato vero blocca e viene ELENCATO nel canale che arriva all\'agente (stderr)', () => {
    const res = runGate('gh pr create --head real-candidate --title x --body "y"');
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toMatch(/\[forte\] scripts\/beta\.mjs/);
    expect(res.stderr).toContain('costrutti condivisi: sharedComputeHelper');
    // gamma lo vedrebbe solo il checker locale: non entra nel verdetto.
    expect(res.stderr).not.toContain('scripts/gamma.mjs');
  });

  it('un checker diverso da origin/main e\' dichiarato nel messaggio con gli hash dei blob', () => {
    const res = runGate('gh pr create --head real-candidate --title x --body "y"');
    const used = git('rev-parse', `real-candidate:${VERDICT}`).slice(0, 10);
    const base = git('rev-parse', `origin/main:${VERDICT}`).slice(0, 10);
    expect(res.stderr).toMatch(/revisione giudicata real-candidate/);
    expect(res.stderr).toContain(`${VERDICT}: blob ${used} (usato) vs ${base} (origin/main)`);
  });

  it('checker della revisione giudicata rotto → ripiega su origin/main e lo dice, non sul checker locale', () => {
    const res = runGate('gh pr create --head broken-checker --title x --body "y"');
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/checker scartati prima di origin\/main @ [0-9a-f]{10}: revisione giudicata broken-checker .*checker rotto/);
    expect(res.stderr).not.toContain('scripts/gamma.mjs');
  });

  it('nessuna revisione contiene il checker → usa quello locale e lo dichiara', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sibling-gate-judged-nochecker-'));
    dirs.push(bare);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: bare, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    mkdirSync(join(bare, 'scripts'), { recursive: true });
    writeFileSync(join(bare, 'scripts/alpha.mjs'), 'export function sharedComputeHelper() { return 1; }\n');
    writeFileSync(join(bare, 'scripts/beta.mjs'), 'import { sharedComputeHelper } from "./alpha.mjs";\nexport const v = sharedComputeHelper();\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('checkout', '-q', '-b', 'feat');
    writeFileSync(join(bare, 'scripts/alpha.mjs'), 'export function sharedComputeHelper() { return 2; }\n');
    g('commit', '-q', '-am', 'feat');
    const res = spawnSync('node', [GATE], {
      input: JSON.stringify({ tool_input: { command: 'gh pr create --head feat --title x --body "y"' }, cwd: bare }),
      encoding: 'utf8',
      cwd: bare,
    });
    expect(res.status).toBe(EXIT_BLOCK);
    expect(res.stderr).toContain('scripts/beta.mjs');
    expect(res.stderr).toMatch(/checker usato: working tree locale .*NON una revisione/);
  });
});

describe('sibling-check-gate: a quoted mention is not a command', () => {
  const CREATE = ['gh', 'pr', 'create'].join(' ');

  it('recognizes the real invocation, including behind an assignment prefix', () => {
    expect(isPrCreateCommand(`${CREATE} --title t --body-file b.md`)).toBe(true);
    expect(isPrCreateCommand(`GH_TOKEN=x ${CREATE} --fill`)).toBe(true);
    expect(isPrCreateCommand(`cd /tmp && ${CREATE} --fill`)).toBe(true);
  });

  it('ignores the same words quoted inside a heredoc or an argument', () => {
    // Reproduced three times on 2026-09-20 while changing these hooks: a
    // commit message that documented the gate was blocked BY the gate.
    const heredoc = ["git commit -F - <<'MSG'", 'docs: how to open a PR', '', `  ${CREATE} --fill`, 'MSG'].join('\n');
    expect(isPrCreateCommand(heredoc)).toBe(false);
    expect(isPrCreateCommand(`echo "${CREATE} --fill"`)).toBe(false);
    expect(isPrCreateCommand(`grep -n '${CREATE}' scripts/ci/foo.mjs`)).toBe(false);
  });

  it('does not treat `gh pr edit` as a creation', () => {
    expect(isPrCreateCommand('gh pr edit 12 --body-file b.md')).toBe(false);
  });

  it('keeps the conservative substring test when the syntax cannot be parsed', () => {
    expect(isPrCreateCommand(`${CREATE} --title "unterminated`)).toBe(true);
  });
});
