/**
 * Un 🔴 che chiede una misura producibile solo da un run su `main` (workflow
 * schedulato, deploy, replay del corpus) non deve diventare uno stallo.
 *
 * #10467 e #10580: il reviewer chiedeva un run «su questa HEAD» di un
 * workflow solo-main; il 🔴-fixer rispondeva `not-fixable` a ogni HEAD (sei
 * round in un giorno), perché il prompt elencava «misura live» fra i motivi
 * validi e REVIEW.md regola 7 lasciava al reviewer la scelta fra misura e
 * trigger di revert. Il reviewer sceglieva la misura, l'unica che nessun
 * agente del ciclo può produrre.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const review = readFileSync(new URL('../REVIEW.md', import.meta.url), 'utf8');
const fixer = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');

describe('REVIEW.md regola 7 — rimedio unico secondo chi può misurare', () => {
  const rule = review.split('\n').find((line) => line.startsWith('7. **Claim perf/optimization non validato'));

  it('la misura solo-main si chiude sul body, con trigger di revert', () => {
    expect(rule).toBeDefined();
    expect(rule).toContain('rimedio unico');
    expect(rule).toContain('`blocked: misura post-merge`');
    expect(rule).toContain('trigger di revert');
    expect(rule).toContain('quel bullet chiude il 🔴');
  });

  it('non offre più «X oppure Y» al reviewer, che il prompt di tests.yml vieta', () => {
    expect(rule).not.toMatch(/oppure dichiara/);
  });
});

describe('pr-redflag-fixer — una misura post-merge non è not-fixable', () => {
  it('il prompt SOLO-BODY prescrive il bullet con trigger di revert e risposta `fixed:`', () => {
    expect(fixer).toContain('**Una misura che solo un run su `main`/schedule/deploy può produrre NON è `not-fixable`**');
    expect(fixer).toContain('`blocked: misura post-merge');
    expect(fixer).toContain('**Trigger di revert:**');
    expect(fixer).toContain('Rispondi `fixed:` citando quel bullet');
  });

  it('«misura live» non è più fra i motivi di not-fixable', () => {
    const line = fixer.split('\n').find((l) => l.includes('— not-fixable: <motivo concreto'));
    expect(line).toBeDefined();
    expect(line).not.toContain('misura live');
  });
});
