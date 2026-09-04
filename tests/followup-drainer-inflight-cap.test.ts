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
  it('col default promuove fino a 3 quando lo slot è vuoto e la coda è lunga', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(3);
  });

  it('con 1 run già viva ne promuove 2, non 3: conta gli slot LIBERI', async () => {
    execFileSync.mockImplementation(makeDispatch(1, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(2);
  });

  it('a cap raggiunto non promuove niente e lo dice col numero', async () => {
    execFileSync.mockImplementation(makeDispatch(3, 5));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(0);
    expect(lines.some((l) => l.includes('in-flight=3/3'))).toBe(true);
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
    expect(promotions(lines)).toHaveLength(3);
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
    execFileSync.mockImplementation(makeDispatch(1, 2));
    const lines = await runDrainCapturingLogs();
    expect(lines.some((l) => l.includes('rescue orfani/crawler saltati: 1 run issue-fix vive'))).toBe(true);
    // Il drain, che quell'assunzione non ce l'ha, continua a lavorare.
    expect(promotions(lines).length).toBeGreaterThan(0);
  });

  it('a slot liberi i rescue girano come sempre', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 2));
    const lines = await runDrainCapturingLogs();
    expect(lines.some((l) => l.includes('rescue orfani/crawler saltati'))).toBe(false);
  });

  it('la riga finale non contraddice le promozioni appena stampate', async () => {
    // Con cap > 1 il ciclo puo' esaurire la coda DOPO aver promosso: la riga
    // «niente da promuovere» compariva sotto i `PROMUOVO #N` dello stesso tick.
    execFileSync.mockImplementation(makeDispatch(0, 2));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(2);
    expect(lines.some((l) => l.includes('niente da promuovere'))).toBe(false);
    expect(lines.some((l) => l.includes('coda esaurita dopo 2 promozione/i'))).toBe(true);
  });

  it('senza candidati la riga «niente da promuovere» resta', async () => {
    execFileSync.mockImplementation(makeDispatch(0, 0));
    const lines = await runDrainCapturingLogs();
    expect(promotions(lines)).toHaveLength(0);
    expect(lines.some((l) => l.includes('niente da promuovere'))).toBe(true);
  });
});
