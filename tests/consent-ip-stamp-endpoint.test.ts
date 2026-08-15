/**
 * The consent-banner half of `consent_ip` (#5920, finishing #5676).
 *
 * #5676 stamps the network of origin from the Cloud Functions every signup
 * crosses. The acts added by #5902/#5920 cross none: the browser writes the
 * proof to Firestore itself, so date + formula + act land and the address does
 * not. This covers the endpoint opened for them and the client that calls it.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and why the auth gate gets the most tests:
 * `stampConsentIp` NEVER OVERWRITES — the first address recorded against a
 * consent is the one that stands. That refusal is right (a login six months
 * later must not replace the consent's network) but it means a bad first
 * stamp is uncorrectable: an open endpoint would let anybody nail their OWN
 * network onto a stranger's consent, forever. So the decision "may this caller
 * stamp this document?" is a pure function, and this is where it is pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decideConsentIpStamp,
  normalizeConsentEmail,
} from '../functions/src/lib/consentIpStampAuth.js';
import {
  CONSENT_IP_STAMP_URL,
  stampConsentIpViaEndpoint,
  __resetConsentIpStampDedup,
} from '@/services/consentIpStamp';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER = 'persona@example.com';

describe('decideConsentIpStamp — nobody stamps anybody but themselves', () => {
  it('accepts a POST whose token claims the very address being stamped', () => {
    expect(
      decideConsentIpStamp({ method: 'POST', token: { email: OWNER }, bodyEmail: OWNER }),
    ).toEqual({ ok: true, email: OWNER });
  });

  it('REFUSES a token that claims a different address — the forgery this gate exists for', () => {
    // Without this branch an attacker signs in as themselves and POSTs the
    // victim's address: `stampConsentIp` finds the field empty, writes the
    // attacker's network, and no honest later call can ever replace it.
    const decision = decideConsentIpStamp({
      method: 'POST',
      token: { email: 'altro@example.com' },
      bodyEmail: OWNER,
    });
    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ status: 403, error: 'email_mismatch' });
  });

  it('refuses with no token at all, and says nothing about the body', () => {
    // Authentication is answered BEFORE the address is looked at, so an
    // anonymous prober cannot use the 400/403 split to learn anything.
    expect(decideConsentIpStamp({ method: 'POST', token: null, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 401, error: 'unauthenticated' });
    expect(decideConsentIpStamp({ method: 'POST', token: null, bodyEmail: 'not-an-email' }))
      .toEqual({ ok: false, status: 401, error: 'unauthenticated' });
    expect(decideConsentIpStamp({ method: 'POST', token: null, bodyEmail: undefined }))
      .toEqual({ ok: false, status: 401, error: 'unauthenticated' });
  });

  it('refuses a token with no email claim rather than treating it as a wildcard', () => {
    // A phone-number or anonymous sign-in produces a token with no `email`.
    // Read as "no constraint", it would authorize stamping ANY document.
    expect(decideConsentIpStamp({ method: 'POST', token: { uid: 'x' }, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 403, error: 'no_email_claim' });
    expect(decideConsentIpStamp({ method: 'POST', token: { email: '' }, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 403, error: 'no_email_claim' });
  });

  it('matches case- and whitespace-insensitively, both sides', () => {
    // Firebase preserves the case the account was created with; the document
    // id is lowercased. A case-sensitive compare would refuse the legitimate
    // owner of every mixed-case account — a silent, permanent no-op.
    expect(
      decideConsentIpStamp({
        method: 'POST',
        token: { email: 'Persona@Example.COM' },
        bodyEmail: '  PERSONA@example.com  ',
      }),
    ).toEqual({ ok: true, email: OWNER });
  });

  it('is POST-only, and says so before anything else', () => {
    expect(decideConsentIpStamp({ method: 'GET', token: { email: OWNER }, bodyEmail: OWNER }))
      .toEqual({ ok: false, status: 405, error: 'method_not_allowed' });
  });

  it('rejects a malformed target address once authenticated', () => {
    expect(decideConsentIpStamp({ method: 'POST', token: { email: OWNER }, bodyEmail: 'nope' }))
      .toEqual({ ok: false, status: 400, error: 'invalid_email' });
    expect(decideConsentIpStamp({ method: 'POST', token: { email: OWNER }, bodyEmail: '' }))
      .toEqual({ ok: false, status: 400, error: 'invalid_email' });
    expect(decideConsentIpStamp({ method: 'POST', token: { email: OWNER }, bodyEmail: { a: 1 } }))
      .toEqual({ ok: false, status: 400, error: 'invalid_email' });
  });

  it('survives a hostile or empty input object instead of throwing into the handler', () => {
    expect(decideConsentIpStamp(undefined as never).ok).toBe(false);
    expect(decideConsentIpStamp({} as never).ok).toBe(false);
  });

  it('normalizes exactly like the document id is built', () => {
    expect(normalizeConsentEmail('  A@B.C ')).toBe('a@b.c');
    expect(normalizeConsentEmail(null)).toBe('');
    expect(normalizeConsentEmail(42)).toBe('');
  });
});

describe('the client never sends the address it is asking about', () => {
  beforeEach(() => {
    __resetConsentIpStampDedup();
  });

  it('POSTs the ID token and the target email — and NO ip field of its own', async () => {
    // The whole reason this is an endpoint: a value the browser supplied is
    // worthless as evidence. The body may name the document; it may never
    // carry the address that gets stored.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await stampConsentIpViaEndpoint(OWNER, {
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CONSENT_IP_STAMP_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ email: OWNER });
    expect(JSON.stringify(body)).not.toMatch(/ip/i);
  });

  it('does not call at all without a token', async () => {
    const fetchImpl = vi.fn();
    await stampConsentIpViaEndpoint(OWNER, {
      getIdToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('NEVER rejects — not on a network failure, not on a throwing token getter', async () => {
    // Both callers are fire-and-forget inside a consent flow. A rejection here
    // would surface as an unhandled promise in the one moment the visitor is
    // being asked to trust us.
    await expect(
      stampConsentIpViaEndpoint(OWNER, {
        getIdToken: async () => 'token-123',
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();

    __resetConsentIpStampDedup();
    await expect(
      stampConsentIpViaEndpoint(OWNER, {
        getIdToken: async () => {
          throw new Error('auth broken');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('asks at most once per address per page session', async () => {
    // The banner stamps on `recorded`, and the alert upgrade it fires stamps
    // again on `upgraded > 0`. The server ignores the second (it never
    // overwrites); this keeps the request from being made twice at all.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const deps = {
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    await stampConsentIpViaEndpoint(OWNER, deps);
    await stampConsentIpViaEndpoint(OWNER.toUpperCase(), deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty or malformed address without a round trip', async () => {
    const fetchImpl = vi.fn();
    const deps = {
      getIdToken: async () => 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    await stampConsentIpViaEndpoint('', deps);
    await stampConsentIpViaEndpoint('nope', deps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the two client-side consent acts both reach it', () => {
  it('the banner stamps only when the proof actually landed', () => {
    // Asserted behaviourally in tests/communications-consent-banner.test.tsx;
    // pinned here at source level too, because the gate is one identifier and
    // dropping it is invisible in a diff read quickly.
    const src = read('components/shared/CommunicationsConsentBanner.tsx');
    expect(src).toMatch(/if \(outcome\.recorded\) void stampConsentIp\(email\)/);
  });

  it('the alert-side upgrade stamps only when it wrote something', () => {
    const src = read('services/jobAlertService.ts');
    const fn = src.slice(src.indexOf('export async function upgradeBackfilledAlertConsent'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body).toMatch(/if \(upgraded > 0\)/);
    expect(body).toContain('stampConsentIpViaEndpoint');
  });
});
