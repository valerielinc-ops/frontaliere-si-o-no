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

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Un lock più vecchio di questo è considerato abbandonato anche se il pid
// risultasse vivo (pid riciclato): meglio un doppio fetch raro che un lock
// avvelenato che disattiva il cleanup per sempre.
//
// DEVE restare sopra il timeout del lavoro più lungo che gira sotto questo lock
// (oggi il fetch di catch-up in prune-merged-worktrees.mjs o il fetch bounded
// della base nel main-tree guard):
// se scadesse prima, una seconda sessione dichiarerebbe abbandonato il lock di un
// titolare ancora al lavoro e si tornerebbe ai fetch concorrenti che questo lock
// esiste per impedire. Invariante verificata in
// tests/prune-fetch-single-flight.test.ts.
export const STALE_LOCK_MS = 45 * 60 * 1000;

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

// I gate di recovery proteggono una sezione sincrona di sole operazioni file.
// Non scadono mentre il proprietario è vivo: rubarli dopo 45 minuti può far
// avanzare due reaper contemporaneamente quando il processo è sospeso.
function processStartIdentity(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim() || null;
  } catch {
    return null;
  }
}

const CURRENT_PROCESS_START_IDENTITY = processStartIdentity(process.pid);

// Per sweep che possono restare vive a lungo non si prende mai un lock solo
// perché ha superato un TTL: serve prova che il processo titolare è terminato.
// Un PID riutilizzato conta come terminazione solo se `ps` consente di
// confrontare l'identità di avvio; errori o payload vecchi restano occupati.
function isLockOwnerDefinitelyDead(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const { pid, processStartIdentity: ownerIdentity } = payload;
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code !== 'EPERM') return false;
  }

  if (typeof ownerIdentity !== 'string' || !ownerIdentity) return false;
  const currentIdentity = processStartIdentity(pid);
  return currentIdentity !== null && currentIdentity !== ownerIdentity;
}

function lockIsStale(payload, { now, stalePolicy }) {
  if (stalePolicy === 'owner-dead-only') return isLockOwnerDefinitelyDead(payload);
  return isLockStale(payload, { now: now() });
}

function isRecoveryLockStale(payload) {
  if (!payload || typeof payload !== 'object') return true;
  // A marker without process identity cannot prove ownership; new markers
  // always include this field.
  if (typeof payload.processStartIdentity !== 'string') return true;
  if (!isProcessAlive(payload.pid)) return true;
  const currentIdentity = processStartIdentity(payload.pid);
  if (currentIdentity) return currentIdentity !== payload.processStartIdentity;
  return !isProcessAlive(payload.pid);
}

function readLockSnapshot(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, 'r');
    const { dev, ino } = fstatSync(fd);
    let payload;
    try {
      payload = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      payload = null; // corrotto → isLockStale() lo tratta come abbandonato
    }
    return { identity: `${dev}:${ino}`, payload };
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    return null; // assente
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Il file canonico appare solo quando il payload completo è pronto. Con la
// scrittura diretta su `lockPath`, un altro processo può leggere il file vuoto
// tra open e write e scambiarlo per un lock abbandonato.
function tryPublishLock(lockPath, payload) {
  const tempPath = `${lockPath}.${payload.ownerToken}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx');
    writeSync(fd, JSON.stringify(payload));
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tempPath, lockPath);
      return true;
    } catch (e) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      /* già rimosso */
    }
  }
}

function recoveryLockPath(lockPath, snapshot) {
  const identity = `${lockPath}\0${snapshot.identity}`;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return `${lockPath}.recovery.${key}`;
}

// Serializza il takeover di uno stesso inode stale. Se un processo muore mentre
// sta recuperando, la generazione successiva usa un path derivato dal suo lock:
// così gli altri possono eleggere atomicamente un nuovo recuperatore senza
// rimuovere il marker attivo di un concorrente.
function claimRecoveryLock(lockPath, staleSnapshot, now) {
  const abandonedGates = [];
  let gatePath = recoveryLockPath(lockPath, staleSnapshot);
  if (!CURRENT_PROCESS_START_IDENTITY) {
    throw new Error('Unable to identify the current process before recovering a single-flight lock.');
  }

  while (true) {
    const ownerToken = randomUUID();
    if (tryPublishLock(gatePath, {
      pid: process.pid,
      startedAt: now(),
      processStartIdentity: CURRENT_PROCESS_START_IDENTITY,
      ownerToken,
      recoveryFor: lockPath,
    })) {
      return { path: gatePath, ownerToken, abandonedGates };
    }

    const gateSnapshot = readLockSnapshot(gatePath);
    if (!gateSnapshot) continue; // il gate è sparito tra EEXIST e la lettura
    if (!isRecoveryLockStale(gateSnapshot.payload)) return null;

    abandonedGates.push({ path: gatePath, identity: gateSnapshot.identity });
    gatePath = recoveryLockPath(lockPath, gateSnapshot);
  }
}

function unlinkLockIfOwned(lockPath, { identity, ownerToken }) {
  const currentSnapshot = readLockSnapshot(lockPath);
  if (!currentSnapshot || currentSnapshot.identity !== identity) return;
  if (ownerToken && currentSnapshot.payload?.ownerToken !== ownerToken) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* già rimosso */
  }
}

function releaseRecoveryLock(recovery) {
  for (const gate of recovery.abandonedGates) {
    unlinkLockIfOwned(gate.path, gate);
  }
  let ownGate;
  try {
    ownGate = readLockSnapshot(recovery.path);
  } catch {
    return;
  }
  if (ownGate?.payload?.ownerToken === recovery.ownerToken) {
    unlinkLockIfOwned(recovery.path, {
      identity: ownGate.identity,
      ownerToken: recovery.ownerToken,
    });
  }
}

// Un processo terminato durante il takeover può lasciare il gate quando il
// lock canonico è già stato rimosso. Il primo acquisitore successivo pulisce
// solo i marker morti che dichiarano di appartenere a questo lock path.
function cleanupOrphanedRecoveryLocks(lockPath) {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.recovery.`;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/^.+\.recovery\.[a-f0-9]{24}$/.test(entry.name)) continue;
    const markerPath = join(directory, entry.name);
    if (!entry.name.startsWith(prefix)) continue;
    let snapshot;
    try {
      snapshot = readLockSnapshot(markerPath);
    } catch {
      continue;
    }
    if (
      !snapshot
      || snapshot.payload?.recoveryFor !== lockPath
      || !isRecoveryLockStale(snapshot.payload)
    ) continue;

    try {
      const currentSnapshot = readLockSnapshot(markerPath);
      if (
        currentSnapshot?.identity === snapshot.identity
        && currentSnapshot.payload?.recoveryFor === lockPath
        && isRecoveryLockStale(currentSnapshot.payload)
      ) unlinkSync(markerPath);
    } catch {
      /* marker già rimosso o non leggibile */
    }
  }
}

