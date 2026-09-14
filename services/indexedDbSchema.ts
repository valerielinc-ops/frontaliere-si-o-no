/**
 * Open one of the site's own IndexedDB databases with a verified schema.
 *
 * IndexedDB only fires `upgradeneeded` when the requested version is newer
 * than the stored version. A database can therefore exist at the current
 * version while its required object store is missing (for example after a
 * WebKit storage-process failure). The SDK/cache code would otherwise reach
 * `transaction(storeName)` and reject with InvalidStateError.
 *
 * This helper is intentionally opt-in and name-scoped. Callers must pass a
 * database they own; it never enumerates or deletes arbitrary user databases.
 * A missing store at the current version is repaired by deleting and
 * recreating that app-owned database. A newer version is never downgraded or
 * deleted: the caller gets `unsupported` and can use its non-IDB fallback.
 */

export interface IndexedDbStoreSchema {
  readonly name: string;
  readonly options?: IDBObjectStoreParameters;
}

export interface IndexedDbSchema {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly IndexedDbStoreSchema[];
  /** Additional migrations for versions owned by the caller. */
  readonly onUpgrade?: (db: IDBDatabase, oldVersion: number) => void;
}

export type IndexedDbSchemaStatus =
  | 'ready'
  | 'repaired'
  | 'unavailable'
  | 'blocked'
  | 'unsupported'
  | 'invalid';

export interface IndexedDbSchemaResult {
  readonly db: IDBDatabase | null;
  readonly status: IndexedDbSchemaStatus;
}

type IndexedDbFactory = Pick<IDBFactory, 'open' | 'deleteDatabase'>;

interface OpenResult {
  readonly db: IDBDatabase | null;
  readonly error?: DOMException | Error | null;
  readonly blocked?: boolean;
}

function defaultFactory(): IndexedDbFactory | null {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return null;
  return indexedDB;
}

function hasRequiredStores(db: IDBDatabase, schema: IndexedDbSchema): boolean {
  return schema.stores.every((store) => db.objectStoreNames.contains(store.name));
}

function safeClose(db: IDBDatabase | null): void {
  try {
    db?.close();
  } catch {
    // A closed/invalid connection is already unusable; continue the fallback.
  }
}

function statusForOpenFailure(result: OpenResult): IndexedDbSchemaStatus {
  if (result.blocked) return 'blocked';
  if (result.error?.name === 'VersionError') return 'unsupported';
  return 'unavailable';
}

function openAtVersion(
  factory: IndexedDbFactory,
  schema: IndexedDbSchema,
): Promise<OpenResult> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(schema.name, schema.version);
    } catch (error) {
      resolve({ db: null, error: error instanceof Error ? error : null });
      return;
    }

    let settled = false;
    const finish = (result: OpenResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.onupgradeneeded = (event) => {
      try {
        schema.onUpgrade?.(request.result, event.oldVersion);
        for (const store of schema.stores) {
          if (!request.result.objectStoreNames.contains(store.name)) {
            request.result.createObjectStore(store.name, store.options);
          }
        }
      } catch (error) {
        // Aborting leaves the request's error visible to onerror. Some
        // browser implementations throw while calling abort on an already
        // aborted upgrade transaction, hence the defensive catch.
        try {
          request.transaction?.abort();
        } catch {
          // The request will still settle through onerror/onblocked.
        }
        if (error instanceof Error) {
          // Keep the error attached to the request when the implementation
          // does not expose one after an upgrade callback throws.
          finish({ db: null, error });
        }
      }
    };
    request.onsuccess = () => finish({ db: request.result });
    request.onerror = () => finish({ db: null, error: request.error });
    request.onblocked = () => finish({ db: null, blocked: true });
  });
}

function deleteDatabase(
  factory: IndexedDbFactory,
  name: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(name);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    request.onsuccess = () => finish(true);
    request.onerror = () => finish(false);
    request.onblocked = () => finish(false);
  });
}

/**
 * Open a schema-checked database. The returned connection belongs to the
 * caller and must be closed when it is no longer needed.
 */
export async function openIndexedDbWithSchema(
  schema: IndexedDbSchema,
  factory: IndexedDbFactory | null = defaultFactory(),
): Promise<IndexedDbSchemaResult> {
  if (!factory) return { db: null, status: 'unavailable' };

  const opened = await openAtVersion(factory, schema);
  if (!opened.db) {
    return { db: null, status: statusForOpenFailure(opened) };
  }
  if (hasRequiredStores(opened.db, schema)) {
    return { db: opened.db, status: 'ready' };
  }

  // The requested version was accepted, so this is a current-version (or
  // older-version) database with a broken schema. Never delete a newer
  // version; openAtVersion would normally report VersionError for it, but the
  // explicit check also protects test doubles and unusual browser behaviour.
  if (opened.db.version > schema.version) {
    safeClose(opened.db);
    return { db: null, status: 'unsupported' };
  }
  safeClose(opened.db);

  // Only app-owned cache/SDK databases reach this branch. Deletion is the
  // only reliable way to make an IndexedDB upgrade transaction run again at
  // an already-used version, and it discards cache/installation metadata only.
  if (!(await deleteDatabase(factory, schema.name))) {
    return { db: null, status: 'blocked' };
  }

  const repaired = await openAtVersion(factory, schema);
  if (!repaired.db) {
    return { db: null, status: statusForOpenFailure(repaired) };
  }
  if (!hasRequiredStores(repaired.db, schema)) {
    safeClose(repaired.db);
    return { db: null, status: 'invalid' };
  }
  return { db: repaired.db, status: 'repaired' };
}
