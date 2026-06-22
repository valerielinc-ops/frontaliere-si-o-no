/**
 * lessons-harvester — spegne i FALSI POSITIVI che fanno ricorrere in eterno due
 * escalation senza fix strutturale possibile (stessa classe di #2290/#2433):
 *
 *   - #2439 `fix-outcome:max-turns`: un run-death `error_max_turns` è burn-fixabile
 *     SOLO su una follow-up single-item ancora instradabile. Aggregate multi-item
 *     (over-budget by construction, target del circuit-breaker) e issue già parkate
 *     `needs-human` dal drainer (#2291: malformed body / network-audit) muoiono al
 *     cap DETERMINISTICAMENTE → niente loop fixabile → non contabili.
 *   - #2440 `reviewer-finding/pr-body-contract`: la regex matcha il VOCABOLARIO del
 *     contratto, ma una violazione GENUINA (sezione mancante/vuota, Closes multi-issue)
 *     è già bloccata dal gate deterministico pr-body-contract.yml. Il bucket ricorre
 *     per affermazioni ("sezioni presenti e sensate") ed etichette-di-posizione
 *     ("PR body ## Implementato L2" su un finding di altro tipo). Conta solo (a).
 */
import { describe, it, expect } from 'vitest';
import {
  isAvoidableMaxTurns,
  isGenuinePrBodyContractViolation,
  bucketFinding,
} from '../scripts/ci/harvest-agent-lessons.mjs';