function acquireSingleFlightLock(lockPath, now, ownerToken, { stalePolicy = 'age' } = {}) {
  if (!CURRENT_PROCESS_START_IDENTITY) {
    throw new Error('Unable to identify the current process before acquiring a single-flight lock.');
  }
  const payload = {
    pid: process.pid,
    startedAt: now(),
    processStartIdentity: CURRENT_PROCESS_START_IDENTITY,
    ownerToken,
  };
  if (tryPublishLock(lockPath, payload)) {
    cleanupOrphanedRecoveryLocks(lockPath);
    return true;
  }

  // Occupato: takeover solo se il titolare è morto o il lock è scaduto.
  const staleSnapshot = readLockSnapshot(lockPath);
  if (!staleSnapshot) return tryPublishLock(lockPath, payload);
  if (!lockIsStale(staleSnapshot.payload, { now, stalePolicy })) return false;

  const recovery = claimRecoveryLock(lockPath, staleSnapshot, now);
  if (!recovery) return false;
  try {
    // Il gate è esclusivo per l'inode osservato: nessun altro takeover può
    // cancellare il lock nuovo tra la verifica e unlinkSync.
    const currentSnapshot = readLockSnapshot(lockPath);
    if (!currentSnapshot) return tryPublishLock(lockPath, payload);
    if (
      currentSnapshot.identity !== staleSnapshot.identity
      || !lockIsStale(currentSnapshot.payload, { now, stalePolicy })
    ) return false;

    try {
      unlinkSync(lockPath);
    } catch {
      return false; // il lock è già stato rimosso
    }
    // If another instance wins the empty-path race, leave its lock untouched.
    const acquired = tryPublishLock(lockPath, payload);
    if (acquired) cleanupOrphanedRecoveryLocks(lockPath);
    return acquired;
  } finally {
    releaseRecoveryLock(recovery);
  }
}

function releaseSingleFlightLock(lockPath, ownerToken, now) {
  let currentSnapshot;
  try {
    currentSnapshot = readLockSnapshot(lockPath);
  } catch {
    return;
  }
  if (currentSnapshot?.payload?.ownerToken !== ownerToken) return;

  // Il rilascio usa lo stesso gate del takeover: altrimenti un processo stale
  // potrebbe sostituire il lock tra il controllo del token e unlinkSync.
  const recovery = claimRecoveryLock(lockPath, currentSnapshot, now);
  if (!recovery) return;
  try {
    let latestSnapshot;
    try {
      latestSnapshot = readLockSnapshot(lockPath);
    } catch {
      return;
    }
    if (
      latestSnapshot?.identity !== currentSnapshot.identity
      || latestSnapshot?.payload?.ownerToken !== ownerToken
    ) return;
    try {
      unlinkSync(lockPath);
    } catch {
      /* già rimosso */
    }
  } finally {
    releaseRecoveryLock(recovery);
  }
}

// Esegue `fn` solo se riesce ad acquisire il lock; altrimenti ritorna
// `{ acquired: false }` senza eseguire nulla. Il lock viene SEMPRE rilasciato,
// anche se `fn` lancia (finally) — un hook che muore non deve lasciare il
// cleanup disabilitato per la sessione successiva.
export function withSingleFlightLock(lockPath, fn, { now = Date.now } = {}) {
  const release = acquireSingleFlightLockHandle(lockPath, { now });
  if (!release) return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    release();
  }
}

// Acquisizione esplicita per un processo CLI che deve tenere il lock durante
// tutto il proprio top-level. Il chiamante registra `release` su `exit`; se
// arriva SIGKILL il lock resta recuperabile solo dopo prova della morte del
// titolare quando `stalePolicy: 'owner-dead-only'`.
export function acquireSingleFlightLockHandle(
  lockPath,
  { now = Date.now, stalePolicy = 'age' } = {},
) {
  const ownerToken = randomUUID();
  if (!acquireSingleFlightLock(lockPath, now, ownerToken, { stalePolicy })) return null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSingleFlightLock(lockPath, ownerToken, now);
  };
}

// Variante async per un lavoro che deve restare single-flight fino alla sua
// conclusione, inclusi child process terminati in modo asincrono.
export async function withSingleFlightLockAsync(lockPath, fn, { now = Date.now } = {}) {
  const release = acquireSingleFlightLockHandle(lockPath, { now });
  if (!release) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    release();
  }
}
