// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ArticleSectionNav, { ArticleSectionNavigation } from '@/components/navigation/ArticleSectionNav';

const { liveSections } = vi.hoisted(() => {
  const names = [
    'Zurigo', 'Vaud', 'Argovia', 'Ticino', 'Berna', 'Basilea', 'Friburgo', 'Ginevra',
    'Glarona', 'Grigioni', 'Giura', 'Lucerna', 'Neuchâtel', 'Nidvaldo', 'Obvaldo',
    'San Gallo', 'Sciaffusa', 'Soletta', 'Svitto', 'Turgovia', 'Uri', 'Vallese', 'Zugo',
    'Appenzello',
  ];
  return {
    liveSections: names.map((displayName, index) => ({
      section: (displayName === 'Zurigo' ? 'canton-zurigo' : `canton-test-${index}`) as `canton-${string}`,
      canton: `C${index}`,
      indexSlug: { it: `canton-${index}`, en: `canton-${index}`, de: `canton-${index}`, fr: `canton-${index}` },
      label: displayName,
      displayName,
    })),
  };
});

vi.mock('@/services/router', () => ({
  buildPath: vi.fn(({ blogSection }: { blogSection?: string }) => blogSection ? `/${blogSection}/` : '/articoli-frontaliere/'),
  isArticleSectionRoute: ({ activeTab }: { activeTab: string }) => activeTab === 'blog',
}));

vi.mock('@/services/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/i18n')>();
  return {
    ...actual,
    useLocale: () => ['it' as const, vi.fn()],
    t: (key: string) => key === 'blog.section.svizzera' ? 'Svizzera' : 'Frontalieri',
  };
});

vi.mock('@/services/runtimeArticleSections', () => ({
  loadLiveCantonArticleSections: vi.fn(() => Promise.resolve(liveSections)),
  localizeCantonArticleSections: vi.fn((sections) => sections),
}));

afterEach(() => cleanup());

describe('ArticleSectionNav', () => {
  it.each(['job-board', 'calculator', 'fisco', 'guida', 'stats', 'sitemap'] as const)('does not render on %s routes', (activeTab) => {
    render(
      <ArticleSectionNavigation
        route={{ activeTab }}
        activeSection="frontaliere"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('article-section-nav')).toBeNull();
  });

  it('renders through the route guard on article routes', async () => {
    render(
      <ArticleSectionNavigation
        route={{ activeTab: 'blog' }}
        activeSection="frontaliere"
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('article-section-nav')).toBeInTheDocument();
  });

  it('keeps all live canton hrefs in the DOM while the disclosure is closed', async () => {
    render(<ArticleSectionNav activeSection="frontaliere" onSelect={vi.fn()} />);

    const panel = await waitFor(() => {
      const result = screen.getByTestId('article-canton-panel');
      expect(within(result).getAllByRole('link', { hidden: true })).toHaveLength(24);
      return result;
    });

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('link', { name: 'Frontalieri' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Apri elenco cantoni' })).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');

    const cantonLinks = within(panel).getAllByRole('link', { hidden: true });
    expect(cantonLinks.map((link) => link.textContent)).toEqual([
      'Appenzello', 'Argovia', 'Basilea', 'Berna', 'Friburgo', 'Ginevra', 'Giura', 'Glarona',
      'Grigioni', 'Lucerna', 'Neuchâtel', 'Nidvaldo', 'Obvaldo', 'San Gallo', 'Sciaffusa', 'Soletta',
      'Svitto', 'Ticino', 'Turgovia', 'Uri', 'Vallese', 'Vaud', 'Zugo', 'Zurigo',
    ]);
    expect(cantonLinks.every((link) => link.getAttribute('href'))).toBe(true);
    expect(cantonLinks.every((link) => link.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('opens as a disclosure, traps focus, and returns focus on Escape', async () => {
    render(<ArticleSectionNav activeSection="frontaliere" onSelect={vi.fn()} />);
    const openButton = await screen.findByRole('button', { name: 'Apri elenco cantoni' });
    fireEvent.click(openButton);

    const panel = screen.getByTestId('article-canton-panel');
    const closeButton = await screen.findByRole('button', { name: 'Chiudi' });
    await waitFor(() => expect(closeButton).toHaveFocus());
    expect(openButton).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('aria-hidden', 'false');

    const cantonLinks = within(panel).getAllByRole('link');
    cantonLinks[cantonLinks.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(openButton).toHaveFocus());
    expect(openButton).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  it('closes on an outside pointer and restores focus to the disclosure', async () => {
    render(<ArticleSectionNav activeSection="frontaliere" onSelect={vi.fn()} />);
    const openButton = await screen.findByRole('button', { name: 'Apri elenco cantoni' });
    fireEvent.click(openButton);
    await screen.findByRole('button', { name: 'Chiudi' });

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(openButton).toHaveFocus());
    expect(openButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks the active live canton on the disclosure and its real link', async () => {
    render(<ArticleSectionNav activeSection="canton-zurigo" onSelect={vi.fn()} />);

    const button = await screen.findByRole('button', { name: /Zurigo/ });
    expect(button).toHaveAttribute('aria-current', 'page');
    expect(button).toHaveAttribute('data-article-section-active', 'true');

    const panel = screen.getByTestId('article-canton-panel');
    expect(within(panel).getByRole('link', { name: 'Zurigo', hidden: true })).toHaveAttribute('aria-current', 'page');
  });
});
