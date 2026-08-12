import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeOneClickUnsubscribeUrl, makeUnsubscribeUrl } from '../services/newsletterUrls.mjs';
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';

// The newsletter's List-Unsubscribe header previously pointed at the apex root
// (`/?action=unsubscribe&...`), which Firebase Hosting's catch-all always serves
// as the SPA — the Cloud Function was never reached (POST 405), and the SPA
// itself rejects a plain token-only link for lack of an `ac` autologin
// credential (GET also failed, silently, with "Link non valido"). Fixed by a
// dedicated /disiscrivi-newsletter/ path proxied straight to the Cloud
// Function, mirroring the already-working /disiscrivi-alert pattern.
describe('newsletter unsubscribe — one-click link routes to the Cloud Function, not the SPA', () => {
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-for-unsub-urls';
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = prevSecret;
  });

  it('makeOneClickUnsubscribeUrl uses the dedicated apex path, not the SPA root', () => {
    const url = makeOneClickUnsubscribeUrl('user@example.com');
    expect(url).toMatch(/^https:\/\/frontaliereticino\.ch\/disiscrivi-newsletter\/\?/);
    expect(url).toContain('action=unsubscribe');
    expect(url).toContain('token=');
    expect(url).not.toContain('cloudfunctions.net');
  });

  it('makeUnsubscribeUrl (footer/SPA link) stays on the root path — unchanged for the working autologin flow', () => {
    const url = makeUnsubscribeUrl('user@example.com');
    expect(url).toMatch(/^https:\/\/frontaliereticino\.ch\/\?action=unsubscribe/);
  });

  it('newsletterManageSubscription reads identifiers from the query on POST (one-click works)', () => {
    // RFC 8058 one-click POST carries action/email/token in the query string,
    // not the body (the body is only `List-Unsubscribe=One-Click`) — so the
    // function MUST merge the query into POST params or the one-click verifies
    // an empty token (403) and never unsubscribes.
    const src = fs.readFileSync(path.resolve(__dirname, '../functions/index.js'), 'utf8');
    const handler = src.slice(src.indexOf('export const newsletterManageSubscription'));
    expect(handler).toMatch(
      /req\.method === 'GET' \? req\.query : \{\s*\.\.\.req\.query,\s*\.\.\.req\.body\s*\}/,
    );
  });

  it('the locale-router Worker proxies /disiscrivi-newsletter to newsletterManageSubscription (no drift)', () => {
    const worker = fs.readFileSync(
      path.resolve(__dirname, '../infra/cloudflare-worker/locale-router.js'),
      'utf8',
    );
    expect(worker).toMatch(
      /'\/disiscrivi-newsletter':\s*`?\$\{CF_FN_BASE\}\/newsletterManageSubscription`?/,
    );
    const wrangler = fs.readFileSync(
      path.resolve(__dirname, '../infra/cloudflare-worker/wrangler.toml'),
      'utf8',
    );
    // Wildcard required: every emitted link carries `?action=…&email=…&token=…`.
    expect(wrangler).toContain('frontaliereticino.ch/disiscrivi-newsletter*');
  });

  it('the confirmation page\'s own resubscribe control also targets the dedicated path (no dead-end loop)', async () => {
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ status: 'confirmed', isActive: true }) }),
          set: async () => {},
          collection: () => ({ add: async () => {} }),
        }),
      }),
    };
    const token = createHmac('sha256', 'test-secret-for-unsub-urls')
      .update('user@example.com')
      .digest('hex');
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: 'user@example.com',
      token,
      locale: 'it',
      secret: 'test-secret-for-unsub-urls',
      db: db as any,
    });
    // Since #5711 the control is a POST form, not an `<a href>` — a crawler
    // follows links and does not submit forms, which is the whole mechanism.
    // The TARGET is unchanged and still asserted here: the dedicated
    // /disiscrivi-newsletter/ path proxied straight to this function, never the
    // SPA root (which rejects a plain token link for lack of an `ac`).
    expect(result.html).toContain('<form method="POST" action="https://frontaliereticino.ch/disiscrivi-newsletter/"');
    expect(result.html).toContain('name="action" value="resubscribe"');
    expect(result.html).not.toMatch(/<a[^>]+href="[^"]*action=resubscribe/);
  });
});

