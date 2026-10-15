/**
 * run-budget — guard di budget riusabile dei loop CI per-item (#5162/#5145/#5144).
 *
 * I tre timeout venivano dal Checkout, non dal lavoro: il job moriva con lo
 * script mai partito, oppure lo faceva partire al minuto 14 di 15. Questo modulo
 * è il numero che mancava — quanto tempo resta DAVVERO alla fase di lavoro — e i
 * test qui sotto fissano le tre proprietà su cui si regge:
 *   1. non si COMINCIA un item che non si farebbe in tempo a FINIRE
 *      (il danno vero non è il run rosso, è la PR lasciata chiusa fra
 *      `gh pr close` e `gh pr reopen`);
 *   2. ciò che non è stato lavorato viene DETTO, mai capato in silenzio;
 *   3. senza deadline il guard è trasparente — non deve poter diventare lui
 *      stesso una nuova modalità di fallimento.
 */
import { describe, it, expect } from 'vitest';
import {
  createRunBudget,
  runBudgetFromEnv,
  rotateForFairness,
  DEADLINE_ENV,
} from '../scripts/ci/lib/run-budget.mjs';

/** Clock fisso iniettabile: i test non devono dipendere dal tempo reale. */
const at = (ms: number) => () => ms;

describe('createRunBudget — non cominciare ciò che non si può finire', () => {
  it('take() concede finché il costo dell item sta nel tempo residuo', () => {
    // deadline fra 60s, riserva 10s → 50s utilizzabili; item da 20s.
    const b = createRunBudget({ deadlineEpochMs: 60_000, reserveMs: 10_000, now: at(0) });
    expect(b.remainingMs()).toBe(50_000);
    expect(b.take('a', 20_000)).toBe(true);
    expect(b.take('b', 20_000)).toBe(true);
  });

  it('take() NEGA quando il tempo residuo non copre il costo dell item', () => {
    // 50s utilizzabili, ma l item ne chiede 60 → non si comincia proprio.
    const b = createRunBudget({ deadlineEpochMs: 60_000, reserveMs: 10_000, now: at(0) });
    expect(b.take('troppo-grosso', 60_000)).toBe(false);
    expect(b.summary().deferred).toEqual(['troppo-grosso']);
    expect(b.summary().processed).toBe(0);
  });

  it('REGRESSIONE #5145: la sezione critica close+reopen non si apre a ridosso della deadline', () => {
    // Lo script parte al minuto 14 di 15 (il Checkout si è preso il resto):
    // restano 60s, la coppia close+reopen ne dichiara 20 ma la riserva è 30 →
    // 30s utilizzabili. canAfford deve dire NO: meglio non toccare la PR che
    // lasciarla chiusa senza nessuno che la riapra.
    const b = createRunBudget({ deadlineEpochMs: 60_000, reserveMs: 30_000, now: at(0) });
    expect(b.remainingMs()).toBe(30_000);
    expect(b.canAfford(20_000)).toBe(true);

    // Un istante dopo, con soli 15s utilizzabili, la coppia non si apre più.
    const tight = createRunBudget({ deadlineEpochMs: 45_000, reserveMs: 30_000, now: at(0) });
    expect(tight.canAfford(20_000)).toBe(false);
  });

  it('la riserva è tempo intoccabile: expired() scatta PRIMA della deadline vera', () => {
    // A 40s dalla deadline con 30s di riserva restano 10s: non scaduto.
    expect(createRunBudget({ deadlineEpochMs: 40_000, reserveMs: 30_000, now: at(0) }).expired()).toBe(false);
    // A 30s dalla deadline la riserva è tutto ciò che rimane: scaduto.
    expect(createRunBudget({ deadlineEpochMs: 30_000, reserveMs: 30_000, now: at(0) }).expired()).toBe(true);
    // Oltre la deadline: scaduto.
    expect(createRunBudget({ deadlineEpochMs: 10_000, reserveMs: 30_000, now: at(0) }).expired()).toBe(true);
  });

  it('il tempo che scorre chiude il budget a metà loop (item dopo il primo rimandati)', () => {
    let clock = 0;
    const b = createRunBudget({ deadlineEpochMs: 100_000, reserveMs: 10_000, now: () => clock });
    expect(b.take('primo', 40_000)).toBe(true);
    clock = 50_000; // il primo item ha consumato 50s → restano 40s utilizzabili
    expect(b.take('secondo', 40_000)).toBe(true);
    clock = 95_000; // ne restano -5 → il terzo non si comincia
    expect(b.take('terzo', 40_000)).toBe(false);
    expect(b.summary().deferred).toEqual(['terzo']);
  });
});

