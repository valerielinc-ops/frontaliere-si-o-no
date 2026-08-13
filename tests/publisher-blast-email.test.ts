import { describe, it, expect } from 'vitest';
import { buildBlastEmail } from '../services/publisherBlastEmail.mjs';
import {
  distinctLocations,
  slugifyPublisher,
  truncatePublisherSlug,
  publisherJobToRecords,
} from '../scripts/lib/publisherJobProjection.mjs';

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

  /**
   * The footer this channel owes its reader (#5759).
   *
   * Third-party advertising is consented to as an OPT-OUT — the owner ruled on
   * 2026-08-13 that no extra checkbox appears at signup — so the compensating
   * control is a per-channel switch in the preference centre. A mail whose only
   * exit is "unsubscribe from everything" offers a different, worse bargain
   * than the one the reader was told about, and leaves someone who wants to
   * keep the newsletter with nothing to click. That is #5684 restated on the
   * one channel where the switch IS the consent.
   *
   * tests/preference-center-coverage.test.ts asserts the source-level half (the
   * template references the builder at all); this is the rendered half, which
   * is the one a recipient can act on.
   */
  it('carries the per-channel opt-out route, in every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const { html } = buildBlastEmail({
        ...ARGS,
        locale,
        preferencesUrl: 'https://frontaliereticino.ch/preferenze-newsletter/?email=user%40example.com&token=t',
      });
      expect(html, `${locale}: the preference link`).toContain('/preferenze-newsletter/');
      // …and it must SAY that the switch is per-channel, or the link is an
      // invitation to leave everything, which is what it exists to avoid.
      expect(html, `${locale}: the scope note`).toMatch(
        /pubblicità di terzi|third-party advertising|Werbung Dritter|publicité de tiers/i,
      );
    }
  });

  it('degrades to the unsubscribe link alone when the sender passes no preferences URL', () => {
    // Pure builder, same rule as buildDripEmail: a missing URL becomes no link,
    // never `href="undefined"`.
    const { html } = buildBlastEmail(ARGS);
    expect(html).not.toContain('href="undefined"');
    expect(html).not.toContain('/preferenze-newsletter/');
    expect(html).toContain(ARGS.unsubscribeUrl.replace(/&/g, '&amp;'));
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

  it('uses the caller-provided locationLabel for the card city (matches CTA slug)', () => {
    // Degenerate shapes where ad.locations[0].label is empty but the CTA slug
    // (and thus locationLabel) resolves to a real city — card must show it.
    const bareString = buildBlastEmail({ ...ARGS, ad: { ...AD, locations: ['Lugano'] }, locationLabel: 'Lugano' });
    expect(bareString.html).toContain('Lugano');
    const emptyFirst = buildBlastEmail({ ...ARGS, ad: { ...AD, locations: [{ label: '  ' }, { label: 'Bellinzona' }] }, locationLabel: 'Bellinzona' });
    expect(emptyFirst.html).toContain('Bellinzona');
  });

  it('falls back to the raw first location when no locationLabel passed', () => {
    const { html } = buildBlastEmail({ ...ARGS, locationLabel: undefined });
    expect(html).toContain('Lugano');
  });
});

// Regression for the reviewer 🔴 (#2084): the CTA slug must match the emitted
// /lavoro/<slug>/ page across ALL location shapes distinctLocations supports,
// or the "Candidati ora" button 404s for real (non-canary) ads.
describe('blast CTA slug matches the projected ad page (distinctLocations parity)', () => {
  // Replicates the slug derivation in blast-publisher-ads.mjs.
  const blastSlug = (ad: Record<string, unknown>) => {
    const label = distinctLocations(ad.locations)[0]?.text || '';
    return truncatePublisherSlug(slugifyPublisher(`${ad.title}-${label}-${(ad.company as { name?: string })?.name || ''}`));
  };
  const pub = (locations: unknown) => ({
    id: 'pub1', publisherUid: 'u', status: 'paid', tier: 'sponsored',
    title: 'Specialista Marketing', description: 'parola '.repeat(60).trim(),
    sourceLang: 'it', company: { name: 'Acme SA' }, locations,
    apply: { mode: 'external_url', url: 'https://acme.ch/jobs' }, paidAt: '2026-06-15T00:00:00Z', createdAt: '2026-06-15T00:00:00Z',
  });
  const projectedSlug = (locations: unknown) =>
    publisherJobToRecords(pub(locations), { nowIso: '2026-06-15T00:00:00Z' })[0]?.slug;

  it('object location', () => {
    const locs = [{ label: 'Lugano', canton: 'TI' }];
    expect(blastSlug(pub(locs))).toBe(projectedSlug(locs));
  });

  it('bare-string location (the .label-undefined case)', () => {
    const locs = ['Lugano'];
    expect(blastSlug(pub(locs))).toBe(projectedSlug(locs));
  });

  it('empty first entry → picks the first non-empty (distinctLocations skip)', () => {
    const locs = [{ label: '  ' }, { label: 'Bellinzona', canton: 'TI' }];
    expect(blastSlug(pub(locs))).toBe(projectedSlug(locs));
    expect(blastSlug(pub(locs))).toContain('bellinzona');
  });
});
