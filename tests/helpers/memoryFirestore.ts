/**
 * In-memory Firestore for unit tests of Admin-SDK code: nested collections,
 * get/set (with Firestore's deep `merge`), delete, add, a single-field
 * `where` with `limit`, and sequential `runTransaction`. Documents are keyed
 * by their full path ("a/1/b/2"), so a test can read any of them directly.
 */

type Data = Record<string, any>;

function isPlainObject(value: unknown): value is Data {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Data, patch: Data): Data {
  const out: Data = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function fieldSegments(field: unknown): string[] {
  if (typeof field === 'string') return field.split('.').filter(Boolean);
  const segments = (field as any)?._segments;
  return Array.isArray(segments) ? segments.map(String).filter(Boolean) : [];
}

function valueAtPath(source: Data, segments: string[]): { found: boolean; value?: unknown } {
  let current: any = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function setAtPath(target: Data, segments: string[], value: unknown): Data {
  if (!segments.length) return target;
  let current: any = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments[segments.length - 1]] = structuredClone(value);
  return target;
}

function mergeSelectedFields(target: Data, patch: Data, fields: unknown[]): Data {
  const out = structuredClone(target);
  for (const field of fields) {
    const segments = fieldSegments(field);
    const selected = valueAtPath(patch, segments);
    if (selected.found) setAtPath(out, segments, selected.value);
  }
  return out;
}

type SetOptions = { merge?: boolean; mergeFields?: unknown[] };

const OPERATORS: Record<string, (left: any, right: any) => boolean> = {
  'in': (left, right) => Array.isArray(right) && right.includes(left),
  '==': (left, right) => left === right,
  '<=': (left, right) => left != null && left <= right,
  '<': (left, right) => left != null && left < right,
  '>=': (left, right) => left != null && left >= right,
  '>': (left, right) => left != null && left > right,
};

export function createMemoryFirestore(initial: Record<string, Data> = {}) {
  const docs = new Map<string, Data>(Object.entries(initial).map(([path, data]) => [path, structuredClone(data)]));
  let autoId = 0;

  function docRef(path: string): any {
    const id = path.split('/').pop() as string;
    const ref: any = {
      id,
      path,
      async get() {
        const data = docs.get(path);
        return { id, ref, exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
      },
      async set(data: Data, options?: SetOptions) {
        const current = docs.get(path);
        if (Array.isArray(options?.mergeFields)) {
          docs.set(path, mergeSelectedFields(current || {}, data, options.mergeFields));
          return;
        }
        docs.set(path, options?.merge && current ? deepMerge(current, data) : structuredClone(data));
      },
      async delete() {
        docs.delete(path);
      },
      collection(name: string) {
        return collectionRef(`${path}/${name}`);
      },
    };
    return ref;
  }

  function collectionRef(path: string): any {
    const depth = path.split('/').length + 1;
    const list = () => [...docs.keys()]
      .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === depth)
      .sort();
    const query = (filters: Array<[string, string, any]>, max = Infinity, sortField?: string, afterId?: string): any => ({
      where: (field: string, operator: string, value: any) => query([...filters, [field, operator, value]], max, sortField, afterId),
      orderBy: (field: string) => query(filters, max, field, afterId),
      limit: (value: number) => query(filters, value, sortField, afterId),
      startAfter: (cursor: string | { id: string }) => query(filters, max, sortField, typeof cursor === 'string' ? cursor : cursor.id),
      count: () => ({ get: async () => ({ data: () => ({ count: list().filter(key => filters.every(([field, operator, value]) => OPERATORS[operator](docs.get(key)?.[field], value))).slice(0, max).length }) }) }),
      async get() {
        const matching = list().filter((key) => (!afterId || key.split('/').pop()! > afterId)
          && filters.every(([field, operator, value]) => OPERATORS[operator](docs.get(key)?.[field], value)));
        if (sortField && sortField !== '__name__') matching.sort((a, b) => {
          const left = docs.get(a)?.[sortField]; const right = docs.get(b)?.[sortField];
          return left < right ? -1 : left > right ? 1 : a.localeCompare(b);
        });
        const snapshots = await Promise.all(matching.slice(0, max).map((key) => docRef(key).get()));
        return { docs: snapshots, empty: snapshots.length === 0, size: snapshots.length };
      },
    });
    return {
      ...query([]),
      doc: (id?: string) => docRef(`${path}/${id || `auto-${++autoId}`}`),
      async add(data: Data) {
        const ref = docRef(`${path}/auto-${++autoId}`);
        await ref.set(data);
        return ref;
      },
    };
  }

  const db = {
    collection: (name: string) => collectionRef(name),
    async runTransaction<T>(callback: (transaction: any) => Promise<T>): Promise<T> {
      return callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: Data, options?: SetOptions) => ref.set(data, options),
        delete: (ref: any) => ref.delete(),
      });
    },
  };

  return {
    db: db as any,
    docs,
    read: (path: string) => docs.get(path),
    list: (prefix: string) => [...docs.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}
