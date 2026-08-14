/**
 * followup-drainer — `--dry-run` deve riportare una preview anche a slot
 * issue-fix occupato (#5524 item 2).
 *
 * Prima della fix, il guard `inFlightFixCount() > 0 -> return` (in cima a
 * RESCUE+PARK / CRAWLER RESCUE / DRAIN) usciva PRIMA di ogni ramo che stampa
 * "cosa farei" — quei tre blocchi stanno tutti SOTTO quella riga. Un
 * `--dry-run` lanciato mentre issue-fix sta girando produceva solo la riga
 * generica "slot occupato" e usciva: chi lo lancia per capire cosa
 * succederebbe non otteneva risposta, indistinguibile da "non ha nemmeno
 * guardato". La fix fa proseguire SOLO il ramo `--dry-run` (nessuna mutazione
 * da proteggere: `edit()` e ogni `if (DRY)` sotto sono già no-op), mentre il
 * ramo reale continua a fermarsi lì — è l'invariante di sicurezza che il
 * commento sopra il guard spiega (il rescue non deve mai toccare la issue di
 * una run viva).
 *
 * Mocka `gh` via `node:child_process` (stesso pattern di
 * tests/github-issue-creator-gate.test.ts) e chiama `runDrain()` esportata
 * direttamente, invece di spawnare un processo — più veloce e permette di
 * confrontare `--dry-run` con la modalità reale nello stesso file
 * re-importando il modulo con `vi.resetModules()` (`DRY`/`REPO` sono `const`
 * fissate al primo import, quindi vanno ri-valutate ad ogni scenario).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const REPO = 'o/r';

// Un solo candidato in coda, con un body abbastanza sostanzioso da non
// finire parcheggiato dai pre-flight (malformed-body/network-audit/epic/
// backlog) e senza path di codice citati (nessuna chiamata `pr list` extra
// per l'overlap-check).
const QUEUED_ISSUE = {
  number: 9001,
  title: 'Some queued follow-up',
  labels: [{ name: 'agent:fix-queued' }],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};
const BODY_OK =
  '## Origine\n\nQualcosa di reale qui — testo abbastanza lungo da superare la ' +
  'soglia dei 50 caratteri che il detector di body malformati richiede.';

/** Instrada ogni chiamata `gh` simulata: slot occupato (1 run queued), tutte
 * le altre liste vuote tranne `agent:fix-queued` (un candidato pronto). */
function ghDispatch(_cmd: string, args: string[]): string {
  const a = args || [];
  if (a[0] === 'run' && a[1] === 'list') {
    const statusIdx = a.indexOf('--status');
    const status = statusIdx >= 0 ? a[statusIdx + 1] : '';
    return status === 'queued' ? JSON.stringify([{ databaseId: 1 }]) : '[]';
  }
  if (a[0] === 'issue' && a[1] === 'list') {
    const labelIdx = a.indexOf('--label');
    const label = labelIdx >= 0 ? a[labelIdx + 1] : null;
    if (label === 'agent:fix-queued') return JSON.stringify([QUEUED_ISSUE]);
    return '[]'; // fu-parked, agent:fix, e il listAllOpenIssues() dell'age-out
  }
  if (a[0] === 'issue' && a[1] === 'view') {
    if (a.includes('comments')) return JSON.stringify({ comments: [] });
    if (a.includes('body')) return JSON.stringify({ body: BODY_OK });
    return JSON.stringify({});
  }
  if (a[0] === 'pr' && a[1] === 'list') return '[]';
  return '[]';
}

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation(ghDispatch);
  process.env.GITHUB_REPOSITORY = REPO;
});

/** Re-importa il modulo con `process.argv` esteso di `extraArgv` (il modulo
 * fissa `DRY`/`REPO` come `const` al primo import), esegue `runDrain()` e
 * cattura ogni riga passata a `console.log`. Non tocca `argv[1]`: la guardia
 * CLI (`process.argv[1]?.endsWith('followup-drainer.mjs')`) resta falsa, così
 * `main()` non parte da solo e l'unica esecuzione è quella esplicita qui sotto. */
async function runDrainCapturingLogs(extraArgv: string[]): Promise<string[]> {
  vi.resetModules();
  const prevArgv = process.argv;
  process.argv = [...prevArgv, ...extraArgv];
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    lines.push(String(msg));
  });
  try {
    const mod = await import('../scripts/ci/followup-drainer.mjs');
    (mod as { runDrain: () => void }).runDrain();
  } finally {
    spy.mockRestore();
    process.argv = prevArgv;
  }
  return lines;
}

describe('followup-drainer --dry-run a slot occupato (#5524 item 2)', () => {
  it('stampa una preview ipotetica anche quando lo slot issue-fix è occupato', async () => {
    const lines = await runDrainCapturingLogs(['--dry-run']);
    expect(lines.some((l) => l.includes('slot issue-fix occupato'))).toBe(true);
    // La preview è la parte che prima non usciva mai: il candidato in coda
    // viene mostrato come se lo slot fosse libero, marcato `[dry]`/PROMUOVO.
    expect(lines.some((l) => l.includes('PROMUOVO #9001'))).toBe(true);
    expect(lines.some((l) => l.includes('[dry] edit #9001'))).toBe(true);
    // Non deve dire "nessuna azione" mentre mostra sotto esattamente un'azione.
    expect(lines.some((l) => l.includes('nessuna azione'))).toBe(false);
  });

  it('in modalità reale il guard resta un muro: nessuna preview, nessuna mutazione tentata', async () => {
    const lines = await runDrainCapturingLogs([]);
    expect(lines.some((l) => l.includes('slot issue-fix occupato (in-flight=1) → nessuna azione.'))).toBe(true);
    // L'invariante di sicurezza del guard (mai toccare la issue di una run
    // viva) resta intatta: niente di quello che sta sotto il return è girato.
    expect(lines.some((l) => l.includes('PROMUOVO'))).toBe(false);
    // Solo l'header ("followup-drainer repo=…") e la riga del guard: nient'altro
    // gira dopo il `return` in modalità reale.
    expect(lines).toEqual(['followup-drainer repo=o/r', 'slot issue-fix occupato (in-flight=1) → nessuna azione.']);
  });
});
