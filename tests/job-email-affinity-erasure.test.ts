// @vitest-environment node
/**
 * La privacy policy promette che il profilo di affinita' dai clic sparisce
 * SUBITO alla disiscrizione da tutte le comunicazioni e alla cancellazione
 * dell'account, e che resta per le disiscrizioni parziali. Un test per
 * percorso: se uno smette di cancellare, la promessa e' falsa.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { affinityDocId } from '../functions/src/lib/jobEmailAffinity.js';
import { eraseJobEmailAffinityProfile } from '../functions/src/lib/jobEmailAffinityStore.js';
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';
import { generateAllAlertsUnsubToken, handleJobAlertUnsubscribe } from '../functions/src/jobAlertUnsubscribe.js';
import { tombstoneEmailKeyedSubscribers } from '../functions/src/authAccountCleanup.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';
import { buildSubscriberExport } from '../scripts/lib/subscriberExport.mjs';

const SECRET = 'affinity-erasure-secret';
const EMAIL = 'person@example.com';
const PROFILE = `job_email_affinity/${affinityDocId(EMAIL, SECRET)}`;
const LEGACY_TOKEN = createHmac('sha256', SECRET).update(EMAIL).digest('hex');
const REPO_ROOT = path.resolve(__dirname, '..');

const previousSecret = process.env.NEWSLETTER_SECRET;
beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
  else process.env.NEWSLETTER_SECRET = previousSecret;
});

function memoryDb(seed: Record<string, Record<string, unknown>>) {
  const memory = createMemoryFirestore({ [PROFILE]: { clicks: 4, version: 1 }, ...seed });
  // batch.update, used by the job-alert unsubscribe, as a merge write.
  memory.db.batch = () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      update: (ref: any, data: Record<string, unknown>) => ops.push(() => ref.set(data, { merge: true })),
      set: (ref: any, data: Record<string, unknown>, options?: unknown) => ops.push(() => ref.set(data, options)),
      delete: (ref: any) => ops.push(() => ref.delete()),
      async commit() { for (const op of ops) await op(); },
    };
  };
  return memory;
}

describe('eraseJobEmailAffinityProfile', () => {
  it('cancella il profilo dello pseudonimo, non altri', async () => {
    const other = `job_email_affinity/${affinityDocId('other@example.com', SECRET)}`;
    const memory = memoryDb({ [other]: { clicks: 2 } });
    expect(await eraseJobEmailAffinityProfile(memory.db, ' Person@Example.com ', { secret: SECRET })).toEqual({ deleted: true });
    expect(memory.read(PROFILE)).toBeUndefined();
    expect(memory.read(other)).toBeDefined();
  });

  it('senza segreto non cancella un id sbagliato e non lancia', async () => {
    delete process.env.NEWSLETTER_SECRET;
    const memory = memoryDb({});
    expect(await eraseJobEmailAffinityProfile(memory.db, EMAIL, { secret: '' })).toMatchObject({ deleted: false, reason: 'missing_secret' });
    expect(memory.read(PROFILE)).toBeDefined();
  });
});

describe('preference centre (newsletterSubscriptionManagement)', () => {
  it.each([
    ['unsubscribe', { action: 'unsubscribe', method: 'GET' }],
    ['unsubscribe_all', { action: 'unsubscribe_all', method: 'POST' }],
    ['toggle_newsletter_subscription spento', { action: 'toggle_newsletter_subscription', method: 'POST', subscribed: false }],
  ])('%s cancella il profilo', async (_label, args) => {
    const memory = memoryDb({ [`newsletter_subscribers/${EMAIL}`]: { email: EMAIL, status: 'confirmed', isActive: true } });
    const result = await handleSubscriptionManagement({
      ...args, email: EMAIL, token: LEGACY_TOKEN, locale: 'it', secret: SECRET, db: memory.db,
    } as any);
    expect(result.status).toBe(200);
    expect(memory.read(PROFILE)).toBeUndefined();
  });

  it('spegnere solo il bollettino giornaliero lascia il profilo', async () => {
    const memory = memoryDb({ [`newsletter_subscribers/${EMAIL}`]: { email: EMAIL, status: 'confirmed', isActive: true } });
    await handleSubscriptionManagement({
      action: 'set_daily_brief_frequency', dailyBriefFrequency: 'off', method: 'POST',
      email: EMAIL, token: LEGACY_TOKEN, locale: 'it', secret: SECRET, db: memory.db,
    } as any);
    expect(memory.read(PROFILE)).toBeDefined();
  });
});

describe('job alert unsubscribe_all', () => {
  const token = generateAllAlertsUnsubToken(EMAIL, SECRET);
  const alerts = {
    [`job_alert_subscribers/${EMAIL}`]: { status: 'active' },
    [`job_alert_subscribers/${EMAIL}/alerts/a1`]: { active: true },
  };

  it('parziale finche la newsletter arriva ancora: il profilo resta', async () => {
    const memory = memoryDb({ ...alerts, [`newsletter_subscribers/${EMAIL}`]: { status: 'confirmed' } });
    const result = await handleJobAlertUnsubscribe({ action: 'unsubscribe_all', email: EMAIL, token, secret: SECRET, db: memory.db });
    expect(result.status).toBe(200);
    expect(memory.read(`job_alert_subscribers/${EMAIL}/alerts/a1`)?.active).toBe(false);
    expect(memory.read(PROFILE)).toBeDefined();
  });

  it('totale se la newsletter era gia ferma: il profilo sparisce', async () => {
    const memory = memoryDb({ ...alerts, [`newsletter_subscribers/${EMAIL}`]: { status: 'unsubscribed' } });
    await handleJobAlertUnsubscribe({ action: 'unsubscribe_all', email: EMAIL, token, secret: SECRET, db: memory.db });
    expect(memory.read(PROFILE)).toBeUndefined();
  });
});

describe('cancellazione dell account', () => {
  it('tombstoneEmailKeyedSubscribers cancella il profilo', async () => {
    const memory = memoryDb({ [`newsletter_subscribers/${EMAIL}`]: { status: 'confirmed' } });
    const result = await tombstoneEmailKeyedSubscribers(EMAIL, memory.db, { newsletterSecret: SECRET });
    expect(result.affinityProfileErased).toBe(true);
    expect(memory.read(PROFILE)).toBeUndefined();
  });

  it('la Cloud Function passa NEWSLETTER_SECRET da Remote Config alla pulizia', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'functions', 'index.js'), 'utf8');
    const block = source.slice(source.indexOf('export const cleanupUserDataOnAccountDelete'), source.indexOf('export const cleanupUserDataOnAccountDelete') + 1200);
    expect(block).toContain('await getNewsletterSecrets()');
    expect(block).toMatch(/cleanupUserDataForDeletedAccount\([\s\S]*\{ newsletterSecret \}/);
  });
});

/** Doppio permissivo per i webhook: legge vuoto, registra le scritture, cancella davvero. */
function webhookDb() {
  const deleted: string[] = [];
  const doc = (docPath: string): any => ({
    id: docPath.split('/').pop(),
    path: docPath,
    get firestore() { return db; },
    get: async () => ({ exists: false, id: docPath.split('/').pop(), data: () => undefined }),
    set: async () => {},
    update: async () => {},
    create: async () => {},
    delete: async () => { deleted.push(docPath); },
    collection: (name: string) => collection(`${docPath}/${name}`),
  });
  const query = (): any => ({
    where: () => query(), orderBy: () => query(), limit: () => query(), select: () => query(),
    get: async () => ({ empty: true, size: 0, docs: [], forEach: () => {} }),
  });
  const collection = (collectionPath: string): any => ({
    ...query(),
    doc: (id: string) => doc(`${collectionPath}/${id}`),
    add: async () => doc(`${collectionPath}/auto`),
  });
  const db: any = {
    collection,
    doc,
    runTransaction: async (callback: any) => callback({
      get: async (ref: any) => ref.get(), set: () => {}, update: () => {}, create: () => {}, delete: () => {},
    }),
    batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
  };
  return { db, deleted };
}

