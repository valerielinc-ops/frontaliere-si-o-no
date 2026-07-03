/**
 * lessons-harvester — isAvoidableAlreadyFixed: spegne il FALSO POSITIVO che ha
 * fatto ricorrere l'escalation `fix-outcome:already-fixed` (#2290, bucket 8/14d).
 *
 * Un marker `<!-- FIX_OUTCOME: already-fixed -->` postato da un genuino run Claude
 * è burn-ricorrente DA ESCALARE solo se il gate pre-flight zero-Claude
 * (check-issue-already-resolved.mjs) avrebbe POTUTO catturarlo. Per due classi il
 * gate, by-design conservativo, NON cortocircuita mai → il run Claude è il path di
 * conferma atteso, non una violazione di regola, e contarlo ri-accende l'escalation
 * in eterno senza fix possibile:
 *   1. follow-up AGGREGATE ("N item deferred" N≥2, o sweep/batch/bulk) — il gate
 *      rifiuta di cortocircuitare (un item risolto ≠ tutti).
 *   2. issue NON-follow-up (crawler-health, validation-failure, free-form) — lo scope
 *      del gate è solo `follow-up`.
 * Le follow-up single-item (il vero target del gate) restano contate.
 */
import { describe, it, expect } from 'vitest';
import { isAvoidableAlreadyFixed } from '../scripts/ci/harvest-agent-lessons.mjs';

describe('isAvoidableAlreadyFixed — non escalare il burn che nessun gate sicuro previene', () => {
  it('follow-up single-item → contabile (vero target del gate)', () => {
    expect(isAvoidableAlreadyFixed(
      'follow-up(#2101): 1 item deferred — feat(newsletter): auto-promote winning subject',
      ['follow-up', 'agent:fix'],
    )).toBe(true);
    // anche senza il prefisso "1 item deferred"
    expect(isAvoidableAlreadyFixed('follow-up(#2229): fix(seo): CollectionPage schema', ['follow-up'])).toBe(true);
  });

  it('follow-up AGGREGATE "N item deferred" (N≥2) → NON contabile (#2260/#2246)', () => {
    expect(isAvoidableAlreadyFixed(
      'follow-up(#2258): 2 item deferred — fix(assemble): preserve long-tail expired slices',
      ['follow-up', 'fu-parked'],
    )).toBe(false);
    expect(isAvoidableAlreadyFixed('follow-up(#x): 5 items deferred — perf sweep', ['follow-up'])).toBe(false);
  });

  it('follow-up AGGREGATE per keyword (sweep/batch/bulk) → NON contabile', () => {
    expect(isAvoidableAlreadyFixed('follow-up: Sweep ~30 crawler thin-source guard', ['follow-up'])).toBe(false);
    expect(isAvoidableAlreadyFixed('follow-up: batch redirect cleanup', ['follow-up'])).toBe(false);
    expect(isAvoidableAlreadyFixed('follow-up: bulk slug migration', ['follow-up'])).toBe(false);
  });

  it('issue NON-follow-up (crawler-health, free-form) → NON contabile (#2147)', () => {
    expect(isAvoidableAlreadyFixed('[crawler-health] svar-spitalverbund-ar: stale', ['agent:fix', 'agent:triaged'])).toBe(false);
    expect(isAvoidableAlreadyFixed('Crawler Failure: foo', [])).toBe(false);
    expect(isAvoidableAlreadyFixed('Validation Failure: bar', ['agent:triaged'])).toBe(false);
  });

  it('"1 item deferred" NON è aggregate (boundary N=1) → contabile', () => {
    expect(isAvoidableAlreadyFixed('follow-up(#9): 1 item deferred — fix(x)', ['follow-up'])).toBe(true);
  });

  it('"1 item deferred" con parola ordinaria "batch"/"sweep"/"bulk" nel titolo → NON aggregate, il count esplicito vince sul keyword fallback (#3378)', () => {
    expect(isAvoidableAlreadyFixed(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
      ['follow-up'],
    )).toBe(true);
  });

  it('input degeneri → NON contabile (proceed-safe: non gonfia il bucket)', () => {
    expect(isAvoidableAlreadyFixed(undefined as unknown as string, undefined as unknown as string[])).toBe(false);
    expect(isAvoidableAlreadyFixed('', null as unknown as string[])).toBe(false);
    expect(isAvoidableAlreadyFixed('follow-up: qualcosa', 'follow-up' as unknown as string[])).toBe(false);
  });
});
