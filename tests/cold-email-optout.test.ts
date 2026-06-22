import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { buildSequence, OPTOUT_EMAIL } from '../scripts/generate-cold-emails.mjs';
// @ts-expect-error — plain .mjs helper, no types
import { makeUnsubToken, buildUnsubUrl } from '../scripts/lib/outreach-unsubscribe-token.mjs';
import { createHmac } from 'node:crypto';

// Compliance guard: cold B2B outreach MUST carry an opt-out on every touch
// (Swiss nDSG/GDPR norm + deliverability). Regressing this risks the sending
// domain's reputation, so it's a hard invariant — not a stylistic nit.
describe('cold-email opt-out invariant', () => {
  const seq = buildSequence({
    company: 'Casale SA',
    candidates: 88,
    periodLabel: 'negli ultimi 3 mesi',
    contactName: 'Denise Rossi',
    topRole: 'Magazziniere',
  });

  it('builds the full 4-touch sequence', () => {
    expect(seq.map((m: any) => m.touch)).toEqual([1, 2, 3, 4]);
  });

  it('every touch includes a working opt-out footer', () => {
    expect(OPTOUT_EMAIL).toMatch(/@frontaliereticino\.ch$/);
    for (const m of seq) {
      expect(m.body, `touch ${m.touch} opt-out instruction`).toMatch(/rispondete con "STOP"/);
      expect(m.body, `touch ${m.touch} opt-out address`).toContain(OPTOUT_EMAIL);
    }
  });

  it('every touch carries the {{UNSUB_URL}} one-click placeholder (substituted at send time)', () => {
    for (const m of seq) {
      expect(m.body, `touch ${m.touch} one-click placeholder`).toContain('{{UNSUB_URL}}');
    }
  });
});

// One-click unsubscribe token + URL must agree byte-for-byte with the
// outreachUnsubscribe Cloud Function (HMAC-SHA256 over `outreach_unsub:<key>`
// with NEWSLETTER_SECRET). A drift here = unverifiable one-click links.
describe('outreach unsubscribe token + URL', () => {
  const SECRET = 'test-secret-deterministic';
  const KEY = 'casale-sa';

  it('makeUnsubToken is deterministic and matches the documented HMAC scheme', () => {
    const expected = createHmac('sha256', SECRET).update(`outreach_unsub:${KEY}`).digest('hex');
    expect(makeUnsubToken(KEY, SECRET)).toBe(expected);
    // Deterministic: same inputs → same token.
    expect(makeUnsubToken(KEY, SECRET)).toBe(makeUnsubToken(KEY, SECRET));
  });

  it('buildUnsubUrl produces the canonical signed URL (trailing-slash path, c + t)', () => {
    const url = buildUnsubUrl(KEY, SECRET);
    const token = makeUnsubToken(KEY, SECRET);
    expect(url).toBe(
      `https://frontaliereticino.ch/disiscrivi-outreach/?c=${encodeURIComponent(KEY)}&t=${token}`,
    );
    expect(url).toContain('/disiscrivi-outreach/?');
  });

  it('falls back to the site home when the secret is missing (never emits an unsigned link)', () => {
    expect(buildUnsubUrl(KEY, '')).toBe('https://frontaliereticino.ch/');
  });
});
