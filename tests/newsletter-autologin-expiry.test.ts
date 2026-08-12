/**
 * #5685 — the `ac` autologin credential: expiry, revocation, and the one
 * property that must survive both.
 *
 * `ac` was a permanent password mailed to the recipient, copied verbatim into
 * the sending provider's click log, into every anti-phishing scanner that
 * fetches our links, into every forward and every mail archive. It never
 * expired and could not be revoked.
 *
 * The dangerous half of fixing that is not the crypto, it is the blast radius:
 * `ac` is also what makes the SPA-handled unsubscribe link work, and this whole
 * wave exists because of an LPD art. 25/32 complaint about an unsubscribe link
 * that did not work. An expiry that expires the exit would be a worse bug than
 * the one it fixes.
 *
 * So the assertions below come in two families, and the second one is the point:
 *
 *   1. a code stops opening a SESSION — on age, on revocation, on opt-out;
 *   2. a code, or the plain email token, never stops recording an OPT-OUT —
 *      not when expired, not when revoked, not when autologin is disabled, and
 *      not for any value of the policy.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

import {
  dayStamp,
  legacyAutologinCode,
  mintAutologinCode,
  parseAutologinCode,
  resolveAutologinPolicy,
  revokedBeforeMs,
  verifyAutologinCode,
} from '../functions/src/lib/autologinCode.js';
import {
  generateAutologinCode,
  makeAuthenticatedActionUrl,
} from '../functions/src/lib/newsletterUrls.js';
import {
  handleSubscriptionManagement,
  verifyOptOutCredential,
} from '../functions/src/newsletterSubscriptionManagement.js';
import { classifyEmailLink, auditEmailLinksStatic } from '../functions/src/lib/emailLinkAudit.js';

const SECRET = 'test-newsletter-secret-key-2026';
const EMAIL = 'user@example.com';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 12, 10, 0, 0);

const V1 = { NEWSLETTER_AC_SCHEME: 'v1' };
const ttl = (days: number) => ({ ...V1, NEWSLETTER_AC_TTL_DAYS: String(days) });

/** Minimal Firestore double — same shape as tests/newsletter-subscription-management.ts's. */
function createFakeDb(existing: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];
  const makeCollection = (name: string) => ({
    doc: (docId: string) => ({
      set: async (data: Record<string, unknown>) => { sets.push({ collection: name, docId, data }); },
      get: async () => {
        const d = existing[name]?.[docId];
        return { exists: !!d, data: () => d || {} };
      },
      collection: (sub: string) => ({
        add: async (data: Record<string, unknown>) => { adds.push({ collection: `${name}/${docId}/${sub}`, data }); },
        get: async () => ({ forEach: () => {} }),
      }),
    }),
    add: async (data: Record<string, unknown>) => { adds.push({ collection: name, data }); },
  });
  return { collection: makeCollection, __sets: sets, __adds: adds } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the policy defaults to today — merging this changes nothing', () => {
  it('an empty environment mints the pre-#5685 code, byte for byte', () => {
    // The whole rollout hinges on this: senders and the Cloud Function deploy
    // on different schedules, so minting a format the verifier does not yet
    // know would sign every recipient out. The switch is a Remote Config edit,
    // and until it is made the code is the historical HMAC.
    const legacy = createHmac('sha256', SECRET).update('autologin:' + EMAIL).digest('hex');
    expect(mintAutologinCode(EMAIL, { secret: SECRET, env: {} })).toBe(legacy);
    expect(generateAutologinCode(EMAIL, { secret: SECRET })).toBe(legacy);
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an unset / misspelled / half-written scheme value can never switch the format on', () => {
    for (const NEWSLETTER_AC_SCHEME of ['', ' ', 'V2', 'v2', 'true', '1', 'yes', 'legacy']) {
      expect(resolveAutologinPolicy({ NEWSLETTER_AC_SCHEME }).mintScheme).toBe('legacy');
    }
    // Only the deliberate word switches it on — case and stray whitespace in a
    // Remote Config value are forgiven, everything else is not.
    for (const NEWSLETTER_AC_SCHEME of ['v1', 'V1', ' v1 ']) {
      expect(resolveAutologinPolicy({ NEWSLETTER_AC_SCHEME }).mintScheme).toBe('v1');
    }
  });

  it('a missing, zero, negative or junk TTL means no expiry — never an accidental one', () => {
    for (const NEWSLETTER_AC_TTL_DAYS of [undefined, '', '0', '-30', 'thirty', 'NaN']) {
      expect(resolveAutologinPolicy({ NEWSLETTER_AC_TTL_DAYS } as any).ttlDays).toBe(0);
    }
    expect(resolveAutologinPolicy({ NEWSLETTER_AC_TTL_DAYS: '30' }).ttlDays).toBe(30);
  });

  it('an unparsable legacy sunset means never', () => {
    expect(resolveAutologinPolicy({ NEWSLETTER_AC_LEGACY_SUNSET: 'soon' }).legacySunsetMs).toBeNull();
    expect(resolveAutologinPolicy({}).legacySunsetMs).toBeNull();
    expect(resolveAutologinPolicy({ NEWSLETTER_AC_LEGACY_SUNSET: '2026-09-15' }).legacySunsetMs)
      .toBe(Date.parse('2026-09-15'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the v1 code', () => {
  it('carries its issue date in the clear, signed, and is shorter than the code it replaces', () => {
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;
    const parsed = parseAutologinCode(code);
    expect(parsed.scheme).toBe('v1');
    expect(parsed.stamp).toBe(dayStamp(NOW));
    expect(parsed.issuedAtMs).toBe(Math.floor(NOW / DAY) * DAY);
    // `ac`/`ne` are deliberately short — Mailgun drops click tracking above
    // 1000 characters of href — so the replacement may not be longer.
    expect(code.length).toBeLessThan(legacyAutologinCode(EMAIL, SECRET)!.length);
    // URL-safe: it travels as a query parameter through four senders.
    expect(code).toMatch(/^[A-Za-z0-9.]+$/);
  });

  it('is stable for a whole day, so one message still costs one HMAC', () => {
    const a = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW });
    const b = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW + 3600_000 });
    expect(a).toBe(b);
  });

  it('is bound to the address AND to the issue date — neither can be swapped', () => {
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, now: NOW }).authentic).toBe(true);
    expect(verifyAutologinCode('someone@example.com', code, { secret: SECRET, now: NOW }).authentic).toBe(false);
    expect(verifyAutologinCode(EMAIL, code, { secret: 'other-secret', now: NOW }).authentic).toBe(false);
    // Forge a younger date onto a real signature → rejected.
    const forged = `a1.${dayStamp(NOW + 40 * DAY)}.${parseAutologinCode(code).signature}`;
    expect(verifyAutologinCode(EMAIL, forged, { secret: SECRET, now: NOW }).authentic).toBe(false);
  });

  it('rejects malformed shapes without throwing', () => {
    for (const bad of ['', 'a1..', 'a1.zz', 'a1.' + dayStamp(NOW) + '.nothex', 'deadbeef', 'a2.1.' + 'f'.repeat(32)]) {
      const v = verifyAutologinCode(EMAIL, bad, { secret: SECRET, now: NOW });
      expect(v.authentic).toBe(false);
      expect(v.canMintSession).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('family 1 — a code stops opening a session', () => {
  it('a v1 code older than the TTL cannot mint a session', () => {
    const policy = resolveAutologinPolicy(ttl(30));
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;
    const fresh = verifyAutologinCode(EMAIL, code, { secret: SECRET, policy, now: NOW + 29 * DAY });
    const stale = verifyAutologinCode(EMAIL, code, { secret: SECRET, policy, now: NOW + 31 * DAY });
    expect(fresh.canMintSession).toBe(true);
    expect(stale.canMintSession).toBe(false);
    expect(stale.expired).toBe(true);
    expect(stale.authentic).toBe(true); // still ours — just too old to be a session
  });

  it('the TTL is applied at verification time, so it re-judges codes already sent — in BOTH directions', () => {
    // This is the rollback lever: emptying NEWSLETTER_AC_TTL_DAYS un-expires
    // every link in every inbox, with no re-mint and no deploy.
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;
    const later = NOW + 100 * DAY;
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy: resolveAutologinPolicy(ttl(30)), now: later }).canMintSession).toBe(false);
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy: resolveAutologinPolicy(ttl(365)), now: later }).canMintSession).toBe(true);
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy: resolveAutologinPolicy(V1), now: later }).canMintSession).toBe(true);
  });

  it('a legacy code keeps working until the sunset date, then stops minting sessions', () => {
    const code = legacyAutologinCode(EMAIL, SECRET)!;
    const policy = resolveAutologinPolicy({ NEWSLETTER_AC_LEGACY_SUNSET: '2026-09-15' });
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy, now: Date.parse('2026-09-14') }).canMintSession).toBe(true);
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy, now: Date.parse('2026-09-16') }).canMintSession).toBe(false);
    // With no sunset configured it behaves exactly as it did before #5685.
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, policy: resolveAutologinPolicy({}), now: Date.parse('2030-01-01') }).canMintSession).toBe(true);
  });

  it('the revocation watermark invalidates every link issued before it, and nothing after', () => {
    const before = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW - 10 * DAY })!;
    const after = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW + 10 * DAY })!;
    const watermark = NOW;
    expect(verifyAutologinCode(EMAIL, before, { secret: SECRET, now: NOW + 11 * DAY, revokedBefore: watermark }).canMintSession).toBe(false);
    // Self-healing: the NEXT email's code is newer than the watermark and works,
    // which is why this is a watermark and not the counter #5685 proposed —
    // a counter would need all eight senders to read it before minting.
    expect(verifyAutologinCode(EMAIL, after, { secret: SECRET, now: NOW + 11 * DAY, revokedBefore: watermark }).canMintSession).toBe(true);
  });

  it('a legacy code has no issue date, so ANY watermark revokes it — that is what revoking has to mean', () => {
    const code = legacyAutologinCode(EMAIL, SECRET)!;
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, now: NOW, revokedBefore: 1 }).canMintSession).toBe(false);
    expect(verifyAutologinCode(EMAIL, code, { secret: SECRET, now: NOW, revokedBefore: null }).canMintSession).toBe(true);
  });

  it('reads the watermark from every shape Firestore can hand back', () => {
    expect(revokedBeforeMs(NOW)).toBe(NOW);
    expect(revokedBeforeMs('2026-08-12T10:00:00.000Z')).toBe(Date.parse('2026-08-12T10:00:00.000Z'));
    expect(revokedBeforeMs({ toMillis: () => NOW })).toBe(NOW);
    expect(revokedBeforeMs(new Date(NOW))).toBe(NOW);
    // Absent or unreadable must mean "not revoked", never "revoked at 0" —
    // the latter would lock every subscriber out of autologin at once.
    for (const junk of [undefined, null, '', 'not a date', {}, NaN]) {
      expect(revokedBeforeMs(junk as any)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('family 2 — the exit never closes', () => {
  it('canOptOut is authenticity and nothing else: no policy value can take it away', () => {
    const legacy = legacyAutologinCode(EMAIL, SECRET)!;
    const v1old = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW - 400 * DAY })!;
    const hostile = resolveAutologinPolicy({
      NEWSLETTER_AC_SCHEME: 'v1',
      NEWSLETTER_AC_TTL_DAYS: '1',
      NEWSLETTER_AC_LEGACY_SUNSET: '2020-01-01',
    });
    for (const code of [legacy, v1old]) {
      const v = verifyAutologinCode(EMAIL, code, { secret: SECRET, policy: hostile, now: NOW, revokedBefore: NOW });
      expect(v.canMintSession).toBe(false); // dead as a session
      expect(v.canOptOut).toBe(true); // alive as an exit
    }
    // A forged code is not an exit either — authenticity is still required.
    expect(verifyAutologinCode(EMAIL, 'f'.repeat(64), { secret: SECRET }).canOptOut).toBe(false);
  });

  it('verifyOptOutCredential takes the email token OR an autologin code, and says which', () => {
    const emailToken = createHmac('sha256', SECRET).update(EMAIL).digest('hex');
    const code = legacyAutologinCode(EMAIL, SECRET)!;
    expect(verifyOptOutCredential(EMAIL, emailToken, SECRET)).toEqual({ ok: true, viaEmailToken: true, viaAutologin: false });
    expect(verifyOptOutCredential(EMAIL, code, SECRET)).toEqual({ ok: true, viaEmailToken: false, viaAutologin: true });
    expect(verifyOptOutCredential(EMAIL, 'garbage', SECRET).ok).toBe(false);
    expect(verifyOptOutCredential('other@example.com', code, SECRET).ok).toBe(false);
  });

  it('an EXPIRED code still unsubscribes, through the Cloud Function, with no session', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: { status: 'confirmed', isActive: true } } });
    const expired = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW - 400 * DAY })!;
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe', email: EMAIL, token: expired, secret: SECRET, locale: 'it',
      autologinPolicy: resolveAutologinPolicy(ttl(30)), db,
    });
    expect(result.status).toBe(200);
    const set = db.__sets.find((s: any) => s.collection === 'newsletter_subscribers');
    expect(set.data.status).toBe('unsubscribed');
    expect(set.data.isActive).toBe(false);
    const event = db.__adds.find((a: any) => a.collection.includes('/events'));
    expect(event.data.event_type).toBe('unsubscribe');
    expect(event.data.credential).toBe('autologin_code');
  });

  it('a REVOKED code still unsubscribes — revocation kills sessions, not the exit', async () => {
    const db = createFakeDb({
      newsletter_subscribers: { [EMAIL]: { status: 'confirmed', isActive: true, autologin_revoked_before: NOW } },
    });
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW - 10 * DAY })!;
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe', email: EMAIL, token: code, secret: SECRET, locale: 'it', db,
    });
    expect(result.status).toBe(200);
    expect(db.__sets.find((s: any) => s.collection === 'newsletter_subscribers').data.status).toBe('unsubscribed');
  });

  it('a subscriber with autologin_enabled:false can still unsubscribe with their code', async () => {
    // That flag means "do not sign me in from a link". It has never meant
    // "do not let me leave", and reading it that way is how somebody ends up
    // filing an LPD complaint.
    const db = createFakeDb({
      newsletter_subscribers: { [EMAIL]: { status: 'confirmed', isActive: true, autologin_enabled: false } },
    });
    const code = legacyAutologinCode(EMAIL, SECRET)!;
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe', email: EMAIL, token: code, secret: SECRET, locale: 'it', db,
    });
    expect(result.status).toBe(200);
    expect(db.__sets.find((s: any) => s.collection === 'newsletter_subscribers').data.status).toBe('unsubscribed');
  });

  it('the confirmation page hides its resubscribe button after an autologin-code opt-out', async () => {
    // That button re-enters the function with `token` and action=resubscribe,
    // which accepts ONLY the email HMAC. Rendering it would offer a button
    // that answers "Link non valido" — the same defect, one click later.
    //
    // The control is a POST form since #5711, not an `<a href>`, so the marker
    // is the hidden field rather than a query string. The two guards compose:
    // #5685 decides WHICH credential may re-subscribe, #5711 decides HOW the
    // request must arrive, and the page only renders the control when the
    // credential in hand can actually complete it.
    const RESUBSCRIBE_CONTROL = 'name="action" value="resubscribe"';
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: { status: 'confirmed' } } });
    const viaCode = await handleSubscriptionManagement({
      action: 'unsubscribe', email: EMAIL, token: legacyAutologinCode(EMAIL, SECRET)!, secret: SECRET, locale: 'it', db,
    });
    expect(viaCode.html).not.toContain(RESUBSCRIBE_CONTROL);
    expect(viaCode.html).not.toContain('action=resubscribe');

    const db2 = createFakeDb({ newsletter_subscribers: { [EMAIL]: { status: 'confirmed' } } });
    const viaToken = await handleSubscriptionManagement({
      action: 'unsubscribe', email: EMAIL, token: createHmac('sha256', SECRET).update(EMAIL).digest('hex'),
      secret: SECRET, locale: 'it', db: db2,
    });
    expect(viaToken.html).toContain(RESUBSCRIBE_CONTROL);
    // …and never as a link, whatever the credential.
    expect(viaToken.html).not.toMatch(/<a[^>]+href="[^"]*action=resubscribe/);
  });

  it('the widened credential is unsubscribe-ONLY — a stale code can never resubscribe anyone', async () => {
    // The #5672 resurrection loop: reading an old email signed the reader in
    // and put them back on the list. Leaving is always honoured; joining always
    // needs the email token.
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: { status: 'unsubscribed', isActive: false } } });
    const result = await handleSubscriptionManagement({
      action: 'resubscribe', email: EMAIL, token: legacyAutologinCode(EMAIL, SECRET)!, secret: SECRET, locale: 'it', db,
    });
    expect(result.status).toBe(403);
    expect(db.__sets).toHaveLength(0);
  });

  it('the preferences API is not widened either — only unsubscribe takes an autologin code', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    for (const action of ['toggle_autologin', 'toggle_newsletter_subscription', 'get_full_status', 'delete_alert', 'revoke_autologin']) {
      const r = await handleSubscriptionManagement({
        action, email: EMAIL, token: legacyAutologinCode(EMAIL, SECRET)!, secret: SECRET, locale: 'it', db,
      });
      expect(r.status, `${action} must reject an autologin code`).toBe(403);
      expect(r.json?.error).toBe('invalid_token');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exchange_auth_code — the only place a code becomes a session', () => {
  const exchange = (token: string, db: any, env: Record<string, string> = {}) =>
    handleSubscriptionManagement({
      action: 'exchange_auth_code', email: EMAIL, token, secret: SECRET, locale: 'it',
      autologinPolicy: resolveAutologinPolicy(env), db,
    });

  it('refuses an expired code with auth_code_expired, and says the exit is still open', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    const old = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: Date.now() - 400 * DAY })!;
    const r = await exchange(old, db, ttl(30));
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ success: false, error: 'auth_code_expired', optOutEligible: true });
    expect(r.json.authToken).toBeUndefined();
  });

  it('refuses a revoked code with auth_code_revoked', async () => {
    const db = createFakeDb({
      newsletter_subscribers: { [EMAIL]: { autologin_revoked_before: Date.now() } },
    });
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: Date.now() - 10 * DAY })!;
    const r = await exchange(code, db, V1 as any);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ success: false, error: 'auth_code_revoked', optOutEligible: true });
  });

  it('still honours autologin_enabled:false, ahead of expiry and revocation', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: { autologin_enabled: false } } });
    const r = await exchange(legacyAutologinCode(EMAIL, SECRET)!, db);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ success: false, error: 'autologin_disabled', optOutEligible: true });
  });

  it('refuses a forged code WITHOUT reading Firestore — no free read amplifier', async () => {
    let reads = 0;
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => { reads += 1; return { exists: false, data: () => ({}) }; },
          set: async () => {},
          collection: () => ({ add: async () => {}, get: async () => ({ forEach: () => {} }) }),
        }),
      }),
    } as any;
    const r = await handleSubscriptionManagement({
      action: 'exchange_auth_code', email: EMAIL, token: 'a'.repeat(64), secret: SECRET, locale: 'it', db,
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('invalid_auth_code');
    expect(r.json.optOutEligible).toBeUndefined(); // a forgery is not an exit
    expect(reads).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('revoke_autologin', () => {
  it('stamps the watermark and records the event, with the email token', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    const r = await handleSubscriptionManagement({
      action: 'revoke_autologin', email: EMAIL, token: createHmac('sha256', SECRET).update(EMAIL).digest('hex'),
      secret: SECRET, locale: 'it', db,
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(db.__sets.find((s: any) => s.collection === 'newsletter_subscribers').data)
      .toHaveProperty('autologin_revoked_before');
    expect(db.__adds.find((a: any) => a.collection.includes('/events')).data.event_type).toBe('autologin_revoked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the links senders build', () => {
  it('makeAuthenticatedActionUrl now carries a SECOND credential the fallback can use', () => {
    // The four callers (winback, dormant winback, drip, publisher blast) used
    // to ship `ac` alone. Once `ac` can expire, `ac` alone is a link that can
    // stop working; `token` is the credential that only ever opts out.
    const url = makeAuthenticatedActionUrl('unsubscribe', EMAIL, { secret: SECRET });
    const params = new URL(url).searchParams;
    expect(params.get('ac')).toBeTruthy();
    expect(params.get('token')).toBe(createHmac('sha256', SECRET).update(EMAIL).digest('hex'));
    // …and the post-send audit (#5710) still reads it as the shape that works.
    const c = classifyEmailLink(url);
    expect(c.kind).toBe('spa-action');
    expect(c.hasAc).toBe(true);
    const { findings } = auditEmailLinksStatic(
      `<html><body>${'x'.repeat(250)}<a href="${url}">esci</a></body></html>`,
      { channel: 'winback' },
    );
    expect(findings.filter((f: any) => f.severity === 'error')).toEqual([]);
  });

  it('a v1 code survives the audit classifier unchanged', () => {
    const url = makeAuthenticatedActionUrl('unsubscribe', EMAIL, { secret: SECRET })
      .replace(/ac=[^&]+/, `ac=${mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })}`);
    expect(classifyEmailLink(url).hasAc).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the SPA keeps the exit open when the exchange refuses', () => {
  // App.tsx cannot be imported in a unit test (3.7k lines, the whole Firebase
  // graph at module scope), so this is source-level — the same convention
  // tests/sent-email-link-audit.test.ts and tests/preference-center-coverage.ts
  // already use for this file class.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');

  it('routes a failed unsubscribe authentication to the Cloud Function before giving up', () => {
    expect(appSrc).toContain('unsubscribeViaCloudFunction');
    const guard = appSrc.slice(appSrc.indexOf('if (!authenticated) {'));
    const fallbackAt = guard.indexOf('unsubscribeViaCloudFunction');
    const rejectAt = guard.indexOf('Link non valido o scaduto');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeLessThan(rejectAt); // the fallback runs FIRST
  });

  it('offers the fallback for unsubscribe only — never for resubscribe', () => {
    const from = appSrc.indexOf('if (!authenticated) {');
    const guard = appSrc.slice(from, appSrc.indexOf('const [{ getFirestore', from));
    expect(guard.length).toBeGreaterThan(0);
    expect(guard).toMatch(/if \(action === 'unsubscribe'\)[\s\S]{0,400}unsubscribeViaCloudFunction/);
    expect(guard).not.toContain('resubscribeViaCloudFunction');
  });

  it('accepts a link that carries only the email token — the #5672 dead end', () => {
    // `?action=unsubscribe&email=…&token=…` with no `ac` used to be rejected
    // before any request was made. It must now reach the fallback.
    expect(appSrc).toMatch(/else if \(!\(action === 'unsubscribe' && urlParams\.get\('token'\)\)\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the client helper', () => {
  it('asks the Cloud Function to unsubscribe with whatever credential it was given', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
    });
    const { unsubscribeViaCloudFunction } = await import('../services/newsletterSubscribers');
    const out = await unsubscribeViaCloudFunction('User@Example.com', 'abc123');
    expect(out.success).toBe(true);
    expect(calls[0]).toContain('action=unsubscribe');
    expect(calls[0]).toContain('email=user%40example.com'); // normalized, as the HMAC is
    expect(calls[0]).toContain('token=abc123');
    expect(calls[0]).toContain('format=json');
    vi.unstubAllGlobals();
  });

  it('refuses to call anything without a credential', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return { ok: true, json: async () => ({}) } as any; });
    const { unsubscribeViaCloudFunction } = await import('../services/newsletterSubscribers');
    expect((await unsubscribeViaCloudFunction(EMAIL, '')).success).toBe(false);
    expect(called).toBe(false);
    vi.unstubAllGlobals();
  });
});
