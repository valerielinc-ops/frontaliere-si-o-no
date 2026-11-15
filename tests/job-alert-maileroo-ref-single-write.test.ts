/**
 * Un solo riferimento Maileroo per email (perf-plan PR 4a).
 *
 * Fino alla PR 4a ogni email dei job alert scriveva due volte lo STESSO documento
 * `newsletter_subscribers/_meta_/maileroo_refs/{messageId}`: una volta il wrapper
 * del cascade (makeMailerooRefOnSent) e una il sender (mailerooMetaOnSent).
 * Verificato prima di toglierne una: stesso id (il messageId), stessi campi
 * (email normalizzata, campaign_id 'job-alert', is_job_alert true, updated_at),
 * stessa semantica `merge: true`. Ora scrive solo il cascade, e il sender gli dice
 * con quale canale (`mailerooRefChannel`), cosi' il documento non dipende dal nome
 * dello script d'ingresso.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sets: Array<{ path: string; data: any; merge: boolean }> = [];

function pathOf(segments: string[]) { return segments.join('/'); }
function fakeDb() {
  const node = (segments: string[]): any => ({
    collection: (name: string) => ({ doc: (id: string) => node([...segments, name, id]) }),
    set: async (data: any, opts: any) => { sets.push({ path: pathOf(segments), data, merge: !!opts?.merge }); },
  });
  return { collection: (name: string) => ({ doc: (id: string) => node([name, id]) }) };
}

vi.mock('../scripts/lib/firestore-admin.mjs', () => ({ getFirestoreDb: async () => fakeDb() }));

// Il cascade di base consegna il messaggio e chiama onSent come farebbe con Maileroo.
vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: vi.fn(async (emails: any[], opts: any) => {
    const sent: any[] = [];
    for (const [index, item] of emails.entries()) {
      const result = { provider: 'maileroo', messageId: `msg-${index + 1}`, scheduledFor: null };
      if (opts.onSent) await opts.onSent(item, result);
      sent.push({ ...item, ...result });
    }
    return { sent, accepted: sent, ambiguous: [], failed: [], providerBreakdown: {} };
  }),
}));

const item = (email: string, type = 'job-alert') => ({
  payload: { to: [email], subject: 's', html: '<p>x</p>', tags: [{ name: 'type', value: type }] },
  recipient: { email },
  meta: { type },
});

describe('Maileroo ref: one write per job-alert email', () => {
  beforeEach(() => { sets.length = 0; vi.clearAllMocks(); });

  it('the cascade wrapper writes exactly one ref per email, as a job alert, whatever the entry script', async () => {
    const { sendEmailCascade } = await import('../scripts/lib/email-cascade.mjs');
    const onSent = vi.fn(async () => {});
    await sendEmailCascade([item('  Seeker@Example.TEST '), item('b@example.test')] as any, {
      mailerooRefChannel: 'job-alert',
      onSent,
      quiet: true,
    } as any);
    const refs = sets.filter((entry) => entry.path.includes('maileroo_refs'));
    expect(refs.map((entry) => entry.path)).toEqual([
      'newsletter_subscribers/_meta_/maileroo_refs/msg-1',
      'newsletter_subscribers/_meta_/maileroo_refs/msg-2',
    ]);
    expect(refs[0]).toMatchObject({
      merge: true,
      data: { email: 'seeker@example.test', campaign_id: 'job-alert', is_job_alert: true },
    });
    // The caller's own onSent still runs, after the ref.
    expect(onSent).toHaveBeenCalledTimes(2);
  });

  it('the retry path (job-alert-retry tag) gets the same single write with the same fields', async () => {
    const { sendEmailCascade } = await import('../scripts/lib/email-cascade.mjs');
    await sendEmailCascade([item('retry@example.test', 'job-alert-retry')] as any, {
      mailerooRefChannel: 'job-alert',
      quiet: true,
    } as any);
    const refs = sets.filter((entry) => entry.path.includes('maileroo_refs'));
    expect(refs).toHaveLength(1);
    expect(refs[0].data).toMatchObject({ campaign_id: 'job-alert', is_job_alert: true, email: 'retry@example.test' });
  });

  it('without the override the channel still comes from the entry script (other senders are unchanged)', async () => {
    const { sendEmailCascade } = await import('../scripts/lib/email-cascade.mjs');
    await sendEmailCascade([item('n@example.test')] as any, { quiet: true } as any);
    const refs = sets.filter((entry) => entry.path.includes('maileroo_refs'));
    expect(refs).toHaveLength(1);
    // The test runner is not send-job-alerts.mjs, so the channel is the entry's own name.
    expect(refs[0].data.is_job_alert).toBe(false);
  });

  it('no ref for another provider or a missing message id', async () => {
    const base = await import('../functions/src/emailCascade.js');
    (base.sendEmailCascade as any).mockImplementationOnce(async (emails: any[], opts: any) => {
      await opts.onSent(emails[0], { provider: 'resend', messageId: 'x' });
      await opts.onSent(emails[0], { provider: 'maileroo' });
      return { sent: [], accepted: [], ambiguous: [], failed: [], providerBreakdown: {} };
    });
    const { sendEmailCascade } = await import('../scripts/lib/email-cascade.mjs');
    await sendEmailCascade([item('n@example.test')] as any, { mailerooRefChannel: 'job-alert', quiet: true } as any);
    expect(sets).toHaveLength(0);
  });
});
