// Lock single-flight per gli hook di sessione che fanno rete sul repo condiviso.
//
// PERCHÉ ESISTE (incidente 2026-08-17): il SessionStart hook lancia
// `prune-merged-worktrees.mjs --apply` in background (`&`, detached) senza alcun
// guard di concorrenza, e quello script fa `git fetch origin main --prune`. Con
// sessioni agent multiple/multiagent — o con una sola sessione che riparte più
// volte — si accumulano N fetch concorrenti sullo STESSO `.git`: si contendono
// il lock di git, nessuno arriva in fondo, e ognuno lascia dietro un pack
// temporaneo abortito (`.git/objects/pack/tmp_pack_*`). Trovati 23 fetch vivi da
// oltre 20 minuti e 38.8 GB di `tmp_pack_*`: `.git` a 55 GB, ogni fetch
// successivo in timeout. Il lock rende quel fetch single-flight: il primo che
// arriva lavora, gli altri escono subito.
//
// Deliberatamente basato su `open(..., 'wx')` (atomico su POSIX e su APFS) e non
// su una libreria: gli hook girano non presidiati, un lock che richiede
// dipendenze extra è un lock che salta l'installazione e non protegge.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

// Un lock più vecchio di questo è considerato abbandonato anche se il pid
// risultasse vivo (pid riciclato): meglio un doppio fetch raro che un lock
// avvelenato che disattiva il cleanup per sempre.
export const STALE_LOCK_MS = 30 * 60 * 1000;

// Ritorna true se il processo esiste ancora. `kill(pid, 0)` non invia segnali:
// sonda solo l'esistenza. EPERM = esiste ma di un altro utente → vivo.
export function isProcessAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

// Un lock è rilevabile come abbandonato senza toccare il filesystem: serve al
// test e alla decisione di takeover. `now`/`isAlive` iniettabili.
export function isLockStale(payload, { now = Date.now(), isAlive = isProcessAlive } = {}) {
  if (!payload || typeof payload !== 'object') return true; // lock illeggibile/corrotto
  const { pid, startedAt } = payload;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return true;
  if (now - startedAt > STALE_LOCK_MS) return true;
  return !isAlive(pid);
}

function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null; // assente o corrotto → isLockStale() lo tratta come abbandonato
  }
}

// Esegue `fn` solo se riesce ad acquisire il lock; altrimenti ritorna
// `{ acquired: false }` senza eseguire nulla. Il lock viene SEMPRE rilasciato,
// anche se `fn` lancia (finally) — un hook che muore non deve lasciare il
// cleanup disabilitato per la sessione successiva.
export function withSingleFlightLock(lockPath, fn, { now = Date.now } = {}) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    // Occupato: takeover solo se il titolare è morto o il lock è scaduto.
    if (!isLockStale(readLock(lockPath), { now: now() })) return { acquired: false };
    try {
      unlinkSync(lockPath);
      fd = openSync(lockPath, 'wx');
    } catch {
      // Un'altra istanza ha vinto la corsa al takeover: lei lavora, noi no.
      return { acquired: false };
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() }));
  } finally {
    closeSync(fd);
  }
  try {
    return { acquired: true, value: fn() };
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* già rimosso da un takeover: niente da rilasciare */
    }
  }
}
