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

  it('fix-outcome:skip-duplicate-diagnosis → mai driver (#5288: il guard che funziona non è una regola violata)', () => {
    // Emesso SOLO dal Mode 2 di check-workflows-scope.mjs: una issue con titolo
    // identico a una già diagnosticata viene short-circuitata PRIMA di spendere un
    // turno Claude. Prima condivideva il marker con `blocked-workflows-scope`, e la
    // conflazione era perversa: più il guard è efficace, più alza il bucket la cui
    // ricorrenza fa scattare l'escalation su quel bucket.
    expect(isEscalationDriver('fix-outcome', 'skip-duplicate-diagnosis')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:skip-duplicate-diagnosis')).toBe(false);
  });

  it('la separazione NON tocca il codice originale: blocked-workflows-scope resta driver', () => {
    // Il blocco vero (capability mancante in una run reale) è ancora segnale di burn
    // ricorrente e deve poter scalare — è il caso che ha aperto #5288.
    expect(isEscalationDriver('fix-outcome', 'blocked-workflows-scope')).toBe(true);
  });

  it('resta contato come volume/context: la carve-out tocca solo l\'escalation, non il tally', () => {
    // `max-turns` è il contro-esempio vicino: anche lui è emesso da un post-step
    // deterministico, ma indica un budget di turni DAVVERO speso su questa issue
    // → è un segnale azionabile sui doc e resta driver.
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });
});

describe('isEscalationDriver — overlap-skip / pr-already-open sono scheduling, non fault (corpus #229, metà sito)', () => {
  // I due esiti che `followup-drainer.mjs` esclude APPOSTA da NON_RETRYABLE («l'overlap è
  // transitorio: la PR bloccante può mergiare → ri-tentabile») e che
  // `close-recovered-structural-hold.mjs` si rifiuta di trattenere («scheduling, not a
  // fault»). Il harvester era l'unico dei tre a non saperlo: misurato sul mirror corpus il
  // 2026-08-13, 11 marker `overlap-skip` su 11 contati come burn ricorrente. Nessuna riga
  // di doc impedisce a due issue indipendenti di nominare lo stesso file nello stesso
  // momento — è la forma normale di un ciclo con più fixer in parallelo.
  it('fix-outcome:overlap-skip → mai driver, in entrambe le shape della chiave', () => {
    expect(isEscalationDriver('fix-outcome', 'overlap-skip')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:overlap-skip')).toBe(false);
  });

  it('fix-outcome:pr-already-open → mai driver (stessa dichiarazione, stessa riga del drainer)', () => {
    expect(isEscalationDriver('fix-outcome', 'pr-already-open')).toBe(false);
    expect(isEscalationDriver('fix-outcome', 'fix-outcome:pr-already-open')).toBe(false);
  });

  it('la carve-out non tocca gli esiti vicini che restano segnale', () => {
    expect(isEscalationDriver('fix-outcome', 'blocked-secrets')).toBe(true);
    expect(isEscalationDriver('fix-outcome', 'max-turns')).toBe(true);
  });
});
