/**
 * followup-drainer — quante run `issue-fix` possono essere vive insieme.
 *
 * ## Cosa cambia, e perché serviva un test proprio
 *
 * Il tetto era `if (inflight > 0) return` più un `return` dopo la prima
 * promozione: un MUTEX hard-coded, non un cap. Con una mediana di 25 min per run
 * e il tick di 20 min del drainer, il soffitto teorico era ~32 fix/giorno, ma
 * l'osservato era ~13 — cioè lo slot singolo era davvero il vincolo, non un
 * limite teorico lontano.
 *
 * Dal 2026-09-04 il tetto è `FOLLOWUP_MAX_INFLIGHT_FIX` (default 3) e il drain
 * riempie gli slot liberi invece di promuovere sempre uno solo.
 *
 * Dal 2026-09-05 quel numero non è più libero: viene CLAMPATO a `fixQueueDepth()`,
 * la profondità reale della coda di `issue-fix.yml`. Il `concurrency` di quel
 * workflow ha un `group:` costante, quindi la profondità è 1 e ogni promozione
 * oltre la prima non riempie uno slot — sfratta la pending precedente, che
 * muore `cancelled` senza posare un `FIX_OUTCOME`, e il RESCUE le addebita un
 * `fu-attempt` per una run mai partita. Misurato sul sito: 823 run `cancelled`
 * il 09-04 (cap 3) contro 31 il 09-03 (cap 1), e 88 issue `fu-parked` senza un
 * solo commento di verdetto, 84 delle quali parcheggiate il 09-04.
 *
 * Le attese qui sotto sono quindi sul comportamento CLAMPATO (1 promozione per
 * tick, come prima del 09-04); i casi che provano la lettura del numero
 * richiesto — kill-switch, valori fuori range, refusi — restano, perché è quel
 * numero a tornare in gioco appena il gruppo di `issue-fix.yml` diventa
 * per-issue.
 *
 * `followup-drainer-dry-run-preview.test.ts` prova il GUARD (cosa succede a slot
 * pieni) e fissa il cap a 1 per farlo; questo file prova il CAP — che il numero
 * di promozioni segua gli slot liberi, in entrambe le direzioni.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const REPO = 'o/r';
const BODY_OK =
  '## Origine\n\nQualcosa di reale qui — testo abbastanza lungo da superare la '
  + 'soglia dei 50 caratteri che il detector di body malformati richiede.';

function queuedIssue(n: number) {
  return {
    number: n,
    title: `Some queued follow-up ${n}`,
    labels: [{ name: 'agent:fix-queued' }],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/** `queuedRuns` run in volo simulate, `candidates` issue pronte in coda. */
function makeDispatch(queuedRuns: number, candidates: number) {
  const issues = Array.from({ length: candidates }, (_, i) => queuedIssue(9001 + i));
  return function ghDispatch(_cmd: string, args: string[]): string {
    const a = args || [];
    if (a[0] === 'run' && a[1] === 'list') {
      const statusIdx = a.indexOf('--status');
      const status = statusIdx >= 0 ? a[statusIdx + 1] : '';
      return status === 'queued'
        ? JSON.stringify(Array.from({ length: queuedRuns }, (_, i) => ({ databaseId: i + 1 })))
        : '[]';
    }
    if (a[0] === 'issue' && a[1] === 'list') {
      const labelIdx = a.indexOf('--label');
      const label = labelIdx >= 0 ? a[labelIdx + 1] : null;
      if (label === 'agent:fix-queued') return JSON.stringify(issues);
      return '[]';
    }
    if (a[0] === 'issue' && a[1] === 'view') {
      if (a.includes('comments')) return JSON.stringify({ comments: [] });
      if (a.includes('body')) return JSON.stringify({ body: BODY_OK });
      return JSON.stringify({});
    }
    if (a[0] === 'pr' && a[1] === 'list') return '[]';
    return '[]';
  };
}