// ── Forensics on the newsletter unsubscribe write ────────────────────────────
//
// Same endpoint, same immediate opt-out: the one-click POST and the footer GET
// are both honoured exactly as before. The difference is that the write now says
// which of the two it was, plus a truncated UA and an ANONYMIZED IP — enough to
// tell a mail-security scanner's prefetch from a human click after the fact,
// which today's data cannot do at all.
describe('newsletter unsubscribe — forensics recorded on the write', () => {
  const SECRET = 'test-secret-forensics';
  const EMAIL = 'user@example.com';

  function capturingDb() {
    const sets: Record<string, any>[] = [];
    const events: Record<string, any>[] = [];
    return {
      sets,
      events,
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ status: 'confirmed', isActive: true }) }),
          set: async (data: any) => { sets.push(data); },
          collection: () => ({ add: async (data: any) => { events.push(data); } }),
        }),
      }),
    };
  }

  function token() {
    return createHmac('sha256', SECRET).update(EMAIL).digest('hex');
  }

  it('records a one-click POST on both the subscriber doc and the event trail', async () => {
    const db = capturingDb();
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: token(),
      locale: 'it',
      secret: SECRET,
      forensics: {
        unsubscribe_method: 'POST',
        unsubscribe_user_agent: 'Google-Mail-Unsubscriber',
        unsubscribe_ip: '203.0.113.0',
      },
      db: db as any,
    });

    expect(result.status).toBe(200);
    const subscriberWrite = db.sets.find((s) => s.status === 'unsubscribed');
    expect(subscriberWrite).toMatchObject({
      status: 'unsubscribed',
      unsubscribe_method: 'POST',
      unsubscribe_user_agent: 'Google-Mail-Unsubscriber',
      unsubscribe_ip: '203.0.113.0',
    });
    const event = db.events.find((e) => e.event_type === 'unsubscribe');
    expect(event).toMatchObject({ unsubscribe_method: 'POST', unsubscribe_ip: '203.0.113.0' });
  });

  it('records a bare GET — the case that is indistinguishable from a scanner today', async () => {
    const db = capturingDb();
    await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: token(),
      locale: 'it',
      secret: SECRET,
      forensics: { unsubscribe_method: 'GET' },
      db: db as any,
    });
    const subscriberWrite = db.sets.find((s) => s.status === 'unsubscribed');
    expect(subscriberWrite!.unsubscribe_method).toBe('GET');
    // Missing user-agent is tolerated — the verb alone is still worth storing.
    expect(subscriberWrite).not.toHaveProperty('unsubscribe_user_agent');
  });

  it('still unsubscribes (200) when the forensics object throws on read', async () => {
    const db = capturingDb();
    const hostile = {
      unsubscribe_method: 'GET',
      get unsubscribe_ip(): string { throw new Error('boom'); },
    };
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: token(),
      locale: 'it',
      secret: SECRET,
      forensics: hostile as any,
      db: db as any,
    });

    expect(result.status).toBe(200);
    const subscriberWrite = db.sets.find((s) => s.status === 'unsubscribed');
    expect(subscriberWrite).toBeTruthy();
    expect(subscriberWrite).not.toHaveProperty('unsubscribe_ip');
  });

  it('leaves the resubscribe direction free of `unsubscribe_*` fields', async () => {
    const db = capturingDb();
    await handleSubscriptionManagement({
      action: 'toggle_newsletter_subscription',
      subscribed: true,
      email: EMAIL,
      token: token(),
      locale: 'it',
      secret: SECRET,
      // The re-opt-in direction requires a POST since #5711 — same asymmetry as
      // `resubscribe`. The opt-OUT direction below is untouched on every verb.
      method: 'POST',
      forensics: { unsubscribe_method: 'POST' },
      db: db as any,
    });
    const write = db.sets.find((s) => s.status === 'subscribed');
    expect(write).toBeTruthy();
    expect(write).not.toHaveProperty('unsubscribe_method');
    const event = db.events.find((e) => e.event_type === 'subscription_resubscribed');
    expect(event).not.toHaveProperty('unsubscribe_method');
  });
});
