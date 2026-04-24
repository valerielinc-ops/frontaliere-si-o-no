import { describe, it, expect } from 'vitest';
import { renderFastestCrossingCard } from '@/build-plugins/borderWaitPagesPlugin';

describe('renderFastestCrossingCard', () => {
  it('returns empty string when every crossing has 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 0 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toBe('');
  });

  it('renders the hero when at least one crossing has > 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 12 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toContain('Gaggiolo');
    expect(html).toContain('12 min');
  });
});
