/**
 * newsletter-action-token.test.ts — one token per ACTION (#5704).
 *
 * The defect: `token` was HMAC(secret, <email>). One string for confirm, for
 * unsubscribe, for resubscribe and for the whole preferences API, minted the
 * same way by four senders and never expiring — so a June confirmation email was
 * still a working re-subscribe button in August, and the "the link is valid for
 * 7 days" the email says in four languages had nothing behind it.
 *
 * The three properties this file pins, in the order they matter:
 *
 *   1. THE EXIT NEVER CLOSES. An unsubscribe token — legacy or v1, of any age,
 *      under any policy — always works. This wave of work exists because of an
 *      LPD art. 25/32 complaint about an unsubscribe link that did not work;
 *      breaking one while fixing a token scheme would be the same harm again.
 *   2. A token is bound to its action. Confirm does not unsubscribe; unsubscribe
 *      does not confirm; neither reaches the preferences API.
 *   3. Backward compatibility is real, and it ENDS on a date — everywhere except
 *      the exit.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOKEN_SCOPES,
  DEFAULT_CONFIRM_TTL_DAYS,
  scopeForAction,
  legacyEmailToken,
  mintNewsletterActionToken,
  parseNewsletterActionToken,
  resolveNewsletterTokenPolicy,
  verifyNewsletterActionToken,
} from '../functions/src/lib/newsletterActionToken.js';
import {
  handleSubscriptionManagement,
  verifyOptOutCredential,
} from '../functions/src/newsletterSubscriptionManagement.js';
import {
  makeUnsubscribeUrl,
  makeOneClickUnsubscribeUrl,
  makeResubscribeUrl,
  makePreferencesUrl,
} from '../functions/src/lib/newsletterUrls.js';
import { generateConfirmationToken } from '../functions/src/newsletterConfirmationEmail.js';

const SECRET = 'test-newsletter-secret-5704';
const EMAIL = 'recipient@example.com';
const DAY_MS = 86_400_000;

/** Everything minted in v1, so the scoping is actually exercised. */
const V1 = resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_SCHEME: 'v1' });
/** The shipped defaults: legacy still minted for the long-lived scopes, v1 for
 * confirm, 7-day confirm window, no sunset. */
const DEFAULTS = resolveNewsletterTokenPolicy({});

type TokenPolicy = ReturnType<typeof resolveNewsletterTokenPolicy>;

function mint(scope: string, opts: { now?: number; policy?: TokenPolicy } = {}) {
  return mintNewsletterActionToken(EMAIL, scope, { secret: SECRET, policy: opts.policy ?? V1, ...(opts.now === undefined ? {} : { now: opts.now }) });
}

function createFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const docs: Record<string, Record<string, unknown>> = { ...seed };
  const events: Array<Record<string, unknown>> = [];
  return {
    docs,
    events,
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            get: async () => ({ exists: !!docs[`${name}/${id}`], data: () => docs[`${name}/${id}`] }),
            set: async (data: Record<string, unknown>) => {
              docs[`${name}/${id}`] = { ...(docs[`${name}/${id}`] || {}), ...data };
            },
            collection: (sub: string) => ({
              add: async (data: Record<string, unknown>) => { events.push({ collection: `${name}/${id}/${sub}`, ...data }); },
              get: async () => ({ forEach: () => {} }),
            }),
          };
        },
        add: async (data: Record<string, unknown>) => { events.push({ collection: name, ...data }); },
      };
    },
  };
}

