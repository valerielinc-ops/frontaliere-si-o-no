import { describe, expect, it } from 'vitest';
import {
  getBorderComparisonCandidates,
  renderBorderWaitComparison,
  renderBorderWaitPicker,
} from '@/build-plugins/borderWaitComparison';

const sourceLabels = {
  tomtom: 'Stima TomTom',
  here: 'Stima HERE',
};

describe('border-wait comparison', () => {
  it('selects nearest peers from the same regional corridor only', () => {
    const peers = getBorderComparisonCandidates('chiasso-brogeda', 4);

    expect(peers).toHaveLength(4);
    expect(peers.map(({ slug }) => slug)).toEqual([
      'maslianico-pizzamiglio',
      'chiasso-strada',
      'maslianico-roggiana',
      'chiasso-centro',
    ]);
    expect(peers.every(({ crossing }) => crossing.province === 'CO')).toBe(true);
    expect(peers.every(({ distanceKm }, index) => index === 0 || distanceKm >= peers[index - 1].distanceKm)).toBe(true);
  });

  it('renders current and peer readings with provenance and separate history', () => {
    const html = renderBorderWaitComparison({
      locale: 'it',
      currentSlug: 'chiasso-brogeda',
      current: {
        totalCrossingMinutes: 0,
        waitTimeMinutes: 0,
        status: 'green',
        source: 'tomtom',
        lastUpdate: '2026-09-09T07:00:00.000Z',
      },
      perCrossing: {
        'chiasso-centro': {
          totalCrossingMinutes: 14,
          status: 'yellow',
          source: 'here',
          lastUpdate: '2026-09-09T07:00:00.000Z',
        },
      },
      regionLabel: 'Ticino–Como',
      sourceLabels,
    });

    expect(html).toContain('data-bw-comparison="true"');
    expect(html).toContain('0 min');
    expect(html).not.toContain('Direzione');
    expect(html).not.toContain('IT → CH');
    expect(html).toContain('Stima TomTom');
    expect(html).toContain('14 min');
    expect(html).toContain('Profilo storico indicativo');
    expect(html).toContain('0-4 min');
    expect(html).toContain('non disponibile');
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('has localized picker controls in %s', (locale) => {
    const html = renderBorderWaitPicker({
      locale,
      region: 'ticino-como',
      crossings: ['chiasso-brogeda', 'chiasso-centro'],
    });

    expect(html).toContain('data-bw-picker="true"');
    expect(html).toContain('data-bw-picker-select');
    expect(html).toContain('data-bw-picker-go');
    expect(html).toContain('chiasso-brogeda');
    expect(html).toContain('details');
  });
});
