/**
 * Account-delete cleanup: Auth onDelete must tombstone email-keyed subscriber
 * docs (client rules deny newsletter delete), then allow every supported
 * registration path to start a new lifecycle on the same email.
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
    add: async (data: Record<string, unknown>) => {
      store[`${colPath}/auto-${++autoId}`] = data;
    },
    orderBy: () => ({
      limit: () => ({
        get: async () => ({ docs: [] }),
      }),
    }),
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

  it('keeps the tombstones when saved-job cleanup fails, so retries remain safe', async () => {
    const { cleanupUserDataForDeletedAccount, isAccountDeletedTombstone } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const db = seedDeletedUser();
    const originalBatch = db.batch;
    db.batch = (() => ({
      delete: () => {},
      commit: async () => { throw new Error('savedJobs unavailable'); },
    })) as unknown as typeof originalBatch;

    await expect(
      cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never),
    ).rejects.toThrow('savedJobs unavailable');
    expect(isAccountDeletedTombstone(db.store[`newsletter_subscribers/${EMAIL}`])).toBe(true);
    expect(isAccountDeletedTombstone(db.store[`job_alert_subscribers/${EMAIL}`])).toBe(true);
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

  it('refuses a confirmation resend while the subscriber is tombstoned', async () => {
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

  it('refuses a login-purpose confirmation while the address is tombstoned', async () => {
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

  it('does not create an Auth user while the address is still tombstoned', async () => {
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

describe('all supported registration methods after account-delete', () => {
  const SECRET = 'test-secret';

  it('a confirmation-link click starts a new confirmed lifecycle', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const { handleSubscriptionManagement } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );
    const { generateConfirmationToken } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);

    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: EMAIL,
      token: generateConfirmationToken(EMAIL, SECRET),
      secret: SECRET,
      locale: 'it',
      db: db as never,
    });

    expect(result.status).toBe(200);
    expect(result.accountDeleted).toBeUndefined();
    const after = db.store[`newsletter_subscribers/${EMAIL}`];
    expect(after.status).toBe('confirmed');
    expect(after.isActive).toBe(true);
    expect(after.account_deleted_at).toBe('__delete__');
    expect(after.resubscribed_at).toBe('__server_ts__');
  });

  it('a resubscribe POST lifts the tombstone and confirms the new cycle', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const { handleSubscriptionManagement } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );
    const { mintNewsletterActionToken, TOKEN_SCOPES } = await import(
      '../functions/src/lib/newsletterActionToken.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);
    const token = mintNewsletterActionToken(EMAIL, TOKEN_SCOPES.RESUBSCRIBE, { secret: SECRET });

    const result = await handleSubscriptionManagement({
      action: 'resubscribe',
      email: EMAIL,
      token,
      secret: SECRET,
      locale: 'it',
      method: 'POST',
      db: db as never,
    });

    expect(result.status).toBe(200);
    expect(result.resubscribeApplied).toBe(true);
    const after = db.store[`newsletter_subscribers/${EMAIL}`];
    expect(after.status).toBe('confirmed');
    expect(after.isActive).toBe(true);
    expect(after.account_deleted_at).toBe('__delete__');
    expect(after.resubscribed_at).toBe('__server_ts__');
  });

  it('ESP open and click do not recover status on a tombstoned subscriber', async () => {
    const { cleanupUserDataForDeletedAccount, isAccountDeletedTombstone } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const { persistMailtrapEvent } = await import(
      '../functions/src/newsletterMailtrapWebhookCore.js'
    );
    const { positiveEventRecoveryFields } = await import(
      '../functions/src/lib/subscriberReactivation.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);
    const tombstone = db.store[`newsletter_subscribers/${EMAIL}`];

    expect(
      positiveEventRecoveryFields({
        currentStatus: String(tombstone.status || ''),
        event: 'open',
        subscriber: tombstone,
      }),
    ).toEqual({});
    expect(
      positiveEventRecoveryFields({
        currentStatus: 'inactive',
        event: 'click',
        subscriber: { ...tombstone, status: 'inactive' },
      }),
    ).toEqual({});

    await persistMailtrapEvent(db as never, {
      event: 'open',
      email: EMAIL,
      message_id: 'm-open',
      timestamp: 1700000000,
    });
    await persistMailtrapEvent(db as never, {
      event: 'click',
      email: EMAIL,
      message_id: 'm-click',
      url: 'https://frontaliereticino.ch/',
      timestamp: 1700000001,
    });

    const after = db.store[`newsletter_subscribers/${EMAIL}`];
    expect(isAccountDeletedTombstone(after)).toBe(true);
    expect(after.status).toBe('unsubscribed');
    expect(after.isActive).toBe(false);
    expect(after.reactivated_at).toBeUndefined();
  });

  it('an autologin code in a leftover email starts Auth without granting newsletter consent', async () => {
    const { cleanupUserDataForDeletedAccount } = await import(
      '../functions/src/authAccountCleanup.js'
    );
    const { handleSubscriptionManagement } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );
    const { mintAutologinCode, resolveAutologinPolicy } = await import(
      '../functions/src/lib/autologinCode.js'
    );
    const db = seedDeletedUser();
    await cleanupUserDataForDeletedAccount({ uid: UID, email: EMAIL }, db as never);
    const env = { NEWSLETTER_AC_SCHEME: 'v1', NEWSLETTER_AC_TTL_DAYS: '30' };
    const token = mintAutologinCode(EMAIL, { secret: SECRET, env, now: Date.now() });
    const admin = (await import('firebase-admin')).default as any;
    const originalAuth = admin.auth;
    admin.auth = () => ({
      getUserByEmail: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
      }),
      createUser: vi.fn(async () => ({ uid: 'new-autologin-user' })),
      createCustomToken: vi.fn(async () => 'custom-auth-token'),
    });

    try {
      const result = await handleSubscriptionManagement({
        action: 'exchange_auth_code',
        email: EMAIL,
        token,
        secret: SECRET,
        locale: 'it',
        autologinPolicy: resolveAutologinPolicy(env),
        db: db as never,
      });

      expect(result.status).toBe(200);
      expect(result.json).toEqual({ success: true, authToken: 'custom-auth-token' });
      const after = db.store[`newsletter_subscribers/${EMAIL}`];
      expect(after.status).toBe('unsubscribed');
      expect(after.isActive).toBe(false);
      expect(after.account_deleted_at).toBeTruthy();
    } finally {
      admin.auth = originalAuth;
    }
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

  it('configures retries for both tombstone triggers before rethrowing failures', () => {
    const sync = indexSrc.slice(
      indexSrc.indexOf('export const syncNewsletterSubscriberAuth'),
      indexSrc.indexOf('// v1 (not v2/identity\'s beforeUserDeleted)'),
    );
    const cleanup = indexSrc.slice(indexSrc.indexOf('export const cleanupUserDataOnAccountDelete'));
    expect(sync).toMatch(/retry:\s*true/);
    expect(cleanup).toMatch(/functionsV1\.runWith\(\{\s*failurePolicy:\s*true\s*\}\)\.auth\.user\(\)\.onDelete/);
  });

  it('only runs the write trigger for a tombstone when the marker is actually cleared', () => {
    expect(indexSrc).toMatch(/const clearedAccountDeletion = wasAccountDeleted && !isAccountDeletedTombstone\(after\.data\(\)\)/);
    expect(indexSrc).toMatch(/if \(isNewDocument && isAccountDeletedTombstone\(after\.data\(\)\)\) return/);
    expect(indexSrc).toMatch(/if \(!isNewDocument && !clearedAccountDeletion\) return/);
  });

  it('rechecks job-alert backfill when a re-registration clears the tombstone', () => {
    expect(indexSrc).toMatch(/const clearedAccountDeletion = beforeData\s+&& isAccountDeletedTombstone\(beforeData\)\s+&& !isAccountDeletedTombstone\(afterData\)/);
    expect(indexSrc).toMatch(/if \(!signalTierChanged\(beforeData, afterData\) && !clearedAccountDeletion\) return/);
  });

  it('clears local newsletter lifecycle flags after a successful account deletion', () => {
    const fn = profileSrc.slice(
      profileSrc.indexOf('const handleDeleteAccount'),
      profileSrc.indexOf('const handleExportData'),
    );
    expect(fn).toMatch(/localStorage\.removeItem\(['"]newsletter_subscribed['"]\)/);
    expect(fn).toMatch(/localStorage\.removeItem\(['"]newsletter_pending_email['"]\)/);
    expect(fn).toMatch(/localStorage\.removeItem\(['"]newsletter_pending_since['"]\)/);
  });
});