describe('scope binding', () => {
  it('a confirm token does not unsubscribe', () => {
    const confirmToken = mint(TOKEN_SCOPES.CONFIRM)!;
    expect(verifyNewsletterActionToken(EMAIL, confirmToken, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: V1 }).canPerform).toBe(true);

    const asUnsubscribe = verifyNewsletterActionToken(EMAIL, confirmToken, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: V1 });
    expect(asUnsubscribe.canPerform).toBe(false);
    expect(asUnsubscribe.reason).toBe('wrong_scope');
  });

  it('an unsubscribe token does not confirm, and does not reach the preferences API', () => {
    const unsubToken = mint(TOKEN_SCOPES.UNSUBSCRIBE)!;
    expect(verifyNewsletterActionToken(EMAIL, unsubToken, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: V1 }).canPerform).toBe(true);
    expect(verifyNewsletterActionToken(EMAIL, unsubToken, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: V1 }).canPerform).toBe(false);
    expect(verifyNewsletterActionToken(EMAIL, unsubToken, TOKEN_SCOPES.PREFERENCES, { secret: SECRET, policy: V1 }).canPerform).toBe(false);
  });

  it('rewriting the scope field of a token does not move it to another action', () => {
    const confirmToken = mint(TOKEN_SCOPES.CONFIRM)!;
    const forged = confirmToken.replace(`.${TOKEN_SCOPES.CONFIRM}.`, `.${TOKEN_SCOPES.UNSUBSCRIBE}.`);
    // The scope is signed, so relabelling it is a signature failure — not a
    // scope failure. Both refuse; this asserts the signature is the backstop.
    const verdict = verifyNewsletterActionToken(EMAIL, forged, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: V1 });
    expect(verdict.canPerform).toBe(false);
    expect(verdict.reason).toBe('bad_signature');
  });

  it('a token belongs to one address', () => {
    const token = mint(TOKEN_SCOPES.PREFERENCES)!;
    expect(verifyNewsletterActionToken('someone-else@example.com', token, TOKEN_SCOPES.PREFERENCES, { secret: SECRET, policy: V1 }).canPerform).toBe(false);
  });

  it('the v1 key is derived, so a legacy signature over a crafted address cannot forge one', () => {
    // The forgery family lib/autologinCode.js documents: sign a crafted
    // "address" that spells the other scheme's message and keep the first 32 hex
    // characters. Legacy has no domain tag to differ from — the bare address IS
    // the message — so the separation lives in the KEY instead.
    const stamp = parseNewsletterActionToken(mint(TOKEN_SCOPES.CONFIRM)!).stamp;
    const craftedAddress = `${TOKEN_SCOPES.CONFIRM}:${stamp}:${EMAIL}`;
    const crafted = createHmac('sha256', SECRET).update(craftedAddress).digest('hex').slice(0, 32);
    const forged = `n1.${TOKEN_SCOPES.CONFIRM}.${stamp}.${crafted}`;
    expect(verifyNewsletterActionToken(EMAIL, forged, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: V1 }).canPerform).toBe(false);
  });

  it('every action that takes a token has a scope — no action inherits the universal credential', () => {
    // Read the handler's own list rather than restating it: an action added to
    // `validActions` without an entry in SCOPE_BY_ACTION would otherwise arrive
    // with a null scope and be refused in production, silently, at runtime.
    const source = readFileSync(
      fileURLToPath(new URL('../functions/src/newsletterSubscriptionManagement.js', import.meta.url)),
      'utf8',
    );
    const listed = /const validActions = \[([^\]]+)\]/.exec(source);
    expect(listed).toBeTruthy();
    const actions = listed![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(actions.length).toBeGreaterThan(10);
    for (const action of actions) {
      // exchange_auth_code is the one exception: its `token` parameter carries an
      // `ac` autologin code, graded by lib/autologinCode.js.
      if (action === 'exchange_auth_code') continue;
      expect(scopeForAction(action), `action ${action} has no token scope`).toBeTruthy();
    }
  });
});

describe('the exit never closes', () => {
  it('an unsubscribe token does not expire, whatever the policy says', () => {
    const ancient = mint(TOKEN_SCOPES.UNSUBSCRIBE, { now: Date.now() - 3650 * DAY_MS })!;
    const hostile = resolveNewsletterTokenPolicy({
      NEWSLETTER_TOKEN_SCHEME: 'v1',
      NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: '1',
      NEWSLETTER_TOKEN_LEGACY_SUNSET: '2020-01-01T00:00:00Z',
    });
    const verdict = verifyNewsletterActionToken(EMAIL, ancient, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: hostile });
    expect(verdict.canPerform).toBe(true);
    expect(verdict.expired).toBe(false);
  });

  it('a legacy token still unsubscribes after the sunset that retires it everywhere else', () => {
    const legacy = legacyEmailToken(EMAIL, SECRET)!;
    const past = resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_LEGACY_SUNSET: '2020-01-01T00:00:00Z' });
    expect(verifyNewsletterActionToken(EMAIL, legacy, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: past }).canPerform).toBe(true);
    expect(verifyNewsletterActionToken(EMAIL, legacy, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: past }).canPerform).toBe(false);
    expect(verifyNewsletterActionToken(EMAIL, legacy, TOKEN_SCOPES.PREFERENCES, { secret: SECRET, policy: past }).canPerform).toBe(false);
    expect(verifyNewsletterActionToken(EMAIL, legacy, TOKEN_SCOPES.RESUBSCRIBE, { secret: SECRET, policy: past }).canPerform).toBe(false);
  });

  it('verifyOptOutCredential takes both shapes, and says which one it took', () => {
    const legacy = legacyEmailToken(EMAIL, SECRET)!;
    const v1 = mint(TOKEN_SCOPES.UNSUBSCRIBE)!;
    expect(verifyOptOutCredential(EMAIL, legacy, SECRET, { policy: V1 })).toMatchObject({ ok: true, viaEmailToken: true });
    expect(verifyOptOutCredential(EMAIL, v1, SECRET, { policy: V1 })).toMatchObject({ ok: true, viaEmailToken: true });
    expect(verifyOptOutCredential(EMAIL, 'not-a-token', SECRET, { policy: V1 }).ok).toBe(false);
  });

  it('the handler unsubscribes on a decade-old v1 token', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'confirmed', isActive: true } });
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: mint(TOKEN_SCOPES.UNSUBSCRIBE, { now: Date.now() - 3650 * DAY_MS })!,
      secret: SECRET,
      locale: 'it',
      tokenPolicy: V1,
      db: db as never,
    });
    expect(result.status).toBe(200);
    expect(db.docs['newsletter_subscribers/recipient@example.com'].status).toBe('unsubscribed');
  });
});

