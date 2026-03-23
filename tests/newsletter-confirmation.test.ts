/**
 * Tests for newsletter confirmation email system (FRO-24)
 *
 * Tests:
 * - Confirmation email HTML builder
 * - sendNewsletterConfirmationEmail logic (cooldown, status checks)
 * - Confirm action in subscription management
 * - Client-side pending email helpers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Server-side tests (mocked) ─────────────────────────────

describe('newsletterConfirmationEmail', () => {
  it('buildNewsletterConfirmationEmailHtml generates valid branded HTML', async () => {
    const { buildNewsletterConfirmationEmailHtml } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const html = buildNewsletterConfirmationEmailHtml('https://example.com/confirm?token=abc');
    expect(html).toContain('Conferma la tua iscrizione');
    expect(html).toContain('Frontaliere Ticino');
    expect(html).toContain('https://example.com/confirm?token=abc');
    expect(html).toContain('Conferma iscrizione');
    expect(html).toContain('Cosa riceverai ogni settimana');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('buildNewsletterConfirmationEmailHtml escapes HTML in URL', async () => {
    const { buildNewsletterConfirmationEmailHtml } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const html = buildNewsletterConfirmationEmailHtml('https://example.com/confirm?email=a<b>c');
    expect(html).not.toContain('<b>c');
    expect(html).toContain('&lt;b&gt;c');
  });

  it('generateConfirmationToken produces consistent HMAC', async () => {
    const { generateConfirmationToken } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const token1 = generateConfirmationToken('test@example.com', 'secret123');
    const token2 = generateConfirmationToken('TEST@EXAMPLE.COM', 'secret123');
    expect(token1).toBe(token2); // case-insensitive
    expect(token1).toHaveLength(64); // SHA-256 hex

    const token3 = generateConfirmationToken('test@example.com', 'different_secret');
    expect(token3).not.toBe(token1);
  });

  it('sendNewsletterConfirmationEmail rejects invalid email', async () => {
    const { sendNewsletterConfirmationEmail } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const result = await sendNewsletterConfirmationEmail({
      email: 'not-an-email',
      resendApiKey: 'key',
      secret: 'secret',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_email');
  });

  it('sendNewsletterConfirmationEmail rejects missing API key', async () => {
    const { sendNewsletterConfirmationEmail } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const result = await sendNewsletterConfirmationEmail({
      email: 'test@example.com',
      resendApiKey: '',
      secret: 'secret',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_resend_api_key');
  });

  it('sendNewsletterConfirmationEmail rejects missing secret', async () => {
    const { sendNewsletterConfirmationEmail } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const result = await sendNewsletterConfirmationEmail({
      email: 'test@example.com',
      resendApiKey: 'key',
      secret: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_newsletter_secret');
  });
});

// ── Subscription management confirm action ─────────────────

describe('handleSubscriptionManagement — confirm action', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  function createFakeDb() {
    const docs: Record<string, any> = {};
    const events: any[] = [];
    return {
      docs,
      events,
      collection(name: string) {
        return {
          doc(id: string) {
            return {
              get: async () => ({
                exists: !!docs[`${name}/${id}`],
                data: () => docs[`${name}/${id}`],
              }),
              set: async (data: any, _opts?: any) => {
                docs[`${name}/${id}`] = { ...(docs[`${name}/${id}`] || {}), ...data };
              },
              collection: (subName: string) => ({
                add: async (data: any) => {
                  events.push({ collection: `${name}/${id}/${subName}`, ...data });
                },
              }),
            };
          },
          add: async (data: any) => {
            events.push({ collection: name, ...data });
          },
        };
      },
    };
  }

  it('confirms a pending subscriber with valid HMAC', { timeout: 30000 }, async () => {
    const { handleSubscriptionManagement, verifyHmacToken } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );
    const { generateConfirmationToken } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );

    const secret = 'test-secret-123';
    const email = 'pending@example.com';
    const token = generateConfirmationToken(email, secret);
    const db = createFakeDb();
    db.docs['newsletter_subscribers/pending@example.com'] = { status: 'pending', isActive: false };

    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email,
      token,
      secret,
      db,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('riattivat');
    const doc = db.docs['newsletter_subscribers/pending@example.com'];
    expect(doc.status).toBe('confirmed');
    expect(doc.isActive).toBe(true);
  });

  it('returns success for already confirmed subscriber', async () => {
    const { handleSubscriptionManagement } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );
    const { generateConfirmationToken } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );

    const secret = 'test-secret';
    const email = 'confirmed@example.com';
    const token = generateConfirmationToken(email, secret);
    const db = createFakeDb();
    db.docs['newsletter_subscribers/confirmed@example.com'] = { status: 'confirmed', isActive: true };

    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email,
      token,
      secret,
      db,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('confirmed@example.com');
  });

  it('rejects confirm with invalid HMAC token', async () => {
    const { handleSubscriptionManagement } = await import(
      '../functions/src/newsletterSubscriptionManagement.js'
    );

    const db = createFakeDb();
    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: 'test@example.com',
      token: 'invalid-token',
      secret: 'test-secret',
      db,
    });

    expect(result.status).toBe(403);
    expect(result.html).toContain('Link non valido');
  });
});

// ── Client-side pending email helpers ───────────────────────

describe('newsletter pending email helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('markNewsletterPendingLocally stores email and timestamp', async () => {
    const { markNewsletterPendingLocally, getNewsletterPendingEmail } = await import(
      '@/services/newsletterSubscribers'
    );
    markNewsletterPendingLocally('Test@Example.Com');
    const result = getNewsletterPendingEmail();
    expect(result).not.toBeNull();
    expect(result!.email).toBe('test@example.com');
    expect(result!.since).toBeGreaterThan(0);
  });

  it('clearNewsletterPendingLocally removes stored data', async () => {
    const { markNewsletterPendingLocally, clearNewsletterPendingLocally, getNewsletterPendingEmail } = await import(
      '@/services/newsletterSubscribers'
    );
    markNewsletterPendingLocally('test@example.com');
    expect(getNewsletterPendingEmail()).not.toBeNull();
    clearNewsletterPendingLocally();
    expect(getNewsletterPendingEmail()).toBeNull();
  });

  it('getNewsletterPendingEmail returns null for invalid data', async () => {
    const { getNewsletterPendingEmail } = await import('@/services/newsletterSubscribers');
    localStorage.setItem('newsletter_pending_email', 'not-an-email');
    expect(getNewsletterPendingEmail()).toBeNull();
  });
});
