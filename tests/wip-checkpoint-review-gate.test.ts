import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

// F7 (2026-11-14): un checkpoint WIP di issue-fix (`wip(issue-N): checkpoint
// ...`) non e' codice finito. Se finisce come HEAD di una PR, la review piena
// (tier high, 60 turni) e' sprecata: il guard chiude il review gate
// fail-closed senza chiamare il modello.
const tests = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');

function guardStep() {
  const start = tests.indexOf('- name: Re-review guard (one terminal verdict per HEAD)');
  const end = tests.indexOf('- name: Determine review tier', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return tests.slice(start, end);
}

function matchesCheckpoint(subject: string) {
  const regexLine = guardStep().split('\n').find((line) => line.includes('=~'));
  expect(regexLine).toBeTruthy();
  const cond = regexLine!.trim().replace(/;\s*then$/u, '');
  const out = execFileSync('bash', ['-c', `head_subject="$1"; ${cond}; then echo yes; else echo no; fi`, '_', subject], { encoding: 'utf8' });
  return out.trim() === 'yes';
}

describe('guard: HEAD che e\' un checkpoint WIP', () => {
  it('riconosce i due subject che issue-fix produce', () => {
    expect(matchesCheckpoint('wip(issue-18225): checkpoint pre-test')).toBe(true);
    expect(matchesCheckpoint('wip(issue-18225): checkpoint automatico di un run terminato senza PR')).toBe(true);
  });

  it('non scambia un fix vero per un checkpoint', () => {
    expect(matchesCheckpoint('fix(issue-18225): consolidate safe git-dir retry')).toBe(false);
    expect(matchesCheckpoint('feat: wip(issue-1): checkpoint')).toBe(false);
    expect(matchesCheckpoint('wip: aggiusto il parser')).toBe(false);
  });

  it('chiude il gate saltando il modello: skip=true scritto DOPO la decisione di admission', () => {
    const step = guardStep();
    const decision = step.indexOf('printf \'%s\\n\' "$decision" >> "$GITHUB_OUTPUT"');
    const flag = step.indexOf('echo "wip_checkpoint=true"; echo "skip=true"');
    expect(decision).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(decision); // l'ultimo valore scritto vince
    expect(step).toContain('repos/$REPO/commits/$HEAD_SHA');
    // fail-open sulla lettura: un subject illeggibile non blocca la review
    expect(step).toContain('2>/dev/null || true)');
  });

  it('skip=true spegne tier, carry-forward e Codex ma non il review gate required', () => {
    for (const id of ['tier', 'carry_forward_review', 'codex_review']) {
      const at = tests.indexOf(`id: ${id}\n`);
      expect(at, id).toBeGreaterThan(-1);
      expect(tests.slice(at, at + 900), id).toContain("steps.guard.outputs.skip != 'true'");
    }
    const gate = tests.indexOf('id: review_gate');
    // il gate gira sempre (always() && !cancelled()) e valuta il verdetto sulla HEAD: nessun LGTM -> rosso
    expect(tests.slice(gate, gate + 900)).toContain('always() && !cancelled() && steps.resolve.outputs.should_review');
    expect(tests.slice(gate, gate + 900)).not.toContain('guard.outputs.skip');
  });
});

// Meta' produttore del contratto (2026-11-15, #18842/#18843/#18844): se la PR di
// issue-fix partisse con il checkpoint come HEAD, il guard sopra la lascerebbe
// per ore senza review. Il prompt e lo step deterministico `Finalize PR HEAD`
// garantiscono che l'HEAD consegnato sia un commit conventional. Il guard resta
// fail-closed: non si tocca.
describe('issue-fix non consegna mai un checkpoint WIP come HEAD della PR', () => {
  const workflow: any = YAML.parse(readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8'));
  const steps: any[] = workflow.jobs.fix.steps;
  const finalize = steps.find((step) => step?.name?.startsWith('Finalize PR HEAD'));
  const prompt: string = steps.find((step) => step?.uses === 'anthropics/claude-code-action@v1'
    || step?.uses === './.github/actions/claude-codex-fallback')?.with?.prompt ?? '';

  it('il prompt non dichiara piu\' il commit finale un no-op e chiede un commit conventional', () => {
    const step7 = prompt.split('\n').find((line) => /^\s*7\. /u.test(line)) ?? '';
    expect(step7).toContain('Commit FINALE');
    expect(step7).toContain('--allow-empty');
    expect(step7).toContain('fix(issue-$ISSUE_NUMBER):');
    expect(step7).toContain('NON deve MAI essere il checkpoint');
    expect(prompt).not.toMatch(/questo passo è un no-op/u);
    expect(prompt).not.toMatch(/una storia wip\+fix sul branch va bene\.(?! )/u);
  });

  it('lo step deterministico esiste, gira dopo il salvataggio WIP e prima della prova di delivery', () => {
    expect(finalize, 'step Finalize PR HEAD mancante').toBeTruthy();
    const names = steps.map((step) => step?.name ?? '');
    const at = names.indexOf(finalize.name);
    expect(at).toBeGreaterThan(names.findIndex((name) => name.startsWith('Salva il lavoro parziale')));
    expect(at).toBeLessThan(names.findIndex((name) => name.startsWith('Evaluate current PR delivery evidence')));
    expect(finalize['continue-on-error']).toBe(true);
    expect(finalize.if).toContain('always()');
    // push normale, mai force
    expect(finalize.run).not.toMatch(/--force|\+HEAD|--delete|git push[^\n]*\s-f(?:\s|$)/u);
    expect(finalize.run).toContain('git push origin "HEAD:refs/heads/$BRANCH"');
    // precondizioni prima del commit: token della App e albero pulito
    const commitAt = finalize.run.indexOf('git commit -q --allow-empty');
    expect(finalize.run.indexOf('if [ -z "${APP_TOKEN:-}" ]')).toBeGreaterThan(0);
    expect(finalize.run.indexOf('if [ -z "${APP_TOKEN:-}" ]')).toBeLessThan(commitAt);
    expect(finalize.run.indexOf('git status --porcelain')).toBeGreaterThan(0);
    expect(finalize.run.indexOf('git status --porcelain')).toBeLessThan(commitAt);
    expect(finalize.run).not.toMatch(/if \[ -n "\$\{APP_TOKEN:-\}" \]; then/u);
  });

  describe('comportamento dello step su un repository reale', () => {
    function run(opts: { subject: string; prHead?: 'same' | 'other' | 'none'; title?: string; appToken?: string; dirty?: boolean }) {
      const temp = mkdtempSync(join(tmpdir(), 'finalize-head-'));
      try {
        const remote = join(temp, 'remote.git');
        const work = join(temp, 'work');
        const bin = join(temp, 'bin');
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        mkdirSync(work); mkdirSync(bin);
        execFileSync('git', ['init', '-q', '--bare', remote]);
        git(work, 'init', '-q', '-b', 'main');
        git(work, 'config', 'user.name', 't'); git(work, 'config', 'user.email', 't@example.invalid');
        git(work, 'remote', 'add', 'origin', remote);
        writeFileSync(join(work, 'a.txt'), 'a');
        // Il push usa il token della App: lo step toglie le credenziali di checkout con
        // l'helper letto da origin/main (qui un no-op) e riscrive l'URL di origin con il
        // token; `url.<bare>.insteadOf` riporta quell'URL sul remote locale.
        mkdirSync(join(work, 'scripts/lib'), { recursive: true });
        writeFileSync(join(work, 'scripts/lib/clear-checkout-git-credentials.sh'), '#!/bin/sh\nexit 0\n');
        git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'base');
        git(work, 'push', '-q', 'origin', 'main');
        git(work, 'checkout', '-q', '-b', 'fix/issue-77');
        writeFileSync(join(work, 'a.txt'), 'b');
        git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', opts.subject);
        git(work, 'push', '-q', 'origin', 'fix/issue-77');
        const head = git(work, 'rev-parse', 'HEAD');
        if (opts.dirty) writeFileSync(join(work, 'residuo.txt'), 'lavoro non committato');
        const prHead = opts.prHead === 'none' ? '' : opts.prHead === 'other' ? '0'.repeat(40) : head;
        // `gh pr list ... --jq` reduced to the value the step reads.
        writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${prHead}'\n`);
        chmodSync(join(bin, 'gh'), 0o755);
        execFileSync('bash', ['-c', finalize.run], {
          cwd: work,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ISSUE: '77',
            REPO: 'owner/repo',
            ISSUE_TITLE: opts.title ?? 'Article content canary: regression detected',
            APP_TOKEN: opts.appToken ?? 'tok',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
            GIT_CONFIG_VALUE_0: 'https://x-access-token:tok@github.com/owner/repo.git',
          },
          stdio: 'pipe',
        });
        const remoteHead = git(remote, 'log', '-1', '--format=%s', 'fix/issue-77');
        const remoteCount = Number(git(remote, 'rev-list', '--count', 'fix/issue-77'));
        return {
          remoteHead,
          remoteCount,
          tipIsOld: git(remote, 'rev-parse', 'fix/issue-77') === head,
          localCommits: Number(git(work, 'rev-list', '--count', `${head}..HEAD`)),
        };
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }

    it('aggiunge un commit conventional vuoto sopra il checkpoint pre-test e lo pusha normale', () => {
      const result = run({ subject: 'wip(issue-77): checkpoint pre-test' });
      expect(result.remoteHead).toBe('fix(issue-77): Article content canary: regression detected');
      expect(result.remoteCount).toBe(3);
      expect(result.tipIsOld).toBe(false);
      // il subject prodotto non e' a sua volta un checkpoint
      expect(/^wip\(issue-\d+\):\s*checkpoint/u.test(result.remoteHead)).toBe(false);
    });

    it('toglie `#` e keyword adiacenti dal titolo e lo tronca a 72 caratteri', () => {
      const result = run({ subject: 'wip(issue-77): checkpoint pre-test', title: `Fixes #123 ${'x'.repeat(100)}` });
      expect(result.remoteHead).not.toContain('#');
      expect(result.remoteHead.length).toBeLessThanOrEqual('fix(issue-77): '.length + 72);
    });

    // Review del bot (#3834, stesso finalizer): senza il token della App il push userebbe
    // GITHUB_TOKEN, che non riattiva la review; con l'albero sporco un commit vuoto
    // consegnerebbe un HEAD senza il lavoro residuo.
    it('senza il token della App: nessun commit e nessun push (niente fallback su GITHUB_TOKEN)', () => {
      const result = run({ subject: 'wip(issue-77): checkpoint pre-test', appToken: '' });
      expect(result.localCommits).toBe(0);
      expect(result.tipIsOld).toBe(true);
    });

    it('albero di lavoro sporco: nessun commit finale e nessun push', () => {
      const result = run({ subject: 'wip(issue-77): checkpoint pre-test', dirty: true });
      expect(result.localCommits).toBe(0);
      expect(result.tipIsOld).toBe(true);
    });

    it('non tocca un HEAD che non e\' un checkpoint, una PR assente o un HEAD diverso dalla PR', () => {
      expect(run({ subject: 'fix(issue-77): gia\' consegnato' }).tipIsOld).toBe(true);
      expect(run({ subject: 'wip(issue-77): checkpoint pre-test', prHead: 'none' }).tipIsOld).toBe(true);
      expect(run({ subject: 'wip(issue-77): checkpoint pre-test', prHead: 'other' }).tipIsOld).toBe(true);
    });
  });
});
