/**
 * lessons-harvester — isEscalationDriver (#4750).
 *
 * `fix-outcome:no-root-cause` escalated a SECOND time (#4750, 6/14d) after its
 * first structural fix (#4580, `isAvoidableNoRootCause`) shipped. All 5 fresh
 * examples (#4748/#4738/#4735/#4702/#4696) were, once again, correct aborts —
 * verified-transient-live or blocked-on-a-separately-tracked-issue — but with
 * SLIGHTLY different phrasing than the regexes added for #4580 (e.g. "verificato
 * live: nessuna root cause di codice" with a colon vs. the regex's comma, or
 * "blip edge/deploy-churn transitorio" vs. the regex's "blip edge transitorio").
 * Unlike its siblings (isAvoidableAlreadyFixed / isAvoidableMaxTurns, which key
 * off fixed-format issue titles/labels), isAvoidableNoRootCause keys off
 * open-ended LLM-authored diagnosis prose — an unbounded input space no regex
 * can close by construction. Widening the regex again would only repeat the
 * same failure a third time.
 *
 * The structural fix: `no-root-cause` is carved out of the `fix-outcome`
 * source's escalation-driver status entirely (same treatment as the
 * `issue-class` source, which is operational volume/context, never a proposal
 * driver) — so no phrasing of a correct abort can ever re-trigger this
 * escalation again, regardless of regex accuracy.
 */
import { describe, it, expect } from 'vitest';
import { isEscalationDriver } from '../scripts/ci/harvest-agent-lessons.mjs';

describe('isEscalationDriver — no-root-cause non può più driveare un\'escalation (#4750)', () => {
  it('fix-outcome:no-root-cause → mai driver, indipendentemente dal count', () => {
    expect(isEscalationDriver('fix-outcome', 'no-root-cause')).toBe(false);
  });

  // #4938: la carve-out sopra non scattava mai in produzione. main() costruisce
  // la chiave come `fix-outcome:${code}` (già prefissata con il source), non
  // come il solo `code` nudo testato sopra — questo caso copre la shape reale
  // usata dalla chiamata `consider('fix-outcome', outcomeCounts, ...)`.
  it('fix-outcome:fix-outcome:no-root-cause (shape reale del call site in main()) → mai driver', () => {
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:no-root-cause')).toBe(false);
  });

  it('altri fix-outcome code restano driver (es. blocked-workflows-scope, già un fix strutturale riuscito)', () => {
    expect(isEscalationDriver('fix-outcome', 'blocked-workflows-scope')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'already-fixed')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'revenue-tracker-manual')).toBe(true);
  });

  it('altri fix-outcome code con la shape prefissata reale restano driver', () => {
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:blocked-workflows-scope')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:already-fixed')).toBe(true);
  });

  it('issue-class resta sempre non-driver (comportamento preesistente, volume operativo)', () => {
    expect(isEscalationDriver('issue-class', 'crawler-failure')).toBe(false);
    expect(isEscalationDriver('issue-class', 'anything')).toBe(false);
  });

  it('reviewer-finding resta driver per qualunque bucket (comportamento preesistente)', () => {
    expect(isEscalationDriver('reviewer-finding', 'pr-body-contract')).toBe(true);
    expect(isEscalationDriver('reviewer-finding', 'sibling-class-fix')).toBe(true);
  });
});

describe('isEscalationDriver — rate-limited non può driveare un\'escalation (quota ≠ regola violata)', () => {
  // Il marker `rate-limited` (issue-fix.yml, post-step deterministico) dice che
  // la quota Max condivisa era esaurita quando è arrivato il turno di quella
  // issue: run morta su HTTP 429 al primo turno, `num_turns: 1`, costo 0, issue
  // mai letta. Misurato il 2026-08-05: 60 delle 61 run fallite di issue-fix nella
  // finestra 7gg erano di questa forma. Senza la carve-out il bucket supererebbe
  // la soglia ≥3/14gg in poche ore e farebbe partire la proposta Claude del
  // harvester — un turno speso a redigere regole che non possono fixare
  // un'interruzione di quota, e speso proprio quando la quota manca.
  it('fix-outcome:rate-limited → mai driver, in entrambe le shape della chiave', () => {
    expect(isEscalationDriver('fix-outcome', 'rate-limited')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:rate-limited')).toBe(false);
  });

  it('resta contato come volume/context: la carve-out tocca solo l\'escalation, non il tally', () => {
    // `max-turns` è il contro-esempio vicino: anche lui è emesso da un post-step
    // deterministico, ma indica un budget di turni DAVVERO speso su questa issue
    // → è un segnale azionabile sui doc e resta driver.
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });
});
