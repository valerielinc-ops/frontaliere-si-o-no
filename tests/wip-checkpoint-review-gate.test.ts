import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
