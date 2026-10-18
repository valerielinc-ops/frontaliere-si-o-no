/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CantonTopicHub from '@/components/community/CantonTopicHub';
import { loadCantonTopicHub } from '@/services/runtimeCantonTopicHubs';

vi.mock('@/services/i18n', () => ({
  useLocale: () => ['it' as const, vi.fn()],
}));

vi.mock('@/services/runtimeArticleSections', () => ({
  cantonSectionConfig: () => ({
    canton: 'ZH',
    topicHubs: { carburanti: {}, fisco: {} },
  }),
}));

vi.mock('@/services/runtimeCantonTopicHubs', () => ({
  loadCantonTopicHub: vi.fn(),
}));

vi.mock('@/packages/articles/engine/shared/cantonSectionCopy.mjs', () => ({
  cantonArchiveCopy: () => ({ title: 'Archivio' }),
  cantonLatestNewsHeading: () => 'Ultime notizie dal Canton Zurigo',
  cantonSectionArchivePath: () => '/archivio/',
  cantonSectionLabel: () => 'Articoli Zurigo',
  cantonSectionLandingPath: () => '/articoli-zurigo/',
  cantonTopicHubLabel: (_section: string, topic: string) => topic === 'fisco' ? 'Fisco Zurigo' : 'Carburanti Zurigo',
  cantonTopicHubPath: (_section: string, topic: string) => `/${topic}/`,
}));

const loadHub = vi.mocked(loadCantonTopicHub);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function hubData(topic: string) {
  return {
    canton: 'ZH',
    topic,
    locale: 'it' as const,
    intro: `Introduzione ${topic} sufficientemente lunga per il test.`,
    keyFacts: [],
    dataBlocks: [],
    curatedArticles: [],
    latestCantonArticles: [],
    links: [],
    updatedAt: '2026-10-07T09:49:20.921Z',
  };
}

function hubDataWithBlocks(topic: string) {
  return {
    ...hubData(topic),
    keyFacts: [{ label: 'Indicatore', value: '12 min' }],
    dataBlocks: [{ id: 'live', title: 'Dati aggiornati', items: [{ label: 'Posto A', value: '12 min' }] }],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CantonTopicHub route handoff', () => {
  it('does not signal the new route ready with the previous hub payload', async () => {
    const first = deferred<ReturnType<typeof hubData> | null>();
    const second = deferred<ReturnType<typeof hubData> | null>();
    loadHub.mockImplementation((_section, topic) => topic === 'carburanti' ? first.promise : second.promise);
    const onReady = vi.fn();

    const view = render(
      <CantonTopicHub section="canton-zh" topic="carburanti" onReady={onReady} />,
    );
    await act(async () => { first.resolve(hubData('carburanti')); });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Carburanti Zurigo'));
    expect(onReady).toHaveBeenLastCalledWith('canton-zh:carburanti:it');

    view.rerender(<CantonTopicHub section="canton-zh" topic="fisco" onReady={onReady} />);
    expect(screen.queryByRole('heading', { name: 'Fisco Zurigo' })).toBeNull();
    expect(onReady).not.toHaveBeenLastCalledWith('canton-zh:fisco:it');

    await act(async () => { second.resolve(hubData('fisco')); });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fisco Zurigo'));
    expect(onReady).toHaveBeenLastCalledWith('canton-zh:fisco:it');
  });

  it('keeps both desktop rails and the four ad pauses after hydration', async () => {
    loadHub.mockResolvedValue(hubDataWithBlocks('carburanti'));

    const view = render(<CantonTopicHub section="canton-zh" topic="carburanti" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Carburanti Zurigo'));

    expect(view.container.querySelector('[data-canton-topic-hub="canton-zh:carburanti"]')).not.toBeNull();
    expect(view.container.querySelectorAll('.cth-react-rail')).toHaveLength(2);
    expect(view.container.querySelectorAll('.cth-ad')).toHaveLength(4);
    expect(view.container.querySelector('.cth-ad-inline-one')).not.toBeNull();
    expect(view.container.querySelector('.cth-ad-inline-two')).not.toBeNull();
  });

  it('renders neutral canton news in a separate localized block', async () => {
    loadHub.mockResolvedValue({
      ...hubData('eventi'),
      latestCantonArticles: [{ title: 'Notizia locale', url: '/articoli-zurigo/notizia-locale/', date: '2026-10-15' }],
    });

    render(<CantonTopicHub section="canton-zh" topic="eventi" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ultime notizie dal Canton Zurigo' })).toBeInTheDocument());

    const block = screen.getByRole('heading', { name: 'Ultime notizie dal Canton Zurigo' }).closest('section');
    expect(block).not.toBeNull();
    expect(block?.querySelector('a[href="/articoli-zurigo/notizia-locale/"]')).not.toBeNull();
    expect(block?.className).toContain('cth-latest-news');
    expect(screen.getByRole('heading', { name: 'Articoli consigliati' })).toBeInTheDocument();
  });

  it('does not render neutral canton news when thematic articles are present', async () => {
    loadHub.mockResolvedValue({
      ...hubData('eventi'),
      curatedArticles: [{ title: 'Notizia tematica', url: '/articoli-zurigo/tema/' }],
      latestCantonArticles: [{ title: 'Fallback cantonale', url: '/articoli-zurigo/fallback/' }],
    });

    render(<CantonTopicHub section="canton-zh" topic="eventi" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Articoli consigliati' })).toBeInTheDocument());

    expect(screen.queryByRole('heading', { name: 'Ultime notizie dal Canton Zurigo' })).toBeNull();
    expect(screen.queryByText('Fallback cantonale')).toBeNull();
  });
});
