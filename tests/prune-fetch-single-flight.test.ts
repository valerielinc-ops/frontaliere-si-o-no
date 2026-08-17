import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  withSingleFlightLock,
  isLockStale,
  isProcessAlive,
  STALE_LOCK_MS,
} from '../scripts/lib/single-flight-lock.mjs';
import {
  listStaleFetchPacks,
  sweepStaleFetchPacks,
  STALE_PACK_AGE_MS,
} from '../scripts/lib/stale-fetch-pack-sweep.mjs';

// Regressione dell'incidente 2026-08-17: il SessionStart hook lanciava
// `prune-merged-worktrees.mjs --apply` detached senza guard → N sessioni agent =
// N `git fetch` concorrenti sullo stesso `.git`, nessuno completava e ognuno
// lasciava un `tmp_pack_*` abortito (38.8 GB di residui, `.git` a 55 GB).

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'single-flight-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('withSingleFlightLock', () => {
  it('esegue il lavoro e rilascia il lock', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');
    const res = withSingleFlightLock(lock, () => 'fatto');

    expect(res).toEqual({ acquired: true, value: 'fatto' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('salta il lavoro quando il lock è tenuto da un processo vivo', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');
    // Titolare vivo: il pid di questo stesso processo di test.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    let ran = false;
    const res = withSingleFlightLock(lock, () => {
      ran = true;
    });

    expect(res.acquired).toBe(false);
    expect(ran).toBe(false);
    // Il lock del titolare NON va rubato né rimosso da chi rinuncia.
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('rientra in possesso di un lock il cui titolare è morto', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');
    // pid inesistente: il caso "sessione uccisa / macchina riavviata".
    fs.writeFileSync(lock, JSON.stringify({ pid: 0x7ffffff0, startedAt: Date.now() }));

    const res = withSingleFlightLock(lock, () => 'takeover');

    expect(res).toEqual({ acquired: true, value: 'takeover' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('rientra in possesso di un lock scaduto anche se il pid risulta vivo', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_LOCK_MS - 1000 }),
    );

    expect(withSingleFlightLock(lock, () => 'scaduto').acquired).toBe(true);
  });

  it('tratta un lock corrotto come abbandonato', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');
    fs.writeFileSync(lock, 'non-json{');

    expect(withSingleFlightLock(lock, () => 'ok').acquired).toBe(true);
  });

  it('rilascia il lock anche se il lavoro lancia', () => {
    const lock = path.join(tmpDir(), 'fetch.lock');

    expect(() =>
      withSingleFlightLock(lock, () => {
        throw new Error('fetch morto');
      }),
    ).toThrow('fetch morto');
    // Un hook che muore non deve disabilitare il cleanup per sempre.
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('isLockStale / isProcessAlive', () => {
  it('considera vivo il processo corrente e morto un pid inesistente', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0x7ffffff0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('considera EPERM come processo vivo (lock di un altro utente)', () => {
    const kill = () => {
      const e = new Error('operation not permitted') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    };
    expect(isProcessAlive(1234, { kill })).toBe(true);
  });

  it('considera stale un payload senza startedAt numerico', () => {
    expect(isLockStale({ pid: process.pid })).toBe(true);
    expect(isLockStale(null)).toBe(true);
    expect(isLockStale({ pid: process.pid, startedAt: Date.now() })).toBe(false);
  });
});

// Il timeout del fetch e la scadenza del lock sono accoppiati: sono asserzioni
// statiche sul sorgente perché prune-merged-worktrees.mjs è una CLI con
// side-effect top-level (fetch + process.exit) — importarla in un test la
// eseguirebbe.
describe('accoppiamento timeout fetch ↔ scadenza lock', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'prune-merged-worktrees.mjs'),
    'utf8',
  );

  function fetchTimeoutMs(): number {
    const m = src.match(/const FETCH_TIMEOUT_MS\s*=\s*([\d_*\s]+);/);
    expect(m, 'FETCH_TIMEOUT_MS non trovato in prune-merged-worktrees.mjs').toBeTruthy();
    // eslint-disable-next-line no-new-func -- espressione numerica letterale del sorgente
    return Number(new Function(`return (${m![1].replace(/_/g, '')})`)());
  }

  it('il timeout del fetch resta sotto la scadenza del lock', () => {
    // Se si invertissero, una seconda sessione ruberebbe il lock a un titolare
    // ancora al lavoro → di nuovo fetch concorrenti sullo stesso .git.
    expect(fetchTimeoutMs()).toBeLessThan(STALE_LOCK_MS);
  });

  it('il timeout del fetch supera il catch-up più lento misurato (20 min)', () => {
    // Un timeout più corto ucciderebbe ogni tentativo di recupero di un repo
    // molto indietro: resterebbe stale per sempre, lasciando un tmp_pack_* a
    // ogni giro. Il pile-up lo impedisce il lock, non il timeout.
    expect(fetchTimeoutMs()).toBeGreaterThan(20 * 60 * 1000);
  });

  it('il fetch gira senza shell e con SIGTERM, così git ripulisce il proprio tmp_pack', () => {
    // `execSync('git fetch …')` passerebbe da `sh -c`: il segnale colpirebbe la
    // shell e il git figlio resterebbe appeso col pack temporaneo aperto.
    expect(src).toMatch(/execFileSync\('git', \['fetch'/);
    expect(src).not.toMatch(/execSync\(`git fetch/);
    // SIGKILL non lascerebbe a git il tempo di rimuovere il temporaneo.
    expect(src).toMatch(/killSignal: 'SIGTERM'/);
    expect(src).not.toMatch(/killSignal: 'SIGKILL'/);
  });
});

describe('listStaleFetchPacks', () => {
  function packDirWith(files: Array<{ name: string; ageMs: number; bytes?: number }>): string {
    const dir = tmpDir();
    for (const f of files) {
      const p = path.join(dir, f.name);
      fs.writeFileSync(p, Buffer.alloc(f.bytes ?? 8));
      const when = new Date(Date.now() - f.ageMs);
      fs.utimesSync(p, when, when);
    }
    return dir;
  }

  it('seleziona solo i tmp_pack_* più vecchi della soglia', () => {
    const dir = packDirWith([
      { name: 'tmp_pack_OLD', ageMs: STALE_PACK_AGE_MS + 60_000 },
      { name: 'tmp_pack_FRESH', ageMs: 5_000 },
    ]);

    const stale = listStaleFetchPacks(dir).map((s) => path.basename(s.path));

    expect(stale).toEqual(['tmp_pack_OLD']);
  });

  it('non tocca MAI i pack reali, per vecchi che siano', () => {
    const dir = packDirWith([
      { name: 'pack-abc123.pack', ageMs: STALE_PACK_AGE_MS * 100 },
      { name: 'pack-abc123.idx', ageMs: STALE_PACK_AGE_MS * 100 },
      { name: 'multi-pack-index', ageMs: STALE_PACK_AGE_MS * 100 },
    ]);

    expect(listStaleFetchPacks(dir)).toEqual([]);
  });

  it('ritorna [] su pack dir inesistente invece di lanciare', () => {
    expect(listStaleFetchPacks(path.join(tmpDir(), 'assente'))).toEqual([]);
  });

  it('sweepStaleFetchPacks cancella i residui e riporta i byte liberati', () => {
    const dir = packDirWith([
      { name: 'tmp_pack_A', ageMs: STALE_PACK_AGE_MS + 1, bytes: 1024 },
      { name: 'tmp_pack_B', ageMs: STALE_PACK_AGE_MS + 1, bytes: 2048 },
      { name: 'tmp_pack_C', ageMs: 1_000, bytes: 4096 },
    ]);

    const res = sweepStaleFetchPacks(dir);

    expect(res).toEqual({ removed: 2, bytes: 3072, candidates: 2 });
    expect(fs.readdirSync(dir)).toEqual(['tmp_pack_C']);
  });

  it('un unlink fallito non ferma lo sweep degli altri residui', () => {
    const dir = packDirWith([
      { name: 'tmp_pack_A', ageMs: STALE_PACK_AGE_MS + 1, bytes: 512 },
      { name: 'tmp_pack_B', ageMs: STALE_PACK_AGE_MS + 1, bytes: 512 },
    ]);

    const res = sweepStaleFetchPacks(dir, {
      unlink: (p: string) => {
        if (String(p).endsWith('tmp_pack_A')) throw new Error('EPERM');
        fs.unlinkSync(p);
      },
    });

    expect(res.candidates).toBe(2);
    expect(res.removed).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['tmp_pack_A']);
  });
});
