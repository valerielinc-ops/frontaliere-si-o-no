// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  openIndexedDbWithSchema,
  type IndexedDbSchema,
} from '@/services/indexedDbSchema';

class FakeRequest {
  result: IDBDatabase | null = null;
  error: DOMException | Error | null = null;
  transaction: IDBTransaction | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class FakeDatabase {
  version: number;
  closed = false;
  private readonly stores: Set<string>;
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  } as unknown as DOMStringList;

  constructor(version: number, stores: Iterable<string>) {
    this.version = version;
    this.stores = new Set(stores);
  }

  createObjectStore(name: string): IDBObjectStore {
    this.stores.add(name);
    return {} as IDBObjectStore;
  }

  deleteObjectStore(name: string): void {
    this.stores.delete(name);
  }

  close(): void {
    this.closed = true;
  }

  storeNames(): string[] {
    return Array.from(this.stores);
  }
}

class FakeIndexedDbFactory {
  private readonly databases = new Map<string, { version: number; stores: Set<string> }>();
  deleteCalls = 0;

  seed(name: string, version: number, stores: string[]): void {
    this.databases.set(name, { version, stores: new Set(stores) });
  }

  snapshot(name: string): { version: number; stores: string[] } | null {
    const database = this.databases.get(name);
    if (!database) return null;
    return { version: database.version, stores: Array.from(database.stores) };
  }

  open(name: string, requestedVersion?: number): IDBOpenDBRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      const existing = this.databases.get(name);
      const version = requestedVersion ?? existing?.version ?? 1;
      if (existing && version < existing.version) {
        request.error = Object.assign(new Error('VersionError'), { name: 'VersionError' });
        request.onerror?.(new Event('error'));
        return;
      }

      const oldVersion = existing?.version ?? 0;
      const database = new FakeDatabase(version, existing?.stores ?? []);
      request.result = database as unknown as IDBDatabase;
      let aborted = false;
      request.transaction = {
        abort: () => {
          aborted = true;
        },
      } as unknown as IDBTransaction;

      if (!existing || version > existing.version) {
        request.onupgradeneeded?.({ oldVersion } as IDBVersionChangeEvent);
      }
      if (aborted) {
        request.error = new Error('Upgrade aborted');
        request.onerror?.(new Event('error'));
        return;
      }

      this.databases.set(name, {
        version: database.version,
        stores: new Set(database.storeNames()),
      });
      request.onsuccess?.(new Event('success'));
    });
    return request as unknown as IDBOpenDBRequest;
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.deleteCalls += 1;
      this.databases.delete(name);
      request.onsuccess?.(new Event('success'));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const SCHEMA: IndexedDbSchema = {
  name: 'firebase-installations-database',
  version: 1,
  stores: [{ name: 'firebase-installations-store' }],
};

describe('openIndexedDbWithSchema()', () => {
  it('repairs a current-version database whose object store is missing', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.seed(SCHEMA.name, SCHEMA.version, []);

    const result = await openIndexedDbWithSchema(SCHEMA, factory as unknown as IDBFactory);

    expect(result.status).toBe('repaired');
    expect(result.db?.objectStoreNames.contains('firebase-installations-store')).toBe(true);
    expect(factory.deleteCalls).toBe(1);
    result.db?.close();
  });

  it('creates the required store during a normal version upgrade', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.seed(SCHEMA.name, 0, []);
    const versionedSchema = { ...SCHEMA, version: 1 };

    const result = await openIndexedDbWithSchema(
      versionedSchema,
      factory as unknown as IDBFactory,
    );

    expect(result.status).toBe('ready');
    expect(factory.deleteCalls).toBe(0);
    expect(factory.snapshot(SCHEMA.name)).toEqual({
      version: 1,
      stores: ['firebase-installations-store'],
    });
    result.db?.close();
  });

  it('never downgrades or deletes a newer SDK-owned database', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.seed(SCHEMA.name, 2, []);

    const result = await openIndexedDbWithSchema(SCHEMA, factory as unknown as IDBFactory);

    expect(result).toEqual({ db: null, status: 'unsupported' });
    expect(factory.deleteCalls).toBe(0);
    expect(factory.snapshot(SCHEMA.name)).toEqual({ version: 2, stores: [] });
  });
});
