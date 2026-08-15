/**
 * Il close+reopen di pr-autorebase (`reopenToRetrigger`) è un re-trigger
 * deterministico: chiude e riapre la PR ~2s dopo perché l'evento `reopened`
 * fa ripartire pr-review-loop e tests.yml. Il call-site post-rebase lo invoca
 * ogni volta che manca l'`## LGTM`.
 *
 * Il 2026-08-14/15 questo ha prodotto un loop che non poteva convergere: con
 * `vitest (unit + integration)` in FAILURE per un motivo suo, pr-review-loop
 * non parte (gira solo su `tests` success) → nessuna review → nessun LGTM →
 * `!lgtm` resta vero → il tick dopo riapre di nuovo. Misurato in ~8h:
 *   #5896  12 riaperture, 89 run di CI (23 di `tests`)
 *   #5906  10 riaperture, 77 run di CI (19 di `tests`)
 * cioè 166 run su 300 di TUTTO il repo — 55% della CI consumata da due PR che
 * per costruzione non potevano mergiare, su una coda serializzata.
 *
 * Questo file fissa le tre invarianti della fix, più le due che la rendono
 * qualcosa di diverso da una guardia che esiste e non guarda.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decideReopen,
  decideNeedsHumanPass,
  reopenFingerprint,
  parseReopenBudget,
  renderReopenBudget,
  DEFAULT_MAX_REOPENS,
} from '../scripts/ci/lib/reopen-breaker.mjs';

const script = readFileSync(resolve('scripts/ci/pr-autorebase.mjs'), 'utf8');

/** Stato di una PR ferma e VERDE (il caso in cui il riciclo ha senso). */
const green = {
  additions: 40, deletions: 3, changedFiles: 2,
  vitestConclusion: 'success', reviewCount: 0,
};

describe('precondizione: non riciclare ciò che il riciclo non può riparare', () => {
  it('check richiesto in FAILURE → NON si ricicla, mai', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideReopen({ vitestConclusion: 'failure', fingerprint: fp, prior: null });
    expect(d.action).toBe('skip-failing-check');
  });

  it('e non si ricicla nemmeno al primo giro, con contatore vergine', () => {
    // La precondizione deve battere il budget: se valesse solo DOPO N giri,
    // ogni PR rossa pagherebbe comunque N vitest da ~18min prima di fermarsi.
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    for (const prior of [null, { count: 0, fingerprint: fp }]) {
      expect(decideReopen({ vitestConclusion: 'failure', fingerprint: fp, prior }).action)
        .toBe('skip-failing-check');
    }
  });

  it('una CANCELLAZIONE da concurrency NON è un failure: la PR resta riciclabile', () => {
    // Il chiamante normalizza il verdetto transient. Se lo trattassimo come
    // rosso bloccheremmo PR sane — l'errore opposto, e altrettanto caro.
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'transient' });
    expect(decideReopen({ vitestConclusion: 'transient', fingerprint: fp, prior: null }).action)
      .toBe('reopen');
  });
});

describe('breaker: una PR verde e ferma si ricicla, ma non più di N volte', () => {
  it(`si ferma dopo ${DEFAULT_MAX_REOPENS} riaperture sullo stesso stato`, () => {
    const fp = reopenFingerprint(green);
    let prior: { count: number; fingerprint: string } | null = null;
    const actions: string[] = [];
    // 8 tick sullo STESSO stato: il loop reale girava ~ogni 30-60 minuti.
    for (let tick = 0; tick < 8; tick++) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: fp, prior });
      actions.push(d.action);
      prior = { count: d.count, fingerprint: fp };
    }
    expect(actions.filter((a) => a === 'reopen')).toHaveLength(DEFAULT_MAX_REOPENS);
    // Tutto ciò che segue è definitivamente fermo: nessun risveglio spontaneo.
    expect(actions.slice(DEFAULT_MAX_REOPENS).every((a) => a === 'skip-breaker')).toBe(true);
  });

  it('il tetto è configurabile e viene rispettato', () => {
    const fp = reopenFingerprint(green);
    let prior: { count: number; fingerprint: string } | null = null;
    let reopens = 0;
    for (let tick = 0; tick < 10; tick++) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: fp, prior, max: 2 });
      if (d.action === 'reopen') reopens++;
      prior = { count: d.count, fingerprint: fp };
    }
    expect(reopens).toBe(2);
  });
});

