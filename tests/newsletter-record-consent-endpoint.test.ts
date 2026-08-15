/**
 * The trusted write path for a client-side consent act (#5928, phase 1;
 * reabsorbs and hardens #5927).
 *
 * The consent banner (#5842/#5920) writes its proof with a browser `updateDoc`,
 * and `firestore.rules` still allows that write with no auth — so the
 * `consent_text` is fabricable by anyone with the project id. This covers the
 * server endpoint that closes it, whose whole job is to refuse everyone who
 * cannot PROVE POSSESSION of the address.
 *
 * WHERE THE TESTS CONCENTRATE, and why: #5927's gate accepted any token whose
 * `email` claim matched, `email_verified` or not — which two token-minting
 * paths (shell accounts, Stripe guest emails) can forge. The owner ratified a
 * single, stronger predicate for this phase: `email_verified === true`. That
 * change is the reason this file exists, so the gate gets the most tests, and
 * two of them name the exact vectors it now excludes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decideRecordConsent,
  planNewsletterConsentWrite,
  pickConsentProofFields,
  normalizeConsentEmail,
  CONSENT_TEXT_FIELDS,
  RECORD_CONSENT_ALLOWED_FIELDS,
  RECORD_CONSENT_FORBIDDEN_FIELDS,
} from '../functions/src/lib/newsletterRecordConsentAuth.js';
import { CONSENT_TEXT_FIELDS as CLIENT_CONSENT_TEXT_FIELDS } from '@/services/jobAlertConsentUpgrade';
import {
  RECORD_CONSENT_URL,
  recordConsentViaEndpoint,
} from '@/services/newsletterRecordConsent';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER = 'persona@example.com';
const EXPECTED_ACT = 'communications_banner_confirm_click';
const EXPECTED_ORIGIN = 'communications_consent_banner';
const PINS = { expectedAct: EXPECTED_ACT, expectedOrigin: EXPECTED_ORIGIN };

const verified = (email = OWNER) => ({ email, email_verified: true });

describe('decideRecordConsent — only a proven owner may deposit a consent', () => {
  it('accepts a POST from a VERIFIED token that claims the very address being stamped', () => {
    expect(
      decideRecordConsent({ method: 'POST', token: verified(), bodyEmail: OWNER }),
    ).toEqual({ ok: true, email: OWNER });
  });

  it('REFUSES the shell-account vector: a matching claim with email_verified:false', () => {
    // `newsletterSubscriberAuthSync.js` creates the shell Auth account of an
    // existing subscriber with `emailVerified: false`. #5927's claim-only gate
    // accepted this; requiring `email_verified` refuses it — the address is not
    // proven to belong to whoever drove the sync.
    expect(
      decideRecordConsent({
        method: 'POST',
        token: { email: OWNER, email_verified: false },
        bodyEmail: OWNER,
      }),
    ).toEqual({ ok: false, status: 403, error: 'email_not_verified' });
  });

  it('REFUSES the Stripe-guest vector: an unverified guest email claim', () => {
    // `stripeReaderCore.js` resolves the user on the Stripe GUEST email, which
    // is free text and never verified. Its token also carries
    // `email_verified: false`, so the same predicate excludes it.
    expect(
      decideRecordConsent({
        method: 'POST',
        token: { email: OWNER, email_verified: false },
        bodyEmail: OWNER,
      }),
    ).toMatchObject({ ok: false, status: 403, error: 'email_not_verified' });
  });

  it('refuses a token with NO email_verified claim at all — absence is not verification', () => {
    expect(
      decideRecordConsent({ method: 'POST', token: { email: OWNER }, bodyEmail: OWNER }),
    ).toEqual({ ok: false, status: 403, error: 'email_not_verified' });
  });

  it('requires the boolean true, not a truthy stand-in', () => {
    // A string 'true' or a 1 is not the claim Firebase sets; accepting it would
    // re-open the gap on any path that can put a truthy value there.
    for (const bad of ['true', 1, {}, 'yes'] as unknown[]) {
      expect(
        decideRecordConsent({
          method: 'POST',
          token: { email: OWNER, email_verified: bad as never },
          bodyEmail: OWNER,
        }),
      ).toMatchObject({ status: 403, error: 'email_not_verified' });
    }
  });

  it('REFUSES a verified token that claims a DIFFERENT address — the cross-stamp forgery', () => {
    const decision = decideRecordConsent({
      method: 'POST',
      token: verified('altro@example.com'),
      bodyEmail: OWNER,
    });
    expect(decision).toEqual({ ok: false, status: 403, error: 'email_mismatch' });
  });

  it('refuses with no token at all, and says nothing about the body', () => {
    // Authentication is answered before the address, so a prober cannot use
    // the 400/403 split to learn anything.
    expect(decideRecordConsent({ method: 'POST', token: null, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 401, error: 'unauthenticated' });
    expect(decideRecordConsent({ method: 'POST', token: null, bodyEmail: 'not-an-email' }))
      .toEqual({ ok: false, status: 401, error: 'unauthenticated' });
  });

  it('refuses a verified token with no email claim rather than treating it as a wildcard', () => {
    expect(decideRecordConsent({ method: 'POST', token: { email_verified: true }, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 403, error: 'no_email_claim' });
    expect(decideRecordConsent({ method: 'POST', token: { email: '', email_verified: true }, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 403, error: 'no_email_claim' });
  });

  it('is POST-only, and says so before it looks at auth or the body', () => {
    expect(decideRecordConsent({ method: 'GET', token: verified(), bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 405, error: 'method_not_allowed' });
  });

  it('rejects a malformed target once past auth and verification', () => {
    expect(decideRecordConsent({ method: 'POST', token: verified(), bodyEmail: 'nope' }))
      .toEqual({ ok: false, status: 400, error: 'invalid_email' });
    expect(decideRecordConsent({ method: 'POST', token: verified(), bodyEmail: { a: 1 } }))
      .toEqual({ ok: false, status: 400, error: 'invalid_email' });
  });

  it('matches case- and whitespace-insensitively, both sides', () => {
    expect(
      decideRecordConsent({
        method: 'POST',
        token: { email: 'Persona@Example.COM', email_verified: true },
        bodyEmail: '  PERSONA@example.com  ',
      }),
    ).toEqual({ ok: true, email: OWNER });
  });

  it('survives a hostile or empty input object instead of throwing into the handler', () => {
    expect(decideRecordConsent(undefined as never).ok).toBe(false);
    expect(decideRecordConsent({} as never).ok).toBe(false);
  });

  it('normalizes exactly like the document id is built', () => {
    expect(normalizeConsentEmail('  A@B.C ')).toBe('a@b.c');
    expect(normalizeConsentEmail(null)).toBe('');
    expect(normalizeConsentEmail(42)).toBe('');
  });
});

describe('planNewsletterConsentWrite — the same invariants as planNewsletterConsentUpgrade', () => {
  it('never creates: a missing document is no-document, not a write', () => {
    expect(planNewsletterConsentWrite(null)).toEqual({ write: false, reason: 'no-document' });
    expect(planNewsletterConsentWrite(undefined)).toEqual({ write: false, reason: 'no-document' });
  });

  it('opt-out outranks everything: a bound opt-out is never re-engaged', () => {
    expect(planNewsletterConsentWrite({ status: 'unsubscribed' }))
      .toEqual({ write: false, reason: 'opt-out-binding' });
    expect(planNewsletterConsentWrite({ unsubscribedAt: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ write: false, reason: 'opt-out-binding' });
  });

  it('never overwrites an existing proof, under either spelling', () => {
    expect(planNewsletterConsentWrite({ consent_text: 'formula precedente' }))
      .toEqual({ write: false, reason: 'already-has-proof' });
    expect(planNewsletterConsentWrite({ consentText: 'formula precedente' }))
      .toEqual({ write: false, reason: 'already-has-proof' });
  });

  it('writes on a clean, contactable document', () => {
    expect(planNewsletterConsentWrite({ email: OWNER, status: 'confirmed', isActive: true }))
      .toEqual({ write: true });
  });

  it('reads the same two consent-text spellings as the client register', () => {
    // Parity with services/jobAlertConsentUpgrade.ts CONSENT_TEXT_FIELDS,
    // asserted rather than assumed — a divergence would let one side overwrite
    // a proof the other treats as present.
    expect([...CONSENT_TEXT_FIELDS]).toEqual([...CLIENT_CONSENT_TEXT_FIELDS]);
  });
});

describe('pickConsentProofFields — the gate proves WHO, this bounds WHAT', () => {
  const goodProof = {
    consent_text: 'Iscrivo il mio indirizzo…',
    consent_text_version: '2026-08-14.1',
    consent_text_displayed: true,
    consent_page_version: '3',
    consent_act: EXPECTED_ACT,
    consent_origin: EXPECTED_ORIGIN,
  };

  it('keeps the allowlisted proof fields', () => {
    const out = pickConsentProofFields(goodProof, PINS);
    expect(out).toEqual({ ok: true, fields: goodProof });
  });

  it('DROPS every forbidden field the register may never assert from here', () => {
    // status/active/consent_given/consent_method are the contract-pinned
    // forbidden fields: an allowlist makes a client that sends them a no-op,
    // not a fabrication.
    const hostile = {
      ...goodProof,
      status: 'confirmed',
      active: true,
      consent_given: true,
      consent_given_at: '2026-08-15T00:00:00.000Z',
      consent_method: 'email_checkbox',
      consent_ip: '9.9.9.9',
    };
    const out = pickConsentProofFields(hostile, PINS);
    expect(out.ok).toBe(true);
    const fields = (out as { ok: true; fields: Record<string, unknown> }).fields;
    for (const forbidden of RECORD_CONSENT_FORBIDDEN_FIELDS) {
      expect(fields).not.toHaveProperty(forbidden);
    }
    // Not even the server-owned IP may be injected through the proof body.
    expect(fields).not.toHaveProperty('consent_ip');
    expect(Object.keys(fields).sort()).toEqual([...RECORD_CONSENT_ALLOWED_FIELDS].sort());
  });

  it('pins the act and origin to this surface — a foreign act is refused, not stored', () => {
    expect(pickConsentProofFields({ ...goodProof, consent_act: 'job_alert_activation_click' }, PINS))
      .toEqual({ ok: false, error: 'unexpected_act' });
    expect(pickConsentProofFields({ ...goodProof, consent_origin: 'somewhere_else' }, PINS))
      .toEqual({ ok: false, error: 'unexpected_origin' });
  });

  it('requires a non-empty consent_text and a proof object at all', () => {
    expect(pickConsentProofFields(null, PINS)).toEqual({ ok: false, error: 'invalid_proof' });
    expect(pickConsentProofFields({ ...goodProof, consent_text: '' }, PINS))
      .toEqual({ ok: false, error: 'invalid_proof' });
    expect(pickConsentProofFields({ ...goodProof, consent_text: 123 as never }, PINS))
      .toEqual({ ok: false, error: 'invalid_proof' });
  });

  it('the forbidden set and the allowlist are disjoint by construction', () => {
    for (const f of RECORD_CONSENT_FORBIDDEN_FIELDS) {
      expect(RECORD_CONSENT_ALLOWED_FIELDS).not.toContain(f);
    }
  });
});

describe('the client sends the target and its proof, never the address as evidence', () => {
  it('POSTs the Bearer token, the target email, sourceUrl and the register proof — and NO ip', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, recorded: true }), { status: 200 }),
    );
    const result = await recordConsentViaEndpoint(OWNER, 'it', {
      sourceUrl: 'https://frontaliereticino.ch/x',
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ serverHandled: true, recorded: true, reason: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RECORD_CONSENT_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    const body = JSON.parse(String(init.body));
    expect(body.email).toBe(OWNER);
    expect(body.sourceUrl).toBe('https://frontaliereticino.ch/x');
    // The proof carries the register bytes and the pinned act — never an IP.
    expect(body.proof.consent_act).toBe(EXPECTED_ACT);
    expect(body.proof.consent_origin).toBe(EXPECTED_ORIGIN);
    expect(typeof body.proof.consent_text).toBe('string');
    expect(body.proof.consent_text.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/consent_ip/);
  });

  it('reports serverHandled:false on any non-200 so the caller falls back', async () => {
    // The shell cohort: the endpoint answers 403 email_not_verified, and the
    // banner must then run its client-side write.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: 'email_not_verified' }), { status: 403 }),
    );
    const result = await recordConsentViaEndpoint(OWNER, 'it', {
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ serverHandled: false });
  });

  it('reports serverHandled:true, recorded:false when the plan skipped the write', async () => {
    // A verified caller who already has a proof or is opted out: the server
    // owns the decision NOT to write, and the client must not write either.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, recorded: false, reason: 'already-has-proof' }), { status: 200 }),
    );
    const result = await recordConsentViaEndpoint(OWNER, 'it', {
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ serverHandled: true, recorded: false, reason: 'already-has-proof' });
  });

  it('does not call, and reports serverHandled:false, without a token', async () => {
    const fetchImpl = vi.fn();
    const result = await recordConsentViaEndpoint(OWNER, 'it', {
      getIdToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ serverHandled: false });
  });

  it('NEVER rejects — a network failure or a throwing token getter resolves to a fallback', async () => {
    await expect(
      recordConsentViaEndpoint(OWNER, 'it', {
        getIdToken: async () => 'token-123',
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ serverHandled: false });

    await expect(
      recordConsentViaEndpoint(OWNER, 'it', {
        getIdToken: async () => {
          throw new Error('auth broken');
        },
      }),
    ).resolves.toEqual({ serverHandled: false });
  });

  it('ignores an empty or malformed address without a round trip', async () => {
    const fetchImpl = vi.fn();
    const deps = { getIdToken: async () => 'token-123', fetchImpl: fetchImpl as unknown as typeof fetch };
    expect(await recordConsentViaEndpoint('', 'it', deps)).toEqual({ serverHandled: false });
    expect(await recordConsentViaEndpoint('nope', 'it', deps)).toEqual({ serverHandled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('functions/index.js — the endpoint executes the gate before it writes', () => {
  const src = read('functions/index.js');
  const endpoint = src.slice(
    src.indexOf('newsletterRecordConsent = onRequest'),
    src.indexOf('sendCalculatorReport = onRequest'),
  );

  it('exists and verifies the ID token', () => {
    expect(endpoint.length).toBeGreaterThan(0);
    expect(endpoint).toContain('verifyIdToken');
  });

  it('gates on decideRecordConsent and returns BEFORE any write when it refuses', () => {
    const gate = endpoint.indexOf('decideRecordConsent({');
    const write = endpoint.indexOf('.set(write, { merge: true })');
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
    expect(endpoint.slice(gate, write)).toMatch(/if \(!decision\.ok\)[\s\S]*return;/);
  });

  it('plans the write (never create, never overwrite) between the gate and the set', () => {
    const gate = endpoint.indexOf('decideRecordConsent({');
    const plan = endpoint.indexOf('planNewsletterConsentWrite(');
    const write = endpoint.indexOf('.set(write, { merge: true })');
    expect(plan).toBeGreaterThan(gate);
    expect(write).toBeGreaterThan(plan);
    expect(endpoint).toMatch(/if \(plan\.write !== true\)[\s\S]*return;/);
  });

  it('reads the IP server-side (buildConsentIpStamp) and never accepts one from the body', () => {
    expect(endpoint).toContain('buildConsentIpStamp(req');
    // The write object is composed from the allowlisted picked fields plus
    // server-observed values; the body's `proof` cannot smuggle a consent_ip
    // because pickConsentProofFields does not allowlist it (asserted above).
    expect(endpoint).toContain('pickConsentProofFields(req.body?.proof');
  });

  it('does not use stampConsentIp — the "exactly 3" count stays intact', () => {
    // This endpoint composes its own single merge write; it must not add a
    // fourth `await stampConsentIp(` call site (pinned in
    // tests/newsletter-consent-proof.test.ts).
    expect(endpoint).not.toContain('stampConsentIp(');
  });
});
