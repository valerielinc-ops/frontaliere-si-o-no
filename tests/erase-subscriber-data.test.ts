import { describe, expect, it } from 'vitest';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELETE_PAGE_SIZE,
  JOB_ALERT_COLLECTION,
  NEWSLETTER_COLLECTION,
  eraseSubscriberData,
  formatEraseReport,
  inventorySubscriberData,
} from '@/scripts/lib/eraseSubscriberData.mjs';
import { parseArgs, run } from '@/scripts/erase-subscriber-data.mjs';

type Row = Record<string, unknown>;

type FakeOptions = {
  failGetPaths?: Set<string>;
  failListPaths?: Set<string>;
  failQueryKeys?: Set<string>;
  failDeletePaths?: Set<string>;
  ignoreDeletePaths?: Set<string>;
  failCommitAt?: number;
};

function errorWithCode(message: string, code: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function makeFakeDb(seed: Record<string, Row> = {}, options: FakeOptions = {}) {
  const docs = new Map<string, Row>(Object.entries(seed));
  let commitCount = 0;
  let directDeleteCount = 0;
  const batchSizes: number[] = [];

  function directChildren(path: string, matcher: (row: Row) => boolean = () => true) {
    const prefix = path + '/';
    return [...docs.entries()]
      .filter(([docPath, row]) => {
        const rest = docPath.startsWith(prefix) ? docPath.slice(prefix.length) : '';
        return Boolean(rest) && !rest.includes('/') && matcher(row);
      })
      .sort(([a], [b]) => a.localeCompare(b));
  }

  function docRef(path: string) {
    return {
      id: path.split('/').pop() as string,
      path,
      get: async () => {
        if (options.failGetPaths?.has(path)) throw new Error('read failed: ' + path);
        return {
          exists: docs.has(path),
          id: path.split('/').pop(),
          ref: docRef(path),
          data: () => docs.get(path),
        };
      },
      delete: async () => {
        directDeleteCount += 1;
        if (options.failDeletePaths?.has(path)) throw new Error('delete failed: ' + path);
        if (!options.ignoreDeletePaths?.has(path)) docs.delete(path);
      },
      collection: (name: string) => colRef(path + '/' + name),
      listCollections: async () => {
        if (options.failListPaths?.has(path)) {
          throw new Error('listCollections failed: ' + path);
        }
        const prefix = path + '/';
        const names = new Set<string>();
        for (const docPath of docs.keys()) {
          if (!docPath.startsWith(prefix)) continue;
          const rest = docPath.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first && rest.includes('/')) names.add(first);
        }
        return [...names].sort().map((id) => ({ id }));
      },
    };
  }

  function queryRef(
    path: string,
    matcher: (row: Row) => boolean = () => true,
    pageSize: number | null = null,
    cursorPath: string | null = null,
    queryKey = path,
  ) {
    return {
      limit: (size: number) => queryRef(path, matcher, size, cursorPath, queryKey),
      startAfter: (cursor: { ref?: { path?: string }; path?: string }) => queryRef(
        path,
        matcher,
        pageSize,
        cursor.ref?.path || cursor.path || null,
        queryKey,
      ),
      get: async () => {
        if (options.failQueryKeys?.has(queryKey)) {
          throw new Error('query failed: ' + queryKey);
        }
        if (!pageSize) throw new Error('fake query used without limit');
        let rows = directChildren(path, matcher);
        if (cursorPath) {
          const cursorIndex = rows.findIndex(([docPath]) => docPath === cursorPath);
          if (cursorIndex === -1) throw new Error('cursor not found: ' + cursorPath);
          rows = rows.slice(cursorIndex + 1);
        }
        const page = rows.slice(0, pageSize);
        return {
          empty: page.length === 0,
          size: page.length,
          docs: page.map(([docPath, row]) => ({
            id: docPath.split('/').pop(),
            ref: docRef(docPath),
            data: () => row,
          })),
        };
      },
    };
  }

  function colRef(path: string) {
    const base = queryRef(path);
    return {
      doc: (id: string) => docRef(path + '/' + id),
      where: (field: string, _operator: string, value: unknown) => queryRef(
        path,
        (row) => row[field] === value,
        null,
        null,
        path + '|' + field,
      ),
      limit: base.limit,
      startAfter: base.startAfter,
      get: base.get,
    };
  }

  return {
    docs,
    stats: {
      get commitCount() {
        return commitCount;
      },
      get directDeleteCount() {
        return directDeleteCount;
      },
      batchSizes,
    },
    collection: (name: string) => colRef(name),
    batch: () => {
      const paths: string[] = [];
      return {
        delete: (ref: { path: string }) => paths.push(ref.path),
        commit: async () => {
          commitCount += 1;
          batchSizes.push(paths.length);
          if (options.failCommitAt === commitCount) {
            throw new Error('batch commit failed at ' + commitCount);
          }
          for (const path of paths) {
            if (!options.ignoreDeletePaths?.has(path)) docs.delete(path);
          }
        },
      };
    },
  };
}

