/**
 * Account-delete cleanup: Auth onDelete must tombstone email-keyed subscriber
 * docs (client rules deny newsletter delete), confirmation send must refuse,
 * and newsletter→Auth sync must not mint a new user that restarts the cycle.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

vi.mock('firebase-admin', () => ({
  default: {
    firestore: Object.assign(
      () => ({ collection: () => ({ doc: () => ({}) }) }),
      {
        FieldValue: {
          serverTimestamp: () => '__server_ts__',
          delete: () => '__delete__',
          increment: (n: number) => n,
        },
      },
    ),
    auth: () => ({
      getUserByEmail: async () => {
        throw Object.assign(new Error('no injected auth'), { code: 'auth/user-not-found' });
      },
      createUser: async () => {
        throw new Error('admin.auth().createUser must not be reached; inject auth');
      },
    }),
  },
}));

vi.mock('firebase-admin/remote-config', () => ({
  getRemoteConfig: () => ({ getTemplate: async () => ({ parameters: {} }) }),
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
  ensureAdminApp: () => undefined,
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
  getNewsletterTokenPolicyConfig: async () => ({}),
}));

vi.mock('../functions/src/emailCascade.js', () => ({
  isProviderConfigured: vi.fn(() => true),
  sendEmailCascade: vi.fn(async () => ({ sent: [{ messageId: 'msg_1' }], failed: [] })),
  PROVIDERS: [{ id: 'resend' }],
}));

const UID = 'uid-deleted-user';
const EMAIL = 'gone@example.com';

function createFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store: Record<string, Record<string, unknown>> = { ...seed };

  const makeDoc = (path: string): any => ({
    path,
    get: async () => ({
      exists: Object.prototype.hasOwnProperty.call(store, path),
      data: () => store[path],
      ref: makeDoc(path),
    }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      store[path] = opts?.merge ? { ...(store[path] || {}), ...data } : { ...data };
    },
    delete: async () => {
      delete store[path];
    },
    collection: (sub: string) => makeCollection(`${path}/${sub}`),
  });

  let autoId = 0;
  const makeCollection = (colPath: string): any => ({
    doc: (id?: string) => makeDoc(`${colPath}/${id || `auto-${++autoId}`}`),
    limit: (n: number) => ({
      get: async () => {
        const prefix = `${colPath}/`;
        const depth = colPath.split('/').length + 1;
        const ids = Object.keys(store).filter(
          (k) => k.startsWith(prefix) && k.split('/').length === depth,
        );
        const page = ids.slice(0, n);
        return {
          empty: page.length === 0,
          size: page.length,
          docs: page.map((k) => ({
            id: k.split('/').pop(),
            ref: makeDoc(k),
            data: () => store[k],
          })),
        };
      },
    }),
  });

  return {
    store,
    collection: (name: string) => makeCollection(name),
    batch() {
      const ops: Array<() => void> = [];
      return {
        delete(ref: { path: string }) {
          ops.push(() => {
            delete store[ref.path];
          });
        },
        set(ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
          ops.push(() => {
            store[ref.path] = opts?.merge ? { ...(store[ref.path] || {}), ...data } : { ...data };
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          store[ref.path] = { ...(store[ref.path] || {}), ...data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          store[ref.path] = { ...(store[ref.path] || {}), ...data };
        },
      }),
  };
}

function seedDeletedUser(extra: Record<string, Record<string, unknown>> = {}) {
  return createFakeDb({
    [`users/${UID}`]: { email: EMAIL, locale: 'it' },
    [`users/${UID}/savedJobs/job-a`]: { jobId: 'job-a' },
    [`users/${UID}/savedJobs/job-b`]: { jobId: 'job-b' },
    [`newsletter_subscribers/${EMAIL}`]: { status: 'pending', isActive: false, email: EMAIL },
    [`job_alert_subscribers/${EMAIL}`]: { status: 'active', isActive: true, email: EMAIL },
    ...extra,
  });
}

async function cascade() {
  return import('../functions/src/emailCascade.js');
}

beforeEach(async () => {
  vi.clearAllMocks();
  const c = await cascade();
  vi.mocked(c.isProviderConfigured).mockReturnValue(true);
  vi.mocked(c.sendEmailCascade).mockResolvedValue({ sent: [{ messageId: 'msg_1' }], failed: [] } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cleanupUserDataForDeletedAccount', () => {
  it('wipes saved jobs and tombstones newsletter + job-alert docs for the Auth email', async () => {
    const { cleanupUserDataForDeletedAccount, isAccountDeletedTombstone } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = seedDeletedUser();

    const result = await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);

    expect(result.deletedSavedJobs).toBe(2);
    expect(result.tombstonedNewsletter).toBe(true);
    expect(result.tombstonedJobAlert).toBe(true);
    expect(db.store[`users/${UID}`]).toBeUndefined();
    expect(db.store[`users/${UID}/savedJobs/job-a`]).toBeUndefined();
    expect(db.store[`users/${UID}/savedJobs/job-b`]).toBeUndefined();

    const newsletter = db.store[`newsletter_subscribers/${EMAIL}`];
    expect(isAccountDeletedTombstone(newsletter)).toBe(true);
    expect(newsletter.status).toBe('unsubscribed');
    expect(newsletter.isActive).toBe(false);
    expect(newsletter.account_deleted_at).toBeTruthy();

    const jobAlert = db.store[`job_alert_subscribers/${EMAIL}`];
    expect(isAccountDeletedTombstone(jobAlert)).toBe(true);
    expect(jobAlert.status).toBe('inactive');
    expect(jobAlert.isActive).toBe(false);
  });

  it('writes a tombstone even when no subscriber docs existed, so a later create is an update', async () => {
    const { cleanupUserDataForDeletedAccount, isAccountDeletedTombstone } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = createFakeDb({ [`users/${UID}`]: { email: EMAIL } });

    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);

    expect(isAccountDeletedTombstone(db.store[`newsletter_subscribers/${EMAIL}`])).toBe(true);
    expect(isAccountDeletedTombstone(db.store[`job_alert_subscribers/${EMAIL}`])).toBe(true);
  });

  it('still wipes saved jobs when the Auth user has no email', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = seedDeletedUser();

    const result = await cleanupUserDataForDeletedAccount({ uid: UID, email: null }, db as never);

    expect(result.deletedSavedJobs).toBe(2);
    expect(result.tombstonedNewsletter).toBe(false);
    expect(db.store[`newsletter_subscribers/${EMAIL}`].status).toBe('pending');
  });
});

describe('sendNewsletterConfirmationEmail after account-delete cleanup', () => {
  async function send(db: ReturnType<typeof createFakeDb>, purpose?: string) {
    const { sendNewsletterConfirmationEmail } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    return sendNewsletterConfirmationEmail({
      email: EMAIL,
      locale: 'it',
      sourcePath: '/profilo',
      secret: 'test-secret',
      purpose,
      db: db as never,
    });
  }

  it('refuses the send path after cleanup of a pending subscriber', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);

    const result = await send(db);

    expect(result.success).toBe(false);
    expect(result.error).toBe('account_deleted');
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
  });

  it('refuses a login-purpose confirm for the same tombstoned address', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);

    const result = await send(db, 'login');

    expect(result.success).toBe(false);
    expect(result.error).toBe('account_deleted');
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
  });

  it('still sends to a leftover pending doc that has not been cleaned up (signup path)', async () => {
    const db = seedDeletedUser();
    const result = await send(db);
    expect(result.success).toBe(true);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });
});

describe('syncAuthAccountForSubscriber after account-delete cleanup', () => {
  function fakeAuth() {
    const createUser = vi.fn(async ({ email }: { email: string }) => ({ uid: `new-${email}` }));
    const getUserByEmail = vi.fn(async () => {
      throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
    });
    return { createUser, getUserByEmail };
  }

  it('does not createUser for a tombstoned address even when Auth has no user', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const { syncAuthAccountForSubscriber } = await import(
      '../functions/src/newsletterSubscriberAuthSync.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);
    const auth = fakeAuth();

    const result = await syncAuthAccountForSubscriber(EMAIL, { db: db as never, auth: auth as never });

    expect(result).toEqual({ created: false, reason: 'account_deleted' });
    expect(auth.createUser).not.toHaveBeenCalled();
  });

  it('still creates an Auth user for a normal new subscriber', async () => {
    const { syncAuthAccountForSubscriber } = await import(
      '../functions/src/newsletterSubscriberAuthSync.js'
    );
    const db = createFakeDb({
      [`newsletter_subscribers/${EMAIL}`]: { status: 'pending', isActive: false },
    });
    const auth = fakeAuth();

    const result = await syncAuthAccountForSubscriber(EMAIL, { db: db as never, auth: auth as never });

    expect(result.created).toBe(true);
    expect(auth.createUser).toHaveBeenCalledWith({
      email: EMAIL,
      emailVerified: false,
      disabled: false,
    });
  });
});

describe('profile delete path no longer pretends client newsletter delete is the wipe', () => {
  const profileSrc = readFileSync(path.join(REPO_ROOT, 'components/pages/UserProfile.tsx'), 'utf8');
  const indexSrc = readFileSync(path.join(REPO_ROOT, 'functions/index.js'), 'utf8');

  it('does not call deleteDoc on newsletter_subscribers (rules deny it; onDelete tombstones)', () => {
    expect(profileSrc).not.toMatch(/deleteDoc\(\s*doc\(\s*db\s*,\s*['"]newsletter_subscribers['"]/);
    expect(profileSrc).not.toMatch(
      /newsletter_subscribers['"]\s*,\s*normalizedEmail\)\)\.catch\(\(\) => \{\}\)/,
    );
  });

  it('cancels the in-flight profile auto-save before Auth delete', () => {
    const fn = profileSrc.slice(
      profileSrc.indexOf('const handleDeleteAccount'),
      profileSrc.indexOf('const handleExportData'),
    );
    expect(fn).toMatch(/saveTimerRef\.current/);
    expect(fn).toMatch(/clearTimeout\(saveTimerRef\.current\)/);
    expect(fn.indexOf('clearTimeout')).toBeLessThan(fn.indexOf('deleteCurrentUser'));
  });

  it('onDelete passes the Auth user email into the shared cleanup', () => {
    expect(indexSrc).toMatch(/cleanupUserDataForDeletedAccount\(\{\s*uid:\s*user\.uid,\s*email:\s*user\.email\s*\}\)/);
  });
});
