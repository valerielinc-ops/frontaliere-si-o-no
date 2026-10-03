import { describe, expect, it } from 'vitest';
import { __renderTopicHubPageForTest, __renderTopicIndexPageForTest } from '../build-plugins/topicClusterHubsPlugin';

function render(date: string, dateStamp: string) {
  return __renderTopicHubPageForTest({
    locale: 'it', section: 'frontaliere', topicKey: 'pensioni',
    members: [{ id: 'pensione', urlSlug: 'pensione', title: 'Pensione documentata', excerpt: 'Informazioni sulla pensione.', date }],
    page: 1, totalPages: 1, eligible: new Set(['pensioni']), dateStamp,
  }).html;
}

function renderIndex(date: string, dateStamp: string) {
  return __renderTopicIndexPageForTest({
    locale: 'it', section: 'frontaliere', eligible: new Set(['pensioni']),
    countByTopic: new Map([['pensioni', 1]]), totalArticles: 1, newest: date.slice(0, 10), dateStamp,
  }).html;
}

describe.each([['hub', render], ['index', renderIndex]] as const)('%s documented freshness', (_name, renderPage) => {
  it('omits the update tile for undated articles across rebuilds', () => {
    for (const day of ['2026-05-18', '2026-05-19']) {
      const html = renderPage('', day);
      expect(html).toContain('<h1');
      expect(html).not.toContain('Aggiornato');
    }
  });
  it('preserves the latest documented article date', () => {
    const html = renderPage('2026-05-15T12:00:00Z', '2026-05-19');
    expect(html).toContain('Aggiornato');
    expect(html).toContain('2026-05-15');
  });
});