const complaintEvents = [
  ['resend', (db: any) => applyResendWebhookEvent({ type: 'email.complained', data: { email: EMAIL, tags: { type: 'newsletter' } } }, { db })],
  ['mailgun', (db: any) => persistMailgunEvent(db, { event: 'complained', recipient: EMAIL, tags: [] })],
  ['mailgun unsubscribed', (db: any) => persistMailgunEvent(db, { event: 'unsubscribed', recipient: EMAIL, tags: [] })],
  ['mailjet', (db: any) => persistMailjetEvent(db, { event: 'spam', email: EMAIL })],
  ['mailtrap', (db: any) => persistMailtrapEvent(db, { event: 'spam_complaint', email: EMAIL })],
  ['maileroo', (db: any) => persistMailerooEvent(db, { event_type: 'complained', event_data: { to: EMAIL }, tags: { type: 'newsletter' } })],
] as const;

describe.each(complaintEvents)('webhook %s', (_provider, handle) => {
  it('cancella il profilo su complaint/unsubscribe', async () => {
    process.env.NEWSLETTER_SECRET = SECRET;
    const { db, deleted } = webhookDb();
    await handle(db).catch(() => {});
    expect(deleted).toContain(PROFILE);
  });
});

describe('webhook: un clic non cancella', () => {
  it('mailgun clicked lascia il profilo', async () => {
    process.env.NEWSLETTER_SECRET = SECRET;
    const { db, deleted } = webhookDb();
    await persistMailgunEvent(db, { event: 'clicked', recipient: EMAIL, url: 'https://frontaliereticino.ch/', tags: [] }).catch(() => {});
    expect(deleted).not.toContain(PROFILE);
  });
});

describe('estrazione dei dati (art. 25 LPD)', () => {
  it('include il profilo di affinita con i valori e le date', () => {
    const markdown = buildSubscriberExport({
      email: EMAIL,
      subscriber: { status: 'confirmed' },
      affinity: {
        clicks: 3,
        last_click_at: '2026-10-01T08:00:00.000Z',
        expires_at: '2027-03-30T08:00:00.000Z',
        dimensions: { category: [{ key: 'informatica', weight: 2 }], canton: [{ key: 'TI', weight: 3 }], company_key: [], sector: [] },
      },
    }, { generatedAt: '2026-10-04T00:00:00.000Z' });
    expect(markdown).toContain("## 7. Profilo di interessi per l'ordine degli annunci");
    expect(markdown).toContain('informatica (peso 2.00)');
    expect(markdown).toContain('2027-03-30T08:00:00.000Z');
  });

  it('dice quando non c e profilo e quando non e stato verificato', () => {
    const base = { email: EMAIL, subscriber: { status: 'confirmed' } };
    expect(buildSubscriberExport({ ...base, affinity: null }, { generatedAt: 'x' })).toContain('Nessun profilo');
    expect(buildSubscriberExport(base, { generatedAt: 'x' })).toContain('Non verificato');
  });
});
