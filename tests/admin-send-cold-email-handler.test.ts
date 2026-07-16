import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .js Cloud Function module, no types
import { handleAdminSendColdEmail } from '../functions/src/adminSendColdEmail.js';

// Web-UI cold-email sender core. Admin gate is enforced by the onRequest wrapper
// (functions/index.js); this core enforces the rest server-side: verified email,
// suppression, dedup, single-source body. Transport is injected so no real email
// is sent.

const SECRET = 'test-secret';
const KEY = 'casale-sa';

function fakeDb({ insights, contact, suppression, sends } = {} as any, setThrowsAtIndex = Infinity) {
  const writes: Array<{ coll: string; id: string; data: any }> = [];
  let writeCount = 0;
  const data: Record<string, any> = {
    employer_insights: insights,
    employer_contacts: contact,
    employer_outreach_suppression: suppression,
    employer_outreach_sends: sends,
  };
  return {
    writes,
    collection(coll: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const d = data[coll];
              return d ? { exists: true, data: () => d } : { exists: false, data: () => null };
            },
            async set(payload: any) {
              if (writeCount >= setThrowsAtIndex) throw new Error('Firestore write error');
              writeCount++;
              writes.push({ coll, id, data: payload });
            },
          };
        },
      };
    },
  };
}

function fakeSender() {
  const sent: any[] = [];
  const sendEmail = async (msg: any) => { sent.push(msg); return { messageId: 'msg_123' }; };
  return { sent, sendEmail };
}

const baseInsights = { companyName: 'Casale SA', totals: { candidates: 49 } };
const baseContact = { email: 'denise@casale.ch', contactName: 'Denise Rossi', topRole: 'Infermiere/a' };

describe('handleAdminSendColdEmail', () => {
  it('sends a fresh touch, substitutes the tokenized links, and logs the send', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.to).toBe('denise@casale.ch');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('candidati inviati');
    // Placeholders replaced with real signed URLs (no leftover template tokens).
    expect(sent[0].text).toContain('https://frontaliereticino.ch/azienda/casale-sa/?t=');
    expect(sent[0].text).not.toContain('{{INSIGHTS_URL}}');
    expect(sent[0].text).not.toContain('{{UNSUB_URL}}');
    expect(sent[0].unsubUrl).toContain('/disiscrivi-outreach/?c=casale-sa&t=');
    // html part mirrors the CLI (send-cold-emails.mjs): real <a href> links,
    // not raw plain-text URLs (no leftover template tokens either).
    expect(sent[0].html).toContain('<a href="https://frontaliereticino.ch/azienda/casale-sa/?t=');
    expect(sent[0].html).not.toContain('{{INSIGHTS_URL}}');
    expect(sent[0].html).not.toContain('{{UNSUB_URL}}');
    // Two writes to employer_outreach_sends: pending marker (pre-send) + confirmed (post-send).
    const sendsWrites = db.writes.filter((w) => w.coll === 'employer_outreach_sends');
    expect(sendsWrites).toHaveLength(2);
  });

  it('dedup blocks a pending touch (send_pending marker in pendingTouches)', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact, sends: { pendingTouches: [1] } });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_sent');
    expect(sent).toHaveLength(0);
  });

  it('removes the pending marker when sendEmail throws (retry not blocked)', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact });
    const sendEmail = async () => { throw new Error('network timeout'); };
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('send_failed');
    // Two writes: first adds to pendingTouches, second removes it on send failure.
    const sendsWrites = db.writes.filter((w) => w.coll === 'employer_outreach_sends');
    expect(sendsWrites).toHaveLength(2);
  });

  it('returns tracked:false and keeps pending marker when confirmed Firestore write fails', async () => {
    // First write (pending marker) succeeds; confirmed write (index 1) throws.
    const db = fakeDb({ insights: baseInsights, contact: baseContact }, 1);
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tracked).toBe(false);
    expect(sent).toHaveLength(1);
    // Only the pending write succeeded; confirmed write was blocked.
    const sendsWrites = db.writes.filter((w) => w.coll === 'employer_outreach_sends');
    expect(sendsWrites).toHaveLength(1);
  });

  it('refuses a touch already sent (dedup) unless forced', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact, sends: { touches: [{ touch: 1 }] } });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_sent');
    expect(sent).toHaveLength(0);
  });

  it('re-sends a logged touch when force=true', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact, sends: { touches: [{ touch: 1 }] } });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, force: true, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('refuses if the company opted out (suppression)', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact, suppression: { companyKey: KEY } });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('suppressed');
    expect(sent).toHaveLength(0);
  });

  it('refuses when there is no verified email (never sends to an inferred guess)', async () => {
    const db = fakeDb({ insights: baseInsights, contact: { contactName: 'Denise', emailInferred: 'guess@casale.ch' } });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_verified_email');
    expect(sent).toHaveLength(0);
  });

  it('rejects an invalid touch number', async () => {
    const db = fakeDb({ insights: baseInsights, contact: baseContact });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 9, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_touch');
    expect(sent).toHaveLength(0);
  });

  it('404s when the company has no insights doc', async () => {
    const db = fakeDb({ contact: baseContact });
    const { sent, sendEmail } = fakeSender();
    const res = await handleAdminSendColdEmail({ companyKey: KEY, touch: 1, secret: SECRET, db, sendEmail });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