describe('the confirm window', () => {
  it('defaults to the 7 days the confirmation email promises in four languages', () => {
    expect(DEFAULT_CONFIRM_TTL_DAYS).toBe(7);
    expect(DEFAULTS.confirmTtlDays).toBe(7);
  });

  it('accepts a confirm token inside the window and refuses it outside', () => {
    const now = Date.now();
    const sixDaysOld = mint(TOKEN_SCOPES.CONFIRM, { now: now - 6 * DAY_MS })!;
    const eightDaysOld = mint(TOKEN_SCOPES.CONFIRM, { now: now - 8 * DAY_MS })!;
    expect(verifyNewsletterActionToken(EMAIL, sixDaysOld, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS, now }).canPerform).toBe(true);
    const stale = verifyNewsletterActionToken(EMAIL, eightDaysOld, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS, now });
    expect(stale.canPerform).toBe(false);
    expect(stale.reason).toBe('expired');
  });

  it('the promised days are a FLOOR — an email sent at 23:59 still works seven days later', () => {
    // The stamp is day-granular, so it is the UTC midnight of the issue day. If
    // the window were measured from there with no rounding, an email sent in the
    // evening would die after six days and change while saying seven.
    const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const sentAt = midnight + 23 * 3_600_000 + 59 * 60_000;
    const token = mint(TOKEN_SCOPES.CONFIRM, { now: sentAt, policy: DEFAULTS })!;
    const justUnderSevenDays = sentAt + 7 * DAY_MS - 60_000;
    expect(verifyNewsletterActionToken(EMAIL, token, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS, now: justUnderSevenDays }).canPerform).toBe(true);
    // And it does die — the rounding is one day, not an amnesty.
    expect(verifyNewsletterActionToken(EMAIL, token, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS, now: sentAt + 9 * DAY_MS }).canPerform).toBe(false);
  });

  it('is switchable off from Remote Config without a deploy, and re-judges tokens already sent', () => {
    const now = Date.now();
    const old = mint(TOKEN_SCOPES.CONFIRM, { now: now - 30 * DAY_MS })!;
    const off = resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: '0' });
    expect(verifyNewsletterActionToken(EMAIL, old, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: off, now }).canPerform).toBe(true);
    const narrow = resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: '1' });
    expect(verifyNewsletterActionToken(EMAIL, old, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: narrow, now }).canPerform).toBe(false);
  });

  it('an unreadable TTL means the promised 7 days, not "no expiry"', () => {
    expect(resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: 'sette' }).confirmTtlDays).toBe(7);
    expect(resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: '  ' }).confirmTtlDays).toBe(7);
    expect(resolveNewsletterTokenPolicy({ NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: '0' }).confirmTtlDays).toBe(0);
  });

  it('refuses a token stamped in the future, which no expiry could ever reach', () => {
    const now = Date.now();
    const future = mint(TOKEN_SCOPES.CONFIRM, { now: now + 5 * DAY_MS })!;
    expect(verifyNewsletterActionToken(EMAIL, future, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS, now }).reason).toBe('future');
  });

  it('the handler refuses a stale confirmation link', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'pending', isActive: false } });
    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: EMAIL,
      token: generateConfirmationToken(EMAIL, SECRET, { now: Date.now() - 30 * DAY_MS })!,
      secret: SECRET,
      locale: 'it',
      db: db as never,
    });
    expect(result.status).toBe(403);
    // Nothing was written: the whole point is that an old confirmation link is
    // not a re-subscribe button any more.
    expect(db.docs['newsletter_subscribers/recipient@example.com'].status).toBe('pending');
  });

  it('the handler still confirms a fresh link', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'confirmed', isActive: true } });
    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: EMAIL,
      token: generateConfirmationToken(EMAIL, SECRET)!,
      secret: SECRET,
      locale: 'it',
      db: db as never,
    });
    expect(result.status).toBe(200);
  });
});

