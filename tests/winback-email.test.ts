import { describe, it, expect } from 'vitest';
import { buildWinbackEmail } from '../services/winbackEmail.mjs';

describe('buildWinbackEmail', () => {
  it('builds a localized email with subject, html, text and an unsubscribe URL', () => {
    const out = buildWinbackEmail({ email: 'user@example.com', locale: 'it' });
    expect(out.subject).toMatch(/newsletter|iscriz|sospend/i);
    expect(out.html).toContain('<!DOCTYPE html');
    expect(out.text.length).toBeGreaterThan(40);
    expect(out.unsubscribeUrl).toContain('action=unsubscribe');
    expect(out.unsubscribeUrl).toContain('user%40example.com');
  });

  it('embeds a resubscribe ("stay") CTA distinct from the unsubscribe link', () => {
    const out = buildWinbackEmail({ email: 'x@y.ch', locale: 'it' });
    expect(out.html).toContain('action=resubscribe');
    expect(out.html).toContain('action=unsubscribe');
  });

  it('renders all four site locales with a localized subject', () => {
    const subjects = ['it', 'en', 'de', 'fr'].map((l) => buildWinbackEmail({ email: 'a@b.ch', locale: l }).subject);
    expect(new Set(subjects).size).toBe(4); // each locale distinct
    expect(subjects.every((s) => s.length > 0)).toBe(true);
  });

  it('falls back to Italian for an unknown locale', () => {
    const it = buildWinbackEmail({ email: 'a@b.ch', locale: 'it' });
    const xx = buildWinbackEmail({ email: 'a@b.ch', locale: 'xx' });
    expect(xx.subject).toBe(it.subject);
  });

  it('sets the html lang attribute to the locale', () => {
    expect(buildWinbackEmail({ email: 'a@b.ch', locale: 'de' }).html).toContain('<html lang="de"');
  });
});
