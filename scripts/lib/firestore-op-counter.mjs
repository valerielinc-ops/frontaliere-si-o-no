// scripts/lib/firestore-op-counter.mjs
//
// Conta le operazioni Firestore del sender dei job alert, per fase e per
// collection (perf-plan PR 1). Alimenta `job-alert-metrics.mjs`.
//
// DOVE SI AGGANCIA. Non sull'istanza `db`, ma sui metodi pubblici delle classi
// del client: il sender passa `db` a librerie (impression di ranking, claim
// discovery, affinity) e il cascade apre un handle suo (`getRefDb`). Un wrapper
// di istanza non vedrebbe né le seconde né il terzo, e i totali non
// tornerebbero con Cloud Monitoring. Agganciando le classi, ogni operazione
// del processo passa da qui, comunque abbia ottenuto il proprio riferimento.
//
// Ogni operazione è contata UNA volta. Il client del 7.x fa passare i percorsi
// l'uno dentro l'altro, e agganciarli tutti conterebbe doppio:
//   - `DocumentReference.get()` chiama `Firestore.getAll()`  → si aggancia getAll;
//   - `Transaction.get/getAll()` NON passano da getAll       → si agganciano;
//   - `Transaction.get(query)` NON passa da `Query.get()`    → si aggancia Query.get;
//   - `DocumentReference.set/update/delete/create()` e le scritture di una
//     transazione passano tutte da `WriteBatch.*`            → si aggancia WriteBatch.
//
// COSA SI CONTA, allineato alla fatturazione:
//   - lettura di documento (esista o no): 1;
//   - query: i documenti restituiti, minimo 1 (una query vuota costa 1 lettura);
//   - scrittura (set/create/update/delete): 1.
// Le letture dentro una transazione ripetuta dopo un conflitto si contano a
// ogni tentativo, come le fattura Firestore.
//
// La collection è l'id della collection che contiene il documento (l'ultimo
// segmento di collection del path): `alerts`, `campaign_deliveries`,
// `newsletter_subscribers`. Mai un id di documento: la telemetria non porta
// email.

const READ = 'read';
const WRITE = 'write';

function collectionOfRef(ref) {
  const id = ref?.parent?.id;
  return typeof id === 'string' && id ? id : '(unknown)';
}

function isDocumentSnapshotLike(value) {
  return value && typeof value === 'object' && 'ref' in value && 'exists' in value;
}

function recordSnapshot(metrics, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (Array.isArray(snapshot.docs)) {
    if (snapshot.docs.length === 0) {
      metrics.recordRead(snapshot.query?._queryOptions?.collectionId || '(query)', 1);
      return;
    }
    const byCollection = new Map();
    for (const doc of snapshot.docs) {
      const name = collectionOfRef(doc?.ref);
      byCollection.set(name, (byCollection.get(name) || 0) + 1);
    }
    for (const [name, count] of byCollection) metrics.recordRead(name, count);
    return;
  }
  if (isDocumentSnapshotLike(snapshot)) metrics.recordRead(collectionOfRef(snapshot.ref), 1);
}

function recordSnapshots(metrics, snapshots) {
  if (!Array.isArray(snapshots)) {
    recordSnapshot(metrics, snapshots);
    return;
  }
  for (const snapshot of snapshots) {
    if (isDocumentSnapshotLike(snapshot)) metrics.recordRead(collectionOfRef(snapshot.ref), 1);
  }
}

function wrapMethod(proto, name, onCall, restores) {
  const original = proto?.[name];
  if (typeof original !== 'function') return false;
  const wrapped = function wrappedFirestoreMethod(...args) {
    const result = original.apply(this, args);
    try {
      onCall(args, result);
    } catch { /* la telemetria non cambia mai l'esito di un'operazione */ }
    return result;
  };
  Object.defineProperty(wrapped, 'name', { value: original.name });
  proto[name] = wrapped;
  restores.push(() => { proto[name] = original; });
  return true;
}

/**
 * Aggancia il contatore alle classi del client Firestore. Idempotente per
 * processo: una seconda chiamata senza `uninstall` è un no-op.
 *
 * @param {ReturnType<import('./job-alert-metrics.mjs').createJobAlertMetrics>} metrics
 * @param {{ Firestore?: Function, Query?: Function, Transaction?: Function, WriteBatch?: Function }} classes
 *   Le classi da agganciare: in produzione quelle di `firebase-admin/firestore`.
 * @returns {() => void} funzione che toglie i ganci (usata dai test).
 */
export function installFirestoreOpCounter(metrics, classes) {
  const { Firestore, Query, Transaction, WriteBatch } = classes || {};
  const restores = [];
  // Un metodo già agganciato porta il marcatore: non si doppia mai il conteggio.
  if (WriteBatch?.prototype?.set?.__jobAlertOpCounter) return () => {};

  const writeHook = ([ref]) => metrics.recordWrite(collectionOfRef(ref), 1);
  for (const method of ['create', 'set', 'update', 'delete']) {
    wrapMethod(WriteBatch?.prototype, method, writeHook, restores);
  }

  // Firestore.getAll: restituisce Promise<DocumentSnapshot[]>. Si conta il
  // risultato (un documento mancante costa comunque una lettura).
  wrapMethod(Firestore?.prototype, 'getAll', (args, result) => {
    Promise.resolve(result).then((snaps) => recordSnapshots(metrics, snaps), () => {});
  }, restores);

  // Query.get: Promise<QuerySnapshot>.
  wrapMethod(Query?.prototype, 'get', (args, result) => {
    Promise.resolve(result).then((snap) => recordSnapshot(metrics, snap), () => {});
  }, restores);

  // Transaction.get(refOrQuery) → DocumentSnapshot | QuerySnapshot;
  // Transaction.getAll(...refs) → DocumentSnapshot[].
  wrapMethod(Transaction?.prototype, 'get', (args, result) => {
    Promise.resolve(result).then((snap) => recordSnapshot(metrics, snap), () => {});
  }, restores);
  wrapMethod(Transaction?.prototype, 'getAll', (args, result) => {
    Promise.resolve(result).then((snaps) => recordSnapshots(metrics, snaps), () => {});
  }, restores);

  for (const proto of [WriteBatch?.prototype, Firestore?.prototype, Query?.prototype, Transaction?.prototype]) {
    for (const key of ['set', 'getAll', 'get']) {
      if (typeof proto?.[key] === 'function') proto[key].__jobAlertOpCounter = true;
    }
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/** Carica le classi reali di `firebase-admin/firestore` e aggancia il contatore. */
export async function installFirestoreOpCounterOnAdminSdk(metrics) {
  const mod = await import('firebase-admin/firestore');
  return installFirestoreOpCounter(metrics, {
    Firestore: mod.Firestore,
    Query: mod.Query,
    Transaction: mod.Transaction,
    WriteBatch: mod.WriteBatch,
  });
}

export const __testing = Object.freeze({ READ, WRITE, collectionOfRef });
