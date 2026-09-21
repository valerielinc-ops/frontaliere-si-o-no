/**
 * Operator-only, manual erasure of data associated with one email address.
 *
 * This module is deliberately kept under scripts/lib and is not imported by
 * the SPA, services, routes, or Cloud Functions. The CLI is the only entry
 * point. A production caller must provide an already-authorized Firebase
 * Admin SDK credential; this module never obtains credentials itself.
 *
 * Safety contract:
 * - inventory is read before every operation;
 * - dry-run is the default; callers must pass apply: true to mutate;
 * - every read, query, listCollections and Auth failure is fatal;
 * - only the explicitly listed collection/subcollection contracts are
 *   traversed; an unexpected subcollection fails closed;
 * - apply returns only after a fresh, explicit zero-residual verification.
 */

export const DELETE_PAGE_SIZE = 450;

export const NEWSLETTER_COLLECTION = 'newsletter_subscribers';
export const JOB_ALERT_COLLECTION = 'job_alert_subscribers';
export const USERS_COLLECTION = 'users';

export const NEWSLETTER_SUBS = Object.freeze([
  'events',
  'campaign_deliveries',
  'private',
]);
export const JOB_ALERT_SUBS = Object.freeze([
  'alerts',
  'alert_deliveries',
  'events',
]);
export const USER_SUBS = Object.freeze(['savedJobs']);

/*
 * These are the only extra stores whose current writers intentionally retain
 * the address in the named field. Do not turn this into a collection-wide
 * PII scanner: adding a store requires checking its writer and retention
 * contract first.
 */
export const EXTRA_EMAIL_STORES = Object.freeze([
  Object.freeze({
    collection: 'contact_submissions',
    fields: Object.freeze(['email']),
    subcollections: Object.freeze([]),
  }),
  Object.freeze({
    collection: 'consulting_orders',
    fields: Object.freeze(['customerEmail']),
    subcollections: Object.freeze([]),
  }),
  Object.freeze({
    collection: 'applications',
    fields: Object.freeze(['candidateEmail']),
    subcollections: Object.freeze([]),
  }),
  Object.freeze({
    collection: 'publishers',
    fields: Object.freeze(['email']),
    subcollections: Object.freeze([]),
  }),
]);

