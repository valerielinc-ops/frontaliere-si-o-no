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

  it('the confirmation page\'s own resubscribe link also targets the dedicated path (no dead-end loop)', async () => {
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
    expect(result.html).toContain('/disiscrivi-newsletter/?action=resubscribe');
    expect(result.html).not.toMatch(/href="https:\/\/frontaliereticino\.ch\/\?action=resubscribe/);
  });
});