describe('isAvoidableMaxTurns — non escalare la morte al cap che è deterministica/inerente', () => {
  it('follow-up single-item ancora instradabile → contabile (loop fixabile, vero target)', () => {
    expect(isAvoidableMaxTurns(
      'follow-up(#2388): 1 item deferred — feat(traffic): webcam warmup gating',
      ['follow-up', 'agent:triaged', 'fu-prio:low'],
    )).toBe(true);
    expect(isAvoidableMaxTurns(
      'follow-up(#2383): fix(seo): raise CF-hot 404 bridge cap',
      ['follow-up', 'funnel-seo', 'agent:triaged'],
    )).toBe(true);
  });

  it('issue parkata needs-human dal drainer → NON contabile (#2291: morte deterministica)', () => {
    expect(isAvoidableMaxTurns(
      'follow-up(#2388): 1 item deferred — feat(traffic): webcam warmup gating',
      ['follow-up', 'agent:triaged', 'fu-parked', 'needs-human'],
    )).toBe(false);
  });

  it('aggregate "N item deferred" (N≥2) → NON contabile (over-budget by construction, #2332)', () => {
    expect(isAvoidableMaxTurns(
      'follow-up(#2331): 5 item deferred — fix(jobboard): canton-aware section',
      ['follow-up', 'funnel-ux', 'agent:fix', 'agent:triaged'],
    )).toBe(false);
    expect(isAvoidableMaxTurns('follow-up(#x): 2 items deferred — perf', ['follow-up'])).toBe(false);
  });

  it('aggregate per keyword (sweep/batch/bulk) → NON contabile', () => {
    expect(isAvoidableMaxTurns('follow-up: Sweep ~30 crawler thin-source guard', ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns('follow-up: batch redirect cleanup', ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns('follow-up: bulk slug migration', ['follow-up'])).toBe(false);
  });

  it('"1 item deferred" NON è aggregate (boundary N=1) → contabile se non parkata', () => {
    expect(isAvoidableMaxTurns('follow-up(#9): 1 item deferred — fix(x)', ['follow-up'])).toBe(true);
  });

  it('PR consegnato (hasDeliveredPr) → NON contabile, anche single-item routable (#2653: overrun post-delivery)', () => {
    // 3/5 esempi dell'escalation #2653 (#2590/#2560/#2476) hanno aperto un PR poi
    // mergiato, poi sforato il cap su churn post-delivery. Un run che ha consegnato
    // un PR è SUCCESS (come lo classifica già issue-fix.yml) → mai burn evitabile.
    expect(isAvoidableMaxTurns(
      'follow-up(#2590): 1 item deferred — fix(x)',
      ['follow-up', 'agent:triaged'],
      true,
    )).toBe(false);
    // senza PR consegnato la stessa issue single-item resta il segnale genuino
    expect(isAvoidableMaxTurns(
      'follow-up(#2590): 1 item deferred — fix(x)',
      ['follow-up', 'agent:triaged'],
      false,
    )).toBe(true);
    // hasDeliveredPr domina anche su aggregate/parked (irrilevante, ma esplicito)
    expect(isAvoidableMaxTurns('follow-up(#x): 3 items deferred', ['follow-up'], true)).toBe(false);
  });

  it('input degeneri → contabile-safe non gonfia (proceed: solo le esclusioni esplicite scartano)', () => {
    // nessuna label needs-human, nessun marcatore aggregate → resta contabile,
    // ma in pratica un titolo vuoto non fa scattare nulla a valle (count basso).
    expect(isAvoidableMaxTurns(undefined as unknown as string, undefined as unknown as string[])).toBe(true);
    expect(isAvoidableMaxTurns('', null as unknown as string[])).toBe(true);
    // labels non-array trattate come [] → nessuna needs-human → contabile
    expect(isAvoidableMaxTurns('follow-up: x', 'follow-up' as unknown as string[])).toBe(true);
  });
});

describe('isGenuinePrBodyContractViolation — conta solo la violazione reale, non affermazioni/etichette', () => {
  it('sezione mancante/vuota/incompleta → violazione (contabile)', () => {
    expect(isGenuinePrBodyContractViolation('🔴 process: manca la sezione `## Non implementato`')).toBe(true);
    expect(isGenuinePrBodyContractViolation('🟡 nit: `## Non implementato` ha un bullet vuoto (`- ` senza testo)')).toBe(true);
    expect(isGenuinePrBodyContractViolation('🔴 `## Implementato` incompleto: non corrisponde al diff')).toBe(true);
    expect(isGenuinePrBodyContractViolation('🟡 Closes multi-issue su una riga sola → chiude solo la prima')).toBe(true);
    expect(isGenuinePrBodyContractViolation('🟡 il bullet dichiara X ma il diff non lo mostra')).toBe(true);
  });

  it('affermazione "il contratto è ok" → NON violazione (#2397/#2396)', () => {
    expect(isGenuinePrBodyContractViolation(
      'Il resto del contratto è ok: sezioni `## Implementato` / `## Non implementato` presenti e sensate',
    )).toBe(false);
    expect(isGenuinePrBodyContractViolation('completeness contract OK, sezioni obbligatorie presenti')).toBe(false);
    expect(isGenuinePrBodyContractViolation('`## Non implementato` accurato, nessun drift')).toBe(false);
  });

  it('etichetta-di-posizione "PR body ## Implementato L2" per un finding di altro tipo → NON violazione (#2409/#2408)', () => {
    expect(isGenuinePrBodyContractViolation(
      '`PR body ## Implementato L2`: 🟡 Nit: descrive il match come "stesso companyKey + titolo"',
    )).toBe(false);
    expect(isGenuinePrBodyContractViolation(
      '`PR body → "## Non implementato" L1`: 🟡 Nit: dichiara 10 match ma la sticky ne elenca 12',
    )).toBe(false);
  });

  it('vocabolario contratto senza affermazione né etichetta → conservativo: violazione', () => {
    expect(isGenuinePrBodyContractViolation('🔴 il completeness contract non è rispettato qui')).toBe(true);
  });
});

describe('bucketFinding — pr-body-contract scarta i falsi positivi e lascia ricadere il vero topic', () => {
  it('affermazione contratto non finisce in pr-body-contract', () => {
    expect(bucketFinding('🟡 sezioni `## Implementato` / `## Non implementato` presenti e sensate')).not.toBe('pr-body-contract');
  });

  it('etichetta-di-posizione con finding sibling cade in sibling-class-fix, non pr-body-contract', () => {
    const b = bucketFinding('`PR body ## Non implementato L1`: 🟡 Nit: stesso antipattern nel file gemello non toccato');
    expect(b).toBe('sibling-class-fix');
  });

  it('violazione genuina di sezione mancante resta pr-body-contract', () => {
    expect(bucketFinding('🔴 process: manca la sezione `## Implementato`')).toBe('pr-body-contract');
  });
});
