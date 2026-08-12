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
  isAutologinRevoked,
  legacyAutologinCode,
  mintAutologinCode,
  parseAutologinCode,
  resolveAutologinPolicy,
  revocationWatermarkFor,
  revokedBeforeMs,
  verifyAutologinCode,
} from '../functions/src/lib/autologinCode.js';
import {
  generateAutologinCode,
  makeAuthenticatedActionUrl,
  wrapAuthenticatedHrefs,
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

  it('cannot be forged out of a legacy code for a crafted address — the two domains do not compose', () => {
    // The draft signed `autologin:v1:<email>:<stamp>` for v1 and
    // `autologin:<email>` for legacy. The first IS the second, with an "email"
    // of `v1:<email>:<stamp>` — so a legacy code minted over that crafted string
    // had the victim's real v1 signature as its first 32 hex characters, and
    // truncation to 128 bits keeps exactly that prefix. Measured against the
    // draft: the forgery verified with canMintSession true. `EMAIL_RE` in
    // functions/src/lib/emailValidation.js accepts the crafted string, so the
    // only thing standing between this and a working forgery was the absence of
    // a path that mints a legacy code over an attacker-supplied address and
    // returns it — a send preview, an admin "show me this recipient's link", an
    // export. One product decision, not a cryptographic margin.
    const stamp = dayStamp(NOW);
    const crafted = `v1:${EMAIL}:${stamp}`;
    const forged = `a1.${stamp}.${legacyAutologinCode(crafted, SECRET)!.slice(0, 32)}`;
    const real = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;

    expect(forged).not.toBe(real);
    expect(verifyAutologinCode(EMAIL, forged, { secret: SECRET, now: NOW }).authentic).toBe(false);
    // The general property, not just this instance: no legacy code over ANY
    // address can produce a v1 signature, because the two messages differ at a
    // position legacy cannot reach and the free-form field is terminal.
    for (const shape of [`v1:${EMAIL}:${stamp}`, `v1:${stamp}:${EMAIL}`, `-v1:${stamp}:${EMAIL}`]) {
      const candidate = `a1.${stamp}.${legacyAutologinCode(shape, SECRET)!.slice(0, 32)}`;
      expect(verifyAutologinCode(EMAIL, candidate, { secret: SECRET, now: NOW }).authentic).toBe(false);
    }
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
    // Self-healing: a later email's code is newer than the watermark and works,
    // which is why this is a watermark and not the counter #5685 proposed —
    // a counter would need all eight senders to read it before minting.
    expect(verifyAutologinCode(EMAIL, after, { secret: SECRET, now: NOW + 11 * DAY, revokedBefore: watermark }).canMintSession).toBe(true);
  });

  it('the boundary that ±10 days never touches: the code minted an HOUR after the revocation', () => {
    // The stamp is day-granular and the revocation is an instant, so "the next
    // email repairs it" was FALSE for the rest of the revocation's own UTC day:
    // revoke at noon, send at 13:00, and the recipient's brand-new code carries
    // that morning's midnight — older than the watermark, refused. The direction
    // is the safe one (a code minted before the revoke must not survive it), so
    // it is kept; what changes is that the boundary is now WRITTEN rather than
    // whatever instant serverTimestamp() produced, and stated: autologin returns
    // with the first email of the FOLLOWING UTC day.
    const noon = Date.UTC(2026, 7, 12, 12, 0, 0);
    const watermark = revocationWatermarkFor(noon);
    expect(new Date(watermark).toISOString()).toBe('2026-08-13T00:00:00.000Z');

    const sameDay = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: noon + 3600_000 })!;
    const nextDay = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: noon + DAY })!;
    const at = (code: string, now: number) =>
      verifyAutologinCode(EMAIL, code, { secret: SECRET, now, revokedBefore: watermark });

    expect(at(sameDay, noon + 2 * 3600_000).canMintSession).toBe(false);
    expect(at(sameDay, noon + 2 * 3600_000).reason).toBe('revoked');
    expect(at(nextDay, noon + DAY + 3600_000).canMintSession).toBe(true);
    // …and through all of it, the exit. A code born revoked still gets its
    // holder off the list.
    expect(at(sameDay, noon + 2 * 3600_000).canOptOut).toBe(true);
  });

  it('a legacy code is revoked wholesale while v1 is minted — and NOT after a rollback to legacy', () => {
    // Undatable, so it is all-or-nothing, and which of the two applies is the
    // rollback lever. Under v1 a watermark kills every legacy code: that is what
    // "revoke everything already sent" has to mean. Under legacy it kills none —
    // otherwise emptying the three Remote Config parameters would leave every
    // subscriber who had ever revoked with a permanently dead autologin, because
    // every code they receive from then on is legacy and no legacy code can be
    // newer than a watermark. The PR's rollback claim is only true with this.
    const code = legacyAutologinCode(EMAIL, SECRET)!;
    const under = (env: Record<string, string>, revokedBefore: number | null) =>
      verifyAutologinCode(EMAIL, code, {
        secret: SECRET, now: NOW, revokedBefore, policy: resolveAutologinPolicy(env),
      }).canMintSession;

    expect(under(V1, 1)).toBe(false);
    expect(under(V1, null)).toBe(true);
    expect(under({}, 1)).toBe(true); // rolled back — the residue does not survive
    expect(under({}, null)).toBe(true);
  });

  it('a code stamped in the FUTURE is immune to both gates, so it is refused on its own terms', () => {
    // Expiry is `now - issuedAt >= ttl` (negative → never true) and revocation is
    // `issuedAt < watermark` (false). A future-dated code therefore survives a
    // TTL of 30 days AND a watermark set to this instant — a permanent credential
    // that the only emergency valve in this design cannot switch off. It costs
    // one sender with a wrong clock, or one caller passing the wrong `now`.
    const code = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW + 400 * DAY })!;
    const v = verifyAutologinCode(EMAIL, code, {
      secret: SECRET, now: NOW, revokedBefore: NOW, policy: resolveAutologinPolicy(ttl(30)),
    });
    expect(v.authentic).toBe(true);
    expect(v.canMintSession).toBe(false);
    expect(v.reason).toBe('future');
    expect(v.canOptOut).toBe(true); // same asymmetry as everywhere else
    // Day granularity means "today's" code already reads as up to a day ahead of
    // the instant it is verified at — the tolerance must not reject that.
    const today = mintAutologinCode(EMAIL, { secret: SECRET, env: V1, now: NOW })!;
    expect(verifyAutologinCode(EMAIL, today, { secret: SECRET, now: NOW }).canMintSession).toBe(true);
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
    // toMatchObject, not toEqual: since #5704 the graded verdicts ride along on
    // the return value so the handler's refusal log can say WHICH credential
    // failed and why. The three fields pinned here are the contract; the
    // verdicts are diagnostics and are asserted in
    // tests/newsletter-action-token.test.ts.
    expect(verifyOptOutCredential(EMAIL, emailToken, SECRET)).toMatchObject({ ok: true, viaEmailToken: true, viaAutologin: false });
    expect(verifyOptOutCredential(EMAIL, code, SECRET)).toMatchObject({ ok: true, viaEmailToken: false, viaAutologin: true });
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
  const emailHmac = createHmac('sha256', SECRET).update(EMAIL).digest('hex');
  const revoke = (db: any, env: Record<string, string>) => handleSubscriptionManagement({
    action: 'revoke_autologin', email: EMAIL, token: emailHmac, secret: SECRET, locale: 'it',
    autologinPolicy: resolveAutologinPolicy(env), db,
  });

  it('stamps the watermark and records the event, with the email token', async () => {
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    const r = await revoke(db, V1);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(db.__sets.find((s: any) => s.collection === 'newsletter_subscribers').data)
      .toHaveProperty('autologin_revoked_before');
    expect(db.__adds.find((a: any) => a.collection.includes('/events')).data.event_type).toBe('autologin_revoked');
    // The caller is told WHEN it takes hold, because it is not "now, and then
    // the next email works" — see the boundary test above.
    expect(Date.parse(r.json.effectiveFrom) % DAY).toBe(0);
  });

  it('REFUSES under the legacy scheme, because there it would be a permanent lock-out', async () => {
    // A legacy code carries no issue date, so it can never be newer than a
    // watermark: revoking while `legacy` is minted kills that subscriber's
    // autologin for good — no future email repairs it and there is no un-revoke
    // API. It also armed a trap for the rollback the PR body promises: flip to
    // v1, somebody revokes, empty the parameters at 3am, and that person is
    // locked out permanently by a state the rollback does not touch. Refusing
    // makes "revocation and v1 are one rollout step" true by construction.
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    const r = await revoke(db, {});
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ success: false, error: 'revocation_requires_v1' });
    expect(db.__sets).toHaveLength(0);
    expect(db.__adds).toHaveLength(0);
  });

  it('and the shared rule is the one the exchange applies — one function, two call sites', () => {
    // exchange_auth_code grades the signature BEFORE reading Firestore (so a
    // forgery costs a hash and no read) and therefore applies the watermark
    // itself. Two copies of the rule is how they drift.
    const v1 = { scheme: 'v1' as const, issuedAtMs: NOW };
    const legacy = { scheme: 'legacy' as const, issuedAtMs: null };
    expect(isAutologinRevoked(v1, NOW + DAY, resolveAutologinPolicy(V1))).toBe(true);
    expect(isAutologinRevoked(v1, NOW - DAY, resolveAutologinPolicy(V1))).toBe(false);
    expect(isAutologinRevoked(v1, null, resolveAutologinPolicy(V1))).toBe(false);
    expect(isAutologinRevoked(legacy, NOW, resolveAutologinPolicy(V1))).toBe(true);
    expect(isAutologinRevoked(legacy, NOW, resolveAutologinPolicy({}))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every minter reaches the policy — including the one inside Cloud Functions', () => {
  const fnDir = path.join(__dirname, '..', 'functions', 'src');

  it('wrapAuthenticatedHrefs mints in the scheme it is given, not the ambient one', () => {
    const html = '<a href="https://frontaliereticino.ch/lavoro/">x</a>';
    const legacyOut = wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET });
    const v1Out = wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET, scheme: 'v1' });
    expect(/ac=[0-9a-f]{64}/.test(legacyOut)).toBe(true);
    expect(/ac=a1\.[0-9a-z]{1,8}\.[0-9a-f]{32}/.test(v1Out)).toBe(true);
  });

  it('no minter under functions/ relies on process.env for the scheme', () => {
    // THE gap this test exists for. `mintAutologinCode` resolves the policy from
    // process.env, which is populated for the eight scripts/ senders by
    // scripts/load-rc-env.mjs — and is EMPTY inside Cloud Functions: NEWSLETTER_AC_*
    // is not in EMAIL_CASCADE_RC_KEYS, functions/ has no .env, and even
    // NEWSLETTER_SECRET is fetched through getNewsletterSecrets() for that reason.
    // So a call site here that omits `scheme` mints legacy for ever, whatever
    // Remote Config says. After NEWSLETTER_AC_LEGACY_SUNSET that means the welcome
    // email — the only email most subscribers ever get — arrives with a code the
    // verifier refuses on sight, silently, with the CI green. The guard has to be
    // a scan: the failure has no import to follow and no runtime error.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        // The builders themselves are the definition, not a call site.
        if (full.endsWith(path.join('lib', 'newsletterUrls.js'))) continue;
        if (full.endsWith(path.join('lib', 'autologinCode.js'))) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const call of src.match(/\b(?:wrapAuthenticatedHrefs|generateAutologinCode|mintAutologinCode)\s*\([\s\S]{0,400}?\)/g) || []) {
          if (!/\bscheme\b/.test(call)) offenders.push(`${path.relative(fnDir, full)} :: ${call.split('\n')[0]}`);
        }
      }
    };
    walk(fnDir);
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the links senders build', () => {
  it('makeAuthenticatedActionUrl ships ONE credential — never the plain email HMAC', async () => {
    // A draft of this PR appended `token` to these links, reasoning that the
    // exit needed a second credential once `ac` expires. It does not: the Cloud
    // Function accepts an authentic `ac` of any age for an opt-out
    // (verifyOptOutCredential), which is the whole separation of powers.
    //
    // And `token` is the WIDER credential, not the narrower one — it is the gate
    // on the entire preferences API below, it never expires, has no revocation
    // watermark, no opt-out, and none of the three policy parameters touch it.
    // Shipping it in four more email families would have widened the exposure
    // #5685 is about, in the commit that narrows `ac`.
    const url = makeAuthenticatedActionUrl('unsubscribe', EMAIL, { secret: SECRET });
    const params = new URL(url).searchParams;
    expect(params.get('ac')).toBeTruthy();
    expect(params.get('token')).toBeNull();
    expect(makeAuthenticatedActionUrl('resubscribe', EMAIL, { secret: SECRET })).not.toContain('token=');

    // What that `token` unlocks, spelled out — this is the list that made adding
    // it to a mailed link the wrong trade.
    const emailHmac = createHmac('sha256', SECRET).update(EMAIL).digest('hex');
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: {} } });
    for (const action of ['get_full_status', 'toggle_newsletter_subscription', 'toggle_autologin']) {
      const r = await handleSubscriptionManagement({
        action, email: EMAIL, token: emailHmac, secret: SECRET, locale: 'it', db,
      });
      expect(r.status, `${action} accepts the plain email HMAC`).toBe(200);
    }
  });

  it('the link still passes the post-send audit with one credential', () => {
    const url = makeAuthenticatedActionUrl('unsubscribe', EMAIL, { secret: SECRET });
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

  const guardSrc = () => {
    const from = appSrc.indexOf('if (!authenticated) {');
    return appSrc.slice(from, appSrc.indexOf('const [{ getFirestore', from));
  };

  it('offers the Cloud Function fallback for unsubscribe only — never for resubscribe', () => {
    const guard = guardSrc();
    expect(guard.length).toBeGreaterThan(0);
    expect(guard).toMatch(/if \(action === 'unsubscribe'\)[\s\S]*?unsubscribeViaCloudFunction/);
    expect(guard).not.toContain('resubscribeViaCloudFunction');
  });

  it('tries EVERY credential in the URL, and never sends the Firebase custom token', () => {
    // `urlParams.get('token') || autologinCode` made one truncated parameter
    // fatal: mail clients wrap long hrefs, a half-copied `token` is non-empty,
    // it wins the `||`, the function refuses it, and the intact `ac` in the same
    // URL is never tried. `legacyAuthToken` must NOT be in the list at all — it
    // is a Firebase custom token, which neither verifyHmacToken nor
    // verifyAutologinCode can accept, so sending it would only put live session
    // material into the function's request log as a query parameter.
    const guard = guardSrc();
    expect(guard).toMatch(/for \(const credential of \[urlParams\.get\('token'\), autologinCode\]\)/);
    expect(guard).not.toMatch(/unsubscribeViaCloudFunction\([^)]*legacyAuthToken/);
    expect(guard).not.toMatch(/credential = [^\n]*legacyAuthToken/);
  });

  it('does NOT make the exit depend on the Cloud Function being up', () => {
    // The regression this catches: before #5685 a failed exchange fell through
    // to the session-less client-side write (firestore.rules makes
    // newsletter_subscribers publicly writable), so a Cloud Function outage did
    // not stop anybody leaving. Routing the exit through that one service and
    // then showing "Link non valido o scaduto" when it blinks would have made
    // leaving strictly LESS reliable than before — in the wave that exists
    // because leaving did not work. So the unsubscribe branch must fall THROUGH
    // the guard, not return from it, whenever an `ac` was present.
    const guard = guardSrc();
    const unsubBranch = guard.slice(
      guard.indexOf("if (action === 'unsubscribe') {"),
      guard.indexOf("} else if ("),
    );
    // The only hard stops inside the unsubscribe branch are "we succeeded" and
    // "there was no `ac` / the function says it is forged".
    expect(unsubBranch).toMatch(/if \(!autologinCode \|\| codeForged\) \{/);
    // …and the write below is reachable without a session.
    expect(appSrc).toMatch(/unsubscribeNewsletterSubscriber\(db, \{/);
  });

  it('keeps "Resta iscritto" working for an authentic code the policy refuses', () => {
    // The mirror defect. `stayUrl` in the win-back email is
    // makeAuthenticatedActionUrl('resubscribe', …), and 25 of 8.641 subscribers
    // carry autologin_enabled:false (production read, 2026-08-12), so their
    // exchange 403s on every send. Before #5685 the failure fell through and
    // they stayed subscribed; dead-ending it would delete people who had just
    // clicked to say they wanted to stay. Only a code the function calls FORGED,
    // or a link with no `ac` at all, stops here — that is the #5672 asymmetry,
    // and it is stricter than the pre-#5685 code, which fell through without
    // ever checking the verdict.
    const guard = guardSrc();
    expect(guard).toMatch(/\} else if \(codeForged \|\| !autologinCode\) \{/);
    expect(appSrc).toMatch(/codeForged = result\.error === 'invalid_auth_code'/);
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
