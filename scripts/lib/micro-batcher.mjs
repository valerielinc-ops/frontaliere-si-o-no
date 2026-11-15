// scripts/lib/micro-batcher.mjs
//
// Micro-batcher generico (perf-plan email senders, A2). Estratto da
// `job-alert-batch-bookkeeping.mjs`, che lo riesporta con la stessa API: la
// jobalert, il saved-jobs-digest, il drip e il winback raccolgono con lo stesso
// meccanismo le scritture di bookkeeping che arrivano insieme (la concorrenza
// del cascade) in un solo `WriteBatch.commit()`.
//
// Piu' gli helper per i codici gRPC di Firestore che i sender usano per
// distinguere un esito definito (`ALREADY_EXISTS` di `WriteBatch.create` =
// «gia' reclamato») da uno incerto.

export const GROUP_MAX_ITEMS = 8;
export const GROUP_WINDOW_MS = 8;

/** gRPC FAILED_PRECONDITION (9). */
export const GRPC_FAILED_PRECONDITION = 9;
/** gRPC ALREADY_EXISTS (6). */
export const GRPC_ALREADY_EXISTS = 6;

function matchesGrpc(error, numeric, names, pattern) {
  const code = error?.code;
  if (code === numeric) return true;
  if (typeof code === 'string' && names.includes(code.toLowerCase().replace(/_/g, '-'))) return true;
  // Alcuni percorsi del client riportano il codice solo nel messaggio
  // («9 FAILED_PRECONDITION: ...», «6 ALREADY_EXISTS: ...»).
  return pattern.test(String(error?.message || ''));
}

/** Errore di precondizione di Firestore (gRPC 9 FAILED_PRECONDITION). */
export function isFailedPrecondition(error) {
  return matchesGrpc(error, GRPC_FAILED_PRECONDITION, ['failed-precondition'], /FAILED_PRECONDITION|precondition/i);
}

/** Documento gia' esistente (gRPC 6 ALREADY_EXISTS), per esempio da `WriteBatch.create`. */
export function isAlreadyExists(error) {
  return matchesGrpc(error, GRPC_ALREADY_EXISTS, ['already-exists'], /ALREADY_EXISTS|already exists/i);
}

/** Raccoglie le richieste in arrivo entro `windowMs` (o `maxItems`) in un solo flush. */
export function createMicroBatcher(flush, {
  maxItems = GROUP_MAX_ITEMS,
  windowMs = GROUP_WINDOW_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let pending = [];
  let timer = null;
  const run = () => {
    if (timer) { clearTimer(timer); timer = null; }
    const group = pending;
    pending = [];
    if (group.length === 0) return;
    Promise.resolve()
      .then(() => flush(group.map((entry) => entry.request)))
      .then((results) => group.forEach((entry, index) => entry.resolve(results[index])))
      .catch((error) => group.forEach((entry) => entry.reject(error)));
  };
  return {
    submit(request) {
      return new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject });
        if (pending.length >= maxItems) run();
        else if (!timer) timer = setTimer(run, windowMs);
      });
    },
    flushNow: run,
    get size() { return pending.length; },
  };
}
