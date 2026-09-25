import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .js Cloud Function module, no types
import { handleOutreachReplyTrack } from '../functions/src/outreachReplyTrack.js';

// Server-side reply telemetry (records EVERY inbound cold-email reply so the
// admin dashboard can show "ha risposto sì/no"). Mirrors the secret-gated,
// sender→companyKey path of outreachStopReply but writes to a separate
// employer_outreach_replies collection. Never writes for an unknown sender.

const SECRET = 'shared-test-secret';

/** Minimal fake Firestore: one contact + capturing reply set(). */
function fakeDb({ contactEmail = 'denise@casale.ch', companyKey = 'casale-sa' } = {}) {
  const writes: Array<{ id: string; data: any }> = [];
  return {
    writes,
    collection(name: string) {
      if (name === 'employer_contacts') {
        return {
          async get() {
            return {
              forEach(cb: (d: any) => void) {
                cb({ id: companyKey, data: () => ({ companyKey, email: contactEmail }) });
              },
            };
          },
        };
      }
      if (name === 'employer_outreach_replies') {
        return {
          doc(id: string) {
            return { async set(data: any) { writes.push({ id, data }); } };
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

describe('handleOutreachReplyTrack', () => {
  it('rejects a request without the shared secret (403, no write)', async () => {
    const db = fakeDb();
    const res = await handleOutreachReplyTrack({
      from: 'denise@casale.ch', subject: 'Re: candidati inviati',
      secret: SECRET, providedSecret: 'wrong', db,
    });
    expect(res.status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  it('records a reply from a known sender (200 recorded, replied=true)', async () => {
    const db = fakeDb();
    const res = await handleOutreachReplyTrack({
      from: 'Denise <denise@casale.ch>', subject: 'Re: candidati inviati',
      secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('recorded');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].id).toBe('casale-sa');
    expect(db.writes[0].data.replied).toBe(true);
    expect(db.writes[0].data.lastReplySubject).toBe('Re: candidati inviati');
  });

  it('does not record a reply from an unknown sender (200 unknown-sender, no write)', async () => {
    const db = fakeDb();
    const res = await handleOutreachReplyTrack({
      from: 'stranger@elsewhere.com', subject: 'hello',
      secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('unknown-sender');
    expect(db.writes).toHaveLength(0);
  });

  it('returns no-sender when the From header has no address', async () => {
    const db = fakeDb();
    const res = await handleOutreachReplyTrack({
      from: '', subject: 'x', secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('no-sender');
    expect(db.writes).toHaveLength(0);
  });
});
