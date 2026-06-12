import { describe, it, expect } from 'vitest';
import { applyTarget, renderBody } from '../build-plugins/publisherAdPagesPlugin';

const BASE_REC = {
  title: 'Prompt engineer da remoto',
  slug: 'prompt-engineer-da-remoto-thun-frontaliere-ticino',
  company: 'Frontaliere Ticino',
  companyLogo: 'https://cdn.example.ch/logo.png',
  location: 'Thun',
  canton: 'BE',
  postedDate: '2026-06-11T15:52:27.928Z',
  salaryMin: 45000,
  salaryMax: 50000,
  currency: 'CHF',
  description: 'Cerchiamo una persona motivata.\n\nSeconda riga di testo.',
  descriptionMd: '## Responsabilità\n- Progettare **prompt**\n- Testare la qualità\n\n## Offriamo\n- Lavoro remoto',
  applyMode: 'in_house',
  applyUrl: 'https://frontaliereticino.ch/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino',
  employmentType: 'FULL_TIME',
  contractType: 'permanent',
  tier: 'sponsored',
  featured: true,
};

describe('applyTarget — the "Candidati ora" CTA destination', () => {
  it('in_house / forward_email → the /candidatura/ sub-page, never a self-link', () => {
    expect(applyTarget(BASE_REC, 'it')).toEqual({
      href: '/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/',
      external: false,
    });
    expect(applyTarget({ ...BASE_REC, applyMode: 'forward_email' }, 'en').href)
      .toBe('/en/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/');
  });

  it('external_url with a real URL → the employer page, new tab', () => {
    const rec = { ...BASE_REC, applyMode: 'external_url', applyUrl: 'https://acme.ch/careers/123' };
    expect(applyTarget(rec, 'it')).toEqual({ href: 'https://acme.ch/careers/123', external: true });
  });

  it('external_url whose applyUrl is the minted self /lavoro/ URL → candidatura fallback (no loop)', () => {
    const rec = { ...BASE_REC, applyMode: 'external_url' }; // applyUrl = self
    expect(applyTarget(rec, 'it').href).toMatch(/\/candidatura\/$/);
  });
});

describe('renderBody — sponsored /lavoro/ page', () => {
  const html = renderBody(BASE_REC, 'it');

  it('renders the publisher logo with the onerror initials fallback', () => {
    expect(html).toContain('src="https://cdn.example.ch/logo.png"');
    expect(html).toContain('alt="Logo Frontaliere Ticino"');
    expect(html).toContain('onerror=');
  });

  it('renders markdown sections (headings + bullets + bold) for sponsored ads', () => {
    expect(html).toContain('Responsabilità</h2>');
    expect(html).toMatch(/<li[^>]*>Progettare <strong>prompt<\/strong><\/li>/);
    expect(html).toContain('Offriamo</h2>');
  });

  it('CTA points to the candidatura page for in_house ads', () => {
    expect(html).toContain('href="/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/"');
    // the page must never link the CTA to itself
    expect(html).not.toMatch(/href="\/lavoro\/prompt-engineer-da-remoto-thun-frontaliere-ticino\/"[^>]*rel="nofollow"/);
  });

  it('shows the sponsored badge and the salary tile', () => {
    expect(html).toContain('Sponsorizzato');
    expect(html).toContain('Retribuzione');
    expect(html).toContain('45');
  });

  it('free-tier ads: no markdown rendering, plain paragraphs, initials logo fallback', () => {
    const free = renderBody(
      { ...BASE_REC, tier: 'free', featured: false, companyLogo: undefined, applyMode: 'external_url', applyUrl: 'https://acme.ch/jobs/1' },
      'it',
    );
    expect(free).not.toContain('Responsabilità</h2>'); // markdown ignored on free
    expect(free).toContain('Cerchiamo una persona motivata.');
    expect(free).toContain('data:image/svg+xml'); // initials badge
    expect(free).toContain('href="https://acme.ch/jobs/1"');
    expect(free).not.toContain('Sponsorizzato');
  });
});