describe('backward compatibility', () => {
  it('a legacy token is accepted for every action while the phase is open', async () => {
    const legacy = legacyEmailToken(EMAIL, SECRET)!;
    for (const scope of Object.values(TOKEN_SCOPES)) {
      expect(
        verifyNewsletterActionToken(EMAIL, legacy, scope, { secret: SECRET, policy: DEFAULTS }).canPerform,
        `legacy token refused for ${scope}`,
      ).toBe(true);
    }
  });

  it('the handler still answers the token shape every email in every inbox carries', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'confirmed', isActive: true } });
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: createHmac('sha256', SECRET).update(EMAIL).digest('hex'),
      secret: SECRET,
      locale: 'it',
      db: db as never,
    });
    expect(result.status).toBe(200);
    expect(db.docs['newsletter_subscribers/recipient@example.com'].status).toBe('unsubscribed');
  });

  it('the default policy keeps minting legacy for the three long-lived scopes, v1 for confirm', () => {
    // Who mints decides: the confirmation email is minted and verified inside
    // one Cloud Functions deploy, the other three are minted by the scripts/
    // senders, which deploy on a different schedule from the verifier.
    expect(mintNewsletterActionToken(EMAIL, TOKEN_SCOPES.UNSUBSCRIBE, { secret: SECRET, policy: DEFAULTS })).toMatch(/^[0-9a-f]{64}$/);
    expect(mintNewsletterActionToken(EMAIL, TOKEN_SCOPES.PREFERENCES, { secret: SECRET, policy: DEFAULTS })).toMatch(/^[0-9a-f]{64}$/);
    expect(mintNewsletterActionToken(EMAIL, TOKEN_SCOPES.RESUBSCRIBE, { secret: SECRET, policy: DEFAULTS })).toMatch(/^[0-9a-f]{64}$/);
    expect(mintNewsletterActionToken(EMAIL, TOKEN_SCOPES.CONFIRM, { secret: SECRET, policy: DEFAULTS })).toMatch(/^n1\.confirm\.[0-9a-z]+\.[0-9a-f]{32}$/);
  });

  it('an unknown scope mints nothing and verifies nothing', () => {
    expect(mintNewsletterActionToken(EMAIL, 'everything', { secret: SECRET, policy: V1 })).toBeNull();
    expect(verifyNewsletterActionToken(EMAIL, mint(TOKEN_SCOPES.CONFIRM)!, 'everything', { secret: SECRET, policy: V1 }).reason).toBe('unknown_scope');
  });
});

describe('the links carry the scope they need', () => {
  it('each builder mints its own action, and none of them accepts another', () => {
    const links = {
      [TOKEN_SCOPES.UNSUBSCRIBE]: makeUnsubscribeUrl(EMAIL, { secret: SECRET, policy: V1 }),
      [TOKEN_SCOPES.RESUBSCRIBE]: makeResubscribeUrl(EMAIL, { secret: SECRET, policy: V1 }),
      [TOKEN_SCOPES.PREFERENCES]: makePreferencesUrl(EMAIL, 'it', { secret: SECRET, policy: V1 })!,
    };
    for (const [scope, url] of Object.entries(links)) {
      const token = new URL(url).searchParams.get('token')!;
      expect(parseNewsletterActionToken(token).scope).toBe(scope);
      expect(verifyNewsletterActionToken(EMAIL, token, scope, { secret: SECRET, policy: V1 }).canPerform).toBe(true);
      for (const other of Object.values(TOKEN_SCOPES)) {
        if (other === scope) continue;
        expect(
          verifyNewsletterActionToken(EMAIL, token, other, { secret: SECRET, policy: V1 }).canPerform,
          `${scope} token accepted as ${other}`,
        ).toBe(false);
      }
    }
  });

  it('the RFC 8058 one-click link carries an unsubscribe token', () => {
    const url = makeOneClickUnsubscribeUrl(EMAIL, { secret: SECRET, policy: V1 });
    const token = new URL(url).searchParams.get('token')!;
    expect(parseNewsletterActionToken(token).scope).toBe(TOKEN_SCOPES.UNSUBSCRIBE);
  });

  it('the address in the link is the address the token is signed over', () => {
    // The two used to disagree: three builders signed `email.toLowerCase()` and
    // emitted the raw address, the confirmation email signed
    // `.toLowerCase().trim()`, and the verifier trimmed both. A stored address
    // with stray whitespace was therefore signed one way and verified another —
    // an unsubscribe link that answered "Link non valido" for ever.
    const messy = '  Recipient@Example.COM ';
    for (const url of [
      makeUnsubscribeUrl(messy, { secret: SECRET, policy: V1 }),
      makeOneClickUnsubscribeUrl(messy, { secret: SECRET, policy: V1 }),
      makeResubscribeUrl(messy, { secret: SECRET, policy: V1 }),
      makePreferencesUrl(messy, 'it', { secret: SECRET, policy: V1 })!,
    ]) {
      const parsed = new URL(url);
      const email = parsed.searchParams.get('email')!;
      const token = parsed.searchParams.get('token')!;
      expect(email).toBe(EMAIL);
      const scope = parseNewsletterActionToken(token).scope!;
      expect(verifyNewsletterActionToken(email, token, scope, { secret: SECRET, policy: V1 }).canPerform).toBe(true);
    }
  });

  it('no secret still degrades to an unsigned link, as it always did', () => {
    const previous = process.env.NEWSLETTER_SECRET;
    delete process.env.NEWSLETTER_SECRET;
    try {
      expect(makeUnsubscribeUrl(EMAIL)).not.toContain('token=');
      expect(makePreferencesUrl(EMAIL, 'it')).toBeNull();
    } finally {
      if (previous !== undefined) process.env.NEWSLETTER_SECRET = previous;
    }
  });
});