describe('il contatore si azzera quando lo stato cambia DAVVERO', () => {
  it('un commit nuovo rimette la PR in gioco', () => {
    const before = reopenFingerprint(green);
    const exhausted = { count: DEFAULT_MAX_REOPENS, fingerprint: before };
    expect(decideReopen({ vitestConclusion: 'success', fingerprint: before, prior: exhausted }).action)
      .toBe('skip-breaker');
    // Nuovo lavoro: il contributo proprio della PR cambia.
    const after = reopenFingerprint({ ...green, additions: 57, changedFiles: 3 });
    const d = decideReopen({ vitestConclusion: 'success', fingerprint: after, prior: exhausted });
    expect(d.action).toBe('reopen');
    expect(d.count).toBe(1); // riparte da zero, non da max
  });

  it('un check tornato verde, o una review arrivata, azzerano allo stesso modo', () => {
    const stuck = reopenFingerprint({ ...green, vitestConclusion: 'transient' });
    const exhausted = { count: DEFAULT_MAX_REOPENS, fingerprint: stuck };
    for (const changed of [
      reopenFingerprint({ ...green, vitestConclusion: 'success' }),
      reopenFingerprint({ ...green, vitestConclusion: 'transient', reviewCount: 1 }),
    ]) {
      const d = decideReopen({ vitestConclusion: 'success', fingerprint: changed, prior: exhausted });
      expect(d.action).toBe('reopen');
      expect(d.count).toBe(1);
    }
  });

  it("REGRESSIONE: un merge di solo main NON azzera il contatore", () => {
    // LA trappola di questa fix. pr-autorebase pusha un merge commit di
    // `origin/main` sul branch a ogni tick, subito PRIMA di chiamare il reopen.
    // Se l'impronta dipendesse dall'head OID (o dal conteggio dei commit)
    // cambierebbe SEMPRE, il contatore ripartirebbe da 1 a ogni giro e il
    // breaker non scatterebbe MAI: guardia presente, loop intatto.
    // GitHub calcola additions/deletions/changedFiles contro la merge-base,
    // quindi un merge di solo main li lascia invariati: stessa impronta.
    const beforeMerge = reopenFingerprint(green);
    const afterMainMerge = reopenFingerprint({ ...green }); // contributo proprio invariato
    expect(afterMainMerge).toBe(beforeMerge);

    let prior: { count: number; fingerprint: string } | null = null;
    let reopens = 0;
    for (let tick = 0; tick < 8; tick++) {
      const d = decideReopen({
        vitestConclusion: 'success', fingerprint: reopenFingerprint({ ...green }), prior,
      });
      if (d.action === 'reopen') reopens++;
      prior = { count: d.count, fingerprint: reopenFingerprint({ ...green }) };
    }
    expect(reopens).toBe(DEFAULT_MAX_REOPENS); // NON 8
  });
});

describe('il contatore sopravvive al close+reopen', () => {
  it('round-trip render → parse: count e impronta si rileggono identici', () => {
    // Vive in un commento sticky sulla PR, non in una variabile di job: lo
    // script è stateless fra un run e l'altro, e un contatore in RAM muore a
    // ogni tick. Un commento sopravvive al close+reopen come una label, e a
    // differenza di una label porta un intero E l'impronta a cui si riferisce.
    const fp = reopenFingerprint(green);
    const body = renderReopenBudget({
      count: 2, max: DEFAULT_MAX_REOPENS, fingerprint: fp, action: 'reopen', reason: 'x',
    });
    expect(parseReopenBudget(body)).toEqual({ count: 2, fingerprint: fp });
  });

  it('uno stato illeggibile non blocca la PR (fail-open)', () => {
    expect(parseReopenBudget('')).toBeNull();
    expect(parseReopenBudget('nessun marker qui')).toBeNull();
    expect(parseReopenBudget('<!-- reopen-budget-state {rotto -->')).toBeNull();
  });
});

