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
    links: [],
    updatedAt: '2026-10-07T09:49:20.921Z',
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
});
