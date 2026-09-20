/**
 * I due fixer autonomi (🔴 e ❌) committano con la stessa identity degli agenti
 * locali: senza un trailer i loro push non si distinguono (6 merge nati da push
 * concorrenti fino al 2026-09-19). E l'escalation `needs-human` veniva ripostata
 * a ogni review oltre il cap (5 volte su #9202, 4 su #9238).
 *
 * Gli hook git NON sono una via: il sandbox Codex toglie `core.hooksPath`
 * (`sanitize-git-config.mjs`) per costruzione. Il trailer lo scrive l'agente
 * su istruzione del prompt, il merge di allineamento lo porta dal workflow, e
 * il classify misura i commit che ne sono privi.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const load = (name: string) =>
  readFileSync(path.resolve(__dirname, '..', '.github', 'workflows', name), 'utf8');

const FIXERS = [
  { file: 'pr-redflag-fixer.yml', kind: 'redflag' },
  { file: 'pr-redcheck-fixer.yml', kind: 'redcheck' },
] as const;

describe.each(FIXERS)('$file', ({ file, kind }) => {
  const src = load(file);

  it('il prompt chiede il trailer Fixer con il round corrente', () => {
    expect(src).toContain(`--trailer "Fixer: ${kind}-round-\${{ steps.guard.outputs.round }}"`);
  });

  it('il merge di allineamento porta il suo trailer', () => {
    expect(src).toContain(`Fixer: ${kind}-align`);
    expect(src).not.toMatch(/if git merge --no-edit origin\/main; then/u);
  });

  it('il classify segnala i commit del round senza trailer', () => {
    expect(src).toContain('%(trailers:key=Fixer,valueonly');
    expect(src).toContain(`senza trailer 'Fixer: ${kind}-round-N'`);
  });

  it('needs-human viene postato una volta sola per PR', () => {
    const marker = `<!-- NEEDS_HUMAN_ESCALATION: ${kind} -->`;
    // Il commento porta il marker, e il guard lo cerca prima di ripostare.
    expect(src).toContain(`grep -qF '${marker}' <<<"$comments"`);
    // Con pipefail, `printf | grep -q` fallisce per SIGPIPE su input grandi.
    expect(src).not.toMatch(/printf '%s' "\$comments" \| grep -q/u);
    expect(src).toContain(`printf '${marker}\\n🛑 **needs-human** (auto)`);
    // Label e commento stanno entrambi nel ramo else del guard.
    const guard = src.slice(src.indexOf(`grep -qF '${marker}'`));
    const elseAt = guard.indexOf('\n            else\n');
    const fiAt = guard.indexOf('\n            fi\n');
    expect(elseAt).toBeGreaterThan(0);
    const body = guard.slice(elseAt, fiAt);
    expect(body).toContain('--add-label "needs-human"');
    expect(body).toContain('pr comment');
    expect(src.match(/--add-label "needs-human"/gu)?.length).toBe(1);
  });
});
