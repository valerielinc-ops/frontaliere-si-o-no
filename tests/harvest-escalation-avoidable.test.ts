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
 *   - #3325 `reviewer-finding/sibling-class-fix`: stessa classe di #2440 ma per il
 *     bucket sibling-sweep (regex su `sibling`/`file gemello`/`stesso anti-pattern`/
 *     `non toccat[o]`). Il bucket non aveva NESSUN filtro (a differenza del suo
 *     gemello pr-body-contract, #3332) → ricorso ×6 in 14gg (#3319/#3317/#3312/
 *     #3267/#3265) contando affermazioni ("nessun sibling residuo", "no
 *     inconsistency") e persino un caso di emoji-come-parola ("nessun 🔴/🟡 da
 *     propagare", #3319) che ingannava `detectSeverity`. Conta solo la violazione
 *     genuina; scarta affermazioni e falsi-positivi dichiarati esplicitamente.
 */
import { describe, it, expect } from 'vitest';
import {
  isAvoidableMaxTurns,
  isAvoidableOverlapSkip,
  isGenuinePrBodyContractViolation,
  isGenuineSiblingClassViolation,
  bucketFinding,
  fixBranchName,
  parseRecoverableBranchStamp,
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
    expect(isAvoidableMaxTurns('follow-up(#x): 2 item deferiti — perf', ['follow-up'])).toBe(false);
  });

  it('aggregate per keyword (sweep/batch/bulk) → NON contabile', () => {
    expect(isAvoidableMaxTurns('follow-up: Sweep ~30 crawler thin-source guard', ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns('follow-up: batch redirect cleanup', ['follow-up'])).toBe(false);
    expect(isAvoidableMaxTurns('follow-up: bulk slug migration', ['follow-up'])).toBe(false);
  });

  it('"1 item deferred" NON è aggregate (boundary N=1) → contabile se non parkata', () => {
    expect(isAvoidableMaxTurns('follow-up(#9): 1 item deferred — fix(x)', ['follow-up'])).toBe(true);
  });

  it('"1 item deferred" con parola ordinaria "batch"/"sweep"/"bulk" nel titolo → NON aggregate, il count esplicito vince sul keyword fallback (#3378)', () => {
    expect(isAvoidableMaxTurns(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
      ['follow-up'],
    )).toBe(true);
  });

  it('crawler-health con needs-human (aggiunto dal drainer crawlersFix pass, #3886) → NON contabile', () => {
    // After the drainer's crawler max-turns pass runs, it adds fu-parked + needs-human
    // to crawler issues that hit error_max_turns. isAvoidableMaxTurns must then
    // return false (already covered by the needs-human gate), so the harvester
    // stops counting them and the escalation self-heals.
    expect(isAvoidableMaxTurns(
      '[crawler-health] kiabi: broken',
      ['agent:fix', 'agent:triaged', 'fu-parked', 'needs-human'],
    )).toBe(false);
    expect(isAvoidableMaxTurns(
      '[crawler-health] apg-sga: broken',
      ['agent:fix', 'agent:triaged', 'fu-parked', 'needs-human'],
    )).toBe(false);
  });

  it('crawler-health senza needs-human (prima che il drainer giri) → contabile come segnale attivo', () => {
    // Until the drainer's new pass runs and adds needs-human, crawler issues
    // that hit max-turns are correctly counted as avoidable burn signal.
    expect(isAvoidableMaxTurns(
      '[crawler-health] kiabi: broken',
      ['agent:fix', 'agent:triaged'],
    )).toBe(true);
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

describe('isAvoidableMaxTurns — il branch è prova di consegna quanto la PR (corpus #274, metà sito)', () => {
  // Misurato sul corpus su 31 morti `max-turns`: consegnate 0, RECUPERABILI 11, vuote 20.
  // Le undici avevano commit su `fix/issue-<N>` avanti a main dal checkpoint WIP (#4337)
  // e nessuna PR: l'unica prova di consegna accettata era `pr-created`, quindi passavano
  // per rumore. Due sono state riaperte a mano e mergiate (#5767 → PR #5774, corpus #166
  // → PR #293), che è la ragione per cui questo caso non è teorico.
  const TITLE = 'follow-up(#5767): 1 item deferred — fix(loop): drainer rescue';
  const LABELS = ['follow-up', 'agent:triaged'];

  it('commit sul branch e nessuna PR → NON contabile: è consegna parziale, non un loop fixabile', () => {
    expect(isAvoidableMaxTurns(TITLE, LABELS,
      { hasDeliveredPr: false, hasRecoverableBranch: true })).toBe(false);
  });

  it('nessuna prova di consegna (né PR né branch) → resta il segnale genuino, contabile', () => {
    // Il discriminante col comportamento vecchio: prima il terzo parametro era un
    // booleano, quindi QUALUNQUE oggetto — anche uno che dichiara zero consegne — era
    // truthy e scartava la run. Le 20 morti davvero vuote sparivano insieme alle 11.
    expect(isAvoidableMaxTurns(TITLE, LABELS,
      { hasDeliveredPr: false, hasRecoverableBranch: false })).toBe(true);
  });

  it('il booleano legacy conserva ESATTAMENTE il significato di prima (call site pre-branch)', () => {
    expect(isAvoidableMaxTurns(TITLE, LABELS, true)).toBe(false);
    expect(isAvoidableMaxTurns(TITLE, LABELS, false)).toBe(true);
    expect(isAvoidableMaxTurns(TITLE, LABELS)).toBe(true);
  });

  it('le esclusioni strutturali vincono comunque (aggregate / needs-human)', () => {
    expect(isAvoidableMaxTurns('follow-up(#x): 3 items deferred', LABELS,
      { hasDeliveredPr: false, hasRecoverableBranch: false })).toBe(false);
    expect(isAvoidableMaxTurns(TITLE, [...LABELS, 'needs-human'],
      { hasDeliveredPr: false, hasRecoverableBranch: true })).toBe(false);
  });

  it('lo stamp lasciato dal marker è leggibile senza spendere una chiamata API', () => {
    expect(fixBranchName(5767)).toBe('fix/issue-5767');
    expect(parseRecoverableBranchStamp(
      '<!-- FIX_OUTCOME: max-turns -->\n<!-- RECOVERABLE_BRANCH: fix/issue-5767 ahead=2 -->\n♻️ …',
    )).toEqual({ branch: 'fix/issue-5767', aheadBy: 2 });
    // `ahead=0` non è lavoro: un branch pushato e poi resettato non va recuperato.
    expect(parseRecoverableBranchStamp('<!-- RECOVERABLE_BRANCH: fix/issue-1 ahead=0 -->')).toBeNull();
    expect(parseRecoverableBranchStamp('<!-- FIX_OUTCOME: max-turns -->')).toBeNull();
    expect(parseRecoverableBranchStamp(undefined as unknown as string)).toBeNull();
  });
});

describe('isAvoidableOverlapSkip — un rinvio di scheduling non è burn evitabile (corpus #229, metà sito)', () => {
  // Misurato sul mirror corpus il 2026-08-13: 11 marker `overlap-skip`, 11 contati, 0
  // scartati — perché il classificatore non esisteva, unico esito senza. Eppure
  // followup-drainer.mjs li dichiara TRANSIENTI (esclusi da NON_RETRYABLE: «la PR
  // bloccante può mergiare → ri-tentabile»).
  it('overlap con una PR terza → NON contabile (nessuna regola di prosa lo previene)', () => {
    expect(isAvoidableOverlapSkip(
      'follow-up(#4102): 1 item deferred — fix(crawler): eHnv feed',
      ['follow-up', 'agent:triaged'],
    )).toBe(false);
    expect(isAvoidableOverlapSkip('qualunque titolo', [], false)).toBe(false);
  });

  it('overlap su una issue che aveva GIÀ la sua PR aperta → contabile: è un buco di hasFixPR', () => {
    expect(isAvoidableOverlapSkip(
      'follow-up(#4102): 1 item deferred — fix(crawler): eHnv feed',
      ['follow-up', 'agent:triaged'],
      true,
    )).toBe(true);
  });

  it('input degeneri non lanciano', () => {
    expect(isAvoidableOverlapSkip(undefined as unknown as string, undefined as unknown as string[])).toBe(false);
    expect(isAvoidableOverlapSkip('', null as unknown as string[])).toBe(false);
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

  it('prescription reference "dichiara/listare nel ## Non implementato" → NON violazione (#2836/#2840)', () => {
    // Reviewer suggerisce dove scrivere qualcosa, non che la sezione sia rotta.
    expect(isGenuinePrBodyContractViolation(
      '🔴 Important: `sendWinbacks()` senza cap consuma quota provider; o dichiara esplicitamente il revert-risk nel `## Non implementato`.',
    )).toBe(false);
    expect(isGenuinePrBodyContractViolation(
      'Fix: gatare `o:tracking-clicks` su Mailgun, oppure correggere il body e listare Mailgun in \'Non implementato\' come provider non ancora coperto.',
    )).toBe(false);
    expect(isGenuinePrBodyContractViolation(
      '🟡 Nit: nota in `## Non implementato` che Maileroo non separa open/click e `tracking:false` spegne entrambi.',
    )).toBe(false);
    expect(isGenuinePrBodyContractViolation(
      'documenta nel `## Non implementato` il limite del flag singolo Maileroo.',
    )).toBe(false);
  });

  it('prescription+violation nello stesso testo: la violation RE vince (caso a domina)', () => {
    // Se il testo ha sia linguaggio di violazione esplicita (claim falso) sia una
    // prescription, la violazione esplicita prevale e il finding viene contato.
    expect(isGenuinePrBodyContractViolation(
      '🔴 il body fa un claim falso su Mailgun; listare in \'Non implementato\' il provider non coperto.',
    )).toBe(true);
    // "rivendicata non esiste" → violazione esplicita
    expect(isGenuinePrBodyContractViolation(
      '🔴 la behavior Mailgun rivendicata non esiste in codebase; dichiara nel `## Non implementato` la copertura mancante.',
    )).toBe(true);
  });

  it('linguaggio esplicito "non è rispettato" resta violazione (caso a)', () => {
    expect(isGenuinePrBodyContractViolation('🔴 il completeness contract non è rispettato qui')).toBe(true);
    expect(isGenuinePrBodyContractViolation('🔴 il completeness contract non è valido')).toBe(true);
  });

  it('vocabolario contratto senza missing/empty/false-claim → NON violazione (default false, corpus #140)', () => {
    // keep=true gonfiava il bucket: una riga che nomina ## Implementato senza
    // dire che la sezione manca/è vuota/mente sul diff veniva contata. Misura
    // 2026-09-17: 14/14d, esempi #1536/#1535/#1534/#1521/#1520.
    expect(isGenuinePrBodyContractViolation('🔴 Important: vedi `## Implementato` per il dettaglio del wiring.')).toBe(false);
    expect(isGenuinePrBodyContractViolation('')).toBe(false);
    expect(isGenuinePrBodyContractViolation(undefined)).toBe(false);
  });

  it('❓ adversarial che nomina solo il vocabolario Implementato → NON violazione', () => {
    expect(isGenuinePrBodyContractViolation(
      '❓ q: non è verificato che ogni voce di `## Non implementato (ancora)` resti vera dopo il rebase.',
    )).toBe(false);
    // un 🔴 confermato sulla stessa riga non viene salvato dal glifo ❓
    expect(isGenuinePrBodyContractViolation(
      '🔴 Important: manca la sezione `## Non implementato`. ❓ q: il rebase la ripristina?',
    )).toBe(true);
  });

  // Verbatim dalle review Codex delle PR citate nella riapertura corpus #140
  // (2026-09-17). Un test su prosa inventata avrebbe dimostrato solo che la
  // regex fa quello che ho scritto io, non che chiude il caso misurato.
  it('corpus #1536: `Stato: per scelta` su PR body:L16 non è una violazione di sezione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L16: 🔴 Important: `Stato: per scelta` (ripetuto anche a `PR body:L18`) non è un piano di completamento valido per `## Non implementato (ancora)`; sostituisci ciascuna voce con `in questa PR`, `PR concatenata #N` o `blocked: <causa esterna reale>`, oppure rimuovila dalla sezione.',
    )).toBe(false);
  });

  it('corpus #1535: `Per scelta` su PR body:L12 non è una violazione di sezione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L12: 🔴 Important: la voce in `## Non implementato (ancora)` lascia deliberatamente il predicato reviewer duplicato ma `Per scelta` non è uno stato o next-step ammesso dal contratto; lo scope dovuto resta un deferral senza piano concreto. Rimuovi la voce se non è lavoro dovuto, oppure indica `in questa PR`, `PR concatenata #N` o `blocked: <causa reale>`.',
    )).toBe(false);
  });

  it('corpus #1534: “per scelta” senza next-step su PR body:L8 non è una violazione di sezione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L8: 🔴 Important: la voce di `## Non implementato (ancora)` dichiara lavoro non eseguito e lo chiude con “per scelta”, senza un next-step concreto; se non resta lavoro dovuto scrivi `Nessuno`, altrimenti indica `in questa PR`, una PR concatenata o `blocked: <causa reale>`.',
    )).toBe(false);
  });

  it('corpus #1521 🔴: “by construction” / “per scelta” su PR body:L8 non è una violazione di sezione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L8: 🔴 Important: le voci in `## Non implementato (ancora)` non dichiarano uno stato concreto (`in questa PR`, `PR concatenata #N` o `blocked: ...`); “by construction” e “per scelta” lasciano scope/processo non chiuso senza next-step. Riscrivile con stato e next-step verificabili, oppure indica `Nessuno: task completo.`',
    )).toBe(false);
  });

  it('corpus #1521 🟡: `## Implementato` dichiara 24 workflow ma il bundle ne ha 1 → false-claim, resta violazione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L3: 🟡 Nit: `## Implementato` dichiara la sincronizzazione di 24 workflow, sette observer e 32 baseline, ma il bundle code-only contiene una sola modifica di workflow e due entry di baseline oltre al contratto; allinea il resoconto a ciò che questa PR modifica — deferred, non funnel-critical.',
    )).toBe(true);
  });

  it('corpus #1520: scelta di non eseguire il lavoro su PR body:L12 non è una violazione di sezione', () => {
    expect(isGenuinePrBodyContractViolation(
      'PR body:L12: 🔴 Important: le due voci sotto `## Non implementato (ancora)` descrivono una scelta di non eseguire il lavoro (`non viene rimosso` e `nomi legacy restano`), ma non indicano una PR concatenata o una causa `blocked:` reale; la stringa `in questa PR` non è un next step quando la frase dichiara che il lavoro non sarà fatto. Sposta questa compatibilità tra le decisioni implementate oppure indica il prossimo passo concreto.',
    )).toBe(false);
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

  it('corpus #140: `per scelta` su PR body:Ln non finisce in pr-body-contract', () => {
    expect(bucketFinding(
      'PR body:L16: 🔴 Important: `Stato: per scelta` (ripetuto anche a `PR body:L18`) non è un piano di completamento valido per `## Non implementato (ancora)`; sostituisci ciascuna voce con `in questa PR`, `PR concatenata #N` o `blocked: <causa esterna reale>`, oppure rimuovila dalla sezione.',
    )).not.toBe('pr-body-contract');
  });

  it('corpus #1521 🟡: false-claim in ## Implementato resta pr-body-contract', () => {
    expect(bucketFinding(
      'PR body:L3: 🟡 Nit: `## Implementato` dichiara la sincronizzazione di 24 workflow, sette observer e 32 baseline, ma il bundle code-only contiene una sola modifica di workflow e due entry di baseline oltre al contratto; allinea il resoconto a ciò che questa PR modifica — deferred, non funnel-critical.',
    )).toBe('pr-body-contract');
  });
});

