import { describe, it, expect } from 'vitest';
import {
  renderEmployerCardHtml,
  renderEmployerCardListHtml,
} from '../../build-plugins/shared/employerCardHtml';

describe('renderEmployerCardHtml (compact)', () => {
  const employer = {
    name: 'Migros Ticino',
    companyKey: 'migros',
    companyDomain: 'migros.ch',
    openings: 12,
  };

  it('renders a card with logo slot, name, and openings count', () => {
    const html = renderEmployerCardHtml(employer, {
      href: '/aziende/migros',
      locale: 'it',
      variant: 'compact',
    });
    expect(html).toContain('href="/aziende/migros"');
    expect(html).toContain('Migros Ticino');
    expect(html).toMatch(/<img[^>]+alt="Logo Migros Ticino"/);
    expect(html).toContain('>12<');
  });

  it('omits openings count when null', () => {
    const html = renderEmployerCardHtml(
      { ...employer, openings: null },
      { href: '/x', locale: 'it', variant: 'compact' },
    );
    expect(html).not.toMatch(/>0</);
  });

  it('uses bg-surface-raised + border-edge (Tailwind tokens, no inline hex)', () => {
    const html = renderEmployerCardHtml(employer, {
      href: '/x',
      locale: 'it',
      variant: 'compact',
    });
    expect(html).toContain('bg-surface-raised');
    expect(html).toContain('border-edge');
    expect(html).not.toMatch(/style="[^"]*background-color:\s*#/);
  });

  it('escapes HTML in employer name', () => {
    const html = renderEmployerCardHtml(
      { name: '<script>x</script>' },
      { href: '/x', locale: 'it', variant: 'compact' },
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('renderEmployerCardHtml (detailed)', () => {
  it('renders sector + city + openings in the detailed variant', () => {
    const html = renderEmployerCardHtml(
      {
        name: 'Lonza',
        companyKey: 'lonza',
        companyDomain: 'lonza.com',
        sector: 'Farmaceutica',
        city: 'Visp',
        openings: 35,
      },
      { href: '/aziende/lonza-visp', locale: 'it', variant: 'detailed' },
    );
    expect(html).toContain('Farmaceutica');
    expect(html).toContain('Visp');
    expect(html).toContain('35');
  });
});

describe('renderEmployerCardListHtml', () => {
  it('renders <ul role="list"> with one <li> per employer', () => {
    const html = renderEmployerCardListHtml(
      [
        { employer: { name: 'A' }, href: '/a' },
        { employer: { name: 'B' }, href: '/b' },
      ],
      { locale: 'it', variant: 'compact' },
    );
    expect(html).toMatch(/<ul[^>]+role="list"/);
    expect((html.match(/<li>/g) || []).length).toBe(2);
  });

  it('returns emptyStateHtml when list is empty', () => {
    const html = renderEmployerCardListHtml([], {
      locale: 'it',
      variant: 'compact',
      emptyStateHtml: '<p>nessuno</p>',
    });
    expect(html).toBe('<p>nessuno</p>');
  });
});