function makeFakeAuth(
  initial: { email: string; uid: string } | null,
  options: { getError?: Error; deleteError?: Error } = {},
) {
  let record = initial;
  let deleteCalls = 0;
  return {
    get deleteCalls() {
      return deleteCalls;
    },
    getUserByEmail: async (email: string) => {
      if (options.getError) throw options.getError;
      if (!record || record.email !== email) {
        throw errorWithCode('Auth user not found', 'auth/user-not-found');
      }
      return { uid: record.uid };
    },
    deleteUser: async (uid: string) => {
      deleteCalls += 1;
      if (options.deleteError) throw options.deleteError;
      if (record?.uid === uid) record = null;
    },
  };
}

const EMAIL = 'tester@example.com';
const OTHER = 'keep-me@example.com';

function seedAll(): Record<string, Row> {
  return {
    [NEWSLETTER_COLLECTION + '/' + EMAIL]: { email: EMAIL, status: 'confirmed' },
    [NEWSLETTER_COLLECTION + '/' + EMAIL + '/events/e1']: { event_type: 'send' },
    [NEWSLETTER_COLLECTION + '/' + EMAIL + '/campaign_deliveries/c1']: { campaign_id: 'weekly' },
    [NEWSLETTER_COLLECTION + '/' + EMAIL + '/private/personalization']: { sector: 'it' },
    [NEWSLETTER_COLLECTION + '/' + OTHER]: { email: OTHER, status: 'confirmed' },
    [NEWSLETTER_COLLECTION + '/_meta_']: { kind: 'meta' },
    [JOB_ALERT_COLLECTION + '/' + EMAIL]: { email: EMAIL, status: 'active' },
    [JOB_ALERT_COLLECTION + '/' + EMAIL + '/alerts/a1']: { keywords: ['it'] },
    [JOB_ALERT_COLLECTION + '/' + EMAIL + '/alert_deliveries/d1']: { sent: true },
    [JOB_ALERT_COLLECTION + '/' + EMAIL + '/events/je1']: { event_type: 'send' },
    [JOB_ALERT_COLLECTION + '/' + OTHER]: { email: OTHER },
    ['users/uid-target']: { email: EMAIL, locale: 'it' },
    ['users/uid-target/savedJobs/job1']: { title: 'Dev' },
    ['users/uid-keep']: { email: OTHER },
    ['contact_submissions/cs1']: { email: EMAIL, message: 'ciao' },
    ['contact_submissions/cs-keep']: { email: OTHER },
    ['consulting_orders/order1']: { customerEmail: EMAIL, status: 'paid' },
    ['applications/app1']: { candidateEmail: EMAIL },
    ['publishers/pub1']: { email: EMAIL },
  };
}

function addManyNewsletterEvents(seed: Record<string, Row>, count: number) {
  for (let i = 0; i < count; i += 1) {
    const id = String(i).padStart(4, '0');
    seed[NEWSLETTER_COLLECTION + '/' + EMAIL + '/events/event-' + id] = { index: i };
  }
}

function expectClean(result: Awaited<ReturnType<typeof eraseSubscriberData>>) {
  expect(result.after.newsletter.exists).toBe(false);
  expect(result.after.jobAlert.exists).toBe(false);
  expect(result.after.users).toHaveLength(0);
  expect(result.after.authUser.error).toBe('user-not-found');
  for (const hits of Object.values(result.after.extra)) {
    expect(hits).toHaveLength(0);
  }
}

