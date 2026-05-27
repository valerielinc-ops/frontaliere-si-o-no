/**
 * Correzioni page test — verifies:
 *  1. Empty log shows "Nessuna correzione registrata"
 *  2. Sample entries render in reverse chronological order
 *  3. Inline JSON-LD has @type=WebPage and a `lastReviewed` field
 *
 * The component imports data/corrections-log.json directly. We use vi.mock
 * with a factory so we can swap log shapes per test without touching disk.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.resetModules();
});

// Stable navigation stub so the component's "Torna alla Home" button mounts
// without needing a NavigationProvider wrapper.
beforeEach(() => {
  vi.doMock('@/services/NavigationContext', () => ({
    useNavigation: () => ({ navigateTo: vi.fn() }),
  }));
});

function jsonLdNodeFromContainer(container: HTMLElement): Record<string, unknown> {
  const node = container.querySelector('script[type="application/ld+json"]');
  expect(node, 'expected an inline JSON-LD <script> in Correzioni page').toBeTruthy();
  const txt = node!.textContent || '';
  return JSON.parse(txt) as Record<string, unknown>;
}

describe('Correzioni — empty log', () => {
  it('renders the empty-state message and a WebPage JSON-LD with lastReviewed', async () => {
    vi.doMock('@/data/corrections-log.json', () => ({
      default: {
        version: 1,
        policy: {
          sla_hours: 48,
          types: ['factual', 'typo', 'clarification'],
          contactEmail: 'redazione@frontaliereticino.ch',
        },
        entries: [],
      },
    }));

    const { Correzioni } = await import('@/components/pages/Correzioni');
    const { container } = render(<Correzioni />);

    expect(
      screen.getByText(/Nessuna correzione registrata finora/i),
    ).toBeTruthy();
    expect(screen.queryByTestId('corrections-list')).toBeNull();

    const ld = jsonLdNodeFromContainer(container);
    expect(ld['@type']).toBe('WebPage');
    expect(typeof ld['lastReviewed']).toBe('string');
    // YYYY-MM-DD prefix
    expect(/^\d{4}-\d{2}-\d{2}$/.test(String(ld['lastReviewed']))).toBe(true);
  });
});

describe('Correzioni — populated log', () => {
  it('renders entries in reverse chronological order and exposes the most recent date in JSON-LD', async () => {
    vi.doMock('@/data/corrections-log.json', () => ({
      default: {
        version: 1,
        policy: {
          sla_hours: 48,
          types: ['factual', 'typo', 'clarification'],
          contactEmail: 'redazione@frontaliereticino.ch',
        },
        entries: [
          {
            date: '2026-01-10T09:00:00.000Z',
            articleId: 'oldest-article',
            type: 'typo',
            description: 'Refuso corretto nel titolo del paragrafo introduttivo.',
          },
          {
            date: '2026-04-20T15:30:00.000Z',
            articleId: 'newest-article',
            type: 'factual',
            description:
              'Aliquota imposta alla fonte aggiornata da 9% a 8% (fonte AFC tabella 2026).',
          },
          {
            date: '2026-03-05T12:00:00.000Z',
            articleId: 'middle-article',
            type: 'clarification',
            description:
              'Aggiunta precisazione sulla franchigia di 10.000 EUR per nuovi frontalieri.',
          },
        ],
      },
    }));

    const { Correzioni } = await import('@/components/pages/Correzioni');
    const { container } = render(<Correzioni />);

    const list = screen.getByTestId('corrections-list');
    expect(list).toBeTruthy();
    const items = list.querySelectorAll('li');
    expect(items.length).toBe(3);

    // Reverse chronological — newest first
    expect(items[0].textContent).toContain('newest-article');
    expect(items[1].textContent).toContain('middle-article');
    expect(items[2].textContent).toContain('oldest-article');

    // JSON-LD lastReviewed picks up the most recent date (YYYY-MM-DD).
    const ld = jsonLdNodeFromContainer(container);
    expect(ld['@type']).toBe('WebPage');
    expect(ld['lastReviewed']).toBe('2026-04-20');
  });
});