describe('isGenuineSiblingClassViolation — conta solo il sibling non-sweepato, non affermazioni/falsi-positivi (#3325)', () => {
  it('sibling non toccato con lo stesso anti-pattern → violazione (contabile, es. #3317)', () => {
    expect(isGenuineSiblingClassViolation(
      '🔴 Important: stesso anti-pattern `.slice(0, 20)` keep-oldest cap-trim non-journalizzato che questa PR ha appena fixato resta intatto in 7 crawler company-specific attivi, non toccato da questa PR né dichiarato in `## Non implementato`.',
    )).toBe(true);
  });

  it('nit di divergenza dal sibling anche se "deferred" resta violazione genuina (AGENTS.md #8 abolisce deferral-as-closure, es. #3312)', () => {
    expect(isGenuineSiblingClassViolation(
      '🟡 Nit: pre-flight is awaited inline per-payload, unlike the sibling events poster which batches all checks upfront via Promise.allSettled — deferred, non funnel-critical.',
    )).toBe(true);
  });

  it('affermazione "nessun 🔴/🟡 da propagare" → NON violazione, anche coi glifi emoji letterali (#3319)', () => {
    expect(isGenuineSiblingClassViolation(
      'Cross-file (sticky sibling-check): condividono token ma non replicano il pattern cap-check-con-auto-esclusione fixato qui — nessun 🔴/🟡 da propagare.',
    )).toBe(false);
  });

  it('affermazione "correctly mirrors the sibling ... no inconsistency" → NON violazione (es. #3267)', () => {
    expect(isGenuineSiblingClassViolation(
      'isSystemicBoilerplateFailure correctly mirrors the sibling floor — ratio AND count AND total-eligible, not ratio alone. No inconsistency, not a candidate for the same split.',
    )).toBe(false);
  });

  it('falso positivo dichiarato esplicitamente (AGENTS.md #6: lessicalmente simile, semanticamente diverso) → NON violazione', () => {
    expect(isGenuineSiblingClassViolation(
      '🟡 Nit: il costrutto è solo lessicalmente simile ma semanticamente diverso — falso positivo, non è lo stesso anti-pattern del sibling.',
    )).toBe(false);
  });

  it('vocabolario sibling senza affermazione né falso-positivo dichiarato → conservativo: violazione', () => {
    expect(isGenuineSiblingClassViolation('🟡 sibling non toccato, verificare a mano')).toBe(true);
  });

  it('"non è un falso positivo" (rifiuto esplicito) → resta violazione genuina (issue #3367)', () => {
    expect(isGenuineSiblingClassViolation(
      '🔴 Important: non è un falso positivo, il sibling condivide lo stesso bug non sweepato.',
    )).toBe(true);
  });
});

describe('bucketFinding — sibling-class-fix scarta i falsi positivi (#3325)', () => {
  it('violazione genuina di sibling non-sweepato resta sibling-class-fix', () => {
    expect(bucketFinding(
      '🔴 Important: stesso anti-pattern non toccato, resta intatto nei 7 crawler sibling',
    )).toBe('sibling-class-fix');
  });

  it('affermazione con emoji-come-parola non finisce in sibling-class-fix', () => {
    const b = bucketFinding(
      'Cross-file (sticky sibling-check): non replicano il pattern fixato qui — nessun 🔴/🟡 da propagare.',
    );
    expect(b).not.toBe('sibling-class-fix');
  });
});