describe('operator-only subscriber erasure', () => {
  it('defaults to dry-run in the library and CLI parser', async () => {
    const db = makeFakeDb(seedAll());
    const auth = makeFakeAuth({ email: EMAIL, uid: 'uid-target' });
    const result = await run(['node', 'erase-subscriber-data.mjs', EMAIL], { db, auth });

    expect(result.dryRun).toBe(true);
    expect(result.apply).toBe(false);
    expect(db.stats.commitCount).toBe(0);
    expect(db.docs.has(NEWSLETTER_COLLECTION + '/' + EMAIL)).toBe(true);
    expect(parseArgs(['node', 'script', EMAIL])).toEqual({
      email: EMAIL,
      apply: false,
      dryRun: true,
    });
    expect(parseArgs(['node', 'script', EMAIL, '--apply'])).toEqual({
      email: EMAIL,
      apply: true,
      dryRun: false,
    });
    expect(formatEraseReport(result)).toContain('mode=DRY_RUN');
  });

  it('accepts an explicit dry-run but never treats dryRun false as apply', async () => {
    expect(parseArgs(['node', 'script', EMAIL, '--dry-run']).dryRun).toBe(true);
    await expect(
      eraseSubscriberData(
        makeFakeDb(seedAll()),
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
        { dryRun: false },
      ),
    ).rejects.toMatchObject({ phase: 'input' });
  });

  it('applies only with the explicit apply option and verifies every store', async () => {
    const db = makeFakeDb(seedAll());
    const auth = makeFakeAuth({ email: EMAIL, uid: 'uid-target' });
    const result = await eraseSubscriberData(db, ' ' + EMAIL.toUpperCase() + ' ', auth, { apply: true });

    expect(result.dryRun).toBe(false);
    expect(result.apply).toBe(true);
    expectClean(result);
    expect(db.docs.has(NEWSLETTER_COLLECTION + '/' + OTHER)).toBe(true);
    expect(db.docs.has(NEWSLETTER_COLLECTION + '/_meta_')).toBe(true);
    expect(db.docs.has(JOB_ALERT_COLLECTION + '/' + OTHER)).toBe(true);
    expect(db.docs.has('users/uid-keep')).toBe(true);
    expect(db.docs.has('contact_submissions/cs-keep')).toBe(true);
    expect(formatEraseReport(result)).toContain('mode=APPLY_VERIFIED');
  });

  it('fails closed on Firestore query and listCollections errors', async () => {
    const queryDb = makeFakeDb(seedAll(), {
      failQueryKeys: new Set(['contact_submissions|email']),
    });
    await expect(
      inventorySubscriberData(
        queryDb,
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
      ),
    ).rejects.toMatchObject({ phase: expect.stringMatching(/^query/) });

    const listDb = makeFakeDb(seedAll(), {
      failListPaths: new Set([NEWSLETTER_COLLECTION + '/' + EMAIL]),
    });
    await expect(
      inventorySubscriberData(
        listDb,
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
      ),
    ).rejects.toMatchObject({ phase: expect.stringMatching(/^listCollections/) });
  });

  it('fails closed on every Auth error except user-not-found', async () => {
    const db = makeFakeDb(seedAll());
    const authError = errorWithCode('Auth unavailable', 'auth/internal-error');
    await expect(
      inventorySubscriberData(db, EMAIL, makeFakeAuth(null, { getError: authError })),
    ).rejects.toMatchObject({ phase: 'Auth getUserByEmail' });
    await expect(
      inventorySubscriberData(db, EMAIL, makeFakeAuth(null, { getError: new Error('user-not-found') })),
    ).rejects.toMatchObject({ phase: 'Auth getUserByEmail' });

    const deleteDb = makeFakeDb(seedAll());
    const deleteAuth = makeFakeAuth(
      { email: EMAIL, uid: 'uid-target' },
      { deleteError: errorWithCode('Auth delete unavailable', 'auth/internal-error') },
    );
    await expect(
      eraseSubscriberData(deleteDb, EMAIL, deleteAuth, { apply: true }),
    ).rejects.toMatchObject({ partial: true });
    expect(deleteAuth.deleteCalls).toBe(1);
  });

  it('keeps paginated deletion in batches below Firestore limit', async () => {
    const seed = seedAll();
    addManyNewsletterEvents(seed, DELETE_PAGE_SIZE + 1);
    const db = makeFakeDb(seed);
    const result = await eraseSubscriberData(
      db,
      EMAIL,
      makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
      { apply: true },
    );

    expectClean(result);
    expect(db.stats.batchSizes).toContain(DELETE_PAGE_SIZE);
    expect(db.stats.batchSizes).toContain(1);
    expect(db.stats.batchSizes.every((size) => size <= 450)).toBe(true);
  });

  it('reports a partial failure instead of a successful erase', async () => {
    const db = makeFakeDb(seedAll(), { failCommitAt: 2 });
    await expect(
      eraseSubscriberData(
        db,
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
        { apply: true },
      ),
    ).rejects.toMatchObject({ partial: true });
    expect(db.docs.has(NEWSLETTER_COLLECTION + '/' + EMAIL + '/campaign_deliveries/c1')).toBe(false);
    expect(db.docs.has(NEWSLETTER_COLLECTION + '/' + EMAIL + '/events/e1')).toBe(true);
  });

  it('fails when final verification finds a document that a delete ignored', async () => {
    const db = makeFakeDb(seedAll(), {
      ignoreDeletePaths: new Set([NEWSLETTER_COLLECTION + '/' + EMAIL]),
    });
    await expect(
      eraseSubscriberData(
        db,
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
        { apply: true },
      ),
    ).rejects.toMatchObject({
      phase: 'verify',
      partial: true,
    });
  });

  it('fails closed on an unexpected subcollection', async () => {
    const seed = seedAll();
    seed[NEWSLETTER_COLLECTION + '/' + EMAIL + '/unexpected/x'] = { pii: true };
    await expect(
      eraseSubscriberData(
        makeFakeDb(seed),
        EMAIL,
        makeFakeAuth({ email: EMAIL, uid: 'uid-target' }),
        { apply: true },
      ),
    ).rejects.toMatchObject({ phase: 'listCollections' });
  });
});

function filesUnder(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return filesUnder(child);
    return [child];
  });
}

describe('operator-only surface guard', () => {
  it('does not expose the utility through UI, routes, services, or functions', () => {
    const worktreeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const roots = [
      join(worktreeRoot, 'App.tsx'),
      join(worktreeRoot, 'components'),
      join(worktreeRoot, 'services'),
      join(worktreeRoot, 'functions'),
      join(worktreeRoot, 'server'),
      join(worktreeRoot, 'hooks'),
      join(worktreeRoot, 'build-plugins'),
      join(worktreeRoot, 'infra'),
    ];
    const forbidden = /eraseSubscriberData|erase-subscriber-data/;
    const hits = roots
      .flatMap(filesUnder)
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});