describe('needs-human: una passata sola, non 48 al giorno', () => {
  // Fermare il close+reopen lasciava in piedi la metà più cara: il ramo
  // needs-human viene DOPO `pushBranch`, quindi ogni tick del cron `*/30`
  // rebasava, pushava e lanciava la suite — 48 tick/giorno × ~18min ≈ 14,4h di
  // CI al giorno per UNA PR che aspetta una persona, su una coda serializzata.
  it('stato invariato → nessun lavoro: niente rebase, niente CI', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    const d = decideNeedsHumanPass({ fingerprint: fp, prior: { count: 0, fingerprint: fp } });
    expect(d.action).toBe('skip-idle');
  });

  it('48 tick su uno stato fermo producono ZERO passate', () => {
    const fp = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    let prior: { count: number; fingerprint: string } | null = { count: 0, fingerprint: fp };
    let passes = 0;
    for (let tick = 0; tick < 48; tick++) {
      if (decideNeedsHumanPass({ fingerprint: fp, prior }).action === 'pass') passes++;
      prior = { count: 0, fingerprint: fp };
    }
    expect(passes).toBe(0);
  });

  it('stato cambiato → UNA passata piena, poi di nuovo silenzio', () => {
    // L'intento del dispatchTests si preserva: chi arriva a guardare la PR
    // trova un risultato riferito allo stato attuale. Ma una volta, non 48.
    const stale = reopenFingerprint({ ...green, vitestConclusion: 'failure' });
    let prior: { count: number; fingerprint: string } | null = { count: 0, fingerprint: stale };
    const fresh = reopenFingerprint({ ...green, additions: 61, vitestConclusion: 'failure' });
    let passes = 0;
    for (let tick = 0; tick < 12; tick++) {
      const d = decideNeedsHumanPass({ fingerprint: fresh, prior });
      if (d.action === 'pass') passes++;
      prior = { count: 0, fingerprint: fresh }; // l'impronta si registra alla passata
    }
    expect(passes).toBe(1);
  });

  it('senza stato registrato la prima passata si fa (fail-open)', () => {
    const fp = reopenFingerprint(green);
    expect(decideNeedsHumanPass({ fingerprint: fp, prior: null }).action).toBe('pass');
  });

  it('il gate è PRIMA del rebase, non sul dispatchTests', () => {
    // Se stesse sul `dispatchTests` il costo resterebbe: il push del rebase è
    // autenticato App/PAT e ri-triggera da sé `pull_request` (#3038), quindi
    // tests.yml — e pr-review-loop, cioè quota Claude — partirebbero comunque.
    // `decideNeedsHumanPass(` con la parentesi: cercare il solo identificatore
    // trova l'IMPORT in cima al file, che precede qualunque cosa — il test
    // resterebbe verde anche col gate spostato dopo il push (verificato per
    // mutazione: senza la parentesi, M3b passava).
    const gate = script.indexOf('decideNeedsHumanPass({');
    const push = script.indexOf('const pushed = pushBranch(branch)');
    const dispatchOnNeedsHuman = script.indexOf("labels.includes('needs-human')", push);
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(push);
    expect(gate).toBeLessThan(dispatchOnNeedsHuman);
  });
});

describe("la guardia è sul percorso, non accanto ad esso", () => {
  it('nessun call-site chiama reopenToRetrigger scavalcando il breaker', () => {
    // Senza questo, aggiungere un quarto ramo che chiama direttamente
    // `reopenToRetrigger(num)` rimette in piedi il loop con tutti i test
    // sopra ancora verdi. L'unica chiamata lecita è quella DENTRO
    // `guardedReopen`, che è il posto in cui la decisione è già stata presa.
    const guardStart = script.indexOf('function guardedReopen');
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = script.indexOf('\n}', script.indexOf('return reopenToRetrigger', guardStart));
    const calls = [...script.matchAll(/\breopenToRetrigger\s*\(/g)]
      .map((m) => m.index!)
      // la definizione stessa non è una chiamata
      .filter((i) => !script.slice(Math.max(0, i - 20), i).includes('function '))
      .filter((i) => i < guardStart || i > guardEnd);
    expect(calls).toHaveLength(0);
  });

  it('la segnalazione è UNA: commento sticky, non un commento nuovo a ogni giro', () => {
    const guard = script.slice(script.indexOf('function guardedReopen'),
      script.indexOf('function readReopenBudgetBody'));
    expect(guard).toContain('upsertStickyComment');
    // `gh pr comment` diretto = un commento nuovo per tick: lo stesso difetto
    // in un'altra forma.
    expect(guard).not.toMatch(/'pr',\s*'comment'/);
    // E non si riscrive nemmeno lo sticky se il body non è cambiato.
    expect(guard).toContain('body !== next');
  });
});