describe('the re-subscribe form on the opt-out page', () => {
  it('carries a token action=resubscribe accepts — the button must not answer "Link non valido"', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'confirmed', isActive: true } });
    const optOut = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: mint(TOKEN_SCOPES.UNSUBSCRIBE)!,
      secret: SECRET,
      locale: 'it',
      tokenPolicy: V1,
      db: db as never,
    });
    expect(optOut.status).toBe(200);

    const formToken = /name="token" value="([^"]+)"/.exec(optOut.html!)?.[1];
    expect(formToken).toBeTruthy();
    expect(parseNewsletterActionToken(formToken!).scope).toBe(TOKEN_SCOPES.RESUBSCRIBE);

    const back = await handleSubscriptionManagement({
      action: 'resubscribe',
      email: EMAIL,
      token: formToken!,
      secret: SECRET,
      locale: 'it',
      method: 'POST',
      tokenPolicy: V1,
      db: createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'unsubscribed', isActive: false } }) as never,
    });
    expect(back.status).toBe(200);
  });

  it('the unsubscribe token itself is refused by action=resubscribe', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'unsubscribed', isActive: false } });
    const result = await handleSubscriptionManagement({
      action: 'resubscribe',
      email: EMAIL,
      token: mint(TOKEN_SCOPES.UNSUBSCRIBE)!,
      secret: SECRET,
      locale: 'it',
      method: 'POST',
      tokenPolicy: V1,
      db: db as never,
    });
    expect(result.status).toBe(403);
    expect(db.docs['newsletter_subscribers/recipient@example.com'].status).toBe('unsubscribed');
  });
});

describe('the preferences API is gated on the preferences scope', () => {
  it('refuses an unsubscribe token on the actions that read and write alerts', async () => {
    for (const action of ['get_full_status', 'create_alert', 'delete_alert', 'toggle_newsletter_subscription', 'revoke_autologin']) {
      const result = await handleSubscriptionManagement({
        action,
        email: EMAIL,
        token: mint(TOKEN_SCOPES.UNSUBSCRIBE)!,
        secret: SECRET,
        locale: 'it',
        method: 'POST',
        tokenPolicy: V1,
        keywords: 'frontaliere',
        alertId: 'alert-1',
        subscribed: 'false',
        db: createFakeDb() as never,
      });
      expect(result.status, `${action} accepted an unsubscribe token`).toBe(403);
      expect(result.json).toMatchObject({ success: false, error: 'invalid_token' });
    }
  });

  it('accepts the token the preferences link carries', async () => {
    const db = createFakeDb({ 'newsletter_subscribers/recipient@example.com': { status: 'confirmed', isActive: true, autologin_enabled: true } });
    const result = await handleSubscriptionManagement({
      action: 'get_autologin_status',
      email: EMAIL,
      token: mint(TOKEN_SCOPES.PREFERENCES)!,
      secret: SECRET,
      locale: 'it',
      tokenPolicy: V1,
      db: db as never,
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: true });
  });
});