describe('createRunBudget — no silent cap (AGENTS.md)', () => {
  it('report() elenca gli item rimandati con la promessa del prossimo tick', () => {
    const b = createRunBudget({ deadlineEpochMs: 0, reserveMs: 0, now: at(0) });
    b.take('#101', 1);
    b.take('#102', 1);
    const lines: string[] = [];
    b.report((m: string) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('::notice::');
    expect(lines[0]).toContain('#101');
    expect(lines[0]).toContain('#102');
    expect(lines[0]).toContain('prossimo tick');
  });

  it('report() tace quando non è stato rimandato nulla (niente rumore sui run puliti)', () => {
    const b = createRunBudget({ deadlineEpochMs: 60_000, reserveMs: 0, now: at(0) });
    b.take('#1', 1);
    const lines: string[] = [];
    b.report((m: string) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it('defer() registra anche gli item saltati per ragioni diverse dal budget', () => {
    const b = createRunBudget({ deadlineEpochMs: 60_000, reserveMs: 0, now: at(0) });
    b.defer('#7 (close+reopen)');
    expect(b.summary().deferred).toEqual(['#7 (close+reopen)']);
  });
});

describe('runBudgetFromEnv — disabilitato = trasparente', () => {
  it('senza env la deadline è assente e ogni item passa (comportamento pre-fix)', () => {
    const b = runBudgetFromEnv({ env: {} as NodeJS.ProcessEnv });
    expect(b.enabled).toBe(false);
    expect(b.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(b.expired()).toBe(false);
    expect(b.canAfford(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(b.take('qualunque', 10 ** 9)).toBe(true);
  });

  it('env non numerica o non positiva → trasparente (mai un guard che rompe da solo)', () => {
    for (const bad of ['', 'nope', '0', '-5']) {
      const b = runBudgetFromEnv({ env: { [DEADLINE_ENV]: bad } as NodeJS.ProcessEnv });
      expect(b.enabled).toBe(false);
      expect(b.take('x', 10 ** 9)).toBe(true);
    }
  });

  it("l'env è in SECONDI e viene convertita in ms", () => {
    // deadline = epoch 1000s = 1_000_000ms; ora = 900_000ms; riserva 0 → 100s.
    const b = runBudgetFromEnv({
      env: { [DEADLINE_ENV]: '1000' } as NodeJS.ProcessEnv,
      reserveMs: 0,
      now: at(900_000),
    });
    expect(b.enabled).toBe(true);
    expect(b.remainingMs()).toBe(100_000);
  });
});

describe('rotateForFairness — un item lento non sequestra il turno degli altri', () => {
  it('ruota la testa in base al numero di run', () => {
    const prs = [1, 2, 3, 4];
    expect(rotateForFairness(prs, 0)).toEqual([1, 2, 3, 4]);
    expect(rotateForFairness(prs, 1)).toEqual([2, 3, 4, 1]);
    expect(rotateForFairness(prs, 2)).toEqual([3, 4, 1, 2]);
    expect(rotateForFairness(prs, 5)).toEqual([2, 3, 4, 1]); // wrap-around
  });

  it('REGRESSIONE #5145: su N run ogni item passa dalla testa almeno una volta', () => {
    // È la proprietà che rende impossibile la starvation: con un cap che taglia
    // sempre la coda della lista, senza rotazione gli ultimi non sarebbero mai
    // valutati.
    const prs = [10, 20, 30, 40, 50];
    const heads = new Set(prs.map((_, run) => rotateForFairness(prs, run)[0]));
    expect(heads).toEqual(new Set(prs));
  });

  it('conserva tutti gli elementi, senza perdite né duplicati', () => {
    const prs = [1, 2, 3, 4, 5, 6, 7];
    const rotated = rotateForFairness(prs, 3);
    expect([...rotated].sort((a, b) => a - b)).toEqual(prs);
  });

  it('liste 0/1 elemento e run number non valido → identità (nessuna sorpresa)', () => {
    expect(rotateForFairness([], 3)).toEqual([]);
    expect(rotateForFairness([9], 3)).toEqual([9]);
    expect(rotateForFairness([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    expect(rotateForFairness([1, 2, 3], 'abc')).toEqual([1, 2, 3]);
    expect(rotateForFairness([1, 2, 3], -1)).toEqual([1, 2, 3]);
  });

  it('non muta la lista originale (il chiamante la riusa per i log)', () => {
    const prs = [1, 2, 3];
    rotateForFairness(prs, 2);
    expect(prs).toEqual([1, 2, 3]);
  });
});
