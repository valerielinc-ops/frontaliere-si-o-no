import { describe, it, expect } from 'vitest';
import { buildBlastEmail } from '../services/publisherBlastEmail.mjs';

const AD = {
  title: 'Specialista Marketing Digitale',
  company: { name: 'Acme SA', logoUrl: 'https://cdn.example.ch/logo.png' },
  locations: [{ label: 'Lugano', canton: 'TI' }],
  salaryMin: 70000,
  salaryMax: 90000,
  currency: 'CHF',
  sector: 'Marketing',
  description: 'Cerchiamo una persona motivata per coordinare campagne digitali e analizzare metriche di conversione verso i frontalieri del Canton Ticino.',
};

const ARGS = {
  ad: AD,
  recipientEmail: 'user@example.com',
  locale: 'it' as const,
  adUrl: 'https://frontaliereticino.ch/lavoro/specialista-marketing-digitale-lugano-acme-sa/?utm_source=newsletter&utm_medium=email&utm_campaign=sponsored_blast',
  unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=user%40example.com',
};

describe('buildBlastEmail', () => {
  it('returns a localized subject with the job title', () => {
    expect(buildBlastEmail(ARGS).subject).toBe('Nuova offerta per te: Specialista Marketing Digitale');
    expect(buildBlastEmail({ ...ARGS, locale: 'en' }).subject).toBe('A new job for you: Specialista Marketing Digitale');
    expect(buildBlastEmail({ ...ARGS, locale: 'de' }).subject).toContain('Ein neues Stellenangebot');
    expect(buildBlastEmail({ ...ARGS, locale: 'fr' }).subject).toContain('Une nouvelle offre');
  });

  it('links the CTA to the specific ad page (not the generic /lavoro alias)', () => {
    const { html } = buildBlastEmail(ARGS);
    expect(html).toContain('href="https://frontaliereticino.ch/lavoro/specialista-marketing-digitale-lugano-acme-sa/?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=sponsored_blast"');
    // The bare-stub generic link must be gone.
    expect(html).not.toContain('href="https://frontaliereticino.ch/lavoro"');
    expect(html).not.toContain(">Vedi l'offerta su Frontaliere Ticino<");
  });

  it('renders branded chrome: top bar, sponsored badge, CTA, footer', () => {
    const { html } = buildBlastEmail(ARGS);
    expect(html).toContain('Frontaliere Ticino');
    expect(html).toContain('Sponsorizzato');
    expect(html).toContain('Candidati ora');
    expect(html).toContain('#f97316'); // brand orange
    expect(html).toMatch(/<!DOCTYPE html>/);
  });

  it('shows salary, location and sector chips', () => {
    const { html } = buildBlastEmail(ARGS);
    expect(html).toContain("CHF 70'000–90'000");
    expect(html).toContain('Lugano');
    expect(html).toContain('Marketing');
  });

  it('uses the company logo when https, with explicit dimensions', () => {
    const { html } = buildBlastEmail(ARGS);
    expect(html).toContain('src="https://cdn.example.ch/logo.png"');
    expect(html).toContain('width="52" height="52"');
  });

  it('falls back to an initials badge when no valid logo', () => {
    const { html } = buildBlastEmail({ ...ARGS, ad: { ...AD, company: { name: 'Acme SA' } } });
    expect(html).not.toContain('<img');
    expect(html).toContain('>A</div>'); // initial of "Acme SA"
  });

  it('drops non-https logos (no mixed content / junk)', () => {
    const { html } = buildBlastEmail({ ...ARGS, ad: { ...AD, company: { name: 'Acme SA', logoUrl: 'http://x/y.png' } } });
    expect(html).not.toContain('<img');
  });

  it('escapes HTML in ad fields (injection-safe)', () => {
    const { html } = buildBlastEmail({ ...ARGS, ad: { ...AD, title: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes the unsubscribe link and the recipient in the why-line', () => {
    const { html } = buildBlastEmail(ARGS);
    // Ampersands are HTML-escaped inside the href attribute.
    expect(html).toContain('href="https://frontaliereticino.ch/?action=unsubscribe&amp;email=user%40example.com"');
    expect(html).toContain('user@example.com');
  });

  it('omits the salary chip when no salary data', () => {
    const { html } = buildBlastEmail({ ...ARGS, ad: { ...AD, salaryMin: null, salaryMax: null } });
    expect(html).not.toContain('Retribuzione:');
  });
});