export class EraseSubscriberDataError extends Error {
  constructor(message, { phase = 'unknown', partial = false, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EraseSubscriberDataError';
    this.phase = phase;
    this.partial = partial;
    this.cause = cause;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function contextualize(error, phase, partial = false) {
  if (error instanceof EraseSubscriberDataError) {
    if (partial) error.partial = true;
    return error;
  }
  return new EraseSubscriberDataError(
    phase + ': ' + errorMessage(error),
    { phase, partial, cause: error },
  );
}

async function phase(phaseName, operation, partial = false) {
  try {
    return await operation();
  } catch (error) {
    throw contextualize(error, phaseName, partial);
  }
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function assertSafeEmail(email) {
  const normalized = normalizeEmail(email);
  if (normalized === '_meta_') {
    throw new EraseSubscriberDataError(
      'rifiuto di cancellare newsletter_subscribers/_meta_',
      { phase: 'input' },
    );
  }
  if (!normalized || !normalized.includes('@')) {
    throw new EraseSubscriberDataError(
      'email richiesta nel formato nome@dominio',
      { phase: 'input' },
    );
  }
  return normalized;
}

function assertDb(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.batch !== 'function') {
    throw new EraseSubscriberDataError(
      'Firestore Admin non disponibile',
      { phase: 'input' },
    );
  }
}

function assertAuth(auth) {
  if (
    !auth
    || typeof auth.getUserByEmail !== 'function'
    || typeof auth.deleteUser !== 'function'
  ) {
    throw new EraseSubscriberDataError(
      'Firebase Auth Admin non disponibile con getUserByEmail/deleteUser',
      { phase: 'input' },
    );
  }
}

function docKey(doc) {
  return doc?.ref?.path || doc?.path || doc?.id || '';
}

function assertSnapshot(snapshot, context) {
  if (!snapshot || typeof snapshot.exists !== 'boolean') {
    throw new Error(context + ' ha restituito uno snapshot non valido');
  }
  return snapshot;
}

function assertPage(snapshot, context) {
  if (!snapshot || !Array.isArray(snapshot.docs)) {
    throw new Error(context + ' ha restituito una pagina non valida');
  }
  if (typeof snapshot.size === 'number' && snapshot.size !== snapshot.docs.length) {
    throw new Error(context + ' ha restituito size incoerente');
  }
  if (snapshot.docs.length > DELETE_PAGE_SIZE) {
    throw new Error(context + ' ha superato il limite di pagina');
  }
  return snapshot.docs;
}

async function readDocument(ref, context) {
  if (!ref || typeof ref.get !== 'function') {
    throw new EraseSubscriberDataError(
      context + ': riferimento Firestore non leggibile',
      { phase: 'read' },
    );
  }
  return phase('lettura ' + context, async () => assertSnapshot(await ref.get(), context));
}

async function listContractSubcollections(ref, allowed, context) {
  if (!ref || typeof ref.listCollections !== 'function') {
    throw new EraseSubscriberDataError(
      context + ': listCollections non disponibile; impossibile verificare le sottocollezioni',
      { phase: 'listCollections' },
    );
  }
  const collections = await phase(
    'listCollections ' + context,
    () => ref.listCollections(),
  );
  if (!Array.isArray(collections)) {
    throw new EraseSubscriberDataError(
      context + ': listCollections ha restituito un valore non valido',
      { phase: 'listCollections' },
    );
  }
  const allowedSet = new Set(allowed);
  const names = [];
  for (const collection of collections) {
    const id = String(collection?.id || '');
    if (!id || !allowedSet.has(id)) {
      throw new EraseSubscriberDataError(
        context + ': sottocollezione non prevista ' + (id || '(senza id)'),
        { phase: 'listCollections' },
      );
    }
    names.push(id);
  }
  return [...new Set(names)].sort();
}

async function readQueryPage(query, cursor, context) {
  return phase('query ' + context, async () => {
    if (!query || typeof query.limit !== 'function') {
      throw new EraseSubscriberDataError(
        context + ': query non paginabile',
        { phase: 'query' },
      );
    }
    let pageQuery = query.limit(DELETE_PAGE_SIZE);
    if (cursor) {
      if (!pageQuery || typeof pageQuery.startAfter !== 'function') {
        throw new EraseSubscriberDataError(
          context + ': startAfter non disponibile per la paginazione',
          { phase: 'query' },
        );
      }
      pageQuery = pageQuery.startAfter(cursor);
    }
    if (!pageQuery || typeof pageQuery.get !== 'function') {
      throw new EraseSubscriberDataError(
        context + ': query senza get',
        { phase: 'query' },
      );
    }
    const snapshot = await pageQuery.get();
    return assertPage(snapshot, context);
  });
}

async function readAllQueryDocs(query, context) {
  const docs = [];
  let cursor = null;
  for (;;) {
    const page = await readQueryPage(query, cursor, context);
    if (page.length === 0) return docs;
    docs.push(...page);
    if (page.length < DELETE_PAGE_SIZE) return docs;
    const nextCursor = page[page.length - 1];
    const nextKey = docKey(nextCursor);
    if (!nextKey || nextKey === docKey(cursor)) {
      throw new EraseSubscriberDataError(
        context + ': cursore di paginazione non avanzato',
        { phase: 'query' },
      );
    }
    cursor = nextCursor;
  }
}

async function countCollection(collectionRef, context) {
  return (await readAllQueryDocs(collectionRef, context)).length;
}

async function inspectDocTree(ref, allowedSubs, context) {
  const snapshot = await readDocument(ref, context);
  const names = await listContractSubcollections(ref, allowedSubs, context);
  const subcollections = {};
  for (const name of names) {
    subcollections[name] = await countCollection(
      ref.collection(name),
      context + '/' + name,
    );
  }
  return {
    path: ref.path || context,
    exists: snapshot.exists === true,
    subcollections,
  };
}

async function inventoryKeyedTree(db, collectionName, email, allowedSubs) {
  const ref = db.collection(collectionName).doc(email);
  const tree = await inspectDocTree(
    ref,
    allowedSubs,
    collectionName + '/' + email,
  );
  const queried = await findEmailDocsOnCollection(
    db,
    db.collection(collectionName),
    ['email'],
    email,
    allowedSubs,
    collectionName,
  );
  const extraDocs = queried.filter(
    (hit) => hit.id !== email && hit.id !== '_meta_',
  );
  return {
    ...tree,
    extraDocIdsByEmailField: extraDocs.map((hit) => hit.id),
    extraDocs,
  };
}

async function findEmailDocsOnCollection(
  db,
  collectionRef,
  fields,
  email,
  allowedSubs,
  context,
) {
  if (!collectionRef || typeof collectionRef.where !== 'function') {
    throw new EraseSubscriberDataError(
      context + ': where non disponibile',
      { phase: 'query' },
    );
  }
  const hits = new Map();
  for (const field of fields) {
    const query = collectionRef.where(field, '==', email);
    const docs = await readAllQueryDocs(query, context + ' where ' + field);
    for (const doc of docs) {
      if (!doc || typeof doc.id !== 'string' || !doc.ref) {
        throw new EraseSubscriberDataError(
          context + ': documento query privo di id/ref',
          { phase: 'query' },
        );
      }
      const hit = hits.get(doc.id) || { id: doc.id, fields: [], ref: doc.ref };
      if (!hit.fields.includes(field)) hit.fields.push(field);
      hits.set(doc.id, hit);
    }
  }
  const result = [];
  for (const hit of hits.values()) {
    const tree = await inspectDocTree(
      hit.ref,
      allowedSubs,
      context + '/' + hit.id,
    );
    result.push({
      id: hit.id,
      fields: hit.fields,
      subcollections: tree.subcollections,
      exists: tree.exists,
      ref: hit.ref,
    });
  }
  return result;
}

async function lookupAuthUser(auth, email) {
  return phase('Auth getUserByEmail', async () => {
    try {
      const record = await auth.getUserByEmail(email);
      if (!record || typeof record.uid !== 'string' || !record.uid) {
        throw new Error('Auth ha restituito un utente senza uid');
      }
      return { found: true, uid: record.uid, error: null };
    } catch (error) {
      const code = error?.code || error?.errorInfo?.code || '';
      if (code === 'auth/user-not-found') {
        return { found: false, uid: null, error: 'user-not-found' };
      }
      throw error;
    }
  });
}

export async function inventorySubscriberData(db, email, auth) {
  assertDb(db);
  assertAuth(auth);
  const normalized = assertSafeEmail(email);
  const authUser = await lookupAuthUser(auth, normalized);

  const newsletter = await inventoryKeyedTree(
    db,
    NEWSLETTER_COLLECTION,
    normalized,
    NEWSLETTER_SUBS,
  );
  const jobAlert = await inventoryKeyedTree(
    db,
    JOB_ALERT_COLLECTION,
    normalized,
    JOB_ALERT_SUBS,
  );

  const userHits = await findEmailDocsOnCollection(
    db,
    db.collection(USERS_COLLECTION),
    ['email'],
    normalized,
    USER_SUBS,
    USERS_COLLECTION,
  );
  const usersById = new Map(userHits.map((hit) => [hit.id, hit]));
  if (authUser.found) {
    const authRef = db.collection(USERS_COLLECTION).doc(authUser.uid);
    const authTree = await inspectDocTree(
      authRef,
      USER_SUBS,
      USERS_COLLECTION + '/' + authUser.uid,
    );
    if (!usersById.has(authUser.uid)) {
      usersById.set(authUser.uid, {
        id: authUser.uid,
        fields: ['auth.uid'],
        subcollections: authTree.subcollections,
        exists: authTree.exists,
        ref: authRef,
      });
    }
  }
  const users = [...usersById.values()];

  const extra = {};
  for (const store of EXTRA_EMAIL_STORES) {
    extra[store.collection] = await findEmailDocsOnCollection(
      db,
      db.collection(store.collection),
      store.fields,
      normalized,
      store.subcollections,
      store.collection,
    );
  }

  return {
    email: normalized,
    newsletter,
    jobAlert,
    users,
    extra,
    authUser,
  };
}

async function deleteSubcollection(db, parentRef, name) {
  const collectionRef = parentRef.collection(name);
  let deleted = 0;
  for (;;) {
    const page = await readQueryPage(
      collectionRef,
      null,
      (parentRef.path || 'document') + '/' + name,
    );
    if (page.length === 0) break;
    const batch = db.batch();
    if (!batch || typeof batch.delete !== 'function' || typeof batch.commit !== 'function') {
      throw new EraseSubscriberDataError(
        'Firestore batch non disponibile per ' + parentRef.path + '/' + name,
        { phase: 'delete' },
      );
    }
    for (const doc of page) {
      if (!doc.ref) {
        throw new EraseSubscriberDataError(
          'documento senza riferimento in ' + parentRef.path + '/' + name,
          { phase: 'delete' },
        );
      }
      batch.delete(doc.ref);
    }
    await phase(
      'commit ' + parentRef.path + '/' + name,
      () => batch.commit(),
      true,
    );
    deleted += page.length;
    if (page.length < DELETE_PAGE_SIZE) break;
  }
  return deleted;
}

export async function deleteDocTree(db, ref, allowedSubs) {
  const names = await listContractSubcollections(
    ref,
    allowedSubs,
    ref.path || 'document',
  );
  const subDeleted = {};
  for (const name of names) {
    subDeleted[name] = await deleteSubcollection(db, ref, name);
  }
  const snapshot = await readDocument(ref, ref.path || 'document');
  if (snapshot.exists) {
    await phase(
      'delete ' + (ref.path || 'document'),
      () => ref.delete(),
      true,
    );
  }
  return { parentDeleted: snapshot.exists === true, subDeleted };
}

function emptyDeletedReport() {
  return {
    newsletter: null,
    jobAlert: null,
    extraNewsletterDocs: [],
    extraJobAlertDocs: [],
    users: [],
    extra: {},
    auth: null,
  };
}

function treeHasData(tree) {
  if (!tree) return false;
  return tree.exists || Object.values(tree.subcollections || {}).some((n) => n > 0);
}

function inventoryResiduals(inventory) {
  const residuals = [];
  if (treeHasData(inventory.newsletter)) {
    residuals.push('newsletter canonical tree');
  }
  if ((inventory.newsletter.extraDocs || []).some(treeHasData)) {
    residuals.push('newsletter extra documents');
  }
  if (treeHasData(inventory.jobAlert)) {
    residuals.push('job-alert canonical tree');
  }
  if ((inventory.jobAlert.extraDocs || []).some(treeHasData)) {
    residuals.push('job-alert extra documents');
  }
  if ((inventory.users || []).some(treeHasData)) {
    residuals.push('users trees');
  }
  for (const [collection, hits] of Object.entries(inventory.extra || {})) {
    if (hits.some(treeHasData)) residuals.push(collection);
  }
  if (inventory.authUser?.found) residuals.push('Auth user');
  return residuals;
}

async function inspectKnownTargets(db, before) {
  const targets = [
    {
      collection: NEWSLETTER_COLLECTION,
      id: before.email,
      allowedSubs: NEWSLETTER_SUBS,
    },
    {
      collection: JOB_ALERT_COLLECTION,
      id: before.email,
      allowedSubs: JOB_ALERT_SUBS,
    },
    ...(before.newsletter.extraDocs || []).map((hit) => ({
      collection: NEWSLETTER_COLLECTION,
      id: hit.id,
      allowedSubs: NEWSLETTER_SUBS,
    })),
    ...(before.jobAlert.extraDocs || []).map((hit) => ({
      collection: JOB_ALERT_COLLECTION,
      id: hit.id,
      allowedSubs: JOB_ALERT_SUBS,
    })),
    ...(before.users || []).map((user) => ({
      collection: USERS_COLLECTION,
      id: user.id,
      allowedSubs: USER_SUBS,
    })),
  ];
  for (const store of EXTRA_EMAIL_STORES) {
    for (const hit of before.extra[store.collection] || []) {
      targets.push({
        collection: store.collection,
        id: hit.id,
        allowedSubs: store.subcollections,
      });
    }
  }
  const residuals = [];
  for (const target of targets) {
    const tree = await inspectDocTree(
      db.collection(target.collection).doc(target.id),
      target.allowedSubs,
      target.collection + '/' + target.id,
    );
    if (treeHasData(tree)) residuals.push(tree.path);
  }
  return residuals;
}

export async function eraseSubscriberData(db, email, auth, opts = {}) {
  assertDb(db);
  assertAuth(auth);
  if (opts && opts.dryRun === false && opts.apply !== true) {
    throw new EraseSubscriberDataError(
      'la cancellazione richiede opts.apply === true; il default resta dry-run',
      { phase: 'input' },
    );
  }
  const apply = opts?.apply === true;
  const dryRun = !apply;
  const before = await inventorySubscriberData(db, email, auth);
  const deleted = emptyDeletedReport();

  if (apply) {
    try {
      deleted.newsletter = await deleteDocTree(
        db,
        db.collection(NEWSLETTER_COLLECTION).doc(before.email),
        NEWSLETTER_SUBS,
      );
      for (const hit of before.newsletter.extraDocs || []) {
        deleted.extraNewsletterDocs.push({
          id: hit.id,
          fields: hit.fields,
          ...(await deleteDocTree(
            db,
            db.collection(NEWSLETTER_COLLECTION).doc(hit.id),
            NEWSLETTER_SUBS,
          )),
        });
      }

      deleted.jobAlert = await deleteDocTree(
        db,
        db.collection(JOB_ALERT_COLLECTION).doc(before.email),
        JOB_ALERT_SUBS,
      );
      for (const hit of before.jobAlert.extraDocs || []) {
        deleted.extraJobAlertDocs.push({
          id: hit.id,
          fields: hit.fields,
          ...(await deleteDocTree(
            db,
            db.collection(JOB_ALERT_COLLECTION).doc(hit.id),
            JOB_ALERT_SUBS,
          )),
        });
      }

      for (const user of before.users) {
        deleted.users.push({
          id: user.id,
          fields: user.fields,
          ...(await deleteDocTree(
            db,
            db.collection(USERS_COLLECTION).doc(user.id),
            USER_SUBS,
          )),
        });
      }

      for (const store of EXTRA_EMAIL_STORES) {
        const rows = [];
        for (const hit of before.extra[store.collection] || []) {
          rows.push({
            id: hit.id,
            fields: hit.fields,
            ...(await deleteDocTree(
              db,
              db.collection(store.collection).doc(hit.id),
              store.subcollections,
            )),
          });
        }
        deleted.extra[store.collection] = rows;
      }

      if (before.authUser.found) {
        await phase(
          'Auth deleteUser ' + before.authUser.uid,
          () => auth.deleteUser(before.authUser.uid),
          true,
        );
        deleted.auth = { uid: before.authUser.uid, deleted: true };
      } else {
        deleted.auth = { uid: null, deleted: false };
      }
    } catch (error) {
      throw contextualize(
        error,
        'apply',
        true,
      );
    }
  }

  const after = await inventorySubscriberData(db, email, auth);
  if (apply) {
    const residuals = [
      ...inventoryResiduals(after),
      ...(await inspectKnownTargets(db, before)),
    ];
    if (residuals.length > 0) {
      throw new EraseSubscriberDataError(
        'verifica finale fallita; dati residui: ' + [...new Set(residuals)].join(', '),
        { phase: 'verify', partial: true },
      );
    }
  }

  return {
    email: before.email,
    apply,
    dryRun,
    before,
    deleted,
    after,
  };
}

function summarizeTree(tree) {
  if (!tree) return 'not found';
  const subs = JSON.stringify(tree.subcollections || {});
  return (tree.exists ? 'exists' : 'not found') + ' subs=' + subs;
}

function summarizeHits(hits) {
  if (!hits || hits.length === 0) return '0';
  return hits
    .map((hit) => hit.id + '[' + hit.fields.join(',') + '] ' + summarizeTree(hit))
    .join('; ');
}

export function formatEraseReport(result) {
  const lines = [];
  lines.push('email=' + result.email);
  lines.push('mode=' + (result.apply ? 'APPLY_VERIFIED' : 'DRY_RUN'));
  lines.push('BEFORE newsletter_subscribers/' + result.email + ' ' + summarizeTree(result.before.newsletter));
  lines.push('BEFORE job_alert_subscribers/' + result.email + ' ' + summarizeTree(result.before.jobAlert));
  lines.push('BEFORE users=' + summarizeHits(result.before.users));
  lines.push('BEFORE auth=' + (
    result.before.authUser.found
      ? 'uid=' + result.before.authUser.uid
      : result.before.authUser.error
  ));
  for (const store of EXTRA_EMAIL_STORES) {
    lines.push(
      'BEFORE ' + store.collection + '='
      + summarizeHits(result.before.extra[store.collection]),
    );
  }
  if (result.apply) {
    lines.push('DELETED newsletter=' + JSON.stringify(result.deleted.newsletter));
    lines.push(
      'DELETED newsletterExtra=' + JSON.stringify(result.deleted.extraNewsletterDocs),
    );
    lines.push('DELETED jobAlert=' + JSON.stringify(result.deleted.jobAlert));
    lines.push(
      'DELETED jobAlertExtra=' + JSON.stringify(result.deleted.extraJobAlertDocs),
    );
    lines.push('DELETED users=' + JSON.stringify(result.deleted.users));
    lines.push('DELETED extra=' + JSON.stringify(result.deleted.extra));
    lines.push('DELETED auth=' + JSON.stringify(result.deleted.auth));
    lines.push('AFTER_VERIFICATION residuals=0');
  } else {
    lines.push('DRY_RUN no writes performed');
  }
  return lines.join('\n');
}
