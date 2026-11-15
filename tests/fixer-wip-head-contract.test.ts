import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

// Meta' produttrice del contratto F7 (vedi wip-checkpoint-review-gate.test.ts):
// il Re-review guard di tests.yml chiude fail-closed senza modello ogni HEAD
// `wip(issue-N): checkpoint ...` e NON si tocca. Misurato il 2026-11-15 su
// #18822 (run 43705023231): il fixer redflag ha consegnato il round come
// `wip(issue-18813): checkpoint pre-test`, imitando lo stile del branch, e la PR
// e' rimasta senza review. Prompt e step deterministico dei due fixer
// garantiscono che l'HEAD consegnata sia un commit conventional.
const KINDS = [
  { kind: 'redflag', file: 'pr-redflag-fixer.yml', before: 'Advance HEAD after a PR-body fix' },
  { kind: 'redcheck', file: 'pr-redcheck-fixer.yml', before: 'Cleanup Firebase credentials' },
] as const;

describe.each(KINDS)('$kind fixer non consegna mai un checkpoint WIP come HEAD', ({ kind, file, before }) => {
  const doc: any = YAML.parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
  const steps: any[] = Object.values<any>(doc.jobs).flatMap((job) => job.steps ?? []);
  const finalize = steps.find((step) => step?.name?.startsWith('Finalize') && step.name.includes('never deliver a WIP checkpoint'));
  const prompt: string = steps.map((step) => step?.with?.prompt).find((value) => typeof value === 'string') ?? '';

  it('il prompt vieta un subject che inizia per `wip(` e chiede fix(...)/chore(...)', () => {
    const rule = prompt.split('\n').find((line) => line.includes('NON inizia MAI con `wip(`')) ?? '';
    expect(rule).toContain('`fix(...)`/`chore(...)`');
    expect(rule).toContain('wip(issue-N): checkpoint pre-test');
    expect(rule).toContain('F7');
  });

  it('lo step esiste, e best-effort, e gira dopo il modello e prima di chi legge la HEAD', () => {
    expect(finalize, 'step Finalize ... mancante').toBeTruthy();
    expect(finalize['continue-on-error']).toBe(true);
    expect(finalize.if).toContain('always()');
    const names = steps.map((step) => step?.name ?? '');
    const at = names.indexOf(finalize.name);
    expect(at).toBeGreaterThan(names.findIndex((name) => name.startsWith('Run Codex')));
    expect(at).toBeLessThan(names.findIndex((name) => name.startsWith(before)));
    expect(at).toBeLessThan(names.findIndex((name) => name.startsWith('Classify outcome')));
    // push normale, mai force, nessun rewrite
    expect(finalize.run).not.toMatch(/--force|\+HEAD|--amend|git reset|git rebase|git push[^\n]*\s-f(?:\s|$)/u);
    expect(finalize.run).toContain('git push origin "HEAD:refs/heads/${HEAD_REF}"');
    expect(finalize.run).toContain(`--trailer "Fixer: ${kind}-round-`);
    // albero pulito prima del commit
    expect(finalize.run.indexOf('git status --porcelain')).toBeGreaterThan(0);
    expect(finalize.run.indexOf('git status --porcelain')).toBeLessThan(finalize.run.indexOf('git commit --allow-empty'));
  });

  describe('comportamento dello step su un repository reale', () => {
    function run(opts: { subject: string; baseIsHead?: boolean; round?: string; dirty?: boolean }) {
      const temp = mkdtempSync(join(tmpdir(), 'fixer-finalize-'));
      try {
        const remote = join(temp, 'remote.git');
        const work = join(temp, 'work');
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        mkdirSync(work);
        execFileSync('git', ['init', '-q', '--bare', remote]);
        git(work, 'init', '-q', '-b', 'main');
        git(work, 'config', 'user.name', 't');
        git(work, 'config', 'user.email', 't@example.invalid');
        git(work, 'remote', 'add', 'origin', remote);
        writeFileSync(join(work, 'a.txt'), 'a');
        git(work, 'add', '-A');
        git(work, 'commit', '-q', '-m', 'base');
        git(work, 'checkout', '-q', '-b', 'fix/issue-77');
        git(work, 'push', '-q', 'origin', 'fix/issue-77');
        const baseSha = git(work, 'rev-parse', 'HEAD');
        if (!opts.baseIsHead) {
          writeFileSync(join(work, 'a.txt'), 'b');
          git(work, 'add', '-A');
          git(work, 'commit', '-q', '-m', opts.subject, '-m', `Fixer: ${kind}-round-1`);
        }
        if (opts.dirty) writeFileSync(join(work, 'residuo.txt'), 'lavoro non committato');
        execFileSync('bash', ['-c', finalize.run], {
          cwd: work,
          env: {
            ...process.env,
            HEAD_REF: 'fix/issue-77',
            BASE_SHA: baseSha,
            FIX_ROUND: opts.round ?? '2',
          },
          stdio: 'pipe',
        });
        const localHead = git(work, 'rev-parse', 'HEAD');
        const remoteSha = git(remote, 'rev-parse', 'fix/issue-77');
        return {
          subject: git(work, 'log', '-1', '--format=%s'),
          trailer: git(work, 'log', '-1', '--format=%(trailers:key=Fixer,valueonly)'),
          commits: Number(git(work, 'rev-list', '--count', `${baseSha}..HEAD`)),
          pushed: remoteSha === localHead,
          remoteIsBase: remoteSha === baseSha,
          parentIsPriorRoundCommit: opts.baseIsHead ? true : git(work, 'rev-parse', 'HEAD^') !== baseSha,
        };
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }

    it('aggiunge un commit conventional vuoto con lo stesso trailer sopra il checkpoint e lo pusha', () => {
      const result = run({ subject: 'wip(issue-18813): checkpoint pre-test' });
      expect(result.subject).toBe(`chore(${kind}): consegna il fix del round 2`);
      expect(/^wip\(/u.test(result.subject)).toBe(false);
      expect(result.trailer.trim()).toBe(`${kind}-round-2`);
      expect(result.commits).toBe(2); // il commit del round + quello nuovo: nessun amend
      expect(result.parentIsPriorRoundCommit).toBe(true);
      expect(result.pushed).toBe(true);
    });

    it('albero di lavoro sporco: nessun commit finale e nessun push (review del bot su #3834)', () => {
      const result = run({ subject: 'wip(issue-18813): checkpoint pre-test', dirty: true });
      expect(result.commits).toBe(1); // solo il commit del round
      expect(result.subject).toBe('wip(issue-18813): checkpoint pre-test');
      expect(result.remoteIsBase).toBe(true);
    });

    it('non tocca un commit conventional, ne un round senza commit nuovi', () => {
      const conventional = run({ subject: 'fix(issue-18813): correggi il guard' });
      expect(conventional.commits).toBe(1);
      expect(conventional.subject).toBe('fix(issue-18813): correggi il guard');
      const noCommit = run({ subject: 'unused', baseIsHead: true });
      expect(noCommit.commits).toBe(0);
      expect(noCommit.remoteIsBase).toBe(true);
    });
  });
});