async function runDrainCapturingLogs(): Promise<string[]> {
  vi.resetModules();
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    lines.push(String(msg));
  });
  try {
    const mod = await import('../scripts/ci/followup-drainer.mjs');
    (mod as { runDrain: () => void }).runDrain();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const promotions = (lines: string[]) => lines.filter((l) => l.startsWith('PROMUOVO #'));

beforeEach(() => {
  execFileSync.mockReset();
  process.env.GITHUB_REPOSITORY = REPO;
  delete process.env.FOLLOWUP_MAX_INFLIGHT_FIX;
});

describe('cap delle run issue-fix in volo', () => {
  it('col default promuove UNA sola issue per tick: il cap è clampato alla coda reale', async () => {
    // Il default richiesto resta 3, ma `issue-fix.yml` tiene una sola pending:
    // la seconda e la terza promozione dello stesso tick non sarebbero lavoro
    // in più, sarebbero due `agent:fix` le cui run muoiono `cancelled` a 0 min.
    execFileSync.mockImplementation(makeDispatch(0, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(1);
  });

  it('dice nel log che ha clampato, e perché: il clamp non è silenzioso', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 5));
    const lines = await runDrainCapturingLogs();
    expect(lines.some((l) => l.includes('cap issue-fix richiesto 3 → clampato a 1'))).toBe(true);
  });

  it('con 1 run già viva non promuove niente e lo dice col numero', async () => {
    execFileSync.mockImplementation(makeDispatch(1, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(0);
    expect(lines.some((l) => l.includes('in-flight=1/1'))).toBe(true);
  });

  it('non promuove più candidati di quanti ne abbia in coda', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 1));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(1);
  });

  it('KILL-SWITCH: FOLLOWUP_MAX_INFLIGHT_FIX=1 ripristina il mutex di prima', async () => {
    process.env.FOLLOWUP_MAX_INFLIGHT_FIX = '1';
    execFileSync.mockImplementation(makeDispatch(0, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(1);
  });

  it('un valore fuori range viene portato a 1, non a «nessun limite»', async () => {
    // `0` e i negativi sono una richiesta esplicita di «meno di uno»: si
    // portano al minimo sensato, 1. Il verso conta — un cap che diventa 0
    // fermerebbe il ciclo, un cap che diventa infinito lo farebbe esplodere.
    for (const v of ['0', '-5']) {
      process.env.FOLLOWUP_MAX_INFLIGHT_FIX = v;
      execFileSync.mockImplementation(makeDispatch(0, 5));
      expect(promotions(await runDrainCapturingLogs()), `cap=${v}`).toHaveLength(1);
    }
  });

  it('un valore NON NUMERICO ricade sul default, e soprattutto non disarma il cap', async () => {
    // Il verso sbagliato in cui sbagliare: con `Math.max(1, Number('nonsense'))`
    // il cap diventava `NaN`, ogni confronto con NaN e' falso, e il drain
    // avrebbe promosso l'INTERA coda in un tick. Un refuso in env non deve
    // togliere il tetto: si comporta come se la variabile non ci fosse.
    process.env.FOLLOWUP_MAX_INFLIGHT_FIX = 'nonsense';
    execFileSync.mockImplementation(makeDispatch(0, 9));
    const lines = await runDrainCapturingLogs();
    // Default 3, poi clampato a 1 dalla profondità della coda: il punto del
    // caso è che NON diventa «nessun limite», non il numero esatto.
    expect(promotions(lines)).toHaveLength(1);
    expect(promotions(lines).length).toBeLessThan(9);
  });

  it('con run vive i RESCUE non girano: l\'invariante che il loro codice assume e\' inflight===0', async () => {
    // Finding Important della review su #7300. Il codice dei rescue dice
    // testualmente «inFlightFixCount() in cima ha gia' garantito che NESSUNA
    // run e' queued/in_progress»: era vero col mutex, falso col cap. Una issue
    // `agent:fix` con la run VIVA da 35 min e senza PR ha outcome null e non e'
    // piu' in settling (35 > SETTLE_MIN), quindi supera ORPHAN_MIN_AGE_MIN=30 e
    // verrebbe classificata orfana — tentativo consumato mentre il fix lavora,
    // e una seconda run sulla stessa issue al tick dopo. Il p90 misurato dei
    // run e' 37 min, sopra la soglia: non e' un caso di laboratorio.
    //
    // Col clamp a `fixQueueDepth()` quella finestra si chiude a monte: con
    // `MAX_INFLIGHT_FIX === 1`, `inflight > 0` implica `freeSlots === 0` e il
    // drain esce PRIMA del blocco dei rescue. L'invariante `inflight === 0` per
    // i rescue vale quindi per costruzione, e non piu' per una guardia
    // aggiunta a valle. Il caso resta a sorvegliare proprio questo: se qualcuno
    // toglie il clamp, il drain arriva ai rescue con una run viva e questa
    // riga cade.
    execFileSync.mockImplementation(makeDispatch(1, 2));
    const lines = await runDrainCapturingLogs();
    expect(lines.some((l) => l.includes('slot issue-fix occupati (in-flight=1/1)'))).toBe(true);
    expect(promotions(lines)).toHaveLength(0);
  });

  it('a slot liberi i rescue girano come sempre', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 2));
    const lines = await runDrainCapturingLogs();
    expect(lines.some((l) => l.includes('rescue orfani/crawler saltati'))).toBe(false);
  });

  it('la riga finale non contraddice le promozioni appena stampate', async () => {
    // La riga «niente da promuovere» non deve mai comparire sotto i
    // `PROMUOVO #N` dello stesso tick: e' la telemetria con cui si giudica il
    // cap, e se si contraddice non serve a niente. Col cap clampato a 1 la riga
    // finale e' quella degli slot pieni, e dice lo stesso numero delle
    // promozioni stampate sopra.
    execFileSync.mockImplementation(makeDispatch(0, 2));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(1);
    expect(lines.some((l) => l.includes('niente da promuovere'))).toBe(false);
    expect(lines.some((l) => l.includes('slot riempiti (1/1 liberi su cap 1)'))).toBe(true);
  });

  it('senza candidati la riga «niente da promuovere» resta', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 0));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(0);
    expect(lines.some((l) => l.includes('niente da promuovere'))).toBe(true);
  });
});
