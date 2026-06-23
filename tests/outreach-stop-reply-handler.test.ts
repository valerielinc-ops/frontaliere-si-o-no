import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — plain .js Cloud Function module, no types
import { handleOutreachStopReply } from '../functions/src/outreachStopReply.js';

// Server-side STOP auto-suppress (follow-up #2620 item 2). This is the path the
// Cloudflare Email Worker hits; it must be secret-gated and must write the
// suppression doc only for an identifiable STOP from a known sender — never a
// public write.

const SECRET = 'shared-test-secret';

/** Minimal fake Firestore: a single contact + a capturing suppression set(). */
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
      if (name === 'employer_outreach_suppression') {
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

describe('handleOutreachStopReply', () => {
  it('rejects a request without the shared secret (403, no write)', async () => {
    const db = fakeDb();
    const res = await handleOutreachStopReply({
      from: 'denise@casale.ch', subject: 'x', body: 'STOP',
      secret: SECRET, providedSecret: 'wrong', db,
    });
    expect(res.status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  it('suppresses a known sender who replies STOP', async () => {
    const db = fakeDb();
    const res = await handleOutreachStopReply({
      from: 'Denise <denise@casale.ch>', subject: 'Re: candidati', body: 'STOP',
      secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('suppressed');
    expect(res.companyKey).toBe('casale-sa');
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].id).toBe('casale-sa');
    expect(db.writes[0].data.source).toBe('stop-reply');
    expect(db.writes[0].data.companyKey).toBe('casale-sa');
  });

  it('does nothing for a non-STOP reply (200, no write)', async () => {
    const db = fakeDb();
    const res = await handleOutreachStopReply({
      from: 'denise@casale.ch', subject: 'Interessati', body: 'quanto costa?',
      secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('no-stop-intent');
    expect(db.writes).toHaveLength(0);
  });

  it('does not suppress an unknown sender (200 unknown-sender, no write)', async () => {
    const db = fakeDb();
    const res = await handleOutreachStopReply({
      from: 'stranger@elsewhere.com', subject: 'STOP', body: '',
      secret: SECRET, providedSecret: SECRET, db,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('unknown-sender');
    expect(db.writes).toHaveLength(0);
  });
});
