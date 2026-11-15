// scripts/lib/firestore-op-counter.mjs
//
// Conta le operazioni Firestore di un sender, per fase e per collection
// (perf-plan PR 1; generalizzato a tutti i sender in perf-plan email senders,
// A1). Alimenta `sender-metrics.mjs` / `job-alert-metrics.mjs`.
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
//   - scrittura (set/create/update/delete): 1;
//   - aggregazione (`count()`, `AggregateQuery.get`): `aggregateQueries` +1 come
//     contatore nominale e 1 lettura ogni 1.000 voci di indice aggregate
//     (minimo 1), come la fatturazione Firestore.
// Le letture dentro una transazione ripetuta dopo un conflitto si contano a
// ogni tentativo, come le fattura Firestore.
//
// La collection è l'id della collection che contiene il documento (l'ultimo
// segmento di collection del path): `alerts`, `campaign_deliveries`,
// `newsletter_subscribers`. Mai un id di documento: la telemetria non porta
// email.

const READ = 'read';
const WRITE = 'write';

// Marcatore di «già agganciato». `__jobAlertOpCounter` è il nome storico: resta
// riconosciuto, così un processo con un contatore installato dalla vecchia API
// non viene agganciato due volte.
const MARKER = '__senderOpCounter';
const LEGACY_MARKER = '__jobAlertOpCounter';
const isMarked = (fn) => Boolean(fn?.[MARKER] || fn?.[LEGACY_MARKER]);

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

function recordAggregate(metrics, aggregateQuery, snapshot) {
  const collection = aggregateQuery?._query?._queryOptions?.collectionId
    || aggregateQuery?.query?._queryOptions?.collectionId
    || '(aggregate)';
  let entries = 0;
  try {
    const data = typeof snapshot?.data === 'function' ? snapshot.data() : null;
    for (const value of Object.values(data || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) entries = Math.max(entries, value);
    }
  } catch { /* il conteggio esatto e' opzionale: il minimo fatturato e' 1 */ }
  if (typeof metrics.count === 'function') metrics.count('aggregateQueries');
  metrics.recordRead(collection, Math.max(1, Math.ceil(entries / 1000)));
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
      onCall(args, result, this);
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
 * @param {ReturnType<import('./sender-metrics.mjs').createSenderMetrics>} metrics
 * @param {{ Firestore?: Function, Query?: Function, Transaction?: Function, WriteBatch?: Function, AggregateQuery?: Function }} classes
 *   Le classi da agganciare: in produzione quelle di `firebase-admin/firestore`.
 * @returns {() => void} funzione che toglie i ganci (usata dai test).
 */
export function installFirestoreOpCounter(metrics, classes) {
  const { Firestore, Query, Transaction, WriteBatch, AggregateQuery } = classes || {};
  const restores = [];
  // Un metodo già agganciato porta il marcatore: non si doppia mai il conteggio.
  if (isMarked(WriteBatch?.prototype?.set)) return () => {};

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

  // AggregateQuery.get: Promise<AggregateQuerySnapshot> (`count()`, `sum()`...).
  wrapMethod(AggregateQuery?.prototype, 'get', (args, result, self) => {
    Promise.resolve(result).then((snap) => recordAggregate(metrics, self, snap), () => {});
  }, restores);

  // Transaction.get(refOrQuery) → DocumentSnapshot | QuerySnapshot;
  // Transaction.getAll(...refs) → DocumentSnapshot[].
  wrapMethod(Transaction?.prototype, 'get', (args, result) => {
    Promise.resolve(result).then((snap) => recordSnapshot(metrics, snap), () => {});
  }, restores);
  wrapMethod(Transaction?.prototype, 'getAll', (args, result) => {
    Promise.resolve(result).then((snaps) => recordSnapshots(metrics, snaps), () => {});
  }, restores);

  for (const proto of [WriteBatch?.prototype, Firestore?.prototype, Query?.prototype, Transaction?.prototype, AggregateQuery?.prototype]) {
    for (const key of ['set', 'getAll', 'get']) {
      if (typeof proto?.[key] === 'function') proto[key][MARKER] = true;
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
    AggregateQuery: mod.AggregateQuery,
  });
}

export const __testing = Object.freeze({ READ, WRITE, MARKER, LEGACY_MARKER, collectionOfRef });
