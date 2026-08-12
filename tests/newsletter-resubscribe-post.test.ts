/**
 * tests/newsletter-resubscribe-post.test.ts — #5711
 *
 * THE DEFECT. The page that confirms an unsubscribe carried the inverse action
 * as an `<a href>`. Whoever scans the links of a message presses it. Measured
 * in production on 2026-08-12, with #5672 already merged: an address opted out
 * at 12:40:53 and was back at `status: 'confirmed'`, `active: true` at 12:40:55
 * with `source_channel: resubscribe_link`. 1,5 seconds — the signature of the
 * antiphishing scanners of #5674 (25 fetches in 7 seconds), not of a person
 * reading a confirmation page and changing their mind.
 *
 * `resubscribe_link` is the ONE exception #5690 left in the opt-out wall, and
 * it is the right exception: a human who reconsiders must be able to come back.
 * So the fix is not to close the exception, it is to make it unreachable by a
 * machine — RFC 8058's asymmetry applied the other way round. The opt-out stays
 * one-click on any verb; the opt-IN needs a POST.
 *
 * TWO INVARIANTS, and they are the two the issue names:
 *   1. a GET on `action=resubscribe` reactivates NOBODY (and writes nothing);
 *   2. `unsubscribed_at` survives a legitimate re-subscription.
 *
 * Every address here is on example.com — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const SECRET = 'test-secret-resubscribe-post';
const EMAIL = 'reader@example.com';
const TOKEN = createHmac('sha256', SECRET).update(EMAIL).digest('hex');

type Write = { docId: string; data: Record<string, any> };
type Event = { docId: string; data: Record<string, any> };

function fakeDb(existing: Record<string, any> | null = { status: 'confirmed', isActive: true }) {
  const sets: Write[] = [];
  const events: Event[] = [];
  return {
    sets,
    events,
    collection: () => ({
      doc: (docId: string) => ({
        get: async () => ({ exists: !!existing, data: () => existing || {} }),
        set: async (data: Record<string, any>) => { sets.push({ docId, data }); },
        collection: () => ({
          add: async (data: Record<string, any>) => { events.push({ docId, data }); },
        }),
      }),
    }),
  };
}

const base = {
  email: EMAIL,
  token: TOKEN,
  locale: 'it',
  secret: SECRET,
};

// ── Invariant 1: a GET reactivates nobody ────────────────────────────────────

describe('a GET on action=resubscribe reactivates nobody', () => {
  it('performs no subscriber write and no event write at all', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false, unsubscribed_at: '2026-08-12T12:40:53.000Z' });
    const result = await handleSubscriptionManagement({ ...base, action: 'resubscribe', method: 'GET', db: db as any });

    expect(result.status).toBe(200);
    expect(result.resubscribeApplied).toBe(false);
    expect(db.sets).toEqual([]);
    // Zero events too, and deliberately: a scanner sweeping every URL in a
    // message would otherwise write one row per invented link into the very
    // event trail the #5711 measurement reads.
    expect(db.events).toEqual([]);
  });

  it('defaults to GET when the caller does not thread the verb — fail-closed', async () => {
    // functions/index.js passes `method: req.method`. A future second
    // entrypoint that forgets to must NOT silently re-open the hole; the same
    // class of vacuous gate as the EDGE_PUSHED_FILES one.
    const db = fakeDb({ status: 'unsubscribed', isActive: false });
    await handleSubscriptionManagement({ ...base, action: 'resubscribe', db: db as any });
    expect(db.sets).toEqual([]);
    expect(db.events).toEqual([]);
  });

  it('answers 200 with the confirmation FORM, not an error — a human may land here', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false });
    const result = await handleSubscriptionManagement({ ...base, action: 'resubscribe', method: 'GET', db: db as any });
    expect(result.html).toContain('<form method="POST"');
    expect(result.html).toContain('name="action" value="resubscribe"');
    expect(result.html).toContain(EMAIL);
  });

  it('accepts a lowercase verb from the request object', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false });
    await handleSubscriptionManagement({ ...base, action: 'resubscribe', method: 'post', db: db as any });
    expect(db.sets.length).toBe(1);
  });
});

describe('the unsubscribe confirmation page offers a form, never a link', () => {
  it('renders a POST form and no resubscribe href', async () => {
    const db = fakeDb();
    const result = await handleSubscriptionManagement({ ...base, action: 'unsubscribe', method: 'POST', db: db as any });

    expect(result.html).toContain('<form method="POST"');
    expect(result.html).toContain('name="action" value="resubscribe"');
    // The exact shape that produced the 1,5-second reactivation.
    expect(result.html).not.toMatch(/<a[^>]+href="[^"]*action=resubscribe/);
  });

  it('still opts out on a bare GET — RFC 8058 and the footer link are untouched', async () => {
    const db = fakeDb();
    const result = await handleSubscriptionManagement({ ...base, action: 'unsubscribe', method: 'GET', db: db as any });
    expect(result.status).toBe(200);
    expect(db.sets[0].data.status).toBe('unsubscribed');
    expect(db.events.some((e) => e.data.event_type === 'unsubscribe')).toBe(true);
  });
});

// ── Invariant 2: the opt-out stamp survives the re-subscription ──────────────

describe('a legitimate re-subscription never erases the opt-out record', () => {
  it('POST resubscribe writes the re-opt-in stamp and leaves unsubscribed_at alone', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false, unsubscribed_at: '2026-08-01T09:00:00.000Z' });
    const result = await handleSubscriptionManagement({ ...base, action: 'resubscribe', method: 'POST', db: db as any });

    expect(result.status).toBe(200);
    expect(result.resubscribeApplied).toBe(true);
    const payload = db.sets[0].data;
    expect(payload.status).toBe('confirmed');
    expect(payload.resubscribed_at).toBeTruthy();
    expect(payload.resubscribedAt).toBeTruthy();
    // Neither a value nor a delete sentinel: the merge does not mention the
    // field, so what the document recorded survives untouched.
    expect(payload).not.toHaveProperty('unsubscribed_at');
    expect(payload).not.toHaveProperty('unsubscribedAt');
    // #5677's invariant still holds: the word comes with its proof.
    expect(payload.confirmed_at).toBeTruthy();
    expect(payload.confirmedAt).toBeTruthy();
  });

  it('the confirm branch lifts an earlier opt-out the same way', async () => {
    const db = fakeDb({ status: 'pending', unsubscribed_at: '2026-08-01T09:00:00.000Z' });
    await handleSubscriptionManagement({ ...base, action: 'confirm', method: 'GET', db: db as any });
    const payload = db.sets[0].data;
    expect(payload.status).toBe('confirmed');
    expect(payload.resubscribed_at).toBeTruthy();
    expect(payload).not.toHaveProperty('unsubscribed_at');
    expect(payload).not.toHaveProperty('unsubscribedAt');
  });

  it('no branch of the handler deletes either spelling of the stamp', () => {
    // A source-level assertion because the behavioural one above can only cover
    // the branches a test remembers to run, and this file's ancestor (#5677)
    // shipped with an Important for exactly that reason.
    const src = read('functions/src/newsletterSubscriptionManagement.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/unsubscribed_at\s*:\s*admin\.firestore\.FieldValue\.delete/);
    expect(src).not.toMatch(/unsubscribedAt\s*:\s*admin\.firestore\.FieldValue\.delete/);
  });

  it('nor does any client writer', () => {
    for (const rel of [
      'services/newsletterSubscribers.ts',
      'components/preferences/SubscriptionPreferencesController.tsx',
    ]) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, `${rel} still deletes an opt-out stamp`).not.toMatch(/unsubscribed_at\s*[:=]\s*deleteField\(\)/);
      expect(src, `${rel} still deletes an opt-out stamp`).not.toMatch(/unsubscribedAt\s*[:=]\s*deleteField\(\)/);
    }
  });
});

// ── Second layer: the burst window ───────────────────────────────────────────

describe('a re-subscription inside the burst window, from the same agent, is refused and recorded', () => {
  const SCANNER = 'Mozilla/5.0 (compatible; SafeLinksScanner/1.0)';

  function justUnsubscribed(agent: string | null, ageMs = 1500) {
    return {
      status: 'unsubscribed',
      isActive: false,
      unsubscribed_at: new Date(Date.now() - ageMs).toISOString(),
      ...(agent ? { unsubscribe_user_agent: agent } : {}),
    };
  }

  it('refuses, changes no state, and writes the refusal to the event trail', async () => {
    const db = fakeDb(justUnsubscribed(SCANNER));
    const result = await handleSubscriptionManagement({
      ...base,
      action: 'resubscribe',
      method: 'POST',
      forensics: { unsubscribe_method: 'POST', unsubscribe_user_agent: SCANNER },
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.resubscribeApplied).toBe(false);
    expect(result.resubscribeRefusedReason).toBe('burst_same_user_agent');
    expect(db.sets).toEqual([]);
    const refusal = db.events.find((e) => e.data.event_type === 'resubscribe_refused');
    expect(refusal, 'a refusal nobody can count is not a defence').toBeTruthy();
    expect(refusal!.data.refusal_reason).toBe('burst_same_user_agent');
    expect(refusal!.data.gap_ms).toBeLessThan(10_000);
    // The UA goes on the event under a NEUTRAL name — `unsubscribe_*` would be
    // a lie on a re-subscribe.
    expect(refusal!.data.request_user_agent).toBe(SCANNER);
    expect(refusal!.data).not.toHaveProperty('unsubscribe_user_agent');
  });

  it('does not fire for a different user agent — the human who re-opens the page in a browser', async () => {
    const db = fakeDb(justUnsubscribed('Gmail-Unsubscriber'));
    await handleSubscriptionManagement({
      ...base,
      action: 'resubscribe',
      method: 'POST',
      forensics: { unsubscribe_user_agent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
      db: db as any,
    });
    expect(db.sets.length).toBe(1);
    expect(db.sets[0].data.status).toBe('confirmed');
  });

  it('does not fire outside the window — the same person, an hour later', async () => {
    const db = fakeDb(justUnsubscribed(SCANNER, 3_600_000));
    await handleSubscriptionManagement({
      ...base,
      action: 'resubscribe',
      method: 'POST',
      forensics: { unsubscribe_user_agent: SCANNER },
      db: db as any,
    });
    expect(db.sets.length).toBe(1);
  });

  it('does not fire when the previous UA was never recorded — no evidence, no refusal', async () => {
    const db = fakeDb(justUnsubscribed(null));
    await handleSubscriptionManagement({
      ...base,
      action: 'resubscribe',
      method: 'POST',
      forensics: { unsubscribe_user_agent: SCANNER },
      db: db as any,
    });
    expect(db.sets.length).toBe(1);
  });

  it('the refusal page still offers the form, so a real misclick recovers in one press', async () => {
    const db = fakeDb(justUnsubscribed(SCANNER));
    const result = await handleSubscriptionManagement({
      ...base,
      action: 'resubscribe',
      method: 'POST',
      forensics: { unsubscribe_user_agent: SCANNER },
      db: db as any,
    });
    expect(result.html).toContain('<form method="POST"');
  });
});

// ── The same asymmetry on the preference-centre toggle ───────────────────────

describe('toggle_newsletter_subscription — opt-IN needs a POST, opt-OUT does not', () => {
  it('refuses subscribed=true on a GET', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false });
    const result = await handleSubscriptionManagement({
      ...base, action: 'toggle_newsletter_subscription', subscribed: 'true', method: 'GET', db: db as any,
    });
    expect(result.status).toBe(405);
    expect(result.json).toEqual({ success: false, error: 'method_not_allowed' });
    expect(db.sets).toEqual([]);
  });

  it('applies subscribed=true on a POST, stamping the re-opt-in without deleting the opt-out', async () => {
    const db = fakeDb({ status: 'unsubscribed', isActive: false, unsubscribed_at: '2026-08-01T09:00:00.000Z' });
    const result = await handleSubscriptionManagement({
      ...base, action: 'toggle_newsletter_subscription', subscribed: 'true', method: 'POST', db: db as any,
    });
    expect(result.status).toBe(200);
    const payload = db.sets[0].data;
    expect(payload.resubscribed_at).toBeTruthy();
    expect(payload.resubscribedAt).toBeTruthy();
    expect(payload).not.toHaveProperty('unsubscribed_at');
  });

  it('still opts OUT on a GET — leaving must never be harder than the mail that provoked it', async () => {
    const db = fakeDb();
    const result = await handleSubscriptionManagement({
      ...base, action: 'toggle_newsletter_subscription', subscribed: 'false', method: 'GET', db: db as any,
    });
    expect(result.status).toBe(200);
    expect(db.sets[0].data.status).toBe('unsubscribed');
  });

  it('the SPA caller POSTs it (no drift between the gate and its only client)', () => {
    const src = read('services/newsletterSubscribers.ts');
    const fn = src.slice(src.indexOf('export async function toggleNewsletterSubscription'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("action=toggle_newsletter_subscription");
    expect(body).toMatch(/fetch\(url,\s*\{\s*method:\s*'POST'\s*\}\)/);
  });
});

// ── The plumbing the two invariants rest on ──────────────────────────────────

// ── The SPA twin: same asymmetry, no server round-trip to hang it on ────────

describe('the SPA re-subscription also waits for a real gesture', () => {
  // App.tsx cannot be imported in a unit test (3.7k lines, the whole Firebase
  // graph at module scope), so this is source-level — the same convention
  // tests/newsletter-autologin-expiry.test.ts and
  // tests/preference-center-coverage.test.ts already use for this file.
  const appSrc = read('App.tsx');

  it('REVERSING a recorded opt-out writes nothing on arrival — it stores the write and asks', () => {
    // `action=resubscribe` covers two situations that only look alike, and the
    // document decides which one arrived. This is the one #5711 is about: a
    // refusal is on record and the arrival wants it overridden.
    const from = appSrc.indexOf('const performResubscribe');
    expect(from, 'the deferred re-subscribe closure is gone — re-point this test').toBeGreaterThan(-1);
    const branch = appSrc.slice(appSrc.indexOf("if (action === 'unsubscribe') {", from), appSrc.indexOf('// Clean URL', from));
    const optedOutBranch = branch.slice(
      branch.indexOf('} else if (await isNewsletterOptedOut('),
      branch.lastIndexOf('} else {'),
    );
    expect(optedOutBranch.length, 'the opt-out discriminator is gone').toBeGreaterThan(0);
    expect(optedOutBranch).toContain('setPendingResubscribe');
    // No write of any kind on arrival.
    expect(optedOutBranch).not.toContain('upsertNewsletterSubscriberRecord');
    expect(optedOutBranch).not.toContain('performResubscribe()');
    expect(optedOutBranch).not.toContain('markNewsletterSubscribedLocally');
  });

  it('CONFIRMING an existing subscription still happens in one tap — the win-back CTA', () => {
    // The other half, and the reason the gate is not blanket. The win-back
    // "Resta iscritto" click cancels a pending sunset on a document that never
    // recorded a refusal: nothing is being overridden, so a second tap would
    // only cost retention. #5726 measured 25 subscribers whose click was
    // already being dropped by the credential wave; this must not add another
    // place to lose them.
    const from = appSrc.indexOf('const performResubscribe');
    const branch = appSrc.slice(from, appSrc.indexOf('// Clean URL', from));
    const winbackBranch = branch.slice(branch.lastIndexOf('} else {'));
    expect(winbackBranch).toContain('await performResubscribe()');
    expect(winbackBranch).not.toContain('setPendingResubscribe');
  });

  it('the discriminator is the DOCUMENT, never a URL parameter', () => {
    // A scanner fetches whatever the link carries, so any parameter-based rule
    // classifies the machine exactly as it classifies the person. `token` is
    // especially useless for it: #5726 records that it is the WIDEST credential
    // we mint (the whole preferences API, no expiry, no revocation watermark).
    const from = appSrc.indexOf('const performResubscribe');
    const branch = appSrc.slice(from, appSrc.indexOf('// Clean URL', from));
    expect(branch).toMatch(/await isNewsletterOptedOut\(db, normalizedEmail\)/);
    expect(branch).not.toMatch(/urlParams\.get\(/);
  });

  it('the toast offers a button, and no `<a href>` carrying action=resubscribe survives', () => {
    expect(appSrc).not.toMatch(/href=\{?`?\/\?action=resubscribe/);
    const toast = appSrc.slice(appSrc.indexOf('{pendingResubscribe && newsletterActionEmail && ('));
    expect(toast.slice(0, 800)).toMatch(/<button[\s\S]{0,200}onClick=/);
  });

  it('the unsubscribe branch arms the same button — the dead link it replaces never worked', () => {
    // The old `<a href="/?action=resubscribe&email=…">` carried no credential at
    // all, so pressing it always answered "Link non valido". The button reuses
    // the session that just performed the unsubscribe.
    const branch = appSrc.slice(appSrc.indexOf("if (action === 'unsubscribe') {", appSrc.indexOf('const performResubscribe')));
    expect(branch.slice(0, branch.indexOf('} else {'))).toContain('setPendingResubscribe');
  });

  it('the win-back CTA still points at the SPA action — the fix is on the landing side', () => {
    // Asserted so nobody "fixes" this by removing the CTA: the email is fine,
    // it is the write-on-arrival that was not.
    const winback = read('services/winbackEmail.mjs');
    expect(winback).toContain("makeAuthenticatedActionUrl('resubscribe', email)");
    expect(winback).toMatch(/#5711/);
  });
});

describe('the verb reaches the handler at all', () => {
  it('functions/index.js threads req.method into handleSubscriptionManagement', () => {
    const src = read('functions/index.js');
    const handler = src.slice(src.indexOf('export const newsletterManageSubscription'));
    expect(handler).toMatch(/method:\s*req\.method/);
  });

  it('the Worker forwards method and body verbatim to the unsubscribe origin', () => {
    // A form POST is worthless if the edge downgrades it. `new Request(url,
    // request)` copies method/headers/body; asserted here because the proxy and
    // the form live in different repos-worth of code and nothing else links them.
    const worker = read('infra/cloudflare-worker/locale-router.js');
    const proxy = worker.slice(worker.indexOf('const unsubOrigin = unsubProxyOrigin'));
    expect(proxy.slice(0, 600)).toMatch(/new Request\(upstream\.toString\(\),\s*request\)/);
  });
});
